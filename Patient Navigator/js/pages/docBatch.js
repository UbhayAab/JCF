// ============================================================
// Patient Navigator: the document BATCH reader
//
// js/pages/documents.js reads one photograph. This reads whatever the family
// actually sent: one PDF, twenty phone photos, or a mix, out of order, some
// upside down, some sent twice.
//
// WHY THE BROWSER RENDERS THE PAGES
//
// sql/92 records why the parse call left pg_net: pg_net wedges above roughly
// 50 KB of request body. A 35 page PDF is that problem again one layer up, so
// the request body is not where the pages travel. The browser renders every
// page to a JPEG, uploads it to the private patient-docs bucket, and sends the
// Edge Function only IDs. The function downloads them with the mentor's own
// JWT, so storage RLS is the access check and a 35 page batch and a one photo
// batch send request bodies of the same size.
//
// WHAT THE TWO REAL BATCHES TAUGHT THIS FILE
//
//   - Families send the same photo twice. Six of the thirty six documents in
//     the second batch were byte identical duplicates of another one. Hashing
//     in the browser drops them before a token is spent, and more importantly
//     before a mentor is shown the same proposal twice and accepts it twice.
//
//   - The pen overrules the print. Three sheets in the first batch and four in
//     the second had a printed value struck out and corrected by hand,
//     including a protocol where the drug changed from Pembrolizumab to
//     Tislelizumab and one where oxaliplatin was cut from 141.95 mg to 100 mg.
//     A corrected value is NEVER pre ticked, at any confidence.
//
//   - The patient's NAME is the least reliable field on a handwritten sheet.
//     Identity keys on the case number. See renderIdentityBanner.
//
//   - Documents disagree with each other. One case number carried three
//     different ages across three sheets. The UI shows the disagreement rather
//     than silently picking a side, except where the disagreement is a
//     birthday, which is marked benign and shown quietly.
// ============================================================

import { getSupabase } from '../supabase.js';
import { CONFIG } from '../config.js';
import { showModal, closeModal } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { GI_SUBTYPES, giLabel } from '../utils/catalog.js';
import { hasDocumentConsent, recordConsent, askConsent } from './documents.js';

// Measured in sql/92: 1600 px q80 costs nothing against full resolution and is
// ten times smaller. Going below it quadrupled the number of WRONG values.
const MAX_EDGE = 1600;
const JPEG_Q = 0.8;
// Segmentation only has to tell one form apart from another, so it runs small.
const THUMB_EDGE = 900;
const THUMB_Q = 0.6;

const MAX_FILES = 60;
const MAX_PAGES = 80;
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
const STEP_TIMEOUT_MS = 300000;

const CORRECTED_NEVER_AUTO = true;

// Only these may be pre ticked, and only when the record is blank and the model
// was confident. Everything clinical stays off by default.
const AUTO_TICK_WHEN_BLANK = new Set([
  'city', 'state', 'pin_code', 'treating_hospital', 'hospital_case_no',
  'occupation', 'caregiver_relationship', 'date_of_birth', 'marital_status',
  'home_state', 'home_district', 'registration_category',
  'nominee_name', 'nominee_relationship',
]);
// hospital_unit is deliberately NOT here. Looking at the rendered review screen
// (screenshots/docbatch/review_card1.png) caught it pre ticked at high
// confidence with the value "Department of Medical Oncology", which is the
// department printed under the letterhead and not the DMG unit at all. A field
// whose most common wrong answer is confident and plausible does not get to be
// ticked for the mentor.

const PATIENT_FIELDS = [
  { key: 'hospital_case_no', label: 'Hospital case number' },
  { key: 'full_name', label: 'Name on the document', readOnly: true },
  { key: 'age', label: 'Age' },
  { key: 'date_of_birth', label: 'Date of birth' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'pin_code', label: 'PIN code' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'marital_status', label: 'Marital status' },
  { key: 'gi_subtype', label: 'GI subtype', options: GI_SUBTYPES },
  { key: 'primary_site', label: 'Primary site' },
  { key: 'histology', label: 'Histology' },
  { key: 'cancer_stage', label: 'Stage' },
  { key: 'tnm_stage', label: 'TNM' },
  { key: 'metastatic_sites', label: 'Metastatic sites' },
  { key: 'comorbidities', label: 'Other conditions' },
  { key: 'allergies', label: 'Allergies' },
  { key: 'diagnosis_date', label: 'Diagnosed' },
  { key: 'trajectory', label: 'Treatment intent' },
  { key: 'treating_hospital', label: 'Hospital' },
  { key: 'treating_doctor', label: 'Treating doctor' },
  { key: 'hospital_unit', label: 'Unit / DMG' },
  { key: 'registration_category', label: 'Registration category' },
  { key: 'caregiver_name', label: 'Caregiver' },
  { key: 'caregiver_relationship', label: 'Relationship' },
  { key: 'nominee_name', label: 'Nominee' },
  { key: 'nominee_relationship', label: 'Nominee relationship' },
  { key: 'railway_concession_from', label: 'Railway concession from' },
  { key: 'railway_concession_to', label: 'Railway concession to' },
  { key: 'family_income_annual_inr', label: 'Family income' },
  { key: 'follow_up_date', label: 'Next review' },
  { key: 'follow_up_instruction', label: 'Before the next review' },
];

// Fields the parser returns under a nested key but that belong on the patient.
const REGISTRATION_TO_PATIENT = {
  'registration.registered_on': 'hospital_registered_on',
  'registration.dmg_unit': 'hospital_unit',
  'registration.opd_days': 'hospital_opd_days',
  'registration.referred_by': 'referred_by',
  'registration.referred_for': 'referred_for',
  'registration.nominee_name': 'nominee_name',
  'registration.nominee_relationship': 'nominee_relationship',
  'registration.railway_concession_from': 'railway_concession_from',
  'registration.railway_concession_to': 'railway_concession_to',
  'registration.home_state': 'home_state',
  'registration.home_district': 'home_district',
  'registration.resident_of_treatment_city': 'resident_of_treatment_city',
  'registration.category_word': 'registration_category',
  'registration.family_income_inr': 'family_income_annual_inr',
};

