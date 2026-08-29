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

async function submitRows(sb, rows, resultEl, after) {
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
    resultEl.innerHTML = `
      <div class="card" style="background:rgba(12,110,116,.06);border-color:rgba(12,110,116,.2)">
        <div style="font-weight:700;color:var(--primary);margin-bottom:4px">${icon('checkCircle')} ${head}</div>
        <div style="font-size:13px;color:var(--color-text-muted)">
          ${linked ? `${linked} row${linked === 1 ? ' was' : 's were'} the same family. Their extra numbers are now linked to the existing patient. ` : ''}
          ${enriched ? `${enriched} ${enriched === 1 ? 'number was' : 'numbers were'} already on the list, and the new details you added (name, hospital, city) have been filled in. ` : ''}
          ${r.duplicates ? `${r.duplicates} already had everything you entered. ` : ''}${r.invalid ? `${r.invalid} invalid number${r.invalid === 1 ? '' : 's'} skipped. ` : ''}
          New leads wait for the manager's auto-distribute. <a href="#intake" style="color:var(--primary);font-weight:600">See everything you've uploaded →</a>
        </div>
      </div>`;
    showToast(done ? head : 'Nothing new to save', done ? 'success' : 'info');
    if (after) after();
  } catch (err) {
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
        <h1>Upload leads</h1>
        <p class="header-subtitle" style="margin:0">Add the numbers you've gathered. A hospital + phone is enough; include more columns if you have them. The manager allots them to caregiver mentors from the auto-distribute.</p>
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
      <div class="field"><label>Notes</label><input class="input" id="s-notes" placeholder="Anything else worth noting" /></div>
      <div class="form-actions" style="justify-content:flex-start"><button type="submit" class="btn btn-primary" id="s-submit">${icon('plus')}Add this lead</button></div>
    </form>

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
  container.querySelectorAll('#upload-tabs .tab').forEach(t => t.addEventListener('click', () => {
    container.querySelectorAll('#upload-tabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const single = t.dataset.mode === 'single';
    $('#mode-single').style.display = single ? '' : 'none';
    $('#mode-paste').style.display = single ? 'none' : '';
  }));

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
    await submitRows(sb, [row], resultEl, () => { $('#mode-single').reset(); refreshWaiting(); });
    btn.disabled = false; btn.innerHTML = `${icon('plus')}Add this lead`;
  });
}
