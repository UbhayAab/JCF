-- ============================================================
-- Patient Navigator — Team Account Creation RPCs
-- Run AFTER sql/11_team_hierarchy_and_lifecycle.sql
-- ============================================================
-- Adds:
--   1. onboard_team_member() — admin or manager sets role + manager_id for a new user
--   2. get_team_tree() — returns the full team hierarchy for the current user
-- ============================================================

-- 1. RPC: Onboard a newly-created user (set role + manager_id)
-- Admin can set any role and any manager.
-- Manager can set only subordinate roles (not admin/manager) and is forced as the manager.
CREATE OR REPLACE FUNCTION public.onboard_team_member(
  p_user_id    UUID,
  p_role       user_role,
  p_manager_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  caller_role user_role;
  caller_id   UUID;
BEGIN
  caller_id   := auth.uid();
  caller_role := public.get_user_role();

  IF caller_role IS NULL OR caller_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'Only admins and managers can onboard team members';
  END IF;

  IF p_user_id = caller_id THEN
    RAISE EXCEPTION 'Cannot modify your own account';
  END IF;

  -- Manager restrictions
  IF caller_role = 'manager' THEN
    IF p_role IN ('admin', 'manager') THEN
      RAISE EXCEPTION 'Managers can only create subordinate roles (caller, caregiver_mentor, therapist, nutritionist, content)';
    END IF;
    -- Force manager_id to be the current manager
    UPDATE public.profiles
    SET role = p_role, manager_id = caller_id, updated_at = now()
    WHERE id = p_user_id;
  ELSE
    -- Admin: full control
    UPDATE public.profiles
    SET role = p_role, manager_id = COALESCE(p_manager_id, manager_id), updated_at = now()
    WHERE id = p_user_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 2. RPC: Get the team tree visible to the current user
-- Admin sees everything. Manager sees themselves + all subordinates.
-- Others see themselves + their subordinates.
CREATE OR REPLACE FUNCTION public.get_team_tree()
RETURNS TABLE(
  id          UUID,
  full_name   TEXT,
  role        user_role,
  manager_id  UUID,
  is_active   BOOLEAN,
  created_at  TIMESTAMPTZ,
  depth       INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.full_name,
    p.role,
    p.manager_id,
    p.is_active,
    p.created_at,
    0::INTEGER AS depth
  FROM public.profiles p
  WHERE public.is_admin()
     OR p.id = auth.uid()
     OR p.id IN (SELECT profile_id FROM public.subordinates_of(auth.uid()))
  ORDER BY p.role, p.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;


-- 3. RPC: Get available managers (for admin dropdown)
-- Admin can assign any active manager/admin as a manager.
CREATE OR REPLACE FUNCTION public.get_available_managers()
RETURNS TABLE(
  id          UUID,
  full_name   TEXT,
  role        user_role
) AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, p.full_name, p.role
  FROM public.profiles p
  WHERE p.is_active = true
    AND p.role IN ('admin', 'manager')
  ORDER BY p.role, p.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