const CLASS_LABEL = {
  treatment_protocol: 'Treatment protocol', drug_calculation: 'Day-care drug sheet',
  nursing_record: 'Nursing record', registration_form: 'Registration slip',
  file_cover: 'File cover', id_card: 'ID card', cost_certificate: 'Cost certificate',
  laboratory_report: 'Laboratory report', radiology_report: 'Radiology report',
  imaging_report: 'Imaging report', histopathology: 'Histopathology',
  pathology_addendum: 'Pathology addendum', endoscopy_report: 'Endoscopy / ERCP',
  device_record: 'Device / PICC card', discharge_summary: 'Discharge summary',
  prescription: 'Prescription', opd_note: 'OPD note', referral_letter: 'Referral letter',
  consent_form: 'Consent form', scheme_card: 'Scheme card',
  income_certificate: 'Income certificate', disability_certificate: 'Disability certificate',
  ration_card: 'Ration card', insurance_document: 'Insurance document',
  ngo_sanction_letter: 'NGO sanction letter', transfusion_record: 'Transfusion record',
  bill_receipt: 'Bill / receipt', not_a_medical_document: 'Not a medical document',
  other: 'Other', unknown: 'Unidentified',
};

const isBlank = (v) =>
  v === null || v === undefined || v === '' || v === 'unknown' ||
  v === 'prefer_not_to_say' || (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.filter((x) => !isBlank(x)).length === 0);

// v97: comorbidities and metastatic_sites are lists on both sides now, a text[]
// column in the record and a JSON array from the reader. The review screen only
// knows how to show and edit a string, and sql/97's doc_text_list splits a
// string back into a list on a semicolon, so a semicolon is the join. Anything
// else round trips into one comorbidity called "Diabetes, Hypertension".
const asText = (v) => (Array.isArray(v)
  ? v.filter((x) => !isBlank(x)).map((x) => String(x).trim()).join('; ')
  : (v === null || v === undefined ? v : v));

const label = (cls) => CLASS_LABEL[cls] || cls || 'Unidentified';

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


/** A document a year ahead of the record is a birthday, not a contradiction. */
function isBenignAgeDrift(recordAge, docAge) {
  const a = Number(recordAge), b = Number(docAge);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) <= 1;
}

// ============================================================
// Rendering pages in the browser
// ============================================================
let pdfLibPromise = null;
async function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import(/* @vite-ignore */ PDFJS).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfLibPromise;
}

function canvasToBlob(canvas, quality) {
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
}

async function drawScaled(source, w, h, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas, quality);
  return { blob, width: canvas.width, height: canvas.height };
}

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One picked file to one or more page records, each with a full render and a
 *  thumbnail. A PDF becomes as many pages as it has; an image becomes one. */
export async function renderFile(file, onPage) {
  const pages = [];
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const pdfjs = await loadPdfLib();
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // render once at the resolution the full JPEG needs, then downscale for
      // the thumbnail. Rendering twice is the slow way to get the same pixels.
      const scale = Math.min(3, MAX_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const full = await drawScaled(canvas, canvas.width, canvas.height, MAX_EDGE, JPEG_Q);
      const thumb = await drawScaled(canvas, canvas.width, canvas.height, THUMB_EDGE, THUMB_Q);
      pages.push({ source_name: file.name, source_kind: 'pdf_page', source_page_no: i,
                   full, thumb });
      onPage?.(pages.length);
      page.cleanup();
    }
    doc.destroy();
  } else if (file.type.startsWith('image/')) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      // The commonest cause by a distance is HEIC off an iPhone, which the
      // file picker accepts as image/* and which no browser here can decode.
      // "Could not read IMG_4821.HEIC" tells a mentor nothing she can act on;
      // the fix is one setting on the phone that sent it.
      const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
      throw new Error(heic
        ? `${file.name} is an iPhone HEIC photo, which this browser cannot open. `
          + `Ask for it again from WhatsApp, or set the phone's camera to `
          + `"Most Compatible" and re-take it.`
        : `Could not read ${file.name}. It may be corrupted, or not really a photo.`);
    }
    const full = await drawScaled(bitmap, bitmap.width, bitmap.height, MAX_EDGE, JPEG_Q);
    const thumb = await drawScaled(bitmap, bitmap.width, bitmap.height, THUMB_EDGE, THUMB_Q);
    bitmap.close();
    pages.push({ source_name: file.name, source_kind: 'image', source_page_no: null,
                 full, thumb });
    onPage?.(1);
  } else {
    throw new Error(`${file.name} is not a photo or a PDF`);
  }
  return pages;
}

// ============================================================
// Talking to the Edge Function
// ============================================================
async function callParser(payload) {
  const sb = getSupabase();
  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error('Your session has expired, please sign in again');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STEP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/doc-parse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError'
      ? 'That step took too long. The pages are saved, so you can try reading them again.'
      : 'Could not reach the reader. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
  const out = await res.json().catch(() => ({}));
  // A 404 here is not "something went wrong", it is "the reader has never been
  // switched on for this project": the doc-parse Edge Function needs a Supabase
  // Management API token to deploy and this project has never had one. A mentor
  // who sees "The reader could not finish" re-takes the photographs and tries
  // again, which is the one thing that cannot possibly help.
  if (res.status === 404) {
    throw new Error('The document reader has not been switched on for this site yet. '
                  + 'Your photos were not wasted, nothing has been uploaded. Tell whoever '
                  + 'set up the portal that doc-parse still needs deploying.');
  }
  if (!res.ok) throw new Error(out.error || 'The reader could not finish');
  return out;
}

