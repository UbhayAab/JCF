// ============================================================
// Patient Navigator: the medical document reader
//
// Replaces the v0 scanner, which posted patient clinical photographs to a
// DIFFERENT Supabase project because only that project had a deploy token
// (js/pages/patients.js, DOC_EXTRACT_URL). Nothing leaves this project now:
// the image goes to our own private bucket and to our own Edge Function, the
// Gemini key is a server-side secret and is never in the browser, and the
// model's answer is a PROPOSAL that a mentor accepts, edits or rejects before
// anything at all is saved.
//
// Shape of the flow. Steps 5 and 6 live in sql/91_parser_pipeline.sql:
//   1. ask consent (once per patient, recorded in patient_consents)
//   2. downscale in the browser, upload the original to patient-docs
//   3. POST to the doc-parse Edge Function (the Gemini key is its secret)
//   4. read the finished extraction row back
//   5. mentor reviews
//   6. apply_document_extraction(extraction_id, accepted)
//
// WHAT THE 13 REAL DOCUMENTS TAUGHT THIS FILE, and where it shows up:
//
//   - The pen overrules the print. Three of thirteen sheets had a printed
//     value struck out and corrected by hand, including one where the drug
//     itself changed from Pembrolizumab to Tislelizumab. So a corrected value
//     is never pre-ticked and the sheet shows the photograph alongside it.
//     See renderHandwritingWarning and CORRECTED_NEVER_AUTO.
//
//   - The patient's NAME is the least reliable thing on a handwritten
//     day-care sheet: read wrong on 2 of 13, both times as a confident,
//     plausible Indian name. The hospital case number was right on 12 of 13.
//     So identity keys on the number, and a name mismatch downgrades trust
//     rather than proving anything. See renderIdentityBanner.
//
//   - Ages drift. On all four patients where the record and the document
//     disagreed about age, the document was newer by exactly one year. That
//     is a birthday, not an error, and flagging it as a conflict would train
//     mentors to click through conflicts. See isBenignAgeDrift.
//
//   - Documents disagree with each other. One nursing record says the patient
//     is 68 while her own registration form and ID card say 62. The parser is
//     right to report what the page says; the UI has to show the disagreement
//     rather than silently pick a side.
// ============================================================

import { getSupabase } from '../supabase.js';
import { CONFIG } from '../config.js';
import { showModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { GI_SUBTYPES, giLabel } from '../utils/catalog.js';

const MAX_EDGE = 1600;     // measured: no accuracy cost, ~10x smaller payload
const JPEG_Q = 0.8;
const PARSE_TIMEOUT_MS = 150000;

// Fields whose value came from a struck-through correction are never ticked by
// default, at any confidence. A mentor has to look at the photo and decide.
const CORRECTED_NEVER_AUTO = true;

// Fields that may be pre-ticked when the record is blank and the model was
// confident. Everything clinical stays off by default: stage and trajectory in
// particular, per PRD failure mode F1 and non-goal NG-3.
const AUTO_TICK_WHEN_BLANK = new Set([
  'city', 'state', 'pin_code', 'treating_hospital', 'hospital_case_no',
  'occupation', 'caregiver_relationship',
]);

const PATIENT_FIELDS = [
  { key: 'hospital_case_no', label: 'Hospital case number' },
  { key: 'age', label: 'Age' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'pin_code', label: 'PIN code' },
  { key: 'gi_subtype', label: 'GI subtype', options: GI_SUBTYPES },
  { key: 'cancer_stage', label: 'Stage' },
  { key: 'tnm_stage', label: 'TNM' },
  { key: 'diagnosis_date', label: 'Diagnosed' },
  { key: 'trajectory', label: 'Treatment intent' },
  { key: 'ecog_status', label: 'ECOG' },
  { key: 'treating_hospital', label: 'Hospital' },
  { key: 'treating_doctor', label: 'Treating doctor' },
  { key: 'caregiver_name', label: 'Caregiver' },
  { key: 'caregiver_relationship', label: 'Relationship' },
];


/**
 * Escape for an HTML ATTRIBUTE, not just for text.
 *
 * sanitize() in js/utils/validators.js round trips through textContent, which
 * escapes < > and & and leaves quotes alone. That is correct for text between
 * tags and WRONG inside an attribute, and every value on this screen came off a
 * photograph of a document we did not write. A cost certificate really does
 * print
 *     favouring "Tata Memorial Hospital a/c. 11F2026/000000"
 * so a double quote arriving in an extracted value is ordinary, not adversarial,
 * and one of them silently breaks the checkbox that carries the value.
 */
const attr = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isBlank = (v) =>
  v === null || v === undefined || v === '' ||
  v === 'unknown' || v === 'prefer_not_to_say' ||
  (typeof v === 'string' && v.trim() === '');

/** A document one year ahead of the record is a birthday, not a contradiction. */
function isBenignAgeDrift(recordAge, docAge) {
  const a = Number(recordAge), b = Number(docAge);
  return Number.isFinite(a) && Number.isFinite(b) && (b - a === 1 || b - a === 0);
}

// ============================================================
// Image handling: identical downscale to the one that was benchmarked
// ============================================================
async function downscale(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 6 * 1024 * 1024) throw new Error('PDF is too large, 6 MB max');
    return { mime: 'application/pdf', b64: await toBase64(await file.arrayBuffer()) };
  }
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo or a PDF');
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('Could not read that photo');
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { mime: 'image/jpeg', b64: canvas.toDataURL('image/jpeg', JPEG_Q).split(',')[1] };
}

