-- 1. Add schema fields
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS assigned_caller_name TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS legacy_notes TEXT;

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS receptiveness_bucket TEXT CHECK (receptiveness_bucket IN ('highly_receptive', 'neutral', 'skeptical', 'agitated', 'overwhelmed'));
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS next_followup_date TIMESTAMPTZ;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS followup_strategy_notes TEXT;

ALTER TABLE public.call_queue ADD COLUMN IF NOT EXISTS receptiveness_bucket TEXT;
ALTER TABLE public.call_queue ADD COLUMN IF NOT EXISTS followup_strategy_notes TEXT;
ALTER TABLE public.call_queue ADD COLUMN IF NOT EXISTS followup_stage INTEGER DEFAULT 1;

-- 2. Migrate legacy notes and caller names from call_logs to patients
UPDATE public.patients p
SET 
  assigned_caller_name = cl.contacted_by_name,
  legacy_notes = 'CSV Import Status: ' || COALESCE(cl.dial_status::text, 'unknown') || ' | Notes: ' || COALESCE(cl.caller_notes, 'None')
FROM public.call_logs cl
WHERE p.id = cl.patient_id
  AND cl.contacted_by_name IS NOT NULL;

-- 3. Wipe call_logs (as requested by user)
DELETE FROM public.call_logs;

-- 4. Rewrite get_next_call to prioritize scheduled follow-ups
CREATE OR REPLACE FUNCTION public.get_next_call(p_team_member_id UUID)
RETURNS JSON AS $$
DECLARE
  queue_entry RECORD;
  patient_data RECORD;
  result JSON;
BEGIN
  -- FIRST PRIORITY: Check for callbacks/follow-ups that are DUE today or earlier
  SELECT cq.* INTO queue_entry
  FROM call_queue cq
  WHERE (cq.status = 'callback' OR cq.status = 'scheduled')
    AND cq.scheduled_for <= now()
    AND (cq.assigned_to IS NULL OR cq.assigned_to = p_team_member_id)
    AND cq.attempts < cq.max_attempts
  ORDER BY cq.scheduled_for ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  -- SECOND PRIORITY: If no follow-ups due, find fresh pending calls
  IF queue_entry IS NULL THEN
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
    'assigned_caller_name', patient_data.assigned_caller_name,
    'legacy_notes', patient_data.legacy_notes,
    'attempt', queue_entry.attempts + 1,
    'priority', queue_entry.priority,
    'queue_notes', queue_entry.notes,
    'followup_strategy_notes', queue_entry.followup_strategy_notes,
    'receptiveness_bucket', queue_entry.receptiveness_bucket,
    'followup_stage', queue_entry.followup_stage
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Complete call and set next state
CREATE OR REPLACE FUNCTION public.complete_queue_call(
  p_queue_id UUID,
  p_status TEXT,
  p_next_followup_date TIMESTAMPTZ DEFAULT NULL,
  p_strategy_notes TEXT DEFAULT NULL,
  p_receptiveness TEXT DEFAULT NULL
)
RETURNS void AS $$
DECLARE
  v_patient_id UUID;
  v_assigned_to UUID;
  v_priority TEXT;
  v_stage INTEGER;
BEGIN
  -- Get current queue info
  SELECT patient_id, assigned_to, priority, followup_stage 
  INTO v_patient_id, v_assigned_to, v_priority, v_stage
  FROM call_queue 
  WHERE id = p_queue_id;

  -- Mark current as completed or skipped
  UPDATE call_queue
  SET status = CASE WHEN p_status = 'scheduled' THEN 'completed' ELSE p_status END,
      updated_at = now()
  WHERE id = p_queue_id;

  -- If a follow-up is scheduled, create a NEW queue entry for the future date
  IF p_next_followup_date IS NOT NULL THEN
    INSERT INTO call_queue (
      patient_id, assigned_to, priority, status, 
      scheduled_for, notes, followup_strategy_notes, 
      receptiveness_bucket, followup_stage
    ) VALUES (
      v_patient_id, v_assigned_to, v_priority, 'scheduled',
      p_next_followup_date, NULL, p_strategy_notes,
      p_receptiveness, COALESCE(v_stage, 1) + 1
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