// ============================================================
// Upload and parse the whole batch
// ============================================================
async function uploadBatch(patientId, files, stage) {
  const sb = getSupabase();
  const uid = (await sb.auth.getUser()).data?.user?.id;

  const { data: batch, error: bErr } = await sb.from('document_batches').insert({
    patient_id: patientId, uploaded_by: uid, source_files: files.length, status: 'uploading',
  }).select('id').single();
  if (bErr) throw new Error('Could not start the upload: ' + bErr.message);

  // ---- render ------------------------------------------------------------
  const pages = [];
  for (const [i, file] of files.entries()) {
    stage(`Preparing ${file.name} (${i + 1} of ${files.length})…`, i / files.length * 0.3);
    const rendered = await renderFile(file, () => {
      stage(`Preparing ${file.name}: ${pages.length + 1} page(s) so far…`, i / files.length * 0.3);
    });
    pages.push(...rendered);
    if (pages.length > MAX_PAGES) {
      throw new Error(`That is more than ${MAX_PAGES} pages. Send it in two goes.`);
    }
  }
  if (!pages.length) throw new Error('Nothing readable in those files');

  // ---- drop byte identical duplicates before spending anything -----------
  const seen = new Map();
  for (const p of pages) {
    p.sha256 = await sha256Hex(p.full.blob);
    p.duplicate = seen.has(p.sha256);
    if (!p.duplicate) seen.set(p.sha256, true);
  }
  const dupes = pages.filter((p) => p.duplicate).length;

  // ---- upload ------------------------------------------------------------
  const rows = [];
  for (const [i, p] of pages.entries()) {
    stage(`Uploading page ${i + 1} of ${pages.length}…`, 0.3 + (i / pages.length) * 0.25);
    const stem = `${patientId}/${batch.id}/p${String(i).padStart(3, '0')}`;
    const bytes = new Uint8Array(await p.full.blob.arrayBuffer());
    const { error: e1 } = await sb.storage.from('patient-docs')
      .upload(`${stem}.jpg`, bytes, { contentType: 'image/jpeg', upsert: false });
    if (e1) throw new Error('Upload failed: ' + e1.message);
    const tbytes = new Uint8Array(await p.thumb.blob.arrayBuffer());
    await sb.storage.from('patient-docs')
      .upload(`${stem}_t.jpg`, tbytes, { contentType: 'image/jpeg', upsert: false });

    rows.push({
      batch_id: batch.id, patient_id: patientId, page_index: i,
      source_name: p.source_name, source_kind: p.source_kind,
      source_page_no: p.source_page_no,
      storage_path: `${stem}.jpg`, thumb_path: `${stem}_t.jpg`,
      width: p.full.width, height: p.full.height,
      byte_size: bytes.length, sha256: p.sha256,
    });
  }
  const { data: inserted, error: pErr } = await sb.from('document_pages')
    .insert(rows).select('id, page_index, sha256');
  if (pErr) throw new Error('Could not record the pages: ' + pErr.message);

  // mark the duplicates now that every page has an id
  const firstBySha = {};
  for (const r of inserted.sort((a, b) => a.page_index - b.page_index)) {
    if (firstBySha[r.sha256] === undefined) firstBySha[r.sha256] = r.id;
    else await sb.from('document_pages').update({ duplicate_of: firstBySha[r.sha256] }).eq('id', r.id);
  }

  await sb.from('document_batches')
    .update({ status: 'segmenting', page_count: pages.length }).eq('id', batch.id);

  // Whether the second reading runs at all is a row in parser_config, not a
  // constant here: it roughly doubles the token cost of a batch, so it is a
  // decision about money that an admin makes without a deploy. Read once, and
  // treated as off if the column is not there yet, so this file works against
  // a database that has had sql/95 but not sql/98.
  const { data: cfgRow } = await sb.from('parser_config')
    .select('audit_enabled').eq('is_active', true).maybeSingle();
  const auditOn = cfgRow?.audit_enabled === true;

  // ---- segment -----------------------------------------------------------
  stage('Working out which pages belong to which document…', 0.6);
  const seg = await callParser({ action: 'segment', batch_id: batch.id });
  const docs = seg.documents ?? [];
  if (!docs.length) throw new Error('None of those pages looked like a document we can read');

  // ---- extract, one call per document ------------------------------------
  const failures = [];
  for (const [i, d] of docs.entries()) {
    stage(`Reading ${label(d.doc_class)} (${i + 1} of ${docs.length})…`,
          0.65 + (i / docs.length) * 0.3);
    try {
      // keep the extraction id: phase 3 is addressed by extraction, not by
      // document, because a document can be read more than once and a check
      // belongs to the reading it checked
      const ex = await callParser({ action: 'extract', document_id: d.document_id });
      d.extraction_id = ex.extraction_id ?? null;
    } catch (e) {
      failures.push(`${label(d.doc_class)}: ${e.message}`);
    }
  }

  // ---- check every answer back against the page --------------------------
  //
  // Phase 3. A separate reading of the same pages that asks, field by field,
  // "does this page support this answer" rather than "what does this page
  // say". It writes nothing and decides nothing. What it produces is the sort
  // that makes this review screen survivable: measured over 35 real documents
  // it confirmed about 98.5% of fields and put roughly 1.5% in front of a
  // human, with no false alarm on any of the 442 fields ground truth says
  // phase 2 got right. docs/RESULTS_audit.md.
  //
  // Best effort by design. If the check fails, every field simply arrives
  // unchecked and the mentor reviews the way she did before phase 3 existed.
  // A reader that stops working must not stop the reading.
  const audits = {};
  if (auditOn) {
    for (const [i, d] of docs.entries()) {
      if (!d.extraction_id && !d.document_id) continue;
      stage(`Checking what we read off ${label(d.doc_class)} (${i + 1} of ${docs.length})…`,
            0.9 + (i / docs.length) * 0.06);
      try {
        const a = await callParser({ action: 'audit', extraction_id: d.extraction_id });
        audits[d.document_id] = a;
      } catch (e) {
        failures.push(`checking ${label(d.doc_class)}: ${e.message}`);
      }
    }
  }

  // ---- reconcile the documents against each other ------------------------
  stage('Checking the documents against each other…', 0.97);
  const merged = await callParser({ action: 'merge', batch_id: batch.id });

  return { batchId: batch.id, docs, merged, audits, dupes, failures, pageCount: pages.length };
}

// ============================================================
// The review screen
// ============================================================
function confBadge(c) {
  if (!c) return '';
  const cls = c === 'high' ? 'ok' : c === 'medium' ? 'neutral' : 'warn';
  return `<span class="badge badge-${cls}">${c}</span>`;
}

function noteFor(fields, key) {
  return (fields.field_notes || []).find((n) => n.field === key) || null;
}

function pageThumbUrl(thumbs, note) {
  if (!note || !Number.isInteger(note.page)) return null;
  return thumbs[note.page] || null;
}

/** What the second reading said about one field. Null when phase 3 did not
 *  run, which is the normal state until an admin turns audit_enabled on. */
export function auditFor(audit, key) {
  if (!audit) return null;
  const list = audit.disputes || audit.rows || [];
  return list.find((r) => (r.field_key ?? r.path) === key) || null;
}

/** The sentence a mentor reads. The verdict word on its own is jargon, and the
 *  point of this row is that she can decide in three seconds whether to open
 *  the photograph. */
const AUDIT_SAYS = {
  wrong: 'The second reading says the page says something else',
  fabricated: 'The second reading could not find this anywhere on the page',
  missing: 'The second reading found this on the page after all',
  unreadable: 'The second reading could not make this out either',
  unchecked: 'The second reading did not get to this one',
};

function auditBadge(a) {
  if (!a || !AUDIT_SAYS[a.verdict]) return '';
  const cls = a.verdict === 'fabricated' || a.verdict === 'wrong' ? 'danger' : 'warn';
  return `<span class="badge badge-${cls === 'danger' ? 'danger' : 'warn'}">checked: disagrees</span>`;
}