async function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ============================================================
// Consent. Separate from patients.consent_given, which covers navigation and
// is effectively forced true at insert time. Photographing a family's hospital
// file and having a machine read it is a different thing to ask, so it is
// asked separately and a refusal is recorded rather than forgotten.
// ============================================================
export async function hasDocumentConsent(patientId) {
  const sb = getSupabase();
  const { data, error } = await sb.rpc('has_document_consent', { p_patient: patientId });
  if (error) throw error;
  return data === true;
}

export async function recordConsent(patientId, granted, method = 'verbal_during_call') {
  const sb = getSupabase();
  const { error } = await sb.from('patient_consents').insert({
    patient_id: patientId, purpose: 'medical_documents',
    granted, method, asked_by: (await sb.auth.getUser()).data?.user?.id,
  });
  if (error) throw error;
}

export function askConsent(patientId, patientName) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.innerHTML = `
      <p style="margin-bottom:12px">Before we photograph anything, ${sanitize(patientName)} or the
      family has to agree to this specifically. Reading their hospital papers is
      not covered by the consent they gave for navigation calls.</p>
      <div class="doc-callout" style="margin-bottom:16px">
        <strong>Say this, in their language:</strong>
        <p style="margin:6px 0 0">"If you send me a photo of your hospital papers, we will read them
        so that we can help you better, and so you do not have to explain everything again on every
        call. We keep them safely. You can tell us to delete them at any time. Is that all right?"</p>
      </div>
      <div class="form-group">
        <label class="form-label">How was this asked?</label>
        <select class="form-select" id="dc-method">
          <option value="verbal_during_call">Verbally, on a call</option>
          <option value="written">In writing</option>
          <option value="digital">Digitally (WhatsApp / form)</option>
          <option value="guardian_consent">Given by a guardian</option>
        </select>
      </div>`;
    showModal({
      title: 'Consent to read documents', content: el, size: 'md',
      footer: `<button class="btn btn-ghost" id="dc-no">They said no</button>
               <button class="btn btn-primary" id="dc-yes">They agreed</button>`,
    });
    document.getElementById('dc-no').addEventListener('click', async () => {
      const method = el.querySelector('#dc-method').value;
      try {
        await recordConsent(patientId, false, method);
      } catch (e) {
        showToast('Could not record the refusal: ' + e.message, 'error');
      }
      closeModal(); resolve(null);
    });
    document.getElementById('dc-yes').addEventListener('click', () => {
      const m = el.querySelector('#dc-method').value;
      closeModal(); resolve(m);
    });
  });
}

