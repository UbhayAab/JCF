-- ============================================================
-- Patient Navigator — Seed Data
-- Run this LAST, after all other SQL files
-- NOTE: Users must be created via Supabase Auth Dashboard
-- This seeds sample patients and call logs for testing
-- ============================================================

-- You'll need to replace these UUIDs with actual user IDs
-- after creating users in Supabase Auth Dashboard.
-- For now these are placeholders.

-- After creating 3 test users in Auth Dashboard:
-- 1. admin@carcinome.org (password: Admin@2026!)
-- 2. manager@carcinome.org (password: Manager@2026!)
-- 3. caller@carcinome.org (password: Caller@2026!)

-- Then update their roles in profiles:
-- UPDATE public.profiles SET role = 'admin', full_name = 'Dr. Priya Sharma' WHERE id = '<admin-uuid>';
-- UPDATE public.profiles SET role = 'manager', full_name = 'Rahul Verma' WHERE id = '<manager-uuid>';
-- UPDATE public.profiles SET role = 'caller', full_name = 'Anita Desai' WHERE id = '<caller-uuid>';

-- ============================================================
-- SAMPLE PATIENTS (use after setting up users)
-- Replace '<caller-uuid>' with actual caller user ID
-- ============================================================

/*
INSERT INTO public.patients (full_name, age, gender, state, city, cancer_type, cancer_stage, diagnosis_date, treating_hospital, insurance_status, economic_status, consent_given, consent_date, consent_method, created_by)
VALUES
  ('Rajesh Kumar', 54, 'male', 'Maharashtra', 'Mumbai', 'Lung Cancer', 'stage_iii', '2025-11-15', 'Tata Memorial Hospital', 'insured', 'middle', true, now(), 'verbal_during_call', '<caller-uuid>'),
  ('Sunita Devi', 47, 'female', 'Delhi', 'New Delhi', 'Breast Cancer', 'stage_ii', '2026-01-20', 'AIIMS Delhi', 'govt_scheme', 'lower_middle', true, now(), 'verbal_during_call', '<caller-uuid>'),
  ('Mohan Lal', 62, 'male', 'Uttar Pradesh', 'Lucknow', 'Prostate Cancer', 'stage_i', '2026-02-10', 'KGMU Lucknow', 'uninsured', 'bpl', true, now(), 'verbal_during_call', '<caller-uuid>'),
  ('Priya Patel', 38, 'female', 'Gujarat', 'Ahmedabad', 'Ovarian Cancer', 'stage_ii', '2025-12-05', 'Gujarat Cancer Research Institute', 'insured', 'upper_middle', true, now(), 'digital', '<caller-uuid>'),
  ('Arun Nair', 55, 'male', 'Kerala', 'Kochi', 'Colorectal Cancer', 'stage_iii', '2026-03-01', 'Regional Cancer Centre Trivandrum', 'govt_scheme', 'lower_middle', true, now(), 'verbal_during_call', '<caller-uuid>'),
  ('Kamla Singh', 68, 'female', 'Rajasthan', 'Jaipur', 'Cervical Cancer', 'stage_iv', '2025-09-20', 'SMS Hospital Jaipur', 'uninsured', 'bpl', true, now(), 'guardian_consent', '<caller-uuid>'),
  ('Vikram Reddy', 45, 'male', 'Telangana', 'Hyderabad', 'Head and Neck Cancer', 'stage_ii', '2026-01-10', 'MNJ Cancer Hospital', 'insured', 'middle', true, now(), 'verbal_during_call', '<caller-uuid>'),
  ('Lakshmi Iyer', 52, 'female', 'Tamil Nadu', 'Chennai', 'Thyroid Cancer', 'stage_i', '2026-04-01', 'Cancer Institute Adyar', 'insured', 'upper_middle', true, now(), 'digital', '<caller-uuid>'),
  ('Deepak Sharma', 60, 'male', 'Madhya Pradesh', 'Bhopal', 'Stomach Cancer', 'unknown', '2026-02-28', 'BMHRC Bhopal', 'govt_scheme', 'bpl', true, now(), 'verbal_during_call', '<caller-uuid>'),
  ('Fatima Begum', 41, 'female', 'West Bengal', 'Kolkata', 'Leukemia', 'not_applicable', '2025-10-15', 'Chittaranjan National Cancer Institute', 'uninsured', 'lower_middle', true, now(), 'verbal_during_call', '<caller-uuid>');
*/

-- ============================================================
-- INSTRUCTIONS:
-- 1. Create users in Supabase Dashboard → Authentication → Users
-- 2. Copy their UUIDs
-- 3. Update profiles with correct roles (UPDATE statements above)
-- 4. Uncomment and run the INSERT above with correct UUIDs
-- ============================================================
