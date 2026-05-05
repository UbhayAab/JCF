// ============================================================
// Patient Navigator — CSV Import Script
// Parses the messy GI Cancer Patients CSV and imports to Supabase
// ============================================================

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// ---- CONFIG ----
const DB_URL = 'postgresql://postgres:HelloWorld%4012312@db.bcgsejdwqefcdaqxykde.supabase.co:5432/postgres';
const CSV_PATH = path.join(__dirname, '..', 'GI Cancer Patients Sheet - Form Responses 1.csv');

// ---- MAPPINGS ----

function normalizeGender(raw) {
  if (!raw) return 'prefer_not_to_say';
  const g = raw.trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'male';
  if (g === 'female' || g === 'f') return 'female';
  return 'prefer_not_to_say';
}

function normalizeStage(raw) {
  if (!raw) return 'unknown';
  const s = raw.trim().toLowerCase()
    .replace(/stage\s*/i, '')
    .replace(/th\s*/i, '')
    .replace(/st\s*/i, '')
    .replace(/nd\s*/i, '')
    .replace(/rd\s*/i, '');
  
  if (s.includes('1') || s.includes('i') && !s.includes('ii') && !s.includes('iv')) return 'stage_i';
  if (s.includes('2') || s === 'ii') return 'stage_ii';
  if (s.includes('2-3') || s.includes('2 3')) return 'stage_ii'; // lower bound
  if (s.includes('3') || s === 'iii') return 'stage_iii';
  if (s.includes('4') || s === 'iv' || s.includes('advanced') || s.includes('last') || s.includes('end')) return 'stage_iv';
  if (s.includes('curative') || s.includes('not reported') || s.includes('don') || s.includes('n/a') || s === '' || s.includes('not confirmed')) return 'unknown';
  return 'unknown';
}

function normalizeCancerType(raw) {
  if (!raw) return null;
  let t = raw.trim();
  
  // Normalize common abbreviations
  t = t.replace(/\bGB\b/gi, 'Gall Bladder');
  t = t.replace(/\bGI\b/gi, 'Gastrointestinal');
  t = t.replace(/\bNET\b/gi, 'Neuroendocrine Tumor');
  t = t.replace(/\bGIST\b/gi, 'GIST');
  
  // Handle "Gastro" alone
  if (/^gastro$/i.test(t)) t = 'Gastrointestinal';
  if (/^gastro\s*,/i.test(t)) t = t.replace(/^gastro/i, 'Gastrointestinal');
  
  // Handle "not reported" etc
  if (/not reported|not sure|yet to detect|did not wish/i.test(t)) return null;
  
  // Capitalize first letter of each word
  t = t.replace(/\b\w/g, c => c.toUpperCase());
  
  return t || null;
}

function normalizePhone(raw) {
  if (!raw) return null;
  let p = raw.trim();
  
  // Handle "same as caregiver" - will be resolved later
  if (/same\s*as\s*caregiver/i.test(p)) return '__SAME_AS_CAREGIVER__';
  
  // Handle "yes" (some rows have 'yes' as phone - invalid)
  if (/^yes$/i.test(p)) return null;
  
  // Strip annotations like "(WhatsApp but no phone call)", "(no WhatsApp)", "number is incorrect"
  p = p.replace(/\(.*?\)/g, '').replace(/number\s*is\s*(incorrect|invalid)/gi, '');
  
  // Handle multiple numbers: "900403595 / or 9021419432" or "6203665219 or/ 9556693883"
  // Take the first valid 10-digit number
  const allDigitGroups = p.match(/\d[\d\s]+/g);
  if (!allDigitGroups) return null;
  
  for (const group of allDigitGroups) {
    const digits = group.replace(/\s/g, '');
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  }
  
  // If no 10-digit number found, try the first group anyway
  const firstDigits = allDigitGroups[0].replace(/\s/g, '');
  if (firstDigits.length >= 9 && firstDigits.length <= 10) return firstDigits;
  
  return null;
}