// ============================================================
// Upload + parse
// ============================================================
async function uploadAndParse(patientId, file, onStage) {
  const sb = getSupabase();
  const uid = (await sb.auth.getUser()).data?.user?.id;

  onStage('Preparing the photo…');
  const { mime, b64 } = await downscale(file);

  onStage('Uploading…');
  const ext = mime === 'application/pdf' ? 'pdf' : 'jpg';
  const path = `${patientId}/${crypto.randomUUID()}.${ext}`;
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const { error: upErr } = await sb.storage.from('patient-docs')
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (upErr) throw new Error('Upload failed: ' + upErr.message);

  const { data: doc, error: docErr } = await sb.from('patient_documents').insert({
    patient_id: patientId, storage_path: path, mime_type: mime,
    byte_size: bytes.length, uploaded_by: uid, doc_type: 'unknown',
  }).select('id').single();
  if (docErr) throw new Error('Could not record the document: ' + docErr.message);

  onStage('Reading the document…');

  // The parse runs in the doc-parse Edge Function, not through pg_net.
  // Measured 2026-08-23: pg_net carries roughly 50 KB of request body and then
  // its worker wedges, and shrinking the photo enough to fit took wrong values
  // on the real batch from 4 to 18 out of 241 fields. The evidence is in
  // supabase/functions/doc-parse/index.ts.
  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error('Your session has expired, please sign in again');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PARSE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/doc-parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ document_id: doc.id, image_b64: b64, mime }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError'
      ? 'Reading took too long. Try again, or use a smaller photo.'
      : 'Could not reach the reader. Check your connection.');
  } finally {
    clearTimeout(timer);
  }

  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'The document could not be read');

  const { data: ex, error: exErr } = await sb.from('document_extractions')
    .select('id,status,fields,summary_text,evidence,identity_check,legibility,error')
    .eq('id', out.extraction_id).single();
  if (exErr || !ex) throw new Error('The reading finished but could not be loaded');
  if (ex.status !== 'parsed') throw new Error(ex.error || 'The document could not be read');
  return { extraction: ex, documentId: doc.id, storagePath: path };
}

// ============================================================
// The review sheet
// ============================================================
function confidenceOf(evidence, field) {
  const e = (evidence || []).find((x) => x.field === field);
  return e || null;
}

function renderIdentityBanner(check, fields, patient) {
  if (check === 'mismatch') {
    return `<div class="doc-callout doc-callout-danger">
      <strong>${icon('alertTriangle')} This may be a different patient.</strong>
      <p>The document is stamped <code>${sanitize(fields.hospital_case_no || 'no number')}</code>,
      but ${sanitize(patient.full_name)} is registered as
      <code>${sanitize(patient.hospital_case_no || 'no number on file')}</code>.
      Nothing can be saved until that is resolved.</p></div>`;
  }
  if (check === 'unverifiable') {
    return `<div class="doc-callout doc-callout-warn">
      <strong>${icon('alertTriangle')} We could not confirm this is the right patient.</strong>
      <p>The page does not carry a case number we can match${
        fields.full_name ? `, and the name on it reads "${sanitize(fields.full_name)}"` : ''}.
      Handwritten day-care sheets are often illegible. Check the photo before you accept anything.</p></div>`;
  }
  return `<div class="doc-callout doc-callout-ok">
    <strong>${icon('check')} Identity confirmed.</strong>
    <p>Case number <code>${sanitize(fields.hospital_case_no || '')}</code> matches this patient.</p></div>`;
}

