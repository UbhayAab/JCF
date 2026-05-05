-- ============================================================
-- Patient Navigator — Test Data Seed
-- 50 patients + 200+ call logs with edge cases
-- Run AFTER all other migrations
-- ============================================================

-- Helper: We need the admin user's ID for created_by
-- (Assumes admin@carcinome.org exists from setup)

DO $$
DECLARE
  admin_id UUID;
  p_id UUID;
  pid_arr UUID[];
  i INT;
  rand_status dial_status_type;
  rand_mindset patient_mindset_type;
  rand_source lead_source_type;
  rand_priority follow_up_priority_type;
  statuses dial_status_type[] := ARRAY['connected','no_answer','busy','callback_requested','wrong_number','voicemail'];
  mindsets patient_mindset_type[] := ARRAY['hopeful','anxious','resistant','neutral','distressed','informed','grateful'];
  sources lead_source_type[] := ARRAY['website','referral','hospital_partner','social_media','whatsapp','helpline','camp','ngo_partner','other'];
  priorities follow_up_priority_type[] := ARRAY['high','medium','low'];
  cancer_types TEXT[] := ARRAY['Breast Cancer','Lung Cancer','Blood Cancer','Oral Cancer','Cervical Cancer','Colorectal Cancer','Liver Cancer','Prostate Cancer','Brain Cancer','Kidney Cancer','Thyroid Cancer','Pancreatic Cancer','Stomach Cancer','Ovarian Cancer','Bladder Cancer'];
  stages cancer_stage_type[] := ARRAY['stage_i','stage_ii','stage_iii','stage_iv','unknown'];
  genders gender_type[] := ARRAY['male','female','other','prefer_not_to_say'];
  states TEXT[] := ARRAY['Maharashtra','Delhi','Karnataka','Tamil Nadu','West Bengal','Gujarat','Rajasthan','Uttar Pradesh','Kerala','Madhya Pradesh','Punjab','Haryana','Bihar','Odisha','Telangana'];
  cities TEXT[] := ARRAY['Mumbai','Delhi','Bangalore','Chennai','Kolkata','Ahmedabad','Jaipur','Lucknow','Kochi','Bhopal','Pune','Hyderabad','Chandigarh','Patna','Bhubaneswar'];
  first_names TEXT[] := ARRAY['Aarav','Vivaan','Aditya','Vihaan','Arjun','Reyansh','Mohammad','Sai','Arnav','Dhruv','Kabir','Ritvik','Ananya','Diya','Aanya','Myra','Sara','Aadhya','Isha','Priya','Kavya','Riya','Neha','Pooja','Meera','Raj','Sunil','Rakesh','Amit','Deepa','Lakshmi','Sunita','Geeta','Ramesh','Vijay','Nisha','Rohit','Sahil','Tanvi','Kunal','Divya','Sneha','Manish','Akash','Bhavna','Chitra','Devika','Esha','Farhan','Gauri'];
  last_names TEXT[] := ARRAY['Sharma','Patel','Kumar','Singh','Reddy','Nair','Gupta','Mehta','Joshi','Desai','Shah','Verma','Rao','Das','Iyer','Pillai','Mishra','Jain','Agarwal','Chauhan','Banerjee','Mukherjee','Ghosh','Bose','Malhotra'];
  rand_name TEXT;
  rand_age INT;
  rand_dur NUMERIC;
  rand_date TIMESTAMPTZ;
