-- ============================================================
-- Patient Navigator — Audit Trail Triggers
-- Run AFTER 03_functions.sql
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_trigger_func()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_log(user_id, action, table_name, record_id, new_values)
    VALUES (auth.uid(), 'INSERT', TG_TABLE_NAME, NEW.id::text, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.audit_log(user_id, action, table_name, record_id, old_values, new_values)
    VALUES (auth.uid(), 'UPDATE', TG_TABLE_NAME, NEW.id::text, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.audit_log(user_id, action, table_name, record_id, old_values)
    VALUES (auth.uid(), 'DELETE', TG_TABLE_NAME, OLD.id::text, to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach to patients table
CREATE TRIGGER audit_patients
  AFTER INSERT OR UPDATE OR DELETE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();

-- Attach to call_logs table
CREATE TRIGGER audit_call_logs
  AFTER INSERT OR UPDATE OR DELETE ON public.call_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();

-- Attach to profiles table
CREATE TRIGGER audit_profiles
  AFTER INSERT OR UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_func();

-- Done! Run 04_seed.sql next.