function renderHandwritingWarning(fields) {
  if (!fields.has_handwritten_corrections) return '';
  const corrected = (fields.medications || []).filter((m) => m.superseded_print);
  const regimenChanged = fields.regimen_superseded_print;
  return `<div class="doc-callout doc-callout-warn">
    <strong>${icon('edit')} Someone corrected this sheet by hand.</strong>
    <p>The printed values were changed in pen, and the pen is what the patient actually received.
    Look at the photo yourself before accepting these.</p>
    ${regimenChanged ? `<p style="margin-top:6px">Protocol: <s>${sanitize(regimenChanged)}</s>
      → <strong>${sanitize(fields.regimen_name || '')}</strong></p>` : ''}
    ${corrected.length ? `<ul style="margin:6px 0 0 18px">${corrected.map((m) =>
      `<li>${sanitize(m.name)}: <s>${sanitize(m.superseded_print)}</s>
        → <strong>${sanitize(m.dose_raw || '')}</strong></li>`).join('')}</ul>` : ''}
  </div>`;
}

function fieldRow(f, proposed, current, evidence) {
  const ev = confidenceOf(evidence, f.key);
  const blank = isBlank(current);
  const same = !blank && String(current).toLowerCase() === String(proposed).toLowerCase();
  if (same) return '';

  const ageDrift = f.key === 'age' && !blank && isBenignAgeDrift(current, proposed);
  const conflict = !blank && !ageDrift;
  const autoTick = blank && AUTO_TICK_WHEN_BLANK.has(f.key) && ev?.confidence === 'high';

  const label = f.options
    ? (f.options.find((o) => o.key === proposed)?.label || proposed)
    : proposed;

  return `
    <label class="doc-field ${conflict ? 'doc-field-conflict' : ''}">
      <input type="checkbox" data-field="${f.key}" data-value="${attr(proposed)}"
             ${autoTick ? 'checked' : ''} />
      <div class="doc-field-body">
        <div class="doc-field-head">
          <strong>${f.label}</strong>
          ${ev ? `<span class="badge badge-${ev.confidence === 'high' ? 'ok'
            : ev.confidence === 'medium' ? 'neutral' : 'warn'}">${ev.confidence}</span>` : ''}
          ${conflict ? '<span class="badge badge-warn">conflicts with the record</span>' : ''}
          ${ageDrift ? '<span class="badge badge-neutral">a year older, probably a birthday</span>' : ''}
        </div>
        <div class="doc-field-value">${sanitize(String(label))}</div>
        ${!blank ? `<div class="doc-field-current">record currently says
          <strong>${sanitize(String(current))}</strong></div>` : ''}
        ${ev ? `<div class="doc-field-quote">“${sanitize(ev.quote)}”</div>` : ''}
      </div>
    </label>`;
}

function renderReview(ctx) {
  const { fields, patient, extraction, signedUrl } = ctx;
  const ev = extraction.evidence || [];

  const rows = PATIENT_FIELDS
    .map((f) => {
      let v = fields[f.key];
      if (f.key === 'diagnosis_date' && v) v = String(v).slice(0, 7);
      if (isBlank(v)) return '';
      return fieldRow(f, v, patient[f.key], ev);
    })
    .filter(Boolean).join('');

  const cancerDrugs = (fields.medications || []).filter((m) => !m.is_supportive);
  const supportive = (fields.medications || []).filter((m) => m.is_supportive);
  const cycles = (fields.cycles || []).filter((c) => c.date);
  const admins = (fields.administrations || []).filter((a) => a.date);
  const weights = [
    ...(fields.weights || []).map((w) => ({ ...w, date: w.date || fields.document_date })),
    ...(fields.weight_kg ? [{ weight_kg: fields.weight_kg, date: fields.document_date,
                              height_cm: fields.height_cm, bsa_m2: fields.bsa_m2 }] : []),
  ].filter((w) => w.date);

  const el = document.createElement('div');
  el.className = 'doc-review';
  el.innerHTML = `
    ${renderIdentityBanner(extraction.identity_check, fields, patient)}
    ${renderHandwritingWarning(fields)}
    ${extraction.legibility === 'poor' ? `<div class="doc-callout doc-callout-warn">
      <strong>This photo is hard to read.</strong>
      <p>Consider asking for a clearer one before trusting anything below.</p></div>` : ''}
    ${fields.government_id_present ? `<div class="doc-callout">
      <strong>${icon('shieldCheck')} An Aadhaar or ABHA number is visible on this page.</strong>
      <p>None of its digits were read or stored. Consider re-taking the photo without that part.</p></div>` : ''}

    <div class="doc-layout">
      <div class="doc-photo">
        ${signedUrl ? `<a href="${signedUrl}" target="_blank" rel="noopener">
          <img src="${signedUrl}" alt="The uploaded document" /></a>
          <p class="form-hint">Tap to open full size</p>` : ''}
      </div>

      <div class="doc-fields">
        ${extraction.summary_text ? `<div class="doc-callout"><strong>What this page says</strong>
          <p>${sanitize(extraction.summary_text)}</p></div>` : ''}

        <h4>Patient record</h4>
        ${rows || '<p class="form-hint">Nothing here that the record does not already have.</p>'}

        ${fields.regimen_name ? `
        <h4>Treatment</h4>
        <label class="doc-field">
          <input type="checkbox" data-group="regimen" checked />
          <div class="doc-field-body">
            <div class="doc-field-head"><strong>${sanitize(fields.regimen_name)}</strong>
              ${fields.trajectory ? `<span class="badge badge-neutral">${sanitize(fields.trajectory)}</span>` : ''}</div>
            <div class="doc-field-value">
              ${fields.total_cycles ? `${fields.total_cycles} cycles planned` : ''}
              ${fields.cycle_length_days ? ` · every ${fields.cycle_length_days} days` : ''}
              ${fields.plan_no ? ` · plan ${fields.plan_no}` : ''}</div>
          </div>
        </label>` : ''}

        ${cycles.length || admins.length ? `
        <h4>Cycles given ${cycles.length + admins.length ? `(${cycles.length + admins.length})` : ''}</h4>
        <p class="form-hint">Each of these is a date someone wrote on the sheet when the patient came in.</p>
        ${[...cycles, ...admins.map((a) => ({ cycle_number: null, date: a.date, source: 'handwritten', drug: a.drug }))]
          .map((c, i) => `
          <label class="doc-field">
            <input type="checkbox" data-group="cycle" data-idx="${i}"
                   data-date="${attr(c.date)}" data-num="${c.cycle_number ?? ''}"
                   data-source="${attr(c.source || '')}" checked />
            <div class="doc-field-body"><div class="doc-field-value">
              ${c.cycle_number ? `Cycle ${c.cycle_number} · ` : ''}${sanitize(c.date)}
              ${c.drug ? ` · ${sanitize(c.drug)}` : ''}
              ${c.source === 'handwritten' ? '<span class="badge badge-neutral">handwritten</span>' : ''}
            </div></div>
          </label>`).join('')}` : ''}

        ${cancerDrugs.length ? `
        <h4>Cancer drugs</h4>
        ${cancerDrugs.map((m, i) => `
          <label class="doc-field ${m.superseded_print ? 'doc-field-conflict' : ''}">
            <input type="checkbox" data-group="med" data-idx="${i}"
                   ${m.superseded_print && CORRECTED_NEVER_AUTO ? '' : 'checked'} />
            <div class="doc-field-body">
              <div class="doc-field-head"><strong>${sanitize(m.name)}</strong>
                ${m.superseded_print ? '<span class="badge badge-warn">corrected by hand</span>' : ''}</div>
              <div class="doc-field-value">
                ${sanitize(m.dose_raw || 'dose not stated')}
                ${m.dose_per_m2_raw ? ` (${sanitize(m.dose_per_m2_raw)})` : ''}
                ${m.route ? ` · ${sanitize(m.route)}` : ''}
                ${m.days_of_cycle ? ` · ${sanitize(m.days_of_cycle)}` : ''}</div>
              ${m.superseded_print ? `<div class="doc-field-current">the sheet originally printed
                <s>${sanitize(m.superseded_print)}</s></div>` : ''}
            </div>
          </label>`).join('')}` : ''}

        ${supportive.length ? `
        <details><summary>${supportive.length} supportive medicines
          (anti-sickness, steroids, mouthwash)</summary>
          ${supportive.map((m, i) => `
          <label class="doc-field">
            <input type="checkbox" data-group="supportive" data-idx="${i}" />
            <div class="doc-field-body"><div class="doc-field-value">
              ${sanitize(m.name)} · ${sanitize(m.dose_raw || '')} ${sanitize(m.route || '')}
            </div></div>
          </label>`).join('')}
        </details>` : ''}

        ${weights.length ? `
        <h4>Weight</h4>
        ${weights.map((w, i) => `
          <label class="doc-field">
            <input type="checkbox" data-group="anthro" data-idx="${i}" checked />
            <div class="doc-field-body"><div class="doc-field-value">
              ${sanitize(String(w.weight_kg))} kg on ${sanitize(w.date)}
              ${w.height_cm ? ` · ${sanitize(String(w.height_cm))} cm` : ''}
              ${w.bsa_m2 ? ` · BSA ${sanitize(String(w.bsa_m2))}` : ''}
            </div></div>
          </label>`).join('')}` : ''}
      </div>
    </div>`;

  // Stash the parsed arrays for the submit handler.
  el._data = { cycles, admins, cancerDrugs, supportive, weights, fields };
  return el;
}

function collect(el, extraction) {
  const d = el._data;
  const patients = {};
  const rejected = [];

  el.querySelectorAll('input[data-field]').forEach((cb) => {
    if (cb.checked) patients[cb.dataset.field] = cb.dataset.value;
    else rejected.push(cb.dataset.field);
  });

  // cancer_type is derived from the subtype exactly as the patient form does,
  // never read off the page.
  if (patients.gi_subtype) {
    const lbl = giLabel(patients.gi_subtype);
    if (lbl) patients.cancer_type = lbl;
  }
  if (patients.diagnosis_date && /^\d{4}-\d{2}$/.test(patients.diagnosis_date)) {
    patients.diagnosis_date += '-01';
  }

  const regimenOn = el.querySelector('input[data-group="regimen"]')?.checked;
  const f = d.fields;

  const cycles = [];
  el.querySelectorAll('input[data-group="cycle"]').forEach((cb) => {
    if (!cb.checked) return;
    cycles.push({
      date: cb.dataset.date,
      cycle_number: cb.dataset.num || null,
      source: cb.dataset.source || null,
    });
  });

  const medications = [];
  el.querySelectorAll('input[data-group="med"]').forEach((cb) => {
    if (cb.checked) medications.push(d.cancerDrugs[+cb.dataset.idx]);
  });
  el.querySelectorAll('input[data-group="supportive"]').forEach((cb) => {
    if (cb.checked) medications.push(d.supportive[+cb.dataset.idx]);
  });

  const anthropometry = [];
  el.querySelectorAll('input[data-group="anthro"]').forEach((cb) => {
    if (!cb.checked) return;
    const w = d.weights[+cb.dataset.idx];
    anthropometry.push({
      measured_on: w.date, weight_kg: w.weight_kg,
      height_cm: w.height_cm ?? null, bsa_m2: w.bsa_m2 ?? null,
    });
  });

  return {
    patients,
    rejected,
    regimen: regimenOn && f.regimen_name ? {
      regimen_name: f.regimen_name,
      superseded_print: f.regimen_superseded_print || null,
      intent: f.trajectory || null,
      plan_no: f.plan_no ?? null,
      total_cycles: f.total_cycles ?? null,
      cycle_length_days: f.cycle_length_days ?? null,
      started_on: null,
    } : null,
    cycles,
    medications: medications.map((m) => ({
      name: m.name, dose_raw: m.dose_raw ?? null,
      dose_per_m2_raw: m.dose_per_m2_raw ?? null,
      superseded_print: m.superseded_print ?? null,
      route: m.route ?? null, frequency: m.frequency ?? null,
      days_of_cycle: m.days_of_cycle ?? null,
      is_supportive: !!m.is_supportive,
      administered_on: null,
    })),
    procedures: (f.procedures || []).filter((p) => p.kind === 'surgery' || p.kind === 'radiotherapy'),
    anthropometry,
  };
}

// ============================================================
// Entry point. Called from the patient detail page.
// ============================================================
export async function openDocumentScanner(patientId) {
  const sb = getSupabase();
  const { data: patient, error } = await sb.from('patients')
    .select('id,full_name,hospital_case_no,age,city,state,pin_code,gi_subtype,cancer_stage,'
          + 'tnm_stage,diagnosis_date,trajectory,ecog_status,treating_hospital,treating_doctor,'
          + 'caregiver_name,caregiver_relationship')
    .eq('id', patientId).single();
  if (error || !patient) { showToast('Could not load the patient', 'error'); return; }

  if (!(await hasDocumentConsent(patientId).catch(() => false))) {
    const method = await askConsent(patientId, patient.full_name);
    if (!method) { showToast('Recorded that they did not agree', 'info'); return; }
    await recordConsent(patientId, true, method);
  }

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*,application/pdf';
  picker.capture = 'environment';
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;

    const busy = document.createElement('div');
    busy.innerHTML = '<div class="spinner"></div><p id="doc-stage">Preparing…</p>';
    showModal({ title: 'Reading the document', content: busy, size: 'sm' });
    const stage = (s) => { const n = document.getElementById('doc-stage'); if (n) n.textContent = s; };

    let result;
    try {
      result = await uploadAndParse(patientId, file, stage);
    } catch (e) {
      closeModal();
      showToast(e.message || 'Could not read that document', 'error');
      return;
    }

    const { data: signed } = await sb.storage.from('patient-docs')
      .createSignedUrl(result.storagePath, 600).catch(() => ({ data: null }));

    const fields = result.extraction.fields || {};
    const el = renderReview({
      fields, patient, extraction: result.extraction,
      signedUrl: signed?.signedUrl || null,
    });

    const blocked = result.extraction.identity_check === 'mismatch';
    showModal({
      title: 'What we read', content: el, size: 'xl',
      footer: `<button class="btn btn-ghost" id="doc-discard">Discard</button>
               <button class="btn btn-primary" id="doc-save" ${blocked ? 'disabled' : ''}>
                 ${blocked ? 'Identity must be resolved first' : 'Save what I ticked'}</button>`,
    });

    document.getElementById('doc-discard').addEventListener('click', async () => {
      await sb.from('document_extractions')
        .update({ status: 'discarded', reviewed_at: new Date().toISOString() })
        .eq('id', result.extraction.id);
      closeModal();
      showToast('Discarded. The photo is still on file.', 'info');
    });

    document.getElementById('doc-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Saving…';
      const accepted = collect(el, result.extraction);
      const { data, error: applyErr } = await sb.rpc('apply_document_extraction', {
        p_extraction_id: result.extraction.id, p_accepted: accepted,
      });
      if (applyErr) {
        btn.disabled = false; btn.textContent = 'Save what I ticked';
        showToast(applyErr.message, 'error');
        return;
      }
      closeModal();
      const parts = [];
      if (data?.patient_fields) parts.push(`${data.patient_fields} field${data.patient_fields > 1 ? 's' : ''}`);
      if (data?.cycles) parts.push(`${data.cycles} cycle${data.cycles > 1 ? 's' : ''}`);
      if (data?.medications) parts.push(`${data.medications} medicine${data.medications > 1 ? 's' : ''}`);
      if (data?.anthropometry) parts.push(`${data.anthropometry} weight${data.anthropometry > 1 ? 's' : ''}`);
      showToast(parts.length ? `Saved ${parts.join(', ')}` : 'Nothing was ticked', 'success');
      window.dispatchEvent(new CustomEvent('patient-updated', { detail: { patientId } }));
    });
  });
  picker.click();
}