function auditNote(a) {
  if (!a || !AUDIT_SAYS[a.verdict]) return '';
  const said = a.correct_value
    ? `<div class="doc-field-current">the second reading read
       <strong>${sanitize(String(a.correct_value))}</strong></div>` : '';
  const ev = a.evidence
    ? `<div class="doc-field-quote">"${sanitize(String(a.evidence))}"</div>` : '';
  const where = Number.isInteger(a.page)
    ? `<div class="doc-field-where">page ${a.page}${a.certainty ? ' · ' + sanitize(a.certainty) + ' certainty' : ''}</div>`
    : (a.certainty ? `<div class="doc-field-where">${sanitize(a.certainty)} certainty</div>` : '');
  const caveat = a.audit_note
    ? `<div class="doc-field-where">${sanitize(String(a.audit_note))}</div>` : '';
  return `<div class="doc-callout doc-callout-warn doc-field-audit">
      <strong>${icon('alertTriangle')} ${AUDIT_SAYS[a.verdict]}.</strong>
      ${said}${ev}${where}${caveat}
    </div>`;
}

function fieldRow(f, proposed, current, note, thumbUrl, docId, audit) {
  const blank = isBlank(current);
  const same = !blank && String(current).toLowerCase() === String(proposed).toLowerCase();
  if (same) return '';

  const ageDrift = f.key === 'age' && !blank && isBenignAgeDrift(current, proposed);
  const conflict = !blank && !ageDrift;
  const corrected = !!note?.printed_value;
  // A field the second reading disputed is NEVER pre ticked, whatever the
  // first reading's confidence was. That is the whole point of asking twice:
  // both real errors in the frozen regression run came back from phase 2 at
  // high confidence, which is exactly the state that pre ticks a field.
  const disputed = !!(audit && AUDIT_SAYS[audit.verdict]);
  const autoTick = !f.readOnly && blank && AUTO_TICK_WHEN_BLANK.has(f.key)
                   && note?.confidence === 'high' && !(corrected && CORRECTED_NEVER_AUTO)
                   && !disputed;

  const shown = f.options
    ? (f.options.find((o) => o.key === proposed)?.label || proposed)
    : proposed;

  return `
    <label class="doc-field ${conflict ? 'doc-field-conflict' : ''} ${disputed ? 'doc-field-disputed' : ''}">
      <input type="checkbox" data-field="${f.key}" data-doc="${docId}"
             data-value="${attr(proposed)}"
             data-conf="${note?.confidence || ''}"
             data-corrected="${corrected ? '1' : ''}"
             data-disputed="${disputed ? '1' : ''}"
             ${f.readOnly ? 'disabled' : ''} ${autoTick ? 'checked' : ''} />
      <div class="doc-field-body">
        <div class="doc-field-head">
          <strong>${f.label}</strong>
          ${confBadge(note?.confidence)}
          ${note?.ink === 'handwritten' ? '<span class="badge badge-neutral">handwritten</span>' : ''}
          ${corrected ? '<span class="badge badge-warn">corrected by hand</span>' : ''}
          ${auditBadge(audit)}
          ${conflict ? '<span class="badge badge-warn">conflicts with the record</span>' : ''}
          ${ageDrift ? '<span class="badge badge-neutral">a year apart, probably a birthday</span>' : ''}
          ${f.readOnly ? '<span class="badge badge-neutral">check only, never saved</span>' : ''}
        </div>
        <div class="doc-field-value">${sanitize(String(shown))}</div>
        ${corrected ? `<div class="doc-field-current">the sheet printed
          <s>${sanitize(note.printed_value)}</s></div>` : ''}
        ${!blank ? `<div class="doc-field-current">record currently says
          <strong>${sanitize(String(current))}</strong></div>` : ''}
        ${note?.quote ? `<div class="doc-field-quote">"${sanitize(note.quote)}"</div>` : ''}
        ${note?.region ? `<div class="doc-field-where">page ${note.page ?? '?'} ·
          ${sanitize(note.region)}</div>` : ''}
        ${auditNote(audit)}
        ${!f.readOnly ? `<input type="text" class="form-input doc-field-edit"
          data-edit="${f.key}" data-doc="${docId}"
          value="${attr(proposed)}" placeholder="edit before saving" />` : ''}
      </div>
      ${thumbUrl ? `<a class="doc-field-thumb" href="${thumbUrl}" target="_blank" rel="noopener"
         title="page ${note.page}"><img src="${thumbUrl}" alt="page ${note.page}" /></a>` : ''}
    </label>`;
}

/**
 * One line at the top of the review that says what the second reading did.
 *
 * This exists because of what the review screen looks like without it. The
 * thirteen document batch produces 1,216 fields; the second reading confirms
 * about 98.5% of them and flags about 1.5%. A mentor who is not told that is
 * looking at the same wall of checkboxes she was looking at before, and the
 * only visible change is a few extra warnings, which reads as the tool getting
 * NOISIER rather than as most of the work having already been done.
 *
 * It also has to say when the check did not run or did not finish, because
 * "nothing was flagged" and "nothing was checked" look identical on screen and
 * are opposite facts.
 */
export function renderAuditSummary(docs) {
  const audits = docs.map((d) => d.audit).filter(Boolean);
  if (!audits.length) return '';

  const sum = (k) => audits.reduce((a, x) => a + (x.summary?.[k] ?? 0), 0);
  const items = sum('items');
  if (!items) return '';
  const disputed = audits.reduce((a, x) => a + (x.disputes?.length ?? 0), 0);
  const partial = audits.filter((a) => a.status !== 'ok');
  const unread = audits.filter((a) => a.pages_checked !== null
                                   && a.pages_checked !== undefined
                                   && a.pages_checked < a.page_count);
  const missedDocs = docs.filter((d) => !d.audit).length;

  return `<div class="doc-callout ${disputed ? 'doc-callout-warn' : ''}">
    <strong>${icon(disputed ? 'alertTriangle' : 'check')}
      We read every page a second time and checked ${items} answer${items > 1 ? 's' : ''}
      against it.</strong>
    <p>${disputed
      ? `<strong>${disputed}</strong> did not hold up and ${disputed > 1 ? 'are' : 'is'}
         marked below. The rest matched the page.`
      : 'Every one matched the page.'}</p>
    ${missedDocs ? `<p class="form-hint">${missedDocs} document(s) were not checked at all,
      so nothing below them is pre ticked on this evidence.</p>` : ''}
    ${partial.length ? `<p class="form-hint">${partial.length} check(s) did not finish, so some
      fields carry no second opinion. Unchecked is not the same as agreed.</p>` : ''}
    ${unread.length ? `<p class="form-hint">${unread.length} document(s) were answered from
      fewer pages than they have. Treat the later pages as unchecked.</p>` : ''}
  </div>`;
}

/**
 * The disputes that have no row on this screen.
 *
 * PATIENT_FIELDS is 32 entries. The second reading checks every field the
 * document produced, which on a treatment protocol is 179 and on a lab report
 * is 306. Everything outside those 32 is saved by the one "save the clinical
 * details from this document" toggle: the drug grid, the cycle dates, the
 * analyte table, the cost break up.
 *
 * So a disagreement about a chemotherapy dose had nowhere at all to appear,
 * and the toggle that saves it is a single checkbox. Rendering the fixture is
 * what showed this: 15 disputes across six documents and every one of them
 * landed outside the 32, so the screen came back with zero marks on it.
 *
 * These cannot be individually ticked, because the payload they belong to is
 * not individually ticked. What they can do is tell the mentor what she is
 * about to save on the strength of one checkbox.
 */
