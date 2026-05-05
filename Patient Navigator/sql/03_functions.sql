-- ============================================================
-- Patient Navigator — Database Functions
-- Run AFTER 02_rls_policies.sql
-- ============================================================

-- 1. AUTO-CALCULATE CONVERSION SCORE
CREATE OR REPLACE FUNCTION public.calculate_conversion_score()
RETURNS TRIGGER AS $$
DECLARE score INTEGER := 0;
BEGIN
  IF NEW.dial_status = 'connected' THEN score := score + 2; END IF;
  IF NEW.call_duration_mins >= 10 THEN score := score + 2;
  ELSIF NEW.call_duration_mins >= 5 THEN score := score + 1; END IF;
  IF NEW.value_pitch_executed THEN score := score + 1; END IF;
  IF NEW.whatsapp_group_joined THEN score := score + 2; END IF;
  IF NEW.social_media_follow THEN score := score + 1; END IF;
  IF NEW.patient_mindset IN ('hopeful','informed','grateful') THEN score := score + 1; END IF;
  IF NEW.follow_up_date IS NOT NULL THEN score := score + 1; END IF;
  NEW.conversion_score := LEAST(score, 10);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER auto_conversion_score
  BEFORE INSERT OR UPDATE ON public.call_logs
  FOR EACH ROW EXECUTE FUNCTION public.calculate_conversion_score();

-- 2. DASHBOARD STATS (role-aware)
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON AS $$
DECLARE result JSON; user_role_val user_role; uid UUID := auth.uid();
BEGIN
  SELECT role INTO user_role_val FROM public.profiles WHERE id = uid;
  IF user_role_val IN ('admin','manager') THEN
    SELECT json_build_object(
      'total_patients', (SELECT count(*) FROM patients WHERE is_active),
      'total_calls_today', (SELECT count(*) FROM call_logs WHERE call_date::date = CURRENT_DATE),
      'total_calls_week', (SELECT count(*) FROM call_logs WHERE call_date >= date_trunc('week', CURRENT_DATE)),
      'connected_today', (SELECT count(*) FROM call_logs WHERE call_date::date = CURRENT_DATE AND dial_status = 'connected'),
      'avg_conversion_score', (SELECT COALESCE(round(avg(conversion_score)::numeric,1),0) FROM call_logs WHERE call_date >= date_trunc('week', CURRENT_DATE)),
      'pending_follow_ups', (SELECT count(*) FROM call_logs WHERE follow_up_date <= CURRENT_DATE AND follow_up_date IS NOT NULL),
      'pending_qa_reviews', (SELECT count(*) FROM call_logs WHERE qa_reviewed = false),
      'patients_this_month', (SELECT count(*) FROM patients WHERE created_at >= date_trunc('month', CURRENT_DATE) AND is_active),
      'consent_rate', (SELECT COALESCE(round((count(*) FILTER (WHERE consent_given))::numeric / NULLIF(count(*)::numeric,0)*100,1),0) FROM patients WHERE is_active)
    ) INTO result;
  ELSE
    SELECT json_build_object(
      'total_patients', (SELECT count(*) FROM patients WHERE created_by=uid AND is_active),
      'total_calls_today', (SELECT count(*) FROM call_logs WHERE caller_id=uid AND call_date::date=CURRENT_DATE),
      'total_calls_week', (SELECT count(*) FROM call_logs WHERE caller_id=uid AND call_date>=date_trunc('week',CURRENT_DATE)),
      'connected_today', (SELECT count(*) FROM call_logs WHERE caller_id=uid AND call_date::date=CURRENT_DATE AND dial_status='connected'),
      'avg_conversion_score', (SELECT COALESCE(round(avg(conversion_score)::numeric,1),0) FROM call_logs WHERE caller_id=uid AND call_date>=date_trunc('week',CURRENT_DATE)),
      'pending_follow_ups', (SELECT count(*) FROM call_logs WHERE caller_id=uid AND follow_up_date<=CURRENT_DATE AND follow_up_date IS NOT NULL),
      'pending_qa_reviews', 0,
      'patients_this_month', (SELECT count(*) FROM patients WHERE created_by=uid AND created_at>=date_trunc('month',CURRENT_DATE) AND is_active),
      'consent_rate', 100
    ) INTO result;
  END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 3. UPDATE USER ROLE (Admin only)
CREATE OR REPLACE FUNCTION public.update_user_role(target_user_id UUID, new_role user_role)
RETURNS BOOLEAN AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Only admins can change roles'; END IF;
  IF target_user_id = auth.uid() THEN RAISE EXCEPTION 'Cannot change own role'; END IF;
  UPDATE public.profiles SET role = new_role WHERE id = target_user_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. TOGGLE USER ACTIVE (Admin only)
CREATE OR REPLACE FUNCTION public.toggle_user_active(target_user_id UUID, active_status BOOLEAN)
RETURNS BOOLEAN AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Only admins can change status'; END IF;
  IF target_user_id = auth.uid() THEN RAISE EXCEPTION 'Cannot deactivate self'; END IF;
  UPDATE public.profiles SET is_active = active_status WHERE id = target_user_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Done! Run 04_seed.sql next.