BEGIN
  -- Get admin user
  SELECT id INTO admin_id FROM profiles WHERE role = 'admin' LIMIT 1;
  IF admin_id IS NULL THEN
    RAISE NOTICE 'No admin user found, using NULL for created_by';
  END IF;

  -- ========================================
  -- INSERT 50 PATIENTS
  -- ========================================
  FOR i IN 1..50 LOOP
    rand_name := first_names[1 + floor(random() * array_length(first_names,1))] || ' ' || last_names[1 + floor(random() * array_length(last_names,1))];
    rand_age := CASE
      WHEN i = 1 THEN 0        -- Edge case: infant
      WHEN i = 2 THEN 120      -- Edge case: very old
      WHEN i = 3 THEN 18       -- Edge case: young adult
      ELSE 25 + floor(random() * 55)::INT
    END;

    INSERT INTO patients (
      full_name, age, gender, state, city,
      cancer_type, cancer_stage,
      diagnosis_date, treating_hospital, current_treatment,
      insurance_status, economic_status, family_support,
      consent_given, consent_date, consent_method,
      created_by, is_active
    ) VALUES (
      rand_name,
      rand_age,
      genders[1 + floor(random() * array_length(genders,1))],
      states[1 + floor(random() * array_length(states,1))],
      cities[1 + floor(random() * array_length(cities,1))],
      cancer_types[1 + floor(random() * array_length(cancer_types,1))],
      stages[1 + floor(random() * array_length(stages,1))],
      CURRENT_DATE - (floor(random() * 365) || ' days')::interval,
      CASE floor(random()*5)::INT
        WHEN 0 THEN 'Tata Memorial Hospital'
        WHEN 1 THEN 'AIIMS Delhi'
        WHEN 2 THEN 'Rajiv Gandhi Cancer Institute'
        WHEN 3 THEN 'Kidwai Memorial Institute'
        ELSE 'Apollo Hospital'
      END,
      CASE floor(random()*4)::INT
        WHEN 0 THEN 'Chemotherapy'
        WHEN 1 THEN 'Radiation'
        WHEN 2 THEN 'Surgery'
        ELSE 'Immunotherapy'
      END,
      (ARRAY['insured','uninsured','govt_scheme','unknown']::insurance_status_type[])[1 + floor(random()*4)],
      (ARRAY['bpl','lower_middle','middle','upper_middle','unknown']::economic_status_type[])[1 + floor(random()*5)],
      random() > 0.2,
      true,
      now() - (floor(random() * 90) || ' days')::interval,
      (ARRAY['verbal_during_call','written','digital','guardian_consent']::consent_method_type[])[1 + floor(random()*4)],
      admin_id,
      CASE WHEN i > 48 THEN false ELSE true END  -- 2 inactive patients
    ) RETURNING id INTO p_id;

    pid_arr := array_append(pid_arr, p_id);
  END LOOP;

  -- ========================================
  -- INSERT 200+ CALL LOGS
  -- ========================================
  FOR i IN 1..220 LOOP
    p_id := pid_arr[1 + floor(random() * array_length(pid_arr,1))];
    rand_status := statuses[1 + floor(random() * array_length(statuses,1))];
    rand_mindset := mindsets[1 + floor(random() * array_length(mindsets,1))];
    rand_source := sources[1 + floor(random() * array_length(sources,1))];
    rand_priority := priorities[1 + floor(random() * array_length(priorities,1))];
    rand_dur := CASE
      WHEN rand_status = 'connected' THEN 2 + floor(random() * 25)
      WHEN i = 1 THEN 0  -- Edge case: 0 duration
      ELSE floor(random() * 3)
    END;
    rand_date := now() - (floor(random() * 90) || ' days')::interval - (floor(random() * 12) || ' hours')::interval;

    INSERT INTO call_logs (
      patient_id, caller_id, call_date,
      lead_source, dial_status, call_duration_mins,
      patient_mindset, value_pitch_executed, whatsapp_group_joined, social_media_follow,
      follow_up_date, follow_up_priority,
      caller_notes, resistance_reason
    ) VALUES (
      p_id,
      admin_id,
      rand_date,
      rand_source,
      rand_status,
      rand_dur,
      CASE WHEN rand_status = 'connected' THEN rand_mindset ELSE 'neutral' END,
      random() > 0.4 AND rand_status = 'connected',
      random() > 0.7 AND rand_status = 'connected',
      random() > 0.8 AND rand_status = 'connected',
      CASE
        WHEN random() > 0.5 AND rand_status IN ('connected','callback_requested')
        THEN (CURRENT_DATE + (floor(random() * 14) || ' days')::interval)::date
        WHEN i <= 5 THEN (CURRENT_DATE - (floor(random() * 5) || ' days')::interval)::date  -- Overdue follow-ups
        ELSE NULL
      END,
      rand_priority,
      CASE
        WHEN rand_status = 'connected' THEN
          (ARRAY[
            'Patient was receptive to information about support groups.',
            'Discussed treatment options and financial assistance.',
            'Patient expressed interest in WhatsApp group for peer support.',
            'Provided information about nutrition counseling services.',
            'Patient is undergoing chemotherapy, needs emotional support.',
            'Discussed DPDPA consent and data handling procedures.',
            'Patient asked about therapy sessions availability.',
            'Referred to caregiver mentor program for family support.',
            'Patient shared positive feedback about NGO services.',
            'Discussed side effects management and quality of life.'
          ])[1 + floor(random()*10)]
        WHEN i = 10 THEN repeat('This is a very long note for edge case testing. ', 25)  -- Edge case: very long note
        ELSE NULL
      END,
      CASE WHEN rand_mindset IN ('resistant','distressed') AND rand_status = 'connected' THEN
        (ARRAY[
          'Patient is skeptical about NGO intentions.',
          'Financial concerns preventing treatment adherence.',
          'Family not supportive of treatment decisions.',
          'Patient prefers alternative medicine over conventional treatment.',
          'Language barrier making communication difficult.'
        ])[1 + floor(random()*5)]
      ELSE NULL END
    );
  END LOOP;

  RAISE NOTICE 'Seeded % patients and 220 call logs', array_length(pid_arr,1);
END $$;