function normalizeMindset(raw) {
  if (!raw) return null;
  const m = raw.trim().toLowerCase();
  if (m.includes('receptive') || m.includes('seeking')) return 'hopeful';
  if (m.includes('neutral') || m.includes('skeptical')) return 'neutral';
  if (m.includes('hostile') || m.includes('do not call')) return 'resistant';
  if (m.includes('overwhelmed') || m.includes('distress')) return 'distressed';
  return null;
}

function normalizeDialStatus(contacted, followUpNotes) {
  if (!contacted) {
    // Check followup notes for clues
    if (followUpNotes) {
      const fn = followUpNotes.toLowerCase();
      if (fn.includes('invalid') || fn.includes('does not exist') || fn.includes('doesn\'t exist')) return 'wrong_number';
      if (fn.includes('not reachable') || fn.includes('unreachable') || fn.includes('unable to connect') || fn.includes('switched off') || fn.includes('switch off') || fn.includes('out of coverage') || fn.includes('not picking up') || fn.includes('didn\'t received') || fn.includes('didn\'t pick') || fn.includes('incoming calls are baned')) return 'no_answer';
      if (fn.includes('traveling') || fn.includes('call later') || fn.includes('reschedule') || fn.includes('follow up') || fn.includes('tomorrow') || fn.includes('weekends') || fn.includes('call again')) return 'callback_requested';
      if (fn.includes('not interested')) return 'connected'; // They did pick up
    }
    return 'no_answer';
  }
  
  const c = contacted.trim().toLowerCase();
  if (c === 'yes' || c === 'true') return 'connected';
  if (c === 'no' || c === 'false') {
    // Check if there's a reason
    if (followUpNotes) {
      const fn = followUpNotes.toLowerCase();
      if (fn.includes('invalid') || fn.includes('does not exist')) return 'wrong_number';
      if (fn.includes('traveling') || fn.includes('call later') || fn.includes('follow up') || fn.includes('reschedule') || fn.includes('tomorrow')) return 'callback_requested';
    }
    return 'no_answer';
  }
  
  // Some entries have notes in the contacted field
  if (c.includes('wrong number') || c.includes('invalid')) return 'wrong_number';
  if (c.includes('not interested')) return 'connected';
  if (c.includes('picked') || c.includes('spoke') || c.includes('connected')) return 'connected';
  
  return 'connected'; // Default if there's any text
}

function normalizeYesNo(raw) {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === 'yes' || v === 'yee' || v === 'true' || v.startsWith('yes') || v.startsWith('interested');
}

function parseCallDuration(raw) {
  if (!raw) return null;
  const d = raw.trim().toLowerCase();
  
  // Extract minutes from formats like "4 min", "3m 55s", "3 mins, 39sec", "5 minutes", "2min", "1min, 24 sec"
  let minutes = 0;
  const minMatch = d.match(/(\d+)\s*(?:min|m\b|minute)/);
  if (minMatch) minutes = parseInt(minMatch[1]);
  
  const secMatch = d.match(/(\d+)\s*(?:sec|s\b)/);
  if (secMatch) minutes = Math.max(1, minutes); // At least 1 min if seconds exist
  
  return minutes || null;
}

function normalizeInsurance(raw) {
  if (!raw) return 'unknown';
  const v = raw.trim().toLowerCase();
  if (v.includes('ayushman') || v.includes('govt') || v.includes('government') || v.includes('tata') || v.includes('phule') || v.includes('card') || v.includes('pmyojna') || v.includes('certificate')) return 'govt_scheme';
  if (v.includes('insurance') || v.includes('insured')) return 'insured';
  if (v.includes('self') || v.includes('loan') || v.includes('property')) return 'uninsured';
  if (v.includes('ngo') || v.includes('trust') || v.includes('hospital') || v.includes('donation') || v.includes('foundation')) return 'uninsured';
  return 'unknown';
}

