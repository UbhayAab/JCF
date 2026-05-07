-- ============================================================
-- Patient Navigator v4 — Team hierarchy + Patient lifecycle
-- Run AFTER sql/10_intelligent_followup.sql
-- ============================================================
-- Adds:
--   1. Team tree (profiles.manager_id) with recursive visibility
--   2. Patient assignment + lifecycle (assigned_to, first_contact, call_stage, do_not_call)
--   3. Per-service pitch tracking (therapy / nutrition / caregiver / clinical_trial / financial_aid)
--   4. Trigger: first contact locks patient to caller forever
--   5. Trigger: deactivating a user redistributes their patients to active teammates
--   6. RPC: distribute_new_patients() — round-robin/load-balanced daily distribution
--   7. Updated RLS policies for team-tree visibility on patients + call_logs
-- ============================================================


-- ============================================================
-- 1. TEAM TREE on profiles
-- ============================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_manager ON public.profiles(manager_id);

COMMENT ON COLUMN public.profiles.manager_id IS 'Self-FK for team hierarchy: this user reports to manager_id. Recursive subordinates_of() walks the tree.';


-- ============================================================
-- 2. PATIENT ASSIGNMENT + LIFECYCLE
-- ============================================================
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS assigned_to            UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS first_contact_at       TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS first_contacted_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS call_stage             INTEGER DEFAULT 0;  -- 0=never called, 1=intro made, 2=trust building, 3=soft offer, 4+=ongoing
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS do_not_call            BOOLEAN DEFAULT false;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS do_not_call_reason     TEXT;

-- Per-service pitch tracking (timestamp = when first pitched; NULL = never pitched)
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS pitched_therapy_at         TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS pitched_nutrition_at       TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS pitched_caregiver_at       TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS pitched_clinical_trial_at  TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS pitched_financial_aid_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_patients_assigned_to    ON public.patients(assigned_to);
CREATE INDEX IF NOT EXISTS idx_patients_first_contact  ON public.patients(first_contact_at);
CREATE INDEX IF NOT EXISTS idx_patients_dnc_active     ON public.patients(do_not_call) WHERE do_not_call = false;
CREATE INDEX IF NOT EXISTS idx_patients_call_stage     ON public.patients(call_stage);


-- ============================================================
-- 3. RECURSIVE TEAM-TREE FUNCTIONS
-- ============================================================

-- Returns all subordinate profile IDs (including the user themselves) walking the manager_id tree.
CREATE OR REPLACE FUNCTION public.subordinates_of(p_user_id UUID)
RETURNS TABLE(profile_id UUID) AS $$
  WITH RECURSIVE subs AS (
    SELECT id FROM public.profiles WHERE id = p_user_id
    UNION
    SELECT p.id FROM public.profiles p
    INNER JOIN subs s ON p.manager_id = s.id
  )
  SELECT id FROM subs;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Can the current authenticated user view records owned by p_owner_id?
-- True if: admin, owner is self, or owner is a subordinate.
CREATE OR REPLACE FUNCTION public.can_view_user_data(p_owner_id UUID)
RETURNS BOOLEAN AS $$
  SELECT
    public.is_admin()
    OR p_owner_id = auth.uid()
    OR p_owner_id IN (SELECT profile_id FROM public.subordinates_of(auth.uid()));
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- ============================================================
-- 4. UPDATED RLS — team-tree visibility on patients
-- ============================================================
DROP POLICY IF EXISTS "patients_select" ON public.patients;
CREATE POLICY "patients_select"
  ON public.patients FOR SELECT
  TO authenticated
  USING (
    public.is_active_user() AND (
      public.is_admin()
      OR (assigned_to IS NOT NULL AND public.can_view_user_data(assigned_to))
      OR (created_by  IS NOT NULL AND public.can_view_user_data(created_by))
    )
  );