export function renderAuditOther(audit, shownKeys) {
  if (!audit) return '';
  const rest = (audit.disputes || []).filter((r) => !shownKeys.has(r.field_key));
  if (!rest.length) return '';
  const line = (r) => {
    const said = r.correct_value
      ? ` &middot; the second reading read <strong>${sanitize(String(r.correct_value))}</strong>`
      : '';
    const ev = r.evidence ? ` <em>"${sanitize(String(r.evidence))}"</em>` : '';
    return `<li><strong>${sanitize(prettyKey(r.field_key))}</strong>: was
      ${r.answer_shown === null || r.answer_shown === undefined || r.answer_shown === ''
        ? 'blank' : `<strong>${sanitize(String(r.answer_shown))}</strong>`}${said}${ev}
      ${Number.isInteger(r.page) ? `<span class="doc-field-where">page ${r.page}</span>` : ''}</li>`;
  };
  return `<div class="doc-callout doc-callout-warn">
    <strong>${icon('alertTriangle')} ${rest.length} thing${rest.length > 1 ? 's' : ''} in the
      clinical details did not hold up when we read the page again.</strong>
    <p class="form-hint">These are saved by the one toggle above, so there is nothing to
      untick individually. Look at the photo before you leave it on.</p>
    <ul class="doc-audit-list" style="margin:6px 0 0 18px">${rest.map(line).join('')}</ul>
  </div>`;
}

/** `medications[2].dose_raw` -> `medications 3, dose raw`. A mentor should not
 *  have to read an array index to find out which drug row is in question. */
