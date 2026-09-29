// ============================================================
// Patient Navigator: Lead Upload (structured)
// Intake teams gather phone numbers, often with the hospital they were
// gathered at, and sometimes more (name, city, cancer type, caregiver…).
// Two ways to add them:
//   • Paste a list: one row per line; an optional header row maps columns.
//   • Add one:      a structured form for a single lead with full detail.
// Both insert unassigned new_leads via bulk_add_leads(); the manager's
// auto-distribute then allots them to callers.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getUserRole } from '../auth.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { showModal, closeModal } from '../components/modal.js';
import { loadCallContext } from '../components/callContext.js';
import { openDocumentViewer, describeDocuments, fmtDayTime, daysAgo } from '../components/docViewer.js';
import { uploadStatusLabel } from '../utils/docClasses.js';

const ALLOWED = ['admin', 'manager', 'content', 'ground_poc', 'uploader'];
const DEFAULT_HOSPITALS = [
  { id: 'default-tmh-mumbai', name: 'Tata Memorial Hospital', city: 'Mumbai', state: 'Maharashtra' },
];

// header synonyms → canonical field the RPC understands
const FIELD_SYNONYMS = {
  phone:          ['phone', 'number', 'mobile', 'contact', 'phonenumber', 'contactnumber', 'mobilenumber', 'ph', 'phoneno', 'cell'],
  name:           ['name', 'patient', 'patientname', 'fullname'],
  hospital:       ['hospital', 'treatinghospital', 'centre', 'center', 'hospitalname'],
  city:           ['city', 'location', 'place', 'area', 'town', 'district'],
  state:          ['state'],
  cancer_type:    ['cancer', 'cancertype', 'diagnosis', 'type', 'disease', 'typeofcancer'],
  caregiver_name: ['caregiver', 'caregivername', 'attendant', 'relative', 'caretaker', 'guardian', 'caregiver1', 'caregivername1'],
  caregiver_phone:['caregiverphone', 'caregivernumber', 'attendantnumber', 'caregivercontact', 'guardianphone', 'caregiverphone1', 'caregiver1phone'],
  caregiver_name_2:  ['caregiver2', 'caregivername2', 'secondcaregiver', 'caregivertwo'],
  caregiver_phone_2: ['caregiverphone2', 'caregiver2phone', 'secondcaregiverphone', 'secondnumber', 'altphone', 'alternatephone', 'alternatenumber', 'phone2', 'number2', 'caregivernumber2'],
  age:            ['age'],
  gender:         ['gender', 'sex'],
  notes:          ['notes', 'remark', 'remarks', 'comment', 'comments', 'additional', 'note'],
};
function canonField(h) {
  const k = String(h).toLowerCase().replace(/[^a-z]/g, '');
  for (const [field, syns] of Object.entries(FIELD_SYNONYMS))
    if (syns.includes(k)) return field;
  return null;
}
function splitDelim(line) {
  if (line.includes('\t')) return parseDelimitedLine(line, '\t');
  if (line.includes('|')) return parseDelimitedLine(line, '|');
  if (line.includes(';')) return parseDelimitedLine(line, ';');
  if (line.includes(',')) return parseDelimitedLine(line, ',');
  return [line];
}
function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  const s = String(line || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (quoted && s[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length > 10) d = d.slice(-10);
  return d.length === 10 ? d : null;
}
function phoneCandidates(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return [];
  if (digits.length === 10) return [digits];
  if (digits.length === 11 && digits.startsWith('0')) return [digits.slice(1)];
  if (digits.length === 12 && digits.startsWith('91')) return [digits.slice(2)];

  let normalized = digits;
  if (normalized.length % 10 === 2 && normalized.startsWith('91')) normalized = normalized.slice(2);
  if (normalized.length % 10 === 1 && normalized.startsWith('0')) normalized = normalized.slice(1);
  if (normalized.length % 10 === 0) {
    const chunks = [];
    for (let i = 0; i < normalized.length; i += 10) chunks.push(normalized.slice(i, i + 10));
    return chunks.filter(p => p.length === 10);
  }
  return [normalized.slice(-10)];
}
function extractLoosePhones(text) {
  const chunks = String(text || '')
    .split(/[\r\n,;\t|]+/)
    .flatMap(part => part.split(/\s{2,}/))
    .map(part => part.trim())
    .filter(Boolean);
  const entries = [];
  const phoneish = /\+?\d[\d\s().-]{7,}\d/g;
  for (const chunk of (chunks.length ? chunks : [String(text || '')])) {
    const matches = [...chunk.matchAll(phoneish)];
    if (!matches.length) {
      const fallback = normPhone(chunk);
      if (fallback) entries.push({ phone: fallback, raw: chunk, chunk });
      continue;
    }
    for (const match of matches) {
      for (const phone of phoneCandidates(match[0])) entries.push({ phone, raw: match[0], chunk });
    }
  }
  return entries;
}
function hospitalLabel(h) {
  return [h?.name, h?.city].filter(Boolean).join(', ');
}
function normalizeHospital(row, fallbackId = '') {
  return {
    id: row?.id || fallbackId,
    name: String(row?.name || '').trim(),
    city: String(row?.city || '').trim(),
    state: String(row?.state || '').trim(),
  };
}

// Parse a pasted block → { rows, invalid, dup, cols, hasHeader }
function parseList(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], invalid: 0, dup: 0, cols: [], hasHeader: false };
  const firstCells = splitDelim(lines[0]).map(c => c.trim());
  const headerMap = firstCells.map(canonField);
  const hasHeader = headerMap.includes('phone') && firstCells.some(c => /[a-z]/i.test(c) && !/\d{7}/.test(c));
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const mapping = hasHeader ? headerMap : null;
  const rows = [], seen = new Set();
  let invalid = 0, dup = 0;
  for (const line of dataLines) {
    const obj = {};
    if (mapping) {
      const cells = splitDelim(line);
      mapping.forEach((field, i) => { if (field && cells[i] != null) { const v = cells[i].trim(); if (v) obj[field] = v; } });
    } else {
      const found = extractLoosePhones(line);
      if (!found.length) { invalid++; continue; }
      for (const entry of found) {
        const phone = normPhone(entry.phone);
        if (!phone) { invalid++; continue; }
        if (seen.has(phone)) { dup++; continue; }
        seen.add(phone);
        const row = { phone };
        if (found.length === 1) {
          const nm = line.replace(entry.raw, ' ').replace(/[",;|\t]+/g, ' ').replace(/\s+/g, ' ').trim();
          if (nm && /[a-z]/i.test(nm)) row.name = nm;
        }
        rows.push(row);
      }
      continue;
    }
    const phone = normPhone(obj.phone);
    if (!phone) { invalid++; continue; }
    if (seen.has(phone)) { dup++; continue; }
    seen.add(phone); obj.phone = phone; rows.push(obj);
  }
  const cols = hasHeader ? [...new Set(headerMap.filter(Boolean))] : ['phone'];
  return { rows, invalid, dup, cols, hasHeader };
}

async function checkPhoneRPC(sb, phone) {
  try {
    const { data, error } = await sb.rpc('check_phone', { p_phone: phone });
    if (error) throw error;
    return data || { found: false };
  } catch { return { found: false, unchecked: true }; }
}

function phoneStatusHTML(st) {
  if (st.unchecked) return '';
  if (!st.found) return `<div class="due-meta" style="color:var(--ok)">New patient: this number is not on file yet.</div>`;
  const last = st.last_call_at ? new Date(st.last_call_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : 'never called';
  const lastMsg = st.last_message_at ? new Date(st.last_message_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : null;
  return `<div class="card" style="background:rgba(199,134,47,.08);border-color:rgba(199,134,47,.3);margin-top:8px;padding:10px 12px">
    <div style="font-weight:700">Already registered: ${sanitize(st.full_name || '')} · ${sanitize(st.patient_code || '')}</div>
    <div style="font-size:13px;color:var(--color-text-muted)">${st.total_calls || 0} calls (${st.connected_calls || 0} connected) · last call: ${last} · ${st.messages_sent || 0} WhatsApp messages sent${lastMsg ? ' · last: ' + lastMsg : ''}${st.assigned_mentor ? ' · with ' + sanitize(st.assigned_mentor) : ''}${st.is_blacklisted ? ' · BLOCKED' : ''}</div>
    ${st.patient_id ? `<a href="#patients/${st.patient_id}" style="font-size:13px;color:var(--primary);font-weight:600">Open their record →</a>` : ''}
  </div>`;
}

async function submitRows(sb, rows, resultEl, after) {
  // Per-phone status BEFORE the insert, so "already exists" is answered with
  // the actual record (name, code, calls, last contact) instead of a bare
  // count. Checked first, then the insert runs.
  let pre = [];
  try { pre = await Promise.all(rows.slice(0, 20).map(r => checkPhoneRPC(sb, r.phone))); }
  catch { pre = []; }
  try {
    const { data, error } = await sb.rpc('bulk_add_leads', { p_rows: rows });
    if (error) throw error;
    const r = data || {};
    const added = r.added || 0, linked = r.linked || 0, enriched = r.enriched || 0;
    // "0 leads added" used to be the whole headline even when the entry had
    // genuinely done something, which is what made a second visit look like
    // a no-op. Count everything that landed.
    const done = added + linked + enriched;
    const head = added
      ? `${added} lead${added === 1 ? '' : 's'} added${linked ? ` · ${linked} linked` : ''}${enriched ? ` · ${enriched} updated` : ''}`
      : done
        ? `${done} record${done === 1 ? '' : 's'} updated`
        : 'Nothing new to save';
    const dupeRows = rows.map((row, i) => ({ row, st: pre[i] })).filter(x => x.st && x.st.found);
    resultEl.innerHTML = `
      <div class="card" style="background:rgba(12,110,116,.06);border-color:rgba(12,110,116,.2)">
        <div style="font-weight:700;color:var(--primary);margin-bottom:4px">${icon('checkCircle')} ${head}</div>
        <div style="font-size:13px;color:var(--color-text-muted)">
          ${linked ? `${linked} row${linked === 1 ? ' was' : 's were'} the same family. Their extra numbers are now linked to the existing patient. ` : ''}
          ${enriched ? `${enriched} ${enriched === 1 ? 'number was' : 'numbers were'} already on the list, and the new details you added (name, hospital, city) have been filled in. ` : ''}
          ${r.duplicates ? `${r.duplicates} already had everything you entered, so nothing changed for ${r.duplicates === 1 ? 'it' : 'them'}. Open the record below to see the calls and messages already on file. ` : ''}${r.invalid ? `${r.invalid} invalid number${r.invalid === 1 ? '' : 's'} skipped (not 10 digits). ` : ''}
          ${!done && !r.duplicates && !r.invalid ? 'The server reported no change. If you just saw an error before this, that first attempt already saved it: check the record below rather than uploading again. ' : ''}
          New leads wait for the manager's auto-distribute. <a href="#intake" style="color:var(--primary);font-weight:600">See everything you've uploaded →</a>
        </div>
        ${dupeRows.length ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
          ${dupeRows.slice(0, 10).map(x => phoneStatusHTML(x.st)).join('')}
          ${dupeRows.length > 10 ? `<div class="due-meta">+ ${dupeRows.length - 10} more already on file.</div>` : ''}
        </div>` : ''}
      </div>`;
    showToast(done ? head : 'Nothing new to save', done ? 'success' : 'info');
    if (after) after();
  } catch (err) {
    // Say whether it landed. A failed insert saves nothing, so retrying is
    // safe; a "duplicate" AFTER an error means the first attempt actually
    // saved and the retry is the no-op. That distinction is the whole fix.
    resultEl.innerHTML = `
      <div class="card" style="background:rgba(190,70,59,.06);border-color:rgba(190,70,59,.3)">
        <div style="font-weight:700;color:var(--danger);margin-bottom:4px">Could not add these leads: ${sanitize(err.message)}</div>
        <div style="font-size:13px;color:var(--color-text-muted)">Nothing was saved from this attempt, so it is safe to fix and retry. If retrying says "already exists", the earlier attempt actually landed: open the record to confirm rather than uploading a third time.</div>
      </div>`;
    showToast('Could not add leads: ' + err.message, 'error');
  }
}

export async function renderUpload(container) {
  const role = getUserRole();
  if (!ALLOWED.includes(role)) {
    container.innerHTML = '<div class="empty-state"><h3>Not available</h3><p>Lead upload is for admins, managers and intake staff.</p></div>';
    return;
  }
  const sb = getSupabase();
  const canManageHospitals = ['admin', 'manager'].includes(role);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Upload leads &amp; documents</h1>
        <p class="header-subtitle" style="margin:0">Add the numbers you've gathered. A hospital + phone is enough; include more columns if you have them. The manager allots them to caregiver mentors from the auto-distribute. Photograph the family's hospital papers while they are with you: <strong>Add one</strong> takes them with the patient, and <strong>Upload documents</strong> adds them to anyone you added before.</p>
      </div>
    </div>

    <div class="stats-grid" style="margin-bottom:var(--s4)">
      <div class="card stat-card"><div class="flex justify-between items-center">
        <div><div class="stat-value" id="lead-waiting">…</div><div class="stat-label">Unassigned leads waiting</div></div>
        <div class="stat-icon">${icon('inbox')}</div></div></div>
      <div class="card stat-card"><div class="flex justify-between items-center">
        <div><div class="stat-value" id="lead-ready">0</div><div class="stat-label">Ready in this paste</div></div>
        <div class="stat-icon" style="background:rgba(12,110,116,.08);color:var(--primary)">${icon('check')}</div></div></div>
      <a class="card stat-card" href="#intake" style="text-decoration:none"><div class="flex justify-between items-center">
        <div><div class="stat-value" id="lead-mine">…</div><div class="stat-label">Uploaded by you: view &amp; download</div></div>
        <div class="stat-icon" style="background:rgba(46,125,85,.1);color:#2E7D55">${icon('fileText')}</div></div></a>
    </div>

    <div class="card" style="max-width:760px;margin-bottom:var(--s4)">
      <div class="field" style="margin-bottom:0">
        <label>Hospital / intake source</label>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <select class="select" id="lead-hospital-select" style="flex:1;min-width:240px"></select>
          ${canManageHospitals ? `<button type="button" class="btn btn-secondary" id="lead-hospital-add">${icon('plus')}Add hospital</button>` : ''}
        </div>
        <span class="form-hint" id="lead-hospital-hint" style="margin-top:6px;display:block">
          This fills hospital, city and state for rows that do not already include those columns.
        </span>
      </div>
    </div>

    <div class="login-tabs" id="upload-tabs" style="max-width:760px;margin-bottom:var(--s4)">
      <button class="tab active" data-mode="paste">Paste a list</button>
      <button class="tab" data-mode="single">Add one (detailed)</button>
      <button class="tab" data-mode="docs">${icon('fileText')}Upload documents</button>
    </div>

    <div class="card" id="mode-paste" style="max-width:760px">
      <div class="field" style="margin-bottom:var(--s3)">
        <label>Numbers</label>
        <textarea class="textarea" id="lead-input" rows="11" spellcheck="false"
          placeholder="Phone, Name, Hospital, City, Cancer type&#10;9876543210, Asha Verma, Tata Memorial, Mumbai, Gall bladder&#10;9876543211, , AIIMS, Delhi, Colon&#10;&#10;Or paste plain numbers:&#10;9876543212, 9876543213&#10;9876543214"></textarea>
        <span class="form-hint" id="lead-preview" style="margin-top:6px;display:block">Paste rows. I'll tally them as you type.</span>
      </div>
      <details style="margin-bottom:var(--s3)">
        <summary style="cursor:pointer;font-size:13px;color:var(--color-text-muted)">Which columns can I include?</summary>
        <div style="font-size:13px;color:var(--color-text-muted);margin-top:6px;line-height:1.6">
          CSV, TSV, comma, semicolon, pipe, or newline-separated numbers are fine. An optional <strong>header row</strong> lets me read your columns:
          <code>Phone</code> (required), <code>Name</code>, <code>Hospital</code>, <code>City</code>, <code>State</code>,
          <code>Cancer type</code>, <code>Caregiver</code>, <code>Caregiver phone</code>, <code>Caregiver 2</code>, <code>Caregiver phone 2</code>, <code>Age</code>, <code>Gender</code>, <code>Notes</code>.
          If a number already belongs to a patient, the row's other numbers get <strong>linked to that same patient</strong> instead of creating a duplicate.
          No header? Paste numbers however you have them; I will extract one lead per 10-digit number.
        </div>
      </details>
      <div id="lead-preview-table" style="margin-bottom:var(--s3)"></div>
      <div class="form-actions" style="justify-content:flex-start;gap:10px">
        <button type="button" class="btn btn-primary" id="lead-submit" disabled>${icon('upload')}Add leads</button>
        <button type="button" class="btn btn-secondary" id="lead-clear">Clear</button>
      </div>
    </div>

    <form class="card" id="mode-single" style="max-width:760px;display:none">
      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:180px"><label>Phone <span class="req">*</span></label><input class="input" id="s-phone" inputmode="tel" placeholder="9876543210" /></div>
        <div class="field" style="flex:1;min-width:180px"><label>Patient name</label><input class="input" id="s-name" placeholder="Optional" /></div>
      </div>
      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:140px"><label>City override</label><input class="input" id="s-city" /></div>
        <div class="field" style="flex:1;min-width:120px"><label>State override</label><input class="input" id="s-state" /></div>
        <div class="field" style="flex:2;min-width:180px"><label>Cancer type</label><input class="input" id="s-cancer" placeholder="e.g., Gall bladder, Colon…" /></div>
      </div>
      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="field" style="width:90px"><label>Age</label><input class="input" id="s-age" type="number" min="0" max="120" /></div>
        <div class="field" style="width:150px"><label>Gender</label>
          <select class="select" id="s-gender"><option value="">N/A</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></div>
      </div>
      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:180px"><label>Caregiver 1 name</label><input class="input" id="s-cgname" /></div>
        <div class="field" style="flex:1;min-width:180px"><label>Caregiver 1 phone</label><input class="input" id="s-cgphone" inputmode="tel" /></div>
      </div>
      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:180px"><label>Caregiver 2 name</label><input class="input" id="s-cgname2" /></div>
        <div class="field" style="flex:1;min-width:180px"><label>Caregiver 2 phone</label><input class="input" id="s-cgphone2" inputmode="tel" /></div>
      </div>
      <span class="form-hint" style="display:block;margin:-6px 0 12px">All numbers stay linked to the same patient. Mentors call the patient first, then caregiver 1, then caregiver 2.</span>
      <div class="field"><label>Notes</label><textarea class="textarea" id="s-notes" rows="4" maxlength="10000" placeholder="Anything else worth noting (up to 10000 characters)"></textarea>
        <span class="form-hint" id="s-notes-count"></span></div>
      <!-- Asked for 26 and 28 Sep 2026 (Aadrika, for the ground team): upload
           the family's medical documents at the same moment the patient is
           entered, from this page. The files wait here and go up through the
           normal reader (consent first) as soon as the patient exists. -->
      <div class="field">
        <label>Medical documents <span style="font-weight:500;color:var(--ink-3)">(optional)</span></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="btn btn-secondary btn-sm" for="s-docs" style="cursor:pointer">${icon('upload')}Choose photos or PDFs</label>
          <input type="file" id="s-docs" accept="image/*,application/pdf" multiple style="display:none" />
          <label class="btn btn-ghost btn-sm" for="s-camera" style="cursor:pointer">${icon('plus')}Take a photo</label>
          <input type="file" id="s-camera" accept="image/*" capture="environment" style="display:none" />
          <button type="button" class="btn btn-ghost btn-sm" id="s-docs-clear" style="display:none">Clear</button>
        </div>
        <span class="form-hint" id="s-docs-list" style="display:block;margin-top:6px">Photograph the hospital papers now, while the family is with you. Take a photo once per page. They are attached to this patient and read as soon as you add them, after the family agrees.</span>
      </div>
      <div id="s-phone-status"></div>
      <div class="form-actions" style="justify-content:flex-start"><button type="submit" class="btn btn-primary" id="s-submit">${icon('plus')}Add this lead</button></div>
    </form>

    <div class="card" id="mode-docs" style="max-width:760px;display:none">
      <div class="field" style="margin-bottom:var(--s3)">
        <label>Upload documents for a patient you added</label>
        <input class="input" id="d-search" type="search" placeholder="Search by name, phone or PAT code" autocomplete="off" />
        <span class="form-hint" style="display:block;margin-top:6px">Everyone you have added is listed, newest first, with the documents already on file. Upload opens your camera or files; the family has to agree once before anything is read.</span>
      </div>
      <div id="d-list" class="wrap-meta"><div class="sk skeleton-row"></div><div class="sk skeleton-row"></div></div>
      <div style="margin-top:var(--s5)">
        <div class="info-label" style="margin-bottom:8px">Your recent uploads</div>
        <div id="d-mine" class="wrap-meta"><div class="sk skeleton-row"></div></div>
      </div>
    </div>

    <div id="lead-result" style="max-width:760px;margin-top:var(--s4)"></div>
  `;

  const $ = (s) => container.querySelector(s);
  const input = $('#lead-input'), preview = $('#lead-preview'), submit = $('#lead-submit');
  const resultEl = $('#lead-result');
  let parsed = { rows: [], invalid: 0, dup: 0, cols: [], hasHeader: false };
  let hospitals = DEFAULT_HOSPITALS.map((h, i) => normalizeHospital(h, `default-${i}`));

  function selectedHospital() {
    const select = $('#lead-hospital-select');
    return hospitals.find(h => h.id === select?.value) || hospitals[0] || null;
  }

  function applyHospitalDefaults(rows) {
    const h = selectedHospital();
    if (!h?.name) return rows;
    return rows.map(row => ({
      ...row,
      hospital: String(row.hospital || '').trim() || h.name,
      city: String(row.city || '').trim() || h.city,
      state: String(row.state || '').trim() || h.state,
    }));
  }

  function updateSingleLocationHints() {
    const h = selectedHospital();
    const hint = $('#lead-hospital-hint');
    if (hint) {
      hint.textContent = h?.name
        ? `Default for new rows: ${hospitalLabel(h)}${h.state ? ', ' + h.state : ''}. CSV/TSV hospital columns can override it.`
        : 'This fills hospital, city and state for rows that do not already include those columns.';
    }
    const city = $('#s-city'), state = $('#s-state');
    if (city) city.placeholder = h?.city ? `Default: ${h.city}` : 'Optional override';
    if (state) state.placeholder = h?.state ? `Default: ${h.state}` : 'Optional override';
  }

  function renderHospitalOptions(preferredId = '') {
    const select = $('#lead-hospital-select');
    if (!select) return;
    const current = preferredId || select.value || hospitals[0]?.id || '';
    select.innerHTML = '';
    hospitals.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = hospitalLabel(h) || h.name;
      select.appendChild(opt);
    });
    if (hospitals.some(h => h.id === current)) select.value = current;
    else if (hospitals[0]) select.value = hospitals[0].id;
    updateSingleLocationHints();
  }

  async function loadHospitals(preferredId = '') {
    try {
      const { data, error } = await sb
        .from('intake_hospitals')
        .select('id,name,city,state')
        .eq('is_active', true)
        .order('name', { ascending: true })
        .order('city', { ascending: true });
      if (error) throw error;
      const loaded = (data || []).map((h, i) => normalizeHospital(h, `hospital-${i}`)).filter(h => h.name);
      hospitals = loaded.length ? loaded : DEFAULT_HOSPITALS.map((h, i) => normalizeHospital(h, `default-${i}`));
    } catch (err) {
      console.warn('[upload] hospital options unavailable; using local default', err);
      hospitals = DEFAULT_HOSPITALS.map((h, i) => normalizeHospital(h, `default-${i}`));
    }
    renderHospitalOptions(preferredId);
    recompute();
  }

  function showAddHospitalModal() {
    const el = document.createElement('form');
    el.innerHTML = `
      <div class="field"><label>Hospital name <span class="req">*</span></label><input class="input" id="ih-name" required placeholder="e.g., Tata Memorial Hospital" /></div>
      <div class="row" style="display:flex;gap:16px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:160px"><label>City</label><input class="input" id="ih-city" placeholder="Mumbai" /></div>
        <div class="field" style="flex:1;min-width:160px"><label>State</label><input class="input" id="ih-state" placeholder="Maharashtra" /></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" id="ih-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary" id="ih-save">${icon('plus')}Add hospital</button>
      </div>
    `;
    showModal({ title: 'Add hospital option', content: el, size: 'lg' });
    el.querySelector('#ih-cancel').addEventListener('click', () => closeModal());
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = el.querySelector('#ih-name').value.trim();
      const city = el.querySelector('#ih-city').value.trim();
      const state = el.querySelector('#ih-state').value.trim();
      if (!name) { showToast('Hospital name is required', 'warning'); return; }
      const btn = el.querySelector('#ih-save');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:17px;height:17px;border-width:2.5px"></span>Saving…';
      try {
        const { data, error } = await sb.rpc('upsert_intake_hospital', {
          p_name: name,
          p_city: city || null,
          p_state: state || null,
        });
        if (error) throw error;
        closeModal();
        showToast('Hospital option added', 'success');
        await loadHospitals(data?.id || '');
      } catch (err) {
        showToast('Could not add hospital: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = `${icon('plus')}Add hospital`;
      }
    });
  }

  renderHospitalOptions();
  loadHospitals();
  $('#lead-hospital-select').addEventListener('change', () => {
    updateSingleLocationHints();
    recompute();
  });
  $('#lead-hospital-add')?.addEventListener('click', showAddHospitalModal);

  async function refreshWaiting() {
    try {
      const { count } = await sb.from('patients').select('*', { count: 'exact', head: true })
        .eq('patient_status', 'new_lead').is('assigned_to', null).eq('is_active', true);
      if ($('#lead-waiting')) $('#lead-waiting').textContent = count ?? '…';
    } catch { /* RLS-scoped; non-critical */ }
    try {
      const { getCurrentUser } = await import('../auth.js');
      const uid = getCurrentUser()?.id;
      if (uid) {
        const { count } = await sb.from('patients').select('*', { count: 'exact', head: true }).eq('created_by', uid);
        if ($('#lead-mine')) $('#lead-mine').textContent = count ?? '…';
      }
    } catch { /* non-critical */ }
  }
  refreshWaiting();

  // tab switching
  const showMode = (mode) => {
    container.querySelectorAll('#upload-tabs .tab').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
    $('#mode-single').style.display = mode === 'single' ? '' : 'none';
    $('#mode-paste').style.display = mode === 'paste' ? '' : 'none';
    $('#mode-docs').style.display = mode === 'docs' ? '' : 'none';
    if (mode === 'docs') loadDocsTab();
  };
  container.querySelectorAll('#upload-tabs .tab').forEach(t => t.addEventListener('click', () => showMode(t.dataset.mode)));

  // ---- Documents, for patients this person added -------------------------
  // The ground team meets the family at the hospital, papers in hand. Until
  // 29 Sep the only way to upload them was to find the patient's record and
  // open its Documents tab, which is not a screen the ground team works in.
  const myId = async () => (await import('../auth.js')).getCurrentUser()?.id;
  const cleanQ = (q) => String(q || '').replace(/[,()*%\\]/g, ' ').trim().slice(0, 60);

  async function loadDocsTab() {
    const list = $('#d-list');
    const q = cleanQ($('#d-search')?.value);
    try {
      const uid = await myId();
      let query = sb.from('patients')
        .select('id, full_name, patient_code, phone_full, created_at')
        .eq('created_by', uid).eq('is_active', true)
        .order('created_at', { ascending: false }).limit(60);
      if (q) query = query.or(`full_name.ilike.*${q}*,patient_code.ilike.*${q}*,phone_full.ilike.*${q}*`);
      const { data, error } = await query;
      if (error) throw error;
      const people = data || [];
      if (!people.length) {
        list.innerHTML = `<div class="due-meta" style="padding:8px 2px">${q ? 'Nobody you added matches that.' : 'You have not added anyone yet. Add a patient first, then their documents go here.'}</div>`;
      } else {
        let ctx = new Map();
        try { ctx = await loadCallContext(people.map(p => p.id)); } catch (e) { console.warn('[upload] document summary unavailable:', e.message); }
        list.innerHTML = `<div class="due-list" style="padding:0">${people.map(p => {
          const d = ctx.get(p.id)?.documents;
          const name = p.full_name || p.patient_code || 'Patient';
          return `<div class="due-row" style="flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div class="due-name">${sanitize(name)} <span class="due-meta">${sanitize(p.patient_code || '')}</span></div>
              <div class="due-meta">Added ${sanitize(daysAgo(p.created_at))} · ${sanitize(d ? describeDocuments(d) : 'documents not checked')}</div>
            </div>
            <div class="row-actions">
              ${d && d.uploads ? `<button type="button" class="btn btn-ghost btn-sm" data-d-view="${p.id}" data-name="${sanitize(name)}">${icon('fileText')}View</button>` : ''}
              <button type="button" class="btn btn-primary btn-sm" data-d-up="${p.id}">${icon('upload')}Upload</button>
            </div>
          </div>`;
        }).join('')}</div>`;
        list.querySelectorAll('[data-d-up]').forEach(b => b.addEventListener('click', async () => {
          const { openDocumentBatch } = await import('./docBatch.js');
          await openDocumentBatch(b.dataset.dUp);
        }));
        list.querySelectorAll('[data-d-view]').forEach(b => b.addEventListener('click', () =>
          openDocumentViewer({ patientId: b.dataset.dView, patientName: b.dataset.name || '' })));
      }
    } catch (e) {
      list.innerHTML = `<div class="due-meta" style="color:var(--danger)">Could not load the patients you added: ${sanitize(e.message)}</div>`;
    }
    loadMyUploads();
  }

  async function loadMyUploads() {
    const mine = $('#d-mine');
    try {
      // Own uploads only, even for a manager on this page: the full log lives
      // on Document uploads. The RPC already limits everyone else to their own.
      const uid = await myId();
      const { data, error } = await sb.rpc('get_document_upload_log', { p_uploader: uid, p_limit: 15 });
      if (error) throw error;
      const rows = data || [];
      mine.innerHTML = rows.length ? `<div class="due-list" style="padding:0">${rows.map(r => `
        <div class="due-row">
          <div style="flex:1;min-width:0">
            <div class="due-name">${sanitize(r.patient_name || r.patient_code || 'Patient')} <span class="due-meta">${sanitize(r.patient_code || '')}</span></div>
            <div class="due-meta">${sanitize(fmtDayTime(r.uploaded_at))} · ${r.page_count || 0} page${r.page_count === 1 ? '' : 's'} · ${sanitize(uploadStatusLabel(r.status))}</div>
          </div>
          <div class="row-actions">${(r.page_count || 0) > 0 && r.status !== 'discarded' ? `<button type="button" class="btn btn-ghost btn-sm" data-u-view="${r.batch_id}" data-pid="${r.patient_id}" data-name="${sanitize(r.patient_name || '')}">${icon('eye')}View</button>` : ''}</div>
        </div>`).join('')}</div>` : '<div class="due-meta">Nothing uploaded by you yet.</div>';
      mine.querySelectorAll('[data-u-view]').forEach(b => b.addEventListener('click', () =>
        openDocumentViewer({ patientId: b.dataset.pid, patientName: b.dataset.name || '', batchId: b.dataset.uView })));
    } catch (e) {
      mine.innerHTML = `<div class="due-meta">Your uploads could not be listed: ${sanitize(e.message)}</div>`;
    }
  }

  let searchTimer = null;
  $('#d-search')?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadDocsTab, 350); });

  // ---- Documents picked on the Add one form --------------------------------
  let pickedDocs = [];
  const renderPicked = () => {
    const hint = $('#s-docs-list');
    const clear = $('#s-docs-clear');
    if (!pickedDocs.length) {
      hint.innerHTML = 'Photograph the hospital papers now, while the family is with you. Take a photo once per page. They are attached to this patient and read as soon as you add them, after the family agrees.';
      clear.style.display = 'none';
      return;
    }
    const names = pickedDocs.slice(0, 4).map(f => sanitize(f.name || 'photo')).join(', ');
    hint.innerHTML = `<strong>${pickedDocs.length} file${pickedDocs.length === 1 ? '' : 's'} ready:</strong> ${names}${pickedDocs.length > 4 ? ` and ${pickedDocs.length - 4} more` : ''}. They go up the moment you add this patient.`;
    clear.style.display = '';
  };
  ['#s-docs', '#s-camera'].forEach(sel => $(sel)?.addEventListener('change', (e) => {
    pickedDocs = pickedDocs.concat([...(e.target.files || [])]);
    e.target.value = '';           // the same page can be photographed again
    renderPicked();
  }));
  $('#s-docs-clear')?.addEventListener('click', () => { pickedDocs = []; renderPicked(); });

  // After a single add: find the patient the number now belongs to, then
  // either send the files already picked or offer the upload right there.
  // A number that belonged to a family someone else registered is not ours to
  // attach papers to, and get_call_context (can_care_for_patient) says so.
  async function afterSingleAdd(phone) {
    const st = await checkPhoneRPC(sb, phone);
    const box = document.createElement('div');
    box.className = 'card wrap-meta';
    box.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap';
    resultEl.appendChild(box);
    if (!st.found || !st.patient_id) {
      box.innerHTML = `<div class="due-meta">${pickedDocs.length ? 'The patient was saved, but I could not find them again to attach the documents. Open the Upload documents tab and upload them there.' : ''}</div>`;
      if (!pickedDocs.length) box.remove();
      return;
    }
    let mine = false;
    try { mine = (await loadCallContext([st.patient_id])).has(st.patient_id); } catch {}
    const name = st.full_name || st.patient_code || 'this patient';
    if (!mine) {
      box.innerHTML = `<div class="due-meta">${sanitize(name)} was registered by someone else, so their documents go through the mentor who looks after them. Ask them, or a manager, to upload these.</div>`;
      return;
    }
    if (pickedDocs.length) {
      const files = pickedDocs;
      pickedDocs = []; renderPicked();
      box.innerHTML = `<div class="due-meta">Uploading ${files.length} file${files.length === 1 ? '' : 's'} for ${sanitize(name)}…</div>`;
      const { uploadDocumentsFor } = await import('./docBatch.js');
      const sent = await uploadDocumentsFor(st.patient_id, files, { consentMethod: 'in_person' });
      box.innerHTML = sent
        ? `<span class="stat-ico ok" style="width:30px;height:30px;border-radius:8px">${icon('checkCircle')}</span><div style="flex:1" class="due-meta">Documents sent for ${sanitize(name)}. They are being read now and show on their record.</div>`
        : `<div style="flex:1" class="due-meta">The documents for ${sanitize(name)} were not uploaded. You can try again:</div><button type="button" class="btn btn-primary btn-sm" data-retry>${icon('upload')}Upload documents</button>`;
    } else {
      box.innerHTML = `<div style="flex:1" class="due-meta">Have ${sanitize(name)}'s hospital papers with you? Add them now.</div><button type="button" class="btn btn-primary btn-sm" data-retry>${icon('upload')}Upload their documents</button>`;
    }
    box.querySelector('[data-retry]')?.addEventListener('click', async () => {
      const { openDocumentBatch } = await import('./docBatch.js');
      await openDocumentBatch(st.patient_id);
    });
  }

  function recompute() {
    const base = parseList(input.value);
    parsed = { ...base, rows: applyHospitalDefaults(base.rows) };
    $('#lead-ready').textContent = parsed.rows.length;
    const bits = [`<strong>${parsed.rows.length}</strong> ready`];
    if (parsed.hasHeader) bits.push(`columns: ${parsed.cols.join(', ')}`);
    if (parsed.dup) bits.push(`${parsed.dup} repeated`);
    if (parsed.invalid) bits.push(`${parsed.invalid} not a 10-digit number`);
    preview.innerHTML = (parsed.rows.length || parsed.invalid || parsed.dup) ? bits.join(' · ') : 'Paste rows. I\'ll tally them as you type.';
    submit.disabled = parsed.rows.length === 0;
    // mini preview table
    const show = ['name', 'hospital', 'city', 'cancer_type'].filter(f => parsed.rows.some(r => r[f]));
    const t = $('#lead-preview-table');
    if (parsed.rows.length && (parsed.hasHeader || show.length)) {
      t.innerHTML = `<div class="table-container"><table class="data-table" style="font-size:12px">
        <thead><tr><th>Phone</th>${show.map(f => `<th>${f.replace('_', ' ')}</th>`).join('')}</tr></thead>
        <tbody>${parsed.rows.slice(0, 5).map(r => `<tr><td>${r.phone}</td>${show.map(f => `<td>${sanitize(r[f] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>${parsed.rows.length > 5 ? `<div style="font-size:12px;color:var(--color-text-muted);padding:6px 2px">…and ${parsed.rows.length - 5} more</div>` : ''}</div>`;
    } else t.innerHTML = '';
  }
  input.addEventListener('input', recompute);
  $('#lead-clear').addEventListener('click', () => { input.value = ''; recompute(); resultEl.innerHTML = ''; });

  submit.addEventListener('click', async () => {
    if (!parsed.rows.length) return;
    submit.disabled = true; submit.innerHTML = '<span class="spinner" style="width:17px;height:17px;border-width:2.5px"></span>Adding…';
    await submitRows(sb, parsed.rows, resultEl, () => { input.value = ''; recompute(); refreshWaiting(); });
    submit.innerHTML = `${icon('upload')}Add leads`; submit.disabled = parsed.rows.length === 0;
  });

  // single detailed add
  // Live phone check: typing the number answers "already registered or new"
  // BEFORE the insert, with the record behind it. Same check bulk submit
  // runs, just earlier.
  let phoneTimer = null;
  $('#s-phone')?.addEventListener('input', () => {
    clearTimeout(phoneTimer);
    const mount = $('#s-phone-status');
    phoneTimer = setTimeout(async () => {
      const raw = $('#s-phone').value;
      const digits = String(raw || '').replace(/\D/g, '').slice(-10);
      if (digits.length !== 10) { if (mount) mount.innerHTML = ''; return; }
      if (mount) mount.innerHTML = '<div class="due-meta">Checking…</div>';
      const st = await checkPhoneRPC(sb, digits);
      if (mount) mount.innerHTML = phoneStatusHTML(st);
    }, 450);
  });
  $('#s-notes')?.addEventListener('input', () => {
    const c = $('#s-notes-count');
    if (c) c.textContent = `${($('#s-notes').value || '').length} / 10000 characters`;
  });
  $('#mode-single').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = normPhone($('#s-phone').value);
    if (!phone) { showToast('Enter a valid 10-digit phone number', 'warning'); return; }
    const h = selectedHospital();
    const row = {
      phone, name: $('#s-name').value.trim(), hospital: h?.name || '',
      city: $('#s-city').value.trim() || h?.city || '', state: $('#s-state').value.trim() || h?.state || '', cancer_type: $('#s-cancer').value.trim(),
      age: $('#s-age').value.trim(), gender: $('#s-gender').value, caregiver_name: $('#s-cgname').value.trim(),
      caregiver_phone: $('#s-cgphone').value.trim(), caregiver_name_2: $('#s-cgname2').value.trim(),
      caregiver_phone_2: $('#s-cgphone2').value.trim(), notes: $('#s-notes').value.trim(),
    };
    const btn = $('#s-submit'); btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:17px;height:17px;border-width:2.5px"></span>Adding…';
    let added = false;
    await submitRows(sb, [row], resultEl, () => {
      added = true; $('#mode-single').reset(); refreshWaiting();
      // The number check runs 450 ms after the last keystroke. A quick Add
      // let it land AFTER the insert and call the patient just added
      // "Already registered", right above "1 lead added".
      clearTimeout(phoneTimer);
      const st = $('#s-phone-status'); if (st) st.innerHTML = '';
    });
    btn.disabled = false; btn.innerHTML = `${icon('plus')}Add this lead`;
    if (added) await afterSingleAdd(phone);
  });
}