DROP POLICY IF EXISTS "patients_update" ON public.patients;
CREATE POLICY "patients_update"
  ON public.patients FOR UPDATE
  TO authenticated
  USING (
    public.is_active_user() AND (
      public.is_admin()
      OR (assigned_to IS NOT NULL AND public.can_view_user_data(assigned_to))
      OR (created_by  IS NOT NULL AND public.can_view_user_data(created_by))
    )
  )
  WITH CHECK (
    public.is_active_user() AND (
      public.is_admin()
      OR (assigned_to IS NOT NULL AND public.can_view_user_data(assigned_to))
      OR (created_by  IS NOT NULL AND public.can_view_user_data(created_by))
    )
  );


-- ============================================================
-- 5. UPDATED RLS — team-tree visibility on call_logs
-- ============================================================
DROP POLICY IF EXISTS "call_logs_select" ON public.call_logs;
CREATE POLICY "call_logs_select"
  ON public.call_logs FOR SELECT
  TO authenticated
  USING (
    public.is_active_user() AND public.can_view_user_data(caller_id)
  );

DROP POLICY IF EXISTS "call_logs_update_managers"  ON public.call_logs;
DROP POLICY IF EXISTS "call_logs_update_own_recent" ON public.call_logs;
CREATE POLICY "call_logs_update_team"
  ON public.call_logs FOR UPDATE
  TO authenticated
  USING (
    public.is_active_user() AND public.can_view_user_data(caller_id)
  )
  WITH CHECK (
    public.is_active_user() AND public.can_view_user_data(caller_id)
  );


-- ============================================================
-- 6. TRIGGER — first contact locks patient to caller
-- ============================================================
-- When a caller actually reaches the patient (connected/voicemail/callback_requested),
-- the patient is permanently assigned to them. Subsequent calls don't re-claim.
CREATE OR REPLACE FUNCTION public.lock_patient_on_first_contact()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.dial_status IN ('connected', 'voicemail', 'callback_requested') THEN
    UPDATE public.patients
    SET
      first_contact_at   = COALESCE(first_contact_at,   NEW.call_date),
      first_contacted_by = COALESCE(first_contacted_by, NEW.caller_id),
      assigned_to        = COALESCE(assigned_to,        NEW.caller_id),
      call_stage         = GREATEST(COALESCE(call_stage, 0), 1)
    WHERE id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_lock_patient_on_first_contact ON public.call_logs;
CREATE TRIGGER trg_lock_patient_on_first_contact
  AFTER INSERT ON public.call_logs
  FOR EACH ROW EXECUTE FUNCTION public.lock_patient_on_first_contact();