function prettyKey(key) {
  return String(key)
    .replace(/\[(\d+)\]/g, (_, n) => ` ${Number(n) + 1}`)
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderValidations(vals) {
  if (!vals?.length) return '';
  const order = { error: 0, warn: 1, info: 2 };
  const sorted = [...vals].sort((a, b) => order[a.severity] - order[b.severity]);
  return sorted.map((v) => `
    <div class="doc-callout ${v.severity === 'error' ? 'doc-callout-danger'
      : v.severity === 'warn' ? 'doc-callout-warn' : ''}">
      <strong>${icon(v.severity === 'info' ? 'info' : 'alertTriangle')}
        ${v.severity === 'error' ? 'Must be resolved' : v.severity === 'warn' ? 'Check this' : 'Note'}</strong>
      <p>${sanitize(v.message)}</p>
    </div>`).join('');
}

export function renderConflicts(conflicts) {
  const real = (conflicts || []).filter((c) => !c.benign);
  const benign = (conflicts || []).filter((c) => c.benign);
  if (!real.length && !benign.length) return '';
  return `
    ${real.length ? `<div class="doc-callout doc-callout-warn">
      <strong>${icon('alertTriangle')} These documents disagree with each other.</strong>
      <p>The newest is proposed below. Every reading is kept either way.</p>
      <ul style="margin:6px 0 0 18px">
        ${real.map((c) => `<li><strong>${sanitize(c.field_key)}</strong>: ${
          c.candidates.map((x) => `${sanitize(String(x.value))} <span class="doc-field-where">(${
            sanitize(label(x.doc_class))}${x.document_date ? ', ' + sanitize(x.document_date) : ''})</span>`)
            .join(' vs ')}</li>`).join('')}
      </ul></div>` : ''}
    ${benign.length ? `<details class="doc-benign"><summary>${benign.length} small
      difference(s) that are not really conflicts</summary>
      <ul style="margin:6px 0 0 18px">${benign.map((c) =>
        `<li><strong>${sanitize(c.field_key)}</strong>: ${sanitize(c.reason)}</li>`).join('')}</ul>
    </details>` : ''}`;
}

function renderIdentityBanner(check, fields, patient) {
  if (check === 'mismatch') {
    return `<div class="doc-callout doc-callout-danger">
      <strong>${icon('alertTriangle')} This may be a different patient.</strong>
      <p>The document is stamped <code>${sanitize(fields.hospital_case_no || 'no number')}</code>,
      but ${sanitize(patient.full_name)} is registered as
      <code>${sanitize(patient.hospital_case_no || 'no number on file')}</code>.
      Nothing from it can be saved until that is resolved.</p></div>`;
  }
  if (check === 'unverifiable') {
    return `<div class="doc-callout doc-callout-warn">
      <strong>${icon('alertTriangle')} We could not confirm this is the right patient.</strong>
      <p>No case number we can match${fields.full_name
        ? `, and the name reads "${sanitize(fields.full_name)}"` : ''}.
      Handwritten sheets are often illegible. Check the photo before accepting anything.</p></div>`;
  }
  return '';
}

export function sectionSummary(cls, fields) {
  const bits = [];
  const push = (n, what) => { if (n) bits.push(`${n} ${what}${n > 1 ? 's' : ''}`); };
  push((fields.medications || []).length, 'medicine');
  push((fields.cycles || []).length, 'cycle');
  push((fields.administrations || []).length, 'administration');
  push((fields.lab_report?.results || []).length, 'lab result');
  push((fields.biomarker_results || []).length, 'biomarker');
  push((fields.imaging?.lesions || []).length, 'lesion');
  push((fields.nutrition_grid || []).length, 'nutrition reading');
  push((fields.devices || []).length, 'device');
  push((fields.schemes || []).length, 'scheme');
  if (fields.cost_certificate?.estimated_total_inr) {
    bits.push(`a cost certificate for Rs ${Number(fields.cost_certificate.estimated_total_inr).toLocaleString('en-IN')}`);
  }
  return bits.join(', ');
}

/** Each document gets a card. The clinical payload of a document is accepted or
 *  rejected as a whole SECTION, because a mentor cannot sensibly tick 25 lab
 *  analytes one by one, and the whole panel is what a doctor reads anyway. */
/**
 * One document card.
 *
 * The field list is COLLAPSED by default and that decision came from looking at
 * the screen rather than from reasoning about it. Six documents rendered as a
 * 17,000 pixel page (tools/review_preview.html, screenshots/docbatch). A batch
 * of twenty, which is the size this feature exists for, would be four times
 * that and no mentor would scroll it.
 *
 * What stays ALWAYS VISIBLE is the part that changes what the mentor does: the
 * identity banner, the validation findings, the one line summary, the red
 * flags, and the toggle that saves the clinical payload. A card opens itself
 * when it needs attention: an identity that is not a clean match, a validation
 * error, or a value the pen corrected.
 */
export function docCard(d, patient, thumbs, index = 0, audit = null) {
  const fields = d.extraction?.fields || {};
  const cls = d.extraction?.doc_class || d.doc_class;
  const summary = sectionSummary(cls, fields);
  const blocked = d.extraction?.identity_check === 'mismatch';
  const hasErrors = (d.validations || []).some((v) => v.severity === 'error');

  // Which field keys this card actually renders a tickable row for. It has to
  // be filled as the rows are BUILT, not from PATIENT_FIELDS, because a field
  // produces no row when the reader returned nothing for it and when the
  // record already agrees. Seeding it from the configured list instead lost
  // exactly the case that matters most: the audit's `missing` verdict on
  // full_name, where the page carries a name the reader did not return. There
  // was no row to mark and the field was filtered out of the list as already
  // shown, so the one real error the audit caught on the regression corpus
  // reached the mentor nowhere at all. tools/review_preview.html now fails
  // loudly on that, which is how it was found.
  const shownKeys = new Set();

  const rows = PATIENT_FIELDS.map((f) => {
    let v = fields[f.key];
    if (v === undefined || v === null) {
      const nested = Object.entries(REGISTRATION_TO_PATIENT).find(([, col]) => col === f.key);
      if (nested) {
        const [path] = nested;
        v = path.split('.').reduce((a, k) => (a === null || a === undefined ? a : a[k]), fields);
      }
    }
    if (f.key === 'diagnosis_date' && v) v = String(v).slice(0, 10);
    if (isBlank(v)) return '';
    // v97: a list field arrives as an array from the reader and as a text[]
    // from the record. Both are flattened the same way so the comparison that
    // decides "already says this" is not array-vs-string, which never matches.
    v = asText(v);
    const note = noteFor(fields, f.key);
    const html = fieldRow(f, v, asText(patient[f.key]), note,
                          pageThumbUrl(thumbs, note), d.document_id, auditFor(audit, f.key));
    if (html) shownKeys.add(f.key);
    return html;
  }).filter(Boolean).join('');

  const rowCount = (rows.match(/class="doc-field /g) || []).length
                 + (rows.match(/class="doc-field doc-field-conflict"/g) || []).length;
  const corrected = (fields.field_notes || []).some((n) => n.printed_value);
  const needsAttention = blocked || hasErrors
    || d.extraction?.identity_check === 'unverifiable' || corrected;
  const openByDefault = needsAttention || index < 2;

  return `
    <section class="doc-card ${blocked ? 'doc-card-blocked' : ''}" data-doc="${d.document_id}"
             data-extraction="${d.extraction?.id || ''}">
      <header class="doc-card-head">
        <div>
          <h4>${sanitize(label(cls))}</h4>
          <div class="doc-field-where">
            ${d.pages} page${d.pages > 1 ? 's' : ''}
            ${fields.document_date ? ' · ' + sanitize(fields.document_date) : ''}
            ${fields.hospital_case_no ? ' · ' + sanitize(fields.hospital_case_no) : ''}
            ${summary ? ' · ' + sanitize(summary) : ''}
          </div>
        </div>
        <label class="doc-section-toggle">
          <input type="checkbox" data-section="${d.document_id}"
                 ${blocked || hasErrors || !summary ? '' : 'checked'}
                 ${blocked ? 'disabled' : ''} />
          <span>Save the clinical details from this document</span>
        </label>
      </header>

      ${renderIdentityBanner(d.extraction?.identity_check, fields, patient)}
      ${renderValidations(d.validations)}
      ${renderAuditOther(audit, shownKeys)}

      ${d.extraction?.summary_text ? `<div class="doc-callout">
        <strong>What this document says</strong>
        <p>${sanitize(d.extraction.summary_text)}</p></div>` : ''}

      ${(fields.red_flags || []).length ? `<div class="doc-callout doc-callout-warn">
        <strong>${icon('alertTriangle')} Worth acting on</strong>
        <p class="form-hint">Each one you leave ticked raises a flag in the concerns
        queue when you save. Untick anything the team is already on.</p>
        <ul class="doc-flag-list">${fields.red_flags.map((r, i) =>
          `<li><label class="doc-flag">
            <input type="checkbox" data-flag="${i}" data-doc="${d.document_id}"
                   data-code="${attr(r.code || 'other')}" ${blocked ? 'disabled' : 'checked'} />
            <span>${sanitize(r.detail)}${Number.isInteger(r.page)
              ? ` <span class="doc-field-where">page ${r.page}</span>` : ''}</span>
          </label></li>`).join('')}</ul></div>` : ''}

      ${rows ? `<details class="doc-card-fields" ${openByDefault ? 'open' : ''}>
        <summary><strong>${rowCount}</strong> proposed change${rowCount > 1 ? 's' : ''}
          to the patient record${needsAttention ? ' &middot; needs a look' : ''}</summary>
        ${rows}
      </details>`
             : '<p class="form-hint">Nothing here that the record does not already have.</p>'}

      ${(fields.field_notes || []).some((n) => n.status === 'could_not_read')
        ? `<details class="doc-benign"><summary>${
            fields.field_notes.filter((n) => n.status === 'could_not_read').length
          } thing(s) we could see but could not read</summary>
          <ul style="margin:6px 0 0 18px">${fields.field_notes
            .filter((n) => n.status === 'could_not_read')
            .map((n) => `<li><strong>${sanitize(n.field)}</strong> on page ${n.page ?? '?'}${
              n.region ? ', ' + sanitize(n.region) : ''}</li>`).join('')}</ul></details>` : ''}
    </section>`;
}

// ============================================================
// Collect what the mentor ticked
// ============================================================
export function collect(root, docs) {
  const byExtraction = {};

  for (const d of docs) {
    const exId = d.extraction?.id;
    if (!exId) continue;
    if (d.extraction.identity_check === 'mismatch') continue;

    const fields = d.extraction.fields || {};
    const patients = {};
    const rejected = [];

    root.querySelectorAll(`input[data-field][data-doc="${d.document_id}"]`).forEach((cb) => {
      if (cb.disabled) return;
      const edit = root.querySelector(
        `input[data-edit="${cb.dataset.field}"][data-doc="${d.document_id}"]`);
      const value = (edit?.value ?? cb.dataset.value).trim();
      if (cb.checked && value) patients[cb.dataset.field] = value;
      else rejected.push(cb.dataset.field);
    });

    // cancer_type is derived from the subtype exactly as the patient form does,
    // never read off the page
    if (patients.gi_subtype) {
      const l = giLabel(patients.gi_subtype);
      if (l) patients.cancer_type = l;
    }
    if (patients.diagnosis_date && /^\d{4}-\d{2}$/.test(patients.diagnosis_date)) {
      patients.diagnosis_date += '-01';
    }

    const sectionOn = root.querySelector(`input[data-section="${d.document_id}"]`)?.checked;
    const payload = { patients, rejected };

    // v97: red flags are ticked one by one and are deliberately NOT tied to the
    // section toggle. "Do not save the clinical details off this sheet" and
    // "nobody needs to know this patient stopped treatment over money" are
    // different sentences, and the second one is never what a mentor means.
    // Until v97 these were painted on the screen and then dropped on close.
    const flags = [];
    root.querySelectorAll(`input[data-flag][data-doc="${d.document_id}"]`).forEach((cb) => {
      if (cb.disabled || !cb.checked) return;
      const f = (fields.red_flags || [])[Number(cb.dataset.flag)];
      if (f?.detail) {
        flags.push({ code: f.code || 'other', detail: f.detail, page: f.page ?? null });
      }
    });
    if (flags.length) payload.red_flags = flags;

    if (sectionOn) {
      if (fields.regimen_name) {
        payload.regimen = {
          regimen_name: fields.regimen_name,
          superseded_print: fields.regimen_superseded_print || null,
          intent: fields.trajectory || null,
          plan_no: fields.plan_no ?? null,
          total_cycles: fields.total_cycles ?? null,
          cycle_length_days: fields.cycle_length_days ?? null,
          started_on: null,
          // v97: parsed since the v2 schema, discarded until sql/97 gave them
          // a column. The margin is where a dose change actually gets written.
          next_cycle_date: fields.next_cycle_date ?? null,
          margin_instructions: fields.margin_instructions ?? null,
        };
      }
      payload.cycles = (fields.cycles || []).filter((c) => c.date);
      payload.medications = (fields.medications || []).map((m) => ({
        name: m.name, dose_raw: m.dose_raw ?? null,
        dose_per_m2_raw: m.dose_per_m2_raw ?? null,
        superseded_print: m.superseded_print ?? m.dose_superseded_print ?? null,
        route: m.route ?? null, frequency: m.frequency ?? null,
        days_of_cycle: m.days_of_cycle ?? null,
        is_supportive: !!m.is_supportive, administered_on: null,
      }));
      payload.procedures = (fields.procedures || [])
        .filter((p) => p.kind === 'surgery' || p.kind === 'radiotherapy');

      // anthropometry: the header block, plus every dated weight, plus the
      // whole nutrition grid, which is a time series and not one number
      const anthro = [];
      if (fields.document_date && (fields.weight_kg || fields.height_cm || fields.bsa_m2)) {
        anthro.push({ measured_on: fields.document_date, weight_kg: fields.weight_kg ?? null,
                      height_cm: fields.height_cm ?? null, bsa_m2: fields.bsa_m2 ?? null });
      }
      for (const w of fields.weights || []) {
        if (w.date) anthro.push({ measured_on: w.date, weight_kg: w.weight_kg ?? null });
      }
      for (const g of fields.nutrition_grid || []) {
        if (!g.date) continue;
        anthro.push({
          measured_on: g.date, weight_kg: g.weight_kg ?? null,
          height_cm: fields.nutrition_height_cm ?? null,
          muac_cm: g.muac_cm ?? null, tsf_mm: g.tsf_mm ?? null,
          calf_circ_cm: g.calf_circ_cm ?? null,
          measurement_context: g.outside_grid ? 'written outside the stamped grid' : 'nutrition grid',
        });
      }
      payload.anthropometry = anthro;

      const lab = fields.lab_report;
      if (lab?.results?.length) {
        payload.lab_results = lab.results.map((r) => ({
          panel: lab.panel ?? null, analyte: r.analyte,
          value_text: r.value_text ?? null, value_num: r.value_num ?? null,
          unit: r.unit ?? null, ref_low: r.ref_low ?? null, ref_high: r.ref_high ?? null,
          ref_text: r.ref_text ?? null, flag: r.flag ?? null,
          flag_source: r.flag_source === 'report' ? 'report' : null,
          specimen: lab.specimen ?? null, requisition_no: lab.requisition_no ?? null,
          lab_name: lab.laboratory ?? null,
          collected_at: lab.collected_at ?? null, reported_at: lab.reported_at ?? null,
          reported_by: lab.finalised_by ?? null,
        }));
      }
      if ((fields.biomarker_results || []).length) payload.biomarkers = fields.biomarker_results;
      if (fields.cost_certificate) payload.cost_certificate = fields.cost_certificate;
      if (fields.imaging) payload.imaging = fields.imaging;
      if (fields.pathology) payload.pathology = fields.pathology;
      if ((fields.devices || []).length) payload.devices = fields.devices;
      if (fields.endoscopy) payload.endoscopy = fields.endoscopy;
      if ((fields.schemes || []).length) payload.schemes = fields.schemes;
    }

    byExtraction[exId] = payload;
  }
  return byExtraction;
}

// docCard, renderConflicts, renderValidations, sectionSummary and collect are
// exported for tools/review_preview.html, which renders this screen against a
// fixture from a real parse run. The review screen cannot be seen in the app
// until the Edge Function is deployed, and shipping a review screen nobody has
// looked at is how a mentor ends up unable to reject a field.

// ============================================================
// Entry point
// ============================================================
export async function openDocumentBatch(patientId) {
  const sb = getSupabase();
  const { data: patient, error } = await sb.from('patients')
    .select('id, full_name, hospital_case_no, age, date_of_birth, city, state, pin_code, '
          + 'occupation, marital_status, gi_subtype, cancer_stage, tnm_stage, diagnosis_date, '
          + 'trajectory, treating_hospital, treating_doctor, hospital_unit, '
          + 'registration_category, caregiver_name, caregiver_relationship, nominee_name, '
          + 'nominee_relationship, railway_concession_from, railway_concession_to, '
          + 'family_income_annual_inr, '
          // v97
          + 'primary_site, histology, metastatic_sites, comorbidities, allergies, '
          + 'follow_up_date, follow_up_instruction')
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
  picker.multiple = true;
  picker.addEventListener('change', async () => {
    const files = [...(picker.files || [])];
    if (!files.length) return;
    if (files.length > MAX_FILES) {
      showToast(`That is more than ${MAX_FILES} files. Send them in two goes.`, 'error');
      return;
    }

    const busy = document.createElement('div');
    busy.innerHTML = `
      <div class="doc-progress">
        <div class="doc-progress-bar"><span id="dbp-bar" style="width:2%"></span></div>
        <p id="dbp-stage">Getting ready…</p>
        <p class="form-hint">${files.length} file(s). This can take a couple of minutes for a
        long PDF. You can leave this open.</p>
      </div>`;
    showModal({ title: 'Reading the documents', content: busy, size: 'md' });
    const stage = (msg, frac) => {
      const n = document.getElementById('dbp-stage');
      const b = document.getElementById('dbp-bar');
      if (n) n.textContent = msg;
      if (b && frac != null) b.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
    };

    let result;
    try {
      result = await uploadBatch(patientId, files, stage);
    } catch (e) {
      closeModal();
      showToast(e.message || 'Could not read those documents', 'error');
      return;
    }

    // ---- load everything the review needs -------------------------------
    const { data: view } = await sb.from('v_batch_documents')
      .select('*').eq('batch_id', result.batchId).order('doc_index');
    const { data: extractions } = await sb.from('document_extractions')
      .select('id, document_id, status, fields, summary_text, identity_check, legibility, doc_class')
      .eq('batch_id', result.batchId);
    const { data: validations } = await sb.from('document_validations')
      .select('extraction_id, code, severity, message, fields, detail')
      .eq('batch_id', result.batchId);
    const { data: pages } = await sb.from('document_pages')
      .select('id, document_id, page_index, thumb_path, storage_path')
      .eq('batch_id', result.batchId).order('page_index');

    // signed URLs for the thumbnails, so a mentor can see the field in context
    const signed = {};
    for (const p of pages || []) {
      const { data } = await sb.storage.from('patient-docs')
        .createSignedUrl(p.thumb_path || p.storage_path, 3600).catch(() => ({ data: null }));
      if (data?.signedUrl) signed[p.id] = data.signedUrl;
    }

    const docs = (view || []).map((v) => {
      const ex = (extractions || []).find((e) => e.document_id === v.document_id) || null;
      const myPages = (pages || []).filter((p) => p.document_id === v.document_id)
        .sort((a, b) => a.page_index - b.page_index);
      const thumbs = {};
      myPages.forEach((p, i) => { thumbs[i + 1] = signed[p.id]; });
      return {
        document_id: v.document_id, doc_class: v.doc_type, pages: v.page_count,
        extraction: ex && ex.status === 'parsed' ? ex : null,
        validations: (validations || []).filter((x) => x.extraction_id === ex?.id),
        // The second reading's disagreements, keyed by document. Undefined
        // when phase 3 did not run or failed, and every field then renders
        // exactly as it did before phase 3 existed.
        audit: result.audits?.[v.document_id] || null,
        thumbs,
      };
    }).filter((d) => d.extraction);

    if (!docs.length) {
      closeModal();
      showToast('Nothing readable came back. The photos are still on file.', 'error');
      return;
    }

    const el = document.createElement('div');
    el.className = 'doc-review doc-batch';
    el.innerHTML = `
      <div class="doc-batch-head">
        <div>
          <strong>${docs.length} document${docs.length > 1 ? 's' : ''}</strong>
          from ${result.pageCount} page${result.pageCount > 1 ? 's' : ''}
          ${result.dupes ? ` · ${result.dupes} duplicate page(s) skipped` : ''}
        </div>
        <button class="btn btn-ghost btn-sm" id="db-accept-high">
          Tick everything we are sure about</button>
      </div>
      ${result.failures.length ? `<div class="doc-callout doc-callout-warn">
        <strong>${icon('alertTriangle')} ${result.failures.length} document(s) could not be read.</strong>
        <p>${result.failures.map(sanitize).join('. ')}. The pages are saved either way.</p></div>` : ''}
      ${renderAuditSummary(docs)}
      ${renderConflicts(result.merged?.conflicts)}
      ${docs.map((d, i) => docCard(d, patient, d.thumbs, i, d.audit)).join('')}`;

    closeModal();
    showModal({
      title: 'What we read', content: el, size: 'xl',
      footer: `<button class="btn btn-ghost" id="db-discard">Discard all</button>
               <button class="btn btn-primary" id="db-save">Save what I ticked</button>`,
    });

    document.getElementById('db-accept-high').addEventListener('click', () => {
      let n = 0;
      let skipped = 0;
      el.querySelectorAll('input[data-field]').forEach((cb) => {
        if (cb.disabled || cb.checked) return;
        // never auto tick a value the pen corrected, at any confidence, and
        // never one that contradicts what the record already says
        if (cb.dataset.corrected) return;
        if (cb.dataset.conf !== 'high') return;
        if (cb.closest('.doc-field')?.classList.contains('doc-field-conflict')) return;
        // and never one the second reading disagreed with. `conf` is the FIRST
        // reading's opinion of itself, and it was high on both of the real
        // errors in the frozen regression corpus, so on its own it is exactly
        // the wrong thing to gate a bulk tick on.
        if (cb.dataset.disputed) { skipped++; return; }
        cb.checked = true; n++;
      });
      showToast(n ? `Ticked ${n} field(s) we are confident about. Nothing corrected by hand, `
                  + `nothing that disagrees with the record`
                  + (skipped ? `, and ${skipped} that the second reading disputed.` : '.')
                  : 'Nothing left that is safe to tick automatically', n ? 'success' : 'info');
    });

    document.getElementById('db-discard').addEventListener('click', async () => {
      await sb.from('document_batches')
        .update({ status: 'discarded', reviewed_at: new Date().toISOString() })
        .eq('id', result.batchId);
      closeModal();
      showToast('Discarded. The pages are still on file.', 'info');
    });

    document.getElementById('db-save').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<div class="spinner"></div> Saving…';
      const accepted = collect(el, docs);
      const { data, error: applyErr } = await sb.rpc('apply_document_batch', {
        p_batch_id: result.batchId, p_accepted: accepted,
      });
      if (applyErr) {
        btn.disabled = false; btn.textContent = 'Save what I ticked';
        showToast(applyErr.message, 'error');
        return;
      }
      closeModal();
      const parts = [];
      const say = (k, one, many) => {
        const n = Number(data?.[k] || 0);
        if (n) parts.push(`${n} ${n > 1 ? (many || one + 's') : one}`);
      };
      say('patient_fields', 'field');
      say('cycles', 'cycle'); say('medications', 'medicine');
      say('lab_results', 'lab result'); say('biomarkers', 'biomarker');
      say('anthropometry', 'measurement'); say('cost_certificates', 'cost certificate');
      say('imaging', 'imaging report'); say('pathology', 'pathology report');
      say('devices', 'device'); say('endoscopy', 'endoscopy report'); say('schemes', 'scheme');
      say('red_flags', 'flag for the concerns queue', 'flags for the concerns queue');
      showToast(parts.length ? `Saved ${parts.join(', ')}` : 'Nothing was ticked',
                parts.length ? 'success' : 'info');
      window.dispatchEvent(new CustomEvent('patient-updated', { detail: { patientId } }));
    });
  });
  picker.click();
}
