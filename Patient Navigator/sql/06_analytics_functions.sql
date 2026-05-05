-- ============================================================
-- Patient Navigator — Analytics Functions
-- Server-side aggregation for dashboard charts
-- Run AFTER 05_audit_trigger.sql
-- ============================================================

-- 1. Calls timeline — daily call counts for last N days
CREATE OR REPLACE FUNCTION public.get_analytics_calls_timeline(days_back INT DEFAULT 30)
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      d::date AS date,
      COALESCE(c.total, 0) AS total_calls,
      COALESCE(c.connected, 0) AS connected_calls
    FROM generate_series(
      CURRENT_DATE - (days_back || ' days')::interval,
      CURRENT_DATE,
      '1 day'
    ) AS d
    LEFT JOIN (
      SELECT
        call_date::date AS day,
        count(*) AS total,
        count(*) FILTER (WHERE dial_status = 'connected') AS connected
      FROM call_logs
      GROUP BY call_date::date
    ) c ON c.day = d::date
    ORDER BY d::date
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 2. Cancer type distribution
CREATE OR REPLACE FUNCTION public.get_analytics_cancer_distribution()
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      COALESCE(cancer_type, 'Unknown') AS cancer_type,
      count(*) AS patient_count
    FROM patients
    WHERE is_active = true
    GROUP BY cancer_type
    ORDER BY patient_count DESC
    LIMIT 12
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 3. Patient mindset breakdown
CREATE OR REPLACE FUNCTION public.get_analytics_mindset_breakdown()
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      patient_mindset::text AS mindset,
      count(*) AS call_count
    FROM call_logs
    WHERE patient_mindset IS NOT NULL
    GROUP BY patient_mindset
    ORDER BY call_count DESC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 4. Lead source distribution
CREATE OR REPLACE FUNCTION public.get_analytics_lead_sources()
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      lead_source::text AS source,
      count(*) AS call_count
    FROM call_logs
    WHERE lead_source IS NOT NULL
    GROUP BY lead_source
    ORDER BY call_count DESC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 5. Caller performance (top callers)
CREATE OR REPLACE FUNCTION public.get_analytics_caller_performance()
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      p.full_name AS caller_name,
      count(c.id) AS total_calls,
      count(c.id) FILTER (WHERE c.dial_status = 'connected') AS connected_calls,
      COALESCE(round(avg(c.conversion_score)::numeric, 1), 0) AS avg_score,
      COALESCE(round(avg(c.call_duration_mins)::numeric, 1), 0) AS avg_duration
    FROM call_logs c
    JOIN profiles p ON p.id = c.caller_id
    GROUP BY p.id, p.full_name
    ORDER BY total_calls DESC
    LIMIT 10
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 6. Geographic distribution (top states)
CREATE OR REPLACE FUNCTION public.get_analytics_geographic()
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      COALESCE(state, 'Unknown') AS state,
      count(*) AS patient_count
    FROM patients
    WHERE is_active = true AND state IS NOT NULL AND state != ''
    GROUP BY state
    ORDER BY patient_count DESC
    LIMIT 10
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 7. Cancer stage distribution
CREATE OR REPLACE FUNCTION public.get_analytics_stage_distribution()
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      cancer_stage::text AS stage,
      count(*) AS patient_count
    FROM patients
    WHERE is_active = true
    GROUP BY cancer_stage
    ORDER BY patient_count DESC
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 8. Conversion score trend (weekly averages)
CREATE OR REPLACE FUNCTION public.get_analytics_score_trend(weeks_back INT DEFAULT 12)
RETURNS JSON AS $$
DECLARE result JSON;
BEGIN
  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      date_trunc('week', d)::date AS week_start,
      COALESCE(round(avg(c.conversion_score)::numeric, 1), 0) AS avg_score,
      COALESCE(count(c.id), 0) AS total_calls
    FROM generate_series(
      CURRENT_DATE - (weeks_back * 7 || ' days')::interval,
      CURRENT_DATE,
      '1 week'
    ) AS d
    LEFT JOIN call_logs c ON date_trunc('week', c.call_date) = date_trunc('week', d)
    GROUP BY date_trunc('week', d)
    ORDER BY week_start
  ) t;
  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Done!
