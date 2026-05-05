-- ============================================================
-- Patient Navigator — Database Schema
-- Carcinome NGO | DPDPA-Compliant Patient Data Management
-- ============================================================
-- Run this FIRST in Supabase SQL Editor (Settings → SQL Editor)
-- ============================================================

-- ============================================================
-- 1. CUSTOM ENUM TYPES
-- ============================================================

CREATE TYPE user_role AS ENUM (
  'admin',
  'manager',
  'caller',
  'caregiver_mentor',
  'therapist',
  'nutritionist',
  'content'
);

CREATE TYPE gender_type AS ENUM ('male', 'female', 'other', 'prefer_not_to_say');

CREATE TYPE dial_status_type AS ENUM (
  'connected',
  'no_answer',
  'busy',
  'wrong_number',
  'callback_requested',
  'voicemail'
);

CREATE TYPE patient_mindset_type AS ENUM (
  'hopeful',
  'anxious',
  'resistant',
  'neutral',
  'distressed',
  'informed',
  'grateful'
);

CREATE TYPE follow_up_priority_type AS ENUM ('high', 'medium', 'low');

CREATE TYPE insurance_status_type AS ENUM (
  'insured',
  'uninsured',
  'govt_scheme',
  'unknown'
);

CREATE TYPE economic_status_type AS ENUM (
  'bpl',
  'lower_middle',
  'middle',
  'upper_middle',
  'unknown'
);

CREATE TYPE cancer_stage_type AS ENUM (
  'stage_i',
  'stage_ii',
  'stage_iii',
  'stage_iv',
  'unknown',
  'not_applicable'
);

CREATE TYPE consent_method_type AS ENUM (
  'verbal_during_call',
  'written',
  'digital',
  'guardian_consent'
);

CREATE TYPE lead_source_type AS ENUM (
  'website',
  'referral',
  'hospital_partner',
  'social_media',
  'whatsapp',
  'helpline',
  'camp',
  'ngo_partner',
  'other'
);


-- ============================================================
-- 2. PROFILES TABLE (extends Supabase auth.users)
-- ============================================================

CREATE TABLE public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  role        user_role NOT NULL DEFAULT 'caller',
  phone       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for role-based queries
CREATE INDEX idx_profiles_role ON public.profiles(role);
CREATE INDEX idx_profiles_active ON public.profiles(is_active);

COMMENT ON TABLE public.profiles IS 'Extended user profiles with role-based access control';


-- ============================================================
-- 3. PATIENTS TABLE (core patient registry)
-- ============================================================

-- Sequence for generating patient codes
CREATE SEQUENCE patient_code_seq START 1;

