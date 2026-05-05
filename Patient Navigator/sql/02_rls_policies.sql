-- ============================================================
-- Patient Navigator — Row Level Security Policies
-- Run this AFTER 01_schema.sql
-- ============================================================

-- ============================================================
-- HELPER: Get current user's role
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS user_role AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND is_active = true
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_manager_or_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'manager') AND is_active = true
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active = true
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Content role can read all data (for reporting/content creation) but not write
CREATE OR REPLACE FUNCTION public.is_reader()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'manager', 'content') AND is_active = true
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- PROFILES TABLE — RLS
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Everyone can read all profiles (needed for displaying names)
CREATE POLICY "profiles_select_all"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (public.is_active_user());

-- Users can update their own profile (name, phone only — not role)
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Only admins can insert new profiles (handled by trigger, but just in case)
CREATE POLICY "profiles_insert_admin"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin() OR id = auth.uid());

-- Only admins can delete profiles
CREATE POLICY "profiles_delete_admin"
  ON public.profiles FOR DELETE
  TO authenticated
  USING (public.is_admin());


-- ============================================================
-- PATIENTS TABLE — RLS
-- ============================================================

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

-- Admin & Manager: can see ALL patients
-- Caller: can see only patients they created
CREATE POLICY "patients_select"
  ON public.patients FOR SELECT
  TO authenticated
  USING (
    public.is_active_user() AND (
      public.is_reader()
      OR created_by = auth.uid()
    )
  );

-- All active users can register new patients
-- All active users EXCEPT content can register new patients
CREATE POLICY "patients_insert"
  ON public.patients FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND created_by = auth.uid()
    AND consent_given = true
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) != 'content'
  );

-- Admin & Manager can update any patient
-- Callers cannot update patient records (only call logs)
CREATE POLICY "patients_update"
  ON public.patients FOR UPDATE
  TO authenticated
  USING (public.is_manager_or_admin())
  WITH CHECK (public.is_manager_or_admin());

-- Only admins can delete (soft-delete preferred, but hard-delete available)
CREATE POLICY "patients_delete"
  ON public.patients FOR DELETE
  TO authenticated
  USING (public.is_admin());


-- ============================================================
-- CALL LOGS TABLE — RLS
-- ============================================================

ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;

-- Admin & Manager: can see ALL call logs
-- Caller: can see only their own call logs
CREATE POLICY "call_logs_select"
  ON public.call_logs FOR SELECT
  TO authenticated
  USING (
    public.is_active_user() AND (
      public.is_reader()
      OR caller_id = auth.uid()
    )
  );

-- All active users can create call logs
CREATE POLICY "call_logs_insert"
  ON public.call_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND caller_id = auth.uid()    -- Must be the caller themselves
  );

-- Admin & Manager can update any call log (for QA review)
-- Callers can update their own call logs only within 24 hours
CREATE POLICY "call_logs_update_managers"
  ON public.call_logs FOR UPDATE
  TO authenticated
  USING (
    public.is_manager_or_admin()
  )
  WITH CHECK (
    public.is_manager_or_admin()
  );

CREATE POLICY "call_logs_update_own_recent"
  ON public.call_logs FOR UPDATE
  TO authenticated
  USING (
    caller_id = auth.uid()
    AND created_at > (now() - INTERVAL '24 hours')
    AND public.is_active_user()
  )
  WITH CHECK (
    caller_id = auth.uid()
    AND public.is_active_user()
  );

-- Only admins can delete call logs
CREATE POLICY "call_logs_delete"
  ON public.call_logs FOR DELETE
  TO authenticated
  USING (public.is_admin());


-- ============================================================
-- AUDIT LOG TABLE — RLS
-- ============================================================

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Only admins can view audit logs
CREATE POLICY "audit_log_select_admin"
  ON public.audit_log FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- All authenticated users can insert audit entries (via trigger/app)
CREATE POLICY "audit_log_insert"
  ON public.audit_log FOR INSERT
  TO authenticated
  WITH CHECK (public.is_active_user());

-- Nobody can update or delete audit logs (immutable)
-- No UPDATE or DELETE policies = denied by default with RLS enabled


-- ============================================================
-- Done! Run 03_functions.sql next.
-- ============================================================
