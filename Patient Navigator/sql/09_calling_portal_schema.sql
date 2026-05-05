-- ============================================================
-- Patient Navigator v3 — Calling Portal Schema
-- Run AFTER all previous migrations
-- ============================================================

-- 0. WIPE ALL DUMMY TEST DATA
DELETE FROM call_logs;
DELETE FROM patients;

-- Reset the patient code sequence
ALTER SEQUENCE patient_code_seq RESTART WITH 1;

-- 1. Add full phone number column to patients
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='patients' AND column_name='phone_full') THEN
    ALTER TABLE public.patients ADD COLUMN phone_full TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='patients' AND column_name='caregiver_relationship') THEN
    ALTER TABLE public.patients ADD COLUMN caregiver_relationship TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='patients' AND column_name='caregiver_phone_full') THEN
    ALTER TABLE public.patients ADD COLUMN caregiver_phone_full TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='patients' AND column_name='clinical_trial_aware') THEN
    ALTER TABLE public.patients ADD COLUMN clinical_trial_aware BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='patients' AND column_name='payment_method') THEN
    ALTER TABLE public.patients ADD COLUMN payment_method TEXT;
  END IF;
END $$;

-- Relax consent constraints for imported data where consent wasn't explicitly tracked
ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS chk_consent_date;
ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS chk_consent_method;

-- 2. Add new call log columns
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_logs' AND column_name='contacted_by_name') THEN
    ALTER TABLE public.call_logs ADD COLUMN contacted_by_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_logs' AND column_name='requirements_noted') THEN
    ALTER TABLE public.call_logs ADD COLUMN requirements_noted TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_logs' AND column_name='social_media_response') THEN
    ALTER TABLE public.call_logs ADD COLUMN social_media_response TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_logs' AND column_name='recording_url') THEN
    ALTER TABLE public.call_logs ADD COLUMN recording_url TEXT;
  END IF;
END $$;

-- 3. TEAM MEMBERS table
CREATE TABLE IF NOT EXISTS public.team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES public.profiles(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  calls_today INTEGER NOT NULL DEFAULT 0,
  calls_total INTEGER NOT NULL DEFAULT 0,
  last_assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view team members"
  ON public.team_members FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Admins can manage team members"
  ON public.team_members FOR ALL
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager'))
  );

-- 4. CALL QUEUE table
CREATE TABLE IF NOT EXISTS public.call_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES public.team_members(id),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','skipped','callback')),
  scheduled_for TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.call_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view call queue"
  ON public.call_queue FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can manage call queue"
  ON public.call_queue FOR ALL
  TO authenticated USING (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_call_queue_status ON public.call_queue(status);
CREATE INDEX IF NOT EXISTS idx_call_queue_assigned ON public.call_queue(assigned_to);
CREATE INDEX IF NOT EXISTS idx_call_queue_patient ON public.call_queue(patient_id);
CREATE INDEX IF NOT EXISTS idx_team_members_active ON public.team_members(is_active);

-- 5. CALL RECORDINGS table
CREATE TABLE IF NOT EXISTS public.call_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_log_id UUID REFERENCES public.call_logs(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name TEXT,
  duration_seconds INTEGER,
  file_size_bytes BIGINT,
  uploaded_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.call_recordings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view recordings"
  ON public.call_recordings FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can upload recordings"
  ON public.call_recordings FOR INSERT
  TO authenticated WITH CHECK (true);

-- 6. RPC: Get next call from queue (round-robin)
CREATE OR REPLACE FUNCTION public.get_next_call(p_team_member_id UUID)
RETURNS JSON AS $$
DECLARE
  queue_entry RECORD;
  patient_data RECORD;
  result JSON;
BEGIN
  -- Find the next pending call, ordered by priority then oldest first
  SELECT cq.* INTO queue_entry
  FROM call_queue cq
  WHERE cq.status = 'pending'
    AND (cq.assigned_to IS NULL OR cq.assigned_to = p_team_member_id)
    AND cq.attempts < cq.max_attempts
  ORDER BY
    CASE cq.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
    cq.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  -- If no pending, check callbacks that are due
  IF queue_entry IS NULL THEN
    SELECT cq.* INTO queue_entry
    FROM call_queue cq
    WHERE cq.status = 'callback'
      AND cq.scheduled_for <= now()
      AND cq.attempts < cq.max_attempts
    ORDER BY cq.scheduled_for ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  END IF;

  IF queue_entry IS NULL THEN
    RETURN json_build_object('found', false);
  END IF;

  -- Assign to team member
  UPDATE call_queue
  SET assigned_to = p_team_member_id,
      status = 'in_progress',
      attempts = attempts + 1,
      updated_at = now()
  WHERE id = queue_entry.id;

  -- Update team member stats
  UPDATE team_members
  SET calls_today = calls_today + 1,
      calls_total = calls_total + 1,
      last_assigned_at = now(),
      updated_at = now()
  WHERE id = p_team_member_id;

  -- Get patient data
  SELECT p.* INTO patient_data
  FROM patients p
  WHERE p.id = queue_entry.patient_id;

  -- Build result
  SELECT json_build_object(
    'found', true,
    'queue_id', queue_entry.id,
    'patient_id', patient_data.id,
    'patient_code', patient_data.patient_code,
    'full_name', patient_data.full_name,
    'age', patient_data.age,
    'gender', patient_data.gender,
    'phone_full', patient_data.phone_full,
    'state', patient_data.state,
    'city', patient_data.city,
    'cancer_type', patient_data.cancer_type,
    'cancer_stage', patient_data.cancer_stage,
    'current_treatment', patient_data.current_treatment,
    'caregiver_name', patient_data.caregiver_name,
    'caregiver_phone_full', patient_data.caregiver_phone_full,
    'caregiver_relationship', patient_data.caregiver_relationship,
    'payment_method', patient_data.payment_method,
    'attempt', queue_entry.attempts + 1,
    'priority', queue_entry.priority,
    'queue_notes', queue_entry.notes
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. RPC: Complete a call in the queue
CREATE OR REPLACE FUNCTION public.complete_queue_call(
  p_queue_id UUID,
  p_status TEXT DEFAULT 'completed'
)
RETURNS void AS $$
BEGIN
  UPDATE call_queue
  SET status = p_status,
      updated_at = now()
  WHERE id = p_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. RPC: Reset daily call counts (run via cron or manually)
CREATE OR REPLACE FUNCTION public.reset_daily_counts()
RETURNS void AS $$
BEGIN
  UPDATE team_members SET calls_today = 0, updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Storage bucket for recordings (run manually in Supabase dashboard if needed)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('call-recordings', 'call-recordings', false);

-- Done!