-- ============================================================
-- 7. RPC — redistribute one user's patients to active teammates
-- ============================================================
CREATE OR REPLACE FUNCTION public.redistribute_patients_of(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  patient_record   RECORD;
  active_users     UUID[];
  num_active       INTEGER;
  next_idx         INTEGER := 0;
  redistributed    INTEGER := 0;
BEGIN
  -- All active users with a patient-facing role, excluding the deactivated one
  SELECT ARRAY_AGG(id ORDER BY id) INTO active_users
  FROM public.profiles
  WHERE is_active = true
    AND role IN ('caller', 'caregiver_mentor', 'manager', 'admin')
    AND id <> p_user_id;

  IF active_users IS NULL THEN RETURN 0; END IF;
  num_active := ARRAY_LENGTH(active_users, 1);
  IF num_active IS NULL OR num_active = 0 THEN RETURN 0; END IF;

  FOR patient_record IN
    SELECT id FROM public.patients
    WHERE assigned_to = p_user_id
      AND do_not_call = false
      AND is_active   = true
    ORDER BY first_contact_at ASC NULLS LAST, created_at ASC
  LOOP
    UPDATE public.patients
    SET assigned_to = active_users[(next_idx % num_active) + 1]
    WHERE id = patient_record.id;
    next_idx      := next_idx + 1;
    redistributed := redistributed + 1;
  END LOOP;

  RETURN redistributed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- 8. TRIGGER — auto-redistribute on user deactivation
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_user_deactivation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_active = true AND NEW.is_active = false THEN
    PERFORM public.redistribute_patients_of(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_redistribute_on_deactivation ON public.profiles;
CREATE TRIGGER trg_redistribute_on_deactivation
  AFTER UPDATE OF is_active ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_deactivation();


-- ============================================================
-- 9. RPC — daily distribution of unassigned new patients
-- ============================================================
-- Load-balanced: assigns each NULL-assigned patient to the active user with the
-- smallest current case-load. Idempotent — safe to re-run any number of times.
-- Returns the count of patients distributed in this run.
CREATE OR REPLACE FUNCTION public.distribute_new_patients()
RETURNS INTEGER AS $$
DECLARE
  patient_record  RECORD;
  active_users    UUID[];
  user_load       INTEGER[] := ARRAY[]::INTEGER[];
  num_active      INTEGER;
  min_idx         INTEGER;
  i               INTEGER;
  distributed     INTEGER := 0;
BEGIN
  SELECT ARRAY_AGG(id ORDER BY id) INTO active_users
  FROM public.profiles
  WHERE is_active = true
    AND role IN ('caller', 'caregiver_mentor', 'manager');

  IF active_users IS NULL THEN RETURN 0; END IF;
  num_active := ARRAY_LENGTH(active_users, 1);
  IF num_active IS NULL OR num_active = 0 THEN RETURN 0; END IF;

  -- Initial load per user = current case-count
  FOR i IN 1..num_active LOOP
    user_load := user_load || (
      SELECT COUNT(*)::INTEGER
      FROM public.patients
      WHERE assigned_to = active_users[i] AND do_not_call = false
    );
  END LOOP;

  -- Assign each unassigned patient to the user with the smallest current load
  FOR patient_record IN
    SELECT id FROM public.patients
    WHERE assigned_to IS NULL
      AND do_not_call = false
      AND is_active   = true
    ORDER BY created_at ASC
  LOOP
    min_idx := 1;
    FOR i IN 2..num_active LOOP
      IF user_load[i] < user_load[min_idx] THEN
        min_idx := i;
      END IF;
    END LOOP;

    UPDATE public.patients
    SET assigned_to = active_users[min_idx]
    WHERE id = patient_record.id;

    user_load[min_idx] := user_load[min_idx] + 1;
    distributed        := distributed + 1;
  END LOOP;

  RETURN distributed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- 10. BACKFILL — map legacy assigned_caller_name (text) → assigned_to (uuid)
-- ============================================================
-- For data imported before assigned_to existed: try to match free-text names
-- to existing profiles by case-insensitive full_name. Unmatched rows stay NULL
-- and will be picked up by the next distribute_new_patients() run.
DO $$
DECLARE
  pat            RECORD;
  matching_user  UUID;
BEGIN
  FOR pat IN
    SELECT id, assigned_caller_name
    FROM public.patients
    WHERE assigned_to IS NULL AND assigned_caller_name IS NOT NULL
  LOOP
    SELECT id INTO matching_user
    FROM public.profiles
    WHERE LOWER(full_name) = LOWER(TRIM(pat.assigned_caller_name))
      AND is_active = true
    LIMIT 1;

    IF matching_user IS NOT NULL THEN
      UPDATE public.patients SET assigned_to = matching_user WHERE id = pat.id;
    END IF;
  END LOOP;
END $$;


-- ============================================================
-- 11. RPC — set a user's manager (admin-only via function check)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_user_manager(p_user_id UUID, p_manager_id UUID)
RETURNS VOID AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can set team hierarchy';
  END IF;
  IF p_user_id = p_manager_id THEN
    RAISE EXCEPTION 'A user cannot be their own manager';
  END IF;
  -- Cycle check: walking up from p_manager_id must not reach p_user_id
  IF p_manager_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.subordinates_of(p_user_id) WHERE profile_id = p_manager_id
  ) THEN
    RAISE EXCEPTION 'Cycle detected: % is already a subordinate of %', p_manager_id, p_user_id;
  END IF;
  UPDATE public.profiles SET manager_id = p_manager_id, updated_at = now() WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- Done. Next: run scripts/create_test_users.js to seed test accounts.
-- ============================================================