CREATE TABLE public.patients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_code          TEXT UNIQUE NOT NULL DEFAULT ('PAT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('patient_code_seq')::text, 5, '0')),
  full_name             TEXT NOT NULL,
  age                   INTEGER CHECK (age >= 0 AND age <= 150),
  gender                gender_type NOT NULL DEFAULT 'prefer_not_to_say',
  phone_masked          TEXT,              -- Last 4 digits only, e.g., "XXXX-XX-8734"
  email                 TEXT,
  state                 TEXT,              -- Indian state of residence
  city                  TEXT,
  pin_code              TEXT CHECK (pin_code IS NULL OR length(pin_code) = 6),

  -- Medical information
  cancer_type           TEXT,
  cancer_stage          cancer_stage_type DEFAULT 'unknown',
  diagnosis_date        DATE,
  treating_hospital     TEXT,
  treating_doctor       TEXT,
  current_treatment     TEXT,              -- e.g., 'Chemotherapy', 'Radiation', 'Surgery', etc.

  -- Socioeconomic
  insurance_status      insurance_status_type DEFAULT 'unknown',
  economic_status       economic_status_type DEFAULT 'unknown',
  family_support        BOOLEAN DEFAULT true,
  caregiver_name        TEXT,
  caregiver_phone_masked TEXT,

  -- DPDPA Consent
  consent_given         BOOLEAN NOT NULL DEFAULT false,
  consent_date          TIMESTAMPTZ,
  consent_method        consent_method_type,
  consent_purpose       TEXT DEFAULT 'Patient navigation and support services by Carcinome NGO',
  data_retention_until  DATE,              -- Auto-set via trigger: consent_date + 3 years

  -- Metadata
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID REFERENCES public.profiles(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT chk_consent_date CHECK (
    (consent_given = false) OR (consent_given = true AND consent_date IS NOT NULL)
  ),
  CONSTRAINT chk_consent_method CHECK (
    (consent_given = false) OR (consent_given = true AND consent_method IS NOT NULL)
  )
);

-- Indexes for common queries
CREATE INDEX idx_patients_code ON public.patients(patient_code);
CREATE INDEX idx_patients_cancer_type ON public.patients(cancer_type);
CREATE INDEX idx_patients_state ON public.patients(state);
CREATE INDEX idx_patients_created_by ON public.patients(created_by);
CREATE INDEX idx_patients_active ON public.patients(is_active);
CREATE INDEX idx_patients_consent ON public.patients(consent_given);
CREATE INDEX idx_patients_retention ON public.patients(data_retention_until);

COMMENT ON TABLE public.patients IS 'Core patient registry with DPDPA-compliant consent tracking';


-- ============================================================
-- 4. CALL LOGS TABLE (every call interaction)
-- ============================================================

CREATE TABLE public.call_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  caller_id             UUID NOT NULL REFERENCES public.profiles(id),
  call_date             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Call details
  lead_source           lead_source_type DEFAULT 'other',
  dial_status           dial_status_type NOT NULL DEFAULT 'no_answer',
  call_duration_mins    NUMERIC(6,1) DEFAULT 0 CHECK (call_duration_mins >= 0),

  -- Patient engagement
  patient_mindset       patient_mindset_type DEFAULT 'neutral',
  value_pitch_executed  BOOLEAN DEFAULT false,
  whatsapp_group_joined BOOLEAN DEFAULT false,
  social_media_follow   BOOLEAN DEFAULT false,
  resource_shared       TEXT,              -- What resources were shared (brochure, link, etc.)

  -- Scoring & follow-up
  conversion_score      INTEGER DEFAULT 0 CHECK (conversion_score >= 0 AND conversion_score <= 10),
  follow_up_date        DATE,
  follow_up_priority    follow_up_priority_type DEFAULT 'medium',

  -- Notes
  caller_notes          TEXT,
  resistance_reason     TEXT,
  key_concerns          TEXT,              -- Patient's main concerns

  -- QA Review
  qa_reviewed           BOOLEAN DEFAULT false,
  qa_reviewer_id        UUID REFERENCES public.profiles(id),
  qa_review_date        TIMESTAMPTZ,
  qa_score              INTEGER CHECK (qa_score IS NULL OR (qa_score >= 1 AND qa_score <= 5)),
  qa_notes              TEXT,

  -- Metadata
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_call_logs_patient ON public.call_logs(patient_id);
CREATE INDEX idx_call_logs_caller ON public.call_logs(caller_id);
CREATE INDEX idx_call_logs_date ON public.call_logs(call_date DESC);
CREATE INDEX idx_call_logs_follow_up ON public.call_logs(follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX idx_call_logs_qa ON public.call_logs(qa_reviewed) WHERE qa_reviewed = false;
CREATE INDEX idx_call_logs_status ON public.call_logs(dial_status);

COMMENT ON TABLE public.call_logs IS 'Call interaction logs with QA review workflow';


-- ============================================================
-- 5. AUDIT LOG TABLE (DPDPA compliance trail)
-- ============================================================

CREATE TABLE public.audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES public.profiles(id),
  action      TEXT NOT NULL,                -- INSERT, UPDATE, DELETE, EXPORT, LOGIN
  table_name  TEXT NOT NULL,
  record_id   TEXT,                          -- The affected record's ID
  old_values  JSONB,
  new_values  JSONB,
  metadata    JSONB DEFAULT '{}',           -- Extra context (IP, user-agent, etc.)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_audit_log_user ON public.audit_log(user_id);
CREATE INDEX idx_audit_log_table ON public.audit_log(table_name);
CREATE INDEX idx_audit_log_action ON public.audit_log(action);
CREATE INDEX idx_audit_log_date ON public.audit_log(created_at DESC);
CREATE INDEX idx_audit_log_record ON public.audit_log(record_id);

COMMENT ON TABLE public.audit_log IS 'Immutable audit trail for DPDPA compliance';


-- ============================================================
-- 6. AUTO-UPDATE updated_at TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- ============================================================
-- 7. AUTO-SET data_retention_until TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_data_retention()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.consent_given = true AND NEW.consent_date IS NOT NULL THEN
    NEW.data_retention_until = (NEW.consent_date + INTERVAL '3 years')::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER set_data_retention
  BEFORE INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.handle_data_retention();


-- ============================================================
-- 8. AUTO-CREATE PROFILE ON AUTH SIGNUP
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'caller'  -- Default role; admin must upgrade
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- Done! Run 02_rls_policies.sql next.
-- ============================================================