function normalizeLocation(raw) {
  if (!raw) return { state: null, city: null };
  let loc = raw.trim();
  
  // Skip if location field is used as notes
  const notePatterns = ['not interested', 'dialled number', 'after the call', 'mobile number', 'the patient is not'];
  for (const pat of notePatterns) {
    if (loc.toLowerCase().includes(pat)) return { state: null, city: null };
  }
  
  // Known state mappings
  const stateMap = {
    'west bengal': 'West Bengal', 'bengal': 'West Bengal', 'wb': 'West Bengal', 'kolkata': 'West Bengal',
    'bihar': 'Bihar', 'patna': 'Bihar',
    'maharashtra': 'Maharashtra', 'mumbai': 'Maharashtra', 'thane': 'Maharashtra', 'pune': 'Maharashtra',
    'navi mumbai': 'Maharashtra', 'neral': 'Maharashtra', 'dahisar': 'Maharashtra', 'malad': 'Maharashtra',
    'kandivali': 'Maharashtra', 'dharavi': 'Maharashtra', 'kurla': 'Maharashtra', 'dadar': 'Maharashtra',
    'andheri': 'Maharashtra', 'vikhroli': 'Maharashtra', 'virar': 'Maharashtra', 'diva': 'Maharashtra',
    'bhandup': 'Maharashtra', 'wadala': 'Maharashtra', 'mankhurd': 'Maharashtra', 'govandi': 'Maharashtra',
    'goregaon': 'Maharashtra', 'solapur': 'Maharashtra', 'nagpur': 'Maharashtra', 'amaravati': 'Maharashtra',
    'cst': 'Maharashtra', 'santa cruz': 'Maharashtra', 'vashi': 'Maharashtra', 'airoli': 'Maharashtra',
    'up': 'Uttar Pradesh', 'uttar pradesh': 'Uttar Pradesh', 'gorakhpur': 'Uttar Pradesh', 'rampur': 'Uttar Pradesh',
    'mp': 'Madhya Pradesh', 'madhya pradesh': 'Madhya Pradesh',
    'karnataka': 'Karnataka',
    'meghalaya': 'Meghalaya',
    'manipur': 'Manipur',
    'assam': 'Assam',
    'odisha': 'Odisha', 'orissa': 'Odisha',
    'jharkhand': 'Jharkhand', 'ranchi': 'Jharkhand',
    'jammu': 'Jammu & Kashmir', 'jammu kashmir': 'Jammu & Kashmir',
    'andhra pradesh': 'Andhra Pradesh',
    'kerala': 'Kerala', 'kochi': 'Kerala',
    'punjab': 'Punjab', 'chandigarh': 'Punjab',
    'rajasthan': 'Rajasthan', 'jaipur': 'Rajasthan',
    'telangana': 'Telangana', 'hyderabad': 'Telangana',
    'kolhapur': 'Maharashtra', 'siliguri': 'West Bengal', 'nanded': 'Maharashtra',
    'darjeeling': 'West Bengal',
  };
  
  // City extraction: take the raw value as city
  let city = loc.split(',')[0].trim();
  let state = null;
  
  // Try to match state
  const lower = loc.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  for (const [key, val] of Object.entries(stateMap)) {
    if (lower.includes(key)) {
      state = val;
      break;
    }
  }
  
  // If city matches a state key, set city to the raw value before comma
  if (city.toLowerCase() in stateMap) {
    if (!state) state = stateMap[city.toLowerCase()];
  }
  
  // Clean up city
  if (city.toLowerCase() === state?.toLowerCase()) city = null;
  if (city && city.length > 50) city = null; // Probably notes, not a city
  
  return { state, city };
}

function parseTimestamp(raw) {
  if (!raw) return null;
  const t = raw.trim();
  // Format: "3/18/2026 10:34:04" (M/D/YYYY HH:MM:SS)
  const match = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [_, month, day, year, hour, min, sec] = match;
  return new Date(year, month - 1, day, hour, min, sec).toISOString();
}

// ---- CSV PARSER (handles multiline quoted fields) ----
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (char === '\r') {
        // skip
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        rows.push(currentRow);
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }
  // Last field/row
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }
  
  return rows;
}

// ---- MAIN ----
async function main() {
  console.log('🚀 Starting CSV import...\n');
  
  // Read CSV
  const csvText = fs.readFileSync(CSV_PATH, 'utf8');
  const allRows = parseCSV(csvText);
  console.log(`📄 Parsed ${allRows.length} total rows from CSV`);
  
  // Skip header row (row 0) and filter data rows
  const dataRows = [];
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row.length < 4) continue;
    
    const col1 = (row[0] || '').trim();
    const contactedBy = (row[1] || '').trim();
    const sno = (row[2] || '').trim();
    const name = (row[3] || '').trim();
    
    // Skip header-like rows
    if (col1.startsWith('FOR') || col1.startsWith('DAY') || col1 === '' && sno === '') continue;
    if (!name) continue;
    
    // Skip if S.No is not numeric (but allow it to be empty if name exists and timestamp exists)
    const hasTimestamp = parseTimestamp(col1) !== null;
    if (!hasTimestamp && !sno) continue;
    
    dataRows.push(row);
  }
  
  console.log(`📊 Found ${dataRows.length} valid patient/call rows\n`);
  
  // Connect to DB
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('✅ Connected to Supabase\n');
  
  // Run schema migration first
  console.log('📦 Running schema migration (09_calling_portal_schema.sql)...');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'sql', '09_calling_portal_schema.sql'), 'utf8');
  await client.query(schemaSql);
  console.log('✅ Schema migration complete\n');
  
  // Get admin user ID for created_by
  const adminResult = await client.query("SELECT id FROM profiles WHERE role = 'admin' LIMIT 1");
  const adminId = adminResult.rows[0]?.id || null;
  console.log(`👤 Admin ID: ${adminId || 'NULL'}\n`);
  
  // Track unique callers for team_members
  const callerNames = new Set();
  
  // Process each row
  let patientsInserted = 0;
  let callsInserted = 0;
  let errors = 0;
  
  // Track patients by name+phone to avoid duplicates
  const patientMap = new Map(); // key: name_phone -> patient_id
  
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    try {
      const timestamp = parseTimestamp((row[0] || '').trim());
      const contactedBy = (row[1] || '').trim();
      const sno = (row[2] || '').trim();
      const name = (row[3] || '').trim();
      const age = parseInt((row[4] || '').trim()) || null;
      const gender = normalizeGender(row[5]);
      let phone = normalizePhone(row[6]);
      const location = normalizeLocation(row[7]);
      const caregiverName = (row[8] || '').trim() || null;
      const caregiverRelationship = (row[9] || '').trim() || null;
      let caregiverPhone = normalizePhone(row[10]);
      const email = (row[11] || '').trim() || null;
      const cancerType = normalizeCancerType(row[12]);
      const cancerStage = normalizeStage(row[13]);
      const treatment = (row[14] || '').trim() || null;
      const clinicalTrial = normalizeYesNo(row[15]);
      const paymentMethod = (row[16] || '').trim() || null;
      const contacted = (row[17] || '').trim();
      const followUpNotes = (row[18] || '').trim();
      const callDuration = parseCallDuration(row[19]);
      const mindset = normalizeMindset(row[20]);
      const valuePitch = normalizeYesNo(row[21]);
      const requirements = (row[22] || '').trim() || null;
      const whatsappSent = normalizeYesNo(row[23]);
      const whatsappJoined = normalizeYesNo(row[24]);
      const socialResponse = (row[25] || '').trim() || null;
      const socialFollow = normalizeYesNo(row[26]);
      
      // Resolve "same as caregiver" phone
      if (phone === '__SAME_AS_CAREGIVER__') phone = caregiverPhone;
      
      // Generate phone_masked
      const phoneMasked = phone ? 'XXXXX-X' + phone.slice(-4) : null;
      const caregiverPhoneMasked = caregiverPhone ? 'XXXXX-X' + caregiverPhone.slice(-4) : null;
      
      // Dial status
      const dialStatus = normalizeDialStatus(contacted, followUpNotes);
      
      // Insurance
      const insurance = normalizeInsurance(paymentMethod);
      
      // Track caller
      if (contactedBy) callerNames.add(contactedBy.toUpperCase());
      
      // Deduplicate patients by name
      const patientKey = name.toLowerCase().replace(/\s+/g, '');
      let patientId = patientMap.get(patientKey);
      
      if (!patientId) {
        // Insert patient
        const insertResult = await client.query(`
          INSERT INTO patients (
            full_name, age, gender, phone_full, phone_masked, email,
            state, city,
            cancer_type, cancer_stage, current_treatment,
            insurance_status, payment_method,
            caregiver_name, caregiver_relationship, caregiver_phone_full, caregiver_phone_masked,
            clinical_trial_aware, family_support,
            consent_given, consent_date, consent_method,
            created_by, is_active
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8,
            $9, $10, $11,
            $12, $13,
            $14, $15, $16, $17,
            $18, $19,
            true, now(), 'verbal_during_call',
            $20, true
          ) RETURNING id
        `, [
          name, age, gender, phone, phoneMasked, email,
          location.state, location.city,
          cancerType, cancerStage, treatment,
          insurance, paymentMethod,
          caregiverName, caregiverRelationship, caregiverPhone, caregiverPhoneMasked,
          clinicalTrial, caregiverName ? true : false,
          adminId
        ]);
        
        patientId = insertResult.rows[0].id;
        patientMap.set(patientKey, patientId);
        patientsInserted++;
      }
      
      // Insert call log
      const callDate = timestamp || new Date().toISOString();
      await client.query(`
        INSERT INTO call_logs (
          patient_id, caller_id, contacted_by_name,
          call_date, dial_status, call_duration_mins,
          patient_mindset, value_pitch_executed,
          whatsapp_group_joined, social_media_follow,
          caller_notes, requirements_noted, social_media_response,
          lead_source
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6,
          $7, $8,
          $9, $10,
          $11, $12, $13,
          'other'
        )
      `, [
        patientId, adminId, contactedBy || null,
        callDate, dialStatus, callDuration,
        mindset, valuePitch,
        whatsappJoined, socialFollow,
        followUpNotes || null, requirements, socialResponse
      ]);
      
      callsInserted++;
      
      if ((i + 1) % 50 === 0) {
        console.log(`  ... processed ${i + 1}/${dataRows.length} rows`);
      }
    } catch (err) {
      errors++;
      console.error(`  ❌ Row ${i + 1} error (${(dataRows[i][3] || '').trim()}): ${err.message}`);
    }
  }
  
  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Import complete!`);
  console.log(`   Patients inserted: ${patientsInserted}`);
  console.log(`   Call logs inserted: ${callsInserted}`);
  console.log(`   Errors: ${errors}`);
  console.log(`   Unique callers: ${callerNames.size}`);
  console.log(`   Callers: ${[...callerNames].join(', ')}`);
  
  // Insert team members
  console.log(`\n📋 Creating team members...`);
  for (const callerName of callerNames) {
    const displayName = callerName.charAt(0) + callerName.slice(1).toLowerCase();
    await client.query(`
      INSERT INTO team_members (name, is_active) VALUES ($1, true)
      ON CONFLICT DO NOTHING
    `, [displayName]);
  }
  console.log(`   ✅ ${callerNames.size} team members created`);
  
  // Verify counts
  const pc = await client.query('SELECT count(*) FROM patients');
  const cc = await client.query('SELECT count(*) FROM call_logs');
  const tc = await client.query('SELECT count(*) FROM team_members');
  console.log(`\n📊 Database counts:`);
  console.log(`   Patients: ${pc.rows[0].count}`);
  console.log(`   Call logs: ${cc.rows[0].count}`);
  console.log(`   Team members: ${tc.rows[0].count}`);
  
  await client.end();
  console.log(`\n🎉 Done!`);
}

main().catch(err => {
  console.error('\n💀 Import failed:', err.message);
  process.exit(1);
});
