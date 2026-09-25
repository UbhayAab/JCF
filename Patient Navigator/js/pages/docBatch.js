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
//
// WHAT 25 SEPTEMBER 2026 TAUGHT IT
//
//   - Hospital and lab report PDFs are often locked with a password. pdf.js
//     answers a locked file with "No password given", and nothing here asked
//     for one, so the whole batch aborted and the raw message went to a toast.
//     A mentor and then a manager picked the same files again and again and
//     got the same toast every time. A locked PDF now asks for its password
//     inside the progress window, and can be skipped on its own.
//
//   - Each of those tries left a batch row saying 'uploading' forever,
//     because the row was created before a single page had been drawn. Pages
//     are drawn first now, and nothing is written until there are some.
//
//   - The pipeline is driven from this browser tab, one call per step, so a
//     closed tab or a locked phone strands a batch mid read, and a batch that
//     finished reading could only be reviewed in the session that read it.
//     Upload documents now lists earlier uploads that stopped or are waiting
//     for a review, and finishes or opens them. See findUnfinishedBatches.
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
// A batch whose last step started or finished longer ago than this is not
// being read by anyone. The longest single step is one Gemini call, capped at
// 240 s in supabase/functions/doc-parse/index.ts, so ten quiet minutes is
// never a batch that is merely slow.
const STALLED_AFTER_MS = 10 * 60 * 1000;

// What a stranded batch says in the patient's Documents tab. They all start
// with a word resumeBatch recognises, so a finished resume can clear them.
const NOTE_UPLOAD_STOPPED = 'Stopped before every page was stored, so nothing was read. '
  + 'Pick the files again.';
const NOTE_SEGMENT_STOPPED = 'Stopped while sorting the pages. Nothing is lost: open Upload '
  + 'documents on this patient and choose Finish reading.';
const NOTE_READ_STOPPED = 'Stopped before any document was read. Nothing is lost: open Upload '
  + 'documents on this patient and choose Finish reading.';
const NOTE_MERGE_STOPPED = 'Stopped before the documents were compared. Nothing is lost: open '
  + 'Upload documents on this patient and choose Finish reading.';
const NOTE_NO_DOCUMENT = 'Stopped: the reader found no document it could read on these pages. '
  + 'Upload a clearer photo, or discard this.';
const RETRY_HINT = 'The pages are saved. Open Upload documents on this patient to finish reading them.';

// Finishing a stopped batch CLAIMS it first, by writing this note in the same
// conditional UPDATE that moves its status (see claimBatch). The note carries
// the time, readable in the Documents tab and parsed back by claimTime, so a
// claim counts as activity and nobody else is offered the batch meanwhile.
const CLAIM_PREFIX = 'Being finished now, started ';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_MS = 330 * 60 * 1000;

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
/**
 * Why one picked file cannot go into the batch, in words a mentor can act on.
 *
 * Every per file failure used to be a plain Error thrown out of the render
 * loop, which aborted the WHOLE batch and showed the raw message. A problem is
 * about one file unless `fatal` is set: the batch carries on without that file
 * and the reason is listed, while it runs and again on the review screen.
 */
export class FileProblem extends Error {
  constructor(kind, message, { fatal = false } = {}) {
    super(message);
    this.name = 'FileProblem';
    this.kind = kind;
    this.fatal = fatal;
  }
}

let pdfLibPromise = null;
async function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import(/* @vite-ignore */ PDFJS).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    }).catch(() => {
      // Cached as a rejection, one failed CDN fetch would fail every later PDF
      // in this tab until a reload, with nothing to say that a reload helps.
      pdfLibPromise = null;
      throw readerUnavailable();
    });
  }
  return pdfLibPromise;
}

function readerUnavailable() {
  return new FileProblem('reader_unavailable',
    'The PDF reader did not load, so nothing was uploaded. Check the internet connection '
    + 'and try again.', { fatal: true });
}

/** A PDF, including one handed over with no type and no .pdf name, which some
 *  Android file managers do with a document saved out of WhatsApp. */
async function looksLikePdf(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return true;
  if (file.type.startsWith('image/')) return false;
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];   // %PDF-
  for (let i = 0; i + sig.length <= head.length; i++) {
    if (sig.every((b, k) => head[i + k] === b)) return true;
  }
  return false;
}

/**
 * Open one PDF, asking for its password when it is locked.
 *
 * pdf.js reports a PDF locked with a user password as a PasswordException,
 * "No password given" (NEED_PASSWORD) and, after a wrong one, "Incorrect
 * Password" (INCORRECT_PASSWORD). It only raises it for a file whose trailer
 * carries an /Encrypt dictionary that the empty password does not open, so an
 * ordinary PDF, or one with only an owner password (printing or copying
 * restrictions), never reaches this. Hospital and lab reports in India very
 * often are locked, usually with a date of birth or a phone number.
 *
 * Until 25 Sep 2026 the loading task had no onPassword, so that exception came
 * straight out of getDocument, aborted the batch, and was shown raw. onPassword
 * keeps the one loading task open while the mentor answers, so a wrong
 * password is asked again with the reason, and the file is never re-read.
 *
 * `asker` is null when there is nobody to ask (tools/pdf_split_check.html calls
 * renderFile with no options); a locked file then fails with a sentence.
 * `known` holds passwords that opened an earlier file in THIS upload, in memory
 * for the length of one upload and never written anywhere. They are tried
 * first, silently, because a family often sends several reports from the same
 * lab locked with the same date of birth.
 */
async function openPdf(pdfjs, file, { asker = null, known = [] } = {}) {
  const { INCORRECT_PASSWORD } = pdfjs.PasswordResponses;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const untried = [...known];
  let typed = false;          // the mentor has typed a password for THIS file
  let usedEarlier = false;    // a password that opened an earlier file was tried
  let lastTried = null;
  let answer = null;          // 'skip' | 'stop' | 'nobody'

  task.onPassword = (updatePassword, reason) => {
    if (untried.length) {
      usedEarlier = true;
      lastTried = untried.shift();
      updatePassword(lastTried);
      return;
    }
    if (!asker) { answer = 'nobody'; updatePassword(new Error('locked')); return; }
    asker.ask({
      fileName: file.name,
      wrong: typed && reason === INCORRECT_PASSWORD,
      usedEarlier: usedEarlier && !typed,
    }).then((reply) => {
      if (reply?.password) {
        typed = true;
        lastTried = reply.password;
        updatePassword(reply.password);
        return;
      }
      answer = reply?.stop ? 'stop' : 'skip';
      updatePassword(new Error(answer));
    }, () => { answer = 'skip'; updatePassword(new Error('skip')); });
  };

  try {
    const doc = await task.promise;
    if (lastTried !== null && !known.includes(lastTried)) known.unshift(lastTried);
    return doc;
  } catch (err) {
    task.destroy().catch(() => {});
    throw pdfProblem(file, err, answer);
  } finally {
    asker?.settle();
  }
}

/** Every way opening a PDF can fail, as the sentence the mentor reads. The raw
 *  pdf.js message is never shown: it is written for developers. */
function pdfProblem(file, err, answer) {
  if (answer === 'stop') return new FileProblem('stopped', 'Stopped. Nothing was uploaded.', { fatal: true });
  if (answer === 'skip') {
    return new FileProblem('skipped', `${file.name} is locked with a password and you skipped it.`);
  }
  if (answer === 'nobody' || err?.name === 'PasswordException') {
    return new FileProblem('locked', `${file.name} is locked with a password, so it was left out.`);
  }
  if (err instanceof FileProblem) return err;
  if (['InvalidPDFException', 'FormatError', 'MissingPDFException'].includes(err?.name)) {
    return new FileProblem('damaged', `${file.name} could not be opened. The file looks damaged, `
      + 'or it is not really a PDF. Ask the family to send it again.');
  }
  // pdf.js runs in a worker loaded from the CDN; when that fails, every PDF
  // fails the same way and the file itself is not the problem
  if (/worker/i.test(String(err?.message))) return readerUnavailable();
  return new FileProblem('unreadable', `${file.name} could not be opened as a PDF. Ask the family `
    + 'to send it again, or to send a photo of each page.');
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

/** One PDF page to a page record: rendered once at the resolution the full
 *  JPEG needs, then downscaled for the thumbnail. Rendering twice is the slow
 *  way to get the same pixels. */
async function renderPdfPage(doc, pageNo, fileName) {
  const page = await doc.getPage(pageNo);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const full = await drawScaled(canvas, canvas.width, canvas.height, MAX_EDGE, JPEG_Q);
    const thumb = await drawScaled(canvas, canvas.width, canvas.height, THUMB_EDGE, THUMB_Q);
    return { source_name: fileName, source_kind: 'pdf_page', source_page_no: pageNo, full, thumb };
  } finally {
    page.cleanup();
  }
}

/** A page that cannot be drawn costs that page, not the file: the rest are
 *  kept and the missing page numbers are reported through onNote. */
async function renderPdfFile(file, onPage, { asker = null, known = [], onNote = null,
                                            isCancelled = null } = {}) {
  const pdfjs = await loadPdfLib();
  const doc = await openPdf(pdfjs, file, { asker, known });
  const pages = [];
  const broken = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      if (isCancelled?.()) throw pdfProblem(file, null, 'stop');
      try {
        pages.push(await renderPdfPage(doc, i, file.name));
        onPage?.(pages.length);
      } catch {
        broken.push(i);
      }
    }
  } finally {
    doc.destroy();
  }
  if (!pages.length) {
    throw new FileProblem('damaged', `${file.name} opened, but none of its pages could be drawn. `
      + 'Ask the family to send it again.');
  }
  if (broken.length) {
    const many = broken.length > 1;
    onNote?.(`${file.name}: page${many ? 's' : ''} ${broken.join(', ')} could not be drawn and `
      + `${many ? 'were' : 'was'} left out.`);
  }
  return pages;
}

async function renderImageFile(file, onPage) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    // The commonest cause by a distance is HEIC off an iPhone, which the
    // file picker accepts as image/* and which no browser here can decode.
    // "Could not read IMG_4821.HEIC" tells a mentor nothing she can act on;
    // the fix is one setting on the phone that sent it.
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
    throw new FileProblem(heic ? 'heic' : 'unreadable', heic
      ? `${file.name} is an iPhone HEIC photo, which this browser cannot open. `
        + `Ask for it again from WhatsApp, or set the phone's camera to `
        + `"Most Compatible" and re-take it.`
      : `Could not read ${file.name}. It may be corrupted, or not really a photo.`);
  }
  const full = await drawScaled(bitmap, bitmap.width, bitmap.height, MAX_EDGE, JPEG_Q);
  const thumb = await drawScaled(bitmap, bitmap.width, bitmap.height, THUMB_EDGE, THUMB_Q);
  bitmap.close();
  onPage?.(1);
  return [{ source_name: file.name, source_kind: 'image', source_page_no: null, full, thumb }];
}

/** One picked file to one or more page records, each with a full render and a
 *  thumbnail. A PDF becomes as many pages as it has; an image becomes one.
 *  `opts.asker` asks for a locked PDF's password. Without it a locked PDF
 *  throws a FileProblem that says so, never the raw pdf.js message. */
export async function renderFile(file, onPage, opts = {}) {
  if (!file.size) {
    throw new FileProblem('empty', `${file.name} is empty. It probably did not finish `
      + 'downloading. Ask the family to send it again.');
  }
  if (await looksLikePdf(file)) return renderPdfFile(file, onPage, opts);
  if (file.type.startsWith('image/')) return renderImageFile(file, onPage);
  throw new FileProblem('unsupported', `${file.name} is not a photo or a PDF, so it was left out.`);
}

/**
 * Draw every picked file, BEFORE anything is written anywhere.
 *
 * The batch row used to be inserted first, so every render failure left a row
 * saying 'uploading' forever: PAT-2026-01106 collected four on 25 Sep 2026,
 * one per try at the same locked PDF. Nothing is created now until there are
 * pages to store.
 *
 * A file that cannot be drawn is left out with its reason and the rest carry
 * on. Only a fatal problem (the mentor stopped, the PDF reader did not load,
 * too many pages) ends the upload, and at this point that costs nothing.
 * The passwords that opened files are forgotten when this returns.
 */
export async function prepareFiles(files, { stage = () => {}, asker = null, onLeftOut = null,
                                            isCancelled = null } = {}) {
  const pages = [];
  const leftOut = [];
  const notes = [];
  const known = [];
  try {
    for (const [i, file] of files.entries()) {
      if (isCancelled?.()) throw pdfProblem(file, null, 'stop');
      const at = (i / files.length) * 0.3;
      stage(`Preparing ${file.name} (${i + 1} of ${files.length})…`, at);
      try {
        const rendered = await renderFile(file, (n) => {
          stage(`Preparing ${file.name}: ${n} page(s) so far…`, at);
        }, { asker, known, isCancelled, onNote: (m) => notes.push(m) });
        pages.push(...rendered);
      } catch (err) {
        if (err instanceof FileProblem && err.fatal) throw err;
        const item = {
          name: file.name,
          reason: err instanceof FileProblem ? err.message
            : `${file.name} could not be read, so it was left out.`,
        };
        leftOut.push(item);
        onLeftOut?.(item);
        continue;
      }
      if (pages.length > MAX_PAGES) {
        throw new FileProblem('too_many', `That is more than ${MAX_PAGES} pages. Send it in two goes.`,
          { fatal: true });
      }
    }
  } finally {
    known.length = 0;
  }
  return { pages, leftOut, notes, filesUsed: files.length - leftOut.length };
}

/**
 * The password question, asked inside the progress window rather than in a
 * second dialog, so a mentor on a phone does not lose her place.
 *
 * The field is plain text on purpose. These are not the mentor's own
 * passwords: they are a date of birth or a phone number read out by a family,
 * and the usual failure is a typo she cannot see. A password type field would
 * also invite the browser to offer to SAVE it, which would put a patient's
 * document password into a shared phone's password manager. The value leaves
 * the field the moment it is submitted and is never logged, stored or sent;
 * only the unlocked pages are uploaded.
 *
 * ask() resolves { password } | { skip: true } | { stop: true }.
 */
export function makePasswordAsker(host) {
  let pending = null;
  const clear = () => { host.hidden = true; host.innerHTML = ''; };

  const ask = ({ fileName, wrong = false, usedEarlier = false }) => new Promise((resolve) => {
    pending = resolve;
    host.hidden = false;
    host.innerHTML = `
      <div class="doc-callout doc-callout-warn" role="group" aria-labelledby="dbp-pw-title"
           style="margin-top:12px;text-align:left">
        <strong id="dbp-pw-title">${icon('lock')} This PDF is locked with a password</strong>
        <p style="overflow-wrap:anywhere">${sanitize(fileName)}</p>
        ${wrong ? `<p role="alert" data-pw-wrong style="color:var(--danger);font-weight:600">That
          password did not open it. Check it and try again.</p>` : ''}
        ${usedEarlier ? `<p data-pw-earlier>The password that opened an earlier file did not
          open this one.</p>` : ''}
        <div class="form-group" style="margin:12px 0 8px">
          <label class="form-label" for="dbp-pw-input">Password</label>
          <input class="form-input" id="dbp-pw-input" type="text" autocomplete="off"
                 autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" />
          <p class="form-hint" data-pw-error role="alert" hidden style="color:var(--danger)"></p>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" class="btn btn-primary btn-sm" data-pw-open>Open this file</button>
          <button type="button" class="btn btn-secondary btn-sm" data-pw-skip>Skip this file</button>
        </div>
        <p>Skipping leaves out only this file. The others carry on.</p>
        <p>The password is usually in the SMS or email the report came with. If not, try the
          patient's date of birth (such as 15081965), their mobile number, or the first four
          letters of their name in capitals and their birth year (such as RAME1965). If none of
          these work, ask the family.</p>
        <p>Only the pages are kept. The password is not saved anywhere.</p>
      </div>`;
    const input = host.querySelector('#dbp-pw-input');
    const err = host.querySelector('[data-pw-error]');
    const finish = (reply) => {
      if (pending !== resolve) return;
      pending = null;
      input.value = '';
      if (reply.password) {
        host.innerHTML = '<p class="form-hint" data-pw-checking style="margin:8px 0">Checking the password…</p>';
      } else {
        clear();
      }
      resolve(reply);
    };
    const submit = () => {
      const value = input.value.trim();
      if (!value) {
        err.textContent = 'Type the password first, or skip this file.';
        err.hidden = false;
        input.focus();
        return;
      }
      finish({ password: value });
    };
    host.querySelector('[data-pw-open]').addEventListener('click', submit);
    host.querySelector('[data-pw-skip]').addEventListener('click', () => finish({ skip: true }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    input.focus();
  });

  return {
    ask,
    /** The file opened or failed: take the question (or "Checking") away. */
    settle: () => { if (!pending) clear(); },
    /** The window was closed while a question was open: that means stop. */
    cancel: () => {
      if (!pending) return;
      const resolve = pending;
      pending = null;
      clear();
      resolve({ stop: true });
    },
  };
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
      ? 'That step took too long.'
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
                  + 'Tell whoever set up the portal that doc-parse still needs deploying.');
  }
  if (!res.ok) throw new Error(out.error || 'The reader could not finish');
  return out;
}

// ============================================================
// Upload and parse the whole batch
// ============================================================

/** Status and note together. Best effort: the caller is already reporting a
 *  failure, and a second failure here must not replace its message. */
async function setBatchState(sb, batchId, status, note) {
  const { error } = await sb.from('document_batches').update({ status, note }).eq('id', batchId);
  return !error;
}

/** A failure the mentor can recover from without picking a single file again. */
function retryable(err) {
  return new Error(`${err?.message || 'The reader could not finish.'} ${RETRY_HINT}`);
}

async function uploadBatch(patientId, files, stage, { asker = null, onLeftOut = null,
                                                      isCancelled = null, onDrawn = null } = {}) {
  // ---- draw every page first; nothing is written until there are some ----
  const prep = await prepareFiles(files, { stage, asker, onLeftOut, isCancelled });
  if (!prep.pages.length) {
    throw new FileProblem('nothing', prep.leftOut.length
      ? `Nothing was uploaded. ${prep.leftOut.map((x) => x.reason).join(' ')}`
      : 'Nothing readable in those files', { fatal: true });
  }
  onDrawn?.();
  const { pages } = prep;

  const sb = getSupabase();
  const uid = (await sb.auth.getUser()).data?.user?.id;
  const { data: batch, error: bErr } = await sb.from('document_batches').insert({
    patient_id: patientId, uploaded_by: uid, source_files: prep.filesUsed, status: 'uploading',
  }).select('id').single();
  if (bErr) throw new Error('Could not start the upload: ' + bErr.message);

  let dupes;
  try {
    dupes = await storePages(sb, patientId, batch.id, pages, stage);
  } catch (err) {
    // never a row that says 'still uploading' about an upload that stopped
    await setBatchState(sb, batch.id, 'failed', NOTE_UPLOAD_STOPPED);
    throw err;
  }

  const read = await readBatch(sb, batch.id, stage);
  return { ...read, dupes, pageCount: pages.length, leftOut: prep.leftOut, notes: prep.notes };
}

/** Hash, upload and record every page, unchanged from before the drawing moved
 *  ahead of it. Returns how many pages were byte identical duplicates. */
async function storePages(sb, patientId, batchId, pages, stage) {
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
    const stem = `${patientId}/${batchId}/p${String(i).padStart(3, '0')}`;
    const bytes = new Uint8Array(await p.full.blob.arrayBuffer());
    const { error: e1 } = await sb.storage.from('patient-docs')
      .upload(`${stem}.jpg`, bytes, { contentType: 'image/jpeg', upsert: false });
    if (e1) throw new Error('Upload failed: ' + e1.message);
    const tbytes = new Uint8Array(await p.thumb.blob.arrayBuffer());
    await sb.storage.from('patient-docs')
      .upload(`${stem}_t.jpg`, tbytes, { contentType: 'image/jpeg', upsert: false });

    rows.push({
      batch_id: batchId, patient_id: patientId, page_index: i,
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
    .update({ status: 'segmenting', page_count: pages.length }).eq('id', batchId);
  return dupes;
}

/**
 * Sort, read, check and compare a batch whose pages are already stored.
 *
 * Every step is one Edge Function call made from this tab, and a batch's
 * status only moves when a step finishes. So a closed tab, a locked phone or a
 * call that times out strands the batch wherever it was: on 25 Sep 2026 one had
 * sat at 'segmenting' since 29 Aug and two at 'extracting' since 3 and 12 Sep.
 * With `resume`, documents that already exist are not sorted again and a
 * document that already has a parsed reading is not read again, so finishing a
 * batch spends only what the stopped run did not.
 */
async function readBatch(sb, batchId, stage, { resume = false } = {}) {
  // Whether the second reading runs at all is a row in parser_config, not a
  // constant here: it roughly doubles the token cost of a batch, so it is a
  // decision about money that an admin makes without a deploy. Read once, and
  // treated as off if the column is not there yet, so this file works against
  // a database that has had sql/95 but not sql/98.
  const { data: cfgRow } = await sb.from('parser_config')
    .select('audit_enabled').eq('is_active', true).maybeSingle();
  const auditOn = cfgRow?.audit_enabled === true;

  // ---- segment -----------------------------------------------------------
  let docs = resume ? await existingDocuments(sb, batchId) : [];
  if (!docs.length) {
    stage('Working out which pages belong to which document…', 0.6);
    try {
      const seg = await callParser({ action: 'segment', batch_id: batchId });
      docs = seg.documents ?? [];
    } catch (err) {
      await setBatchState(sb, batchId, 'failed', NOTE_SEGMENT_STOPPED);
      throw retryable(err);
    }
  }
  if (!docs.length) {
    // segment has already moved the batch to 'extracting', where it would
    // otherwise say "being read" for ever (PAT-2026-01462, since 12 Sep)
    await setBatchState(sb, batchId, 'failed', NOTE_NO_DOCUMENT);
    throw new Error('None of those pages looked like a document we can read. The pages are '
      + 'saved: upload a clearer photo, or discard them from Upload documents.');
  }

  // ---- extract, one call per document ------------------------------------
  const readAlready = resume ? await parsedReadings(sb, batchId) : {};
  const failures = [];
  for (const [i, d] of docs.entries()) {
    if (readAlready[d.document_id]) { d.extraction_id = readAlready[d.document_id]; continue; }
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
  // Not one document read: merging now would mark the batch ready for a
  // review that has nothing in it, and that review would say "Nothing
  // readable came back" every time anyone opened it.
  if (!docs.some((d) => d.extraction_id)) {
    await setBatchState(sb, batchId, 'failed', NOTE_READ_STOPPED);
    const why = [...new Set(failures)].slice(0, 3).join('. ');
    throw retryable(new Error(`None of the documents could be read. ${why}`.trim()));
  }

  const audits = {};
  if (auditOn) {
    const checked = resume ? await finishedAudits(sb, batchId) : {};
    for (const [i, d] of docs.entries()) {
      // a document that was not read has nothing to check; asking anyway only
      // added a second, more confusing failure line for the same document
      if (!d.extraction_id) continue;
      if (checked[d.extraction_id]) { audits[d.document_id] = checked[d.extraction_id]; continue; }
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
  let merged;
  try {
    merged = await callParser({ action: 'merge', batch_id: batchId });
  } catch (err) {
    await setBatchState(sb, batchId, 'failed', NOTE_MERGE_STOPPED);
    throw retryable(err);
  }
  return { batchId, docs, merged, audits, failures };
}

// ============================================================
// What an earlier run already left in the database
// ============================================================

/** The documents a batch was already cut into, in the shape segment returns. */
async function existingDocuments(sb, batchId) {
  const { data } = await sb.from('patient_documents')
    .select('id, doc_type, page_count, doc_index')
    .eq('batch_id', batchId).is('deleted_at', null).order('doc_index');
  return (data || []).map((d) => ({ document_id: d.id, doc_class: d.doc_type, pages: d.page_count }));
}

/** document_id -> the id of its LATEST reading, when that reading parsed.
 *  v_batch_documents already picks the latest per document. */
async function parsedReadings(sb, batchId) {
  const { data } = await sb.from('v_batch_documents')
    .select('document_id, extraction_id, extraction_status').eq('batch_id', batchId);
  const out = {};
  for (const r of data || []) {
    if (r.extraction_status === 'parsed' && r.extraction_id) out[r.document_id] = r.extraction_id;
  }
  return out;
}

/** extraction_id -> a finished second reading, rebuilt from sql/98's tables in
 *  the shape the audit call returns, so a resumed or reopened review marks the
 *  same disputes and never pre ticks a field the second reading disputed. */
async function finishedAudits(sb, batchId) {
  const { data: rows } = await sb.from('document_audits')
    .select('id, extraction_id, document_id, status, items, confirmed, disputed, unchecked, '
          + 'pages_checked, page_count')
    .eq('batch_id', batchId).in('status', ['ok', 'partial']);
  if (!rows?.length) return {};
  const { data: disputes } = await sb.from('document_field_audits')
    .select('audit_id, field_key, question, answer_shown, verdict, correct_value, evidence, '
          + 'page_no, certainty, audit_note')
    .in('audit_id', rows.map((r) => r.id)).eq('disputed', true);
  const out = {};
  for (const a of rows) {
    out[a.extraction_id] = {
      audit_id: a.id, extraction_id: a.extraction_id, status: a.status,
      summary: { items: a.items, confirmed: a.confirmed, disputed: a.disputed, unchecked: a.unchecked },
      pages_checked: a.pages_checked, page_count: a.page_count,
      disputes: (disputes || []).filter((x) => x.audit_id === a.id).map((x) => ({
        field_key: x.field_key, question: x.question,
        // stored as "(blank)" for display; the live call returns null
        answer_shown: /^\(blank/.test(x.answer_shown || '') ? null : x.answer_shown,
        verdict: x.verdict, correct_value: x.correct_value, evidence: x.evidence,
        page: x.page_no, certainty: x.certainty, audit_note: x.audit_note,
      })),
    };
  }
  return out;
}

/** Everything the review screen needs for a batch that finished reading in
 *  some earlier session, read back without calling the reader at all. */
async function loadBatchState(sb, batch) {
  const docs = await existingDocuments(sb, batch.id);
  const readings = await parsedReadings(sb, batch.id);
  const checked = await finishedAudits(sb, batch.id);
  const audits = {};
  for (const d of docs) {
    d.extraction_id = readings[d.document_id] ?? null;
    if (d.extraction_id && checked[d.extraction_id]) audits[d.document_id] = checked[d.extraction_id];
  }
  const { data: conflicts } = await sb.from('document_field_conflicts')
    .select('field_key, candidates, preferred_value, preferred_document_id, reason, benign')
    .eq('batch_id', batch.id);
  const { count: dupes } = await sb.from('document_pages')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batch.id).not('duplicate_of', 'is', null);
  return {
    batchId: batch.id, docs, audits, merged: { conflicts: conflicts || [] },
    dupes: dupes || 0, pageCount: batch.page_count,
    failures: docs.filter((d) => !d.extraction_id)
      .map((d) => `${label(d.doc_class)}: this document was not read`),
    leftOut: [], notes: [],
  };
}

/** The claim note for `now`, in IST to the minute, e.g.
 *  "Being finished now, started 25 Sep 2026 17:42 IST." */
export function claimNote(now = Date.now()) {
  const t = new Date(now + IST_MS);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${CLAIM_PREFIX}${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} ${hh}:${mm} IST.`;
}

/** When a claim note was written, in ms, or 0 for any other note. */
export function claimTime(note) {
  const m = /^Being finished now, started (\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}) IST\.$/
    .exec(note || '');
  if (!m || MONTHS.indexOf(m[2]) < 0) return 0;
  return Date.UTC(+m[3], MONTHS.indexOf(m[2]), +m[1], +m[4], +m[5]) - IST_MS;
}

/**
 * Take a stopped batch for this session, or learn that someone else has.
 *
 * The check "is anyone reading it" and the act of reading it were two steps,
 * so two people pressing Finish reading on the same batch at the same moment
 * could both sort its pages again, which duplicates its documents and pays for
 * the reading twice. One UPDATE that moves the status and writes a claim note
 * ONLY WHERE the status and note are still what this session saw is atomic in
 * Postgres: the second session's UPDATE matches no row.
 */
async function claimBatch(sb, batch, nextStatus) {
  let q = sb.from('document_batches')
    .update({ status: nextStatus, note: claimNote() })
    .eq('id', batch.id).eq('status', batch.status);
  q = batch.note === null || batch.note === undefined ? q.is('note', null) : q.eq('note', batch.note);
  const { data, error } = await q.select('id');
  return !error && (data || []).length === 1;
}

/** Pick a stopped batch up from wherever it stopped. */
async function resumeBatch(sb, batch, stage) {
  // someone may be driving it right now, in another tab or on another phone
  const { data: runs } = await sb.from('document_parse_runs')
    .select('status, started_at').eq('batch_id', batch.id);
  const live = (runs || []).some((r) => r.status === 'pending'
    && Date.now() - Date.parse(r.started_at) < STALLED_AFTER_MS);
  if (live) throw new Error('This upload is still being read somewhere else. Try again in a few minutes.');

  const { count } = await sb.from('document_pages')
    .select('id', { count: 'exact', head: true }).eq('batch_id', batch.id);
  if (!count) {
    await setBatchState(sb, batch.id, 'failed', NOTE_UPLOAD_STOPPED);
    throw new Error('This upload has no stored pages, so there is nothing to finish. Pick the files again.');
  }

  const hasDocs = (await existingDocuments(sb, batch.id)).length > 0;
  if (!(await claimBatch(sb, batch, hasDocs ? 'extracting' : 'segmenting'))) {
    throw new Error('Someone else is finishing this upload right now. Try again in a few minutes.');
  }

  const read = await readBatch(sb, batch.id, stage, { resume: true });
  // the claim is over; segment has already cleared it when it ran
  await sb.from('document_batches').update({ note: null })
    .eq('id', batch.id).like('note', `${CLAIM_PREFIX}%`);
  const { count: dupes } = await sb.from('document_pages')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batch.id).not('duplicate_of', 'is', null);
  return { ...read, dupes: dupes || 0, pageCount: count, leftOut: [], notes: [] };
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
// The progress window, shared by a new upload and a resumed one.
// Exported for tools/pdf_password_check.html, which drives it at phone width.
// ============================================================
export function openProgress(title, fileCount, onUserClose = null) {
  const busy = document.createElement('div');
  busy.innerHTML = `
    <div class="doc-progress">
      <div class="doc-progress-bar"><span id="dbp-bar" style="width:2%"></span></div>
      <p id="dbp-stage">Getting ready…</p>
      ${fileCount ? `<p class="form-hint">${fileCount} file(s). This can take a couple of minutes
      for a long PDF. You can leave this open.</p>` : ''}
    </div>
    <div data-pw-host hidden></div>
    <div class="doc-callout" data-left-out hidden style="margin-top:12px;text-align:left">
      <strong>${icon('info')} Left out of this upload</strong>
      <ul style="margin:6px 0 0 18px;list-style:disc;display:grid;gap:4px"></ul>
    </div>`;
  const overlay = showModal({ title, content: busy, size: 'md', onClose: onUserClose });
  if (onUserClose) {
    // Another dialog opening removes this one WITHOUT onClose. While a
    // password question may be open, losing the window has to mean stop, or
    // the upload would wait for ever for an answer nobody can give.
    const watch = new MutationObserver(() => {
      if (!overlay.isConnected) { watch.disconnect(); onUserClose(); }
    });
    watch.observe(document.body, { childList: true });
  }
  const stage = (msg, frac) => {
    const n = document.getElementById('dbp-stage');
    const b = document.getElementById('dbp-bar');
    if (n) n.textContent = msg;
    if (b && frac != null) b.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
  };
  const box = busy.querySelector('[data-left-out]');
  const leftOut = (item) => {
    box.hidden = false;
    const li = document.createElement('li');
    li.textContent = item.reason;
    box.querySelector('ul').appendChild(li);
  };
  return { stage, leftOut, asker: makePasswordAsker(busy.querySelector('[data-pw-host]')) };
}

// ============================================================
// The review, for a batch read just now or in an earlier session
// ============================================================
const PATIENT_COLUMNS = 'id, full_name, hospital_case_no, age, date_of_birth, city, state, pin_code, '
  + 'occupation, marital_status, gi_subtype, cancer_stage, tnm_stage, diagnosis_date, '
  + 'trajectory, treating_hospital, treating_doctor, hospital_unit, '
  + 'registration_category, caregiver_name, caregiver_relationship, nominee_name, '
  + 'nominee_relationship, railway_concession_from, railway_concession_to, '
  + 'family_income_annual_inr, '
  // v97
  + 'primary_site, histology, metastatic_sites, comorbidities, allergies, '
  + 'follow_up_date, follow_up_instruction';

async function loadPatient(sb, patientId) {
  const { data, error } = await sb.from('patients').select(PATIENT_COLUMNS)
    .eq('id', patientId).single();
  return error ? null : data;
}

/** The files and pages that did not make it in, so "Everything was read" is
 *  never what a mentor assumes about an upload that dropped a file. */
function renderLeftOut(result) {
  const items = [...(result.leftOut || []).map((x) => x.reason), ...(result.notes || [])];
  if (!items.length) return '';
  return `<div class="doc-callout doc-callout-warn" data-left-out-summary>
    <strong>${icon('alertTriangle')} ${items.length} thing${items.length > 1 ? 's' : ''} left out of
      this upload</strong>
    <ul style="margin:6px 0 0 18px;list-style:disc;display:grid;gap:4px">${
      items.map((m) => `<li>${sanitize(m)}</li>`).join('')}</ul>
    <p class="form-hint">Everything else was read. Upload a left out file on its own once you have it.</p>
  </div>`;
}

async function showBatchReview(sb, patient, patientId, result) {
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
    // The reading v_batch_documents calls the latest. A document read twice
    // (a resumed batch) also has an older failed reading, and taking whichever
    // came back first could hide the one that parsed.
    const ex = (extractions || []).find((e) => e.id === v.extraction_id)
      || (extractions || []).find((e) => e.document_id === v.document_id) || null;
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
    // Left at 'ready_for_review' it would ask for a review with nothing in it
    // every time anyone opened it. As 'failed' it offers Finish reading.
    await setBatchState(sb, result.batchId, 'failed', NOTE_READ_STOPPED);
    showToast('Nothing readable came back. The pages are still on file, and Upload documents '
      + 'on this patient can try reading them again.', 'error', 10000);
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
    ${renderLeftOut(result)}
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
    // Closing this used to be the end of the read: the batch stayed 'ready for
    // review' and nothing anywhere opened it again. Two sat for 16 and 26 days.
    onClose: () => showToast('Not saved yet. Nothing is lost: Upload documents on this patient '
      + 'opens this review again.', 'info', 8000),
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
      showToast(sanitize(applyErr.message), 'error');
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
}

// ============================================================
// Earlier uploads that stopped, or are waiting for a person
// ============================================================

/**
 * Until 25 Sep 2026 nothing ever came back for a batch once the tab that
 * started it was gone. Live that day: one batch 'segmenting' since 29 Aug, two
 * 'extracting' since 3 and 12 Sep, and two 'ready_for_review' for 16 and 26
 * days, because the review screen only existed at the end of the session that
 * read the pages. The patient's Documents tab said "read, waiting for you" and
 * offered nothing to click.
 *
 * So Upload documents lists them first. A batch is listed when it is waiting
 * for a review, when it failed after its pages were stored, or when it has
 * been quiet mid read for longer than STALLED_AFTER_MS.
 */
export async function findUnfinishedBatches(sb, patientId, now = Date.now()) {
  const { data: batches, error } = await sb.from('document_batches')
    .select('id, status, page_count, note, uploaded_at')
    .eq('patient_id', patientId).is('deleted_at', null)
    .in('status', ['uploading', 'segmenting', 'extracting', 'failed', 'ready_for_review'])
    .order('uploaded_at', { ascending: false }).limit(10);
  if (error || !batches?.length) return [];
  const { data: runs } = await sb.from('document_parse_runs')
    .select('batch_id, started_at, completed_at').in('batch_id', batches.map((b) => b.id));
  return batches
    .map((b) => classifyBatch(b, (runs || []).filter((r) => r.batch_id === b.id), now))
    .filter(Boolean);
}

/** What a batch needs, or null when it needs nothing from this screen. Pure,
 *  so tools/pdf_password_check.html can test the rules without a database. */
export function classifyBatch(batch, runs = [], now = Date.now()) {
  if (batch.status === 'ready_for_review') return { ...batch, action: 'review' };
  // no page was ever stored, so there is nothing to finish: pick the files again
  if (!(batch.page_count > 0)) return null;
  if (batch.status === 'failed') return { ...batch, action: 'resume' };
  if (!['uploading', 'segmenting', 'extracting'].includes(batch.status)) return null;
  // a claim is activity: someone pressed Finish reading and is on it
  const last = Math.max(Date.parse(batch.uploaded_at) || 0, claimTime(batch.note), ...runs.map((r) =>
    Math.max(Date.parse(r.started_at) || 0, Date.parse(r.completed_at) || 0)));
  return now - last > STALLED_AFTER_MS ? { ...batch, action: 'resume' } : null;
}

const STOPPED_WHERE = {
  uploading: 'before the pages were sorted',
  segmenting: 'while sorting the pages',
  extracting: 'while reading the documents',
};

function unfinishedRow(b) {
  const when = new Date(b.uploaded_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const pages = `${b.page_count} page${b.page_count === 1 ? '' : 's'}`;
  const review = b.action === 'review';
  // A stop note ends with how to reach this very list; here only its first
  // sentence, where it stopped, is news.
  const stoppedAt = b.status === 'failed' && b.note
    ? (b.note.match(/^.*?\.(\s|$)/)?.[0] || b.note).trim()
    : `Stopped ${STOPPED_WHERE[b.status] || 'before it finished'}.`;
  const why = review
    ? 'Read and waiting for someone to check it. Nothing from it is on the record yet.'
    : `${stoppedAt} Nothing is lost: the pages are saved.`;
  return `<div class="doc-callout ${review ? 'doc-callout-warn' : 'doc-callout-danger'}"
               data-unfinished="${b.id}">
    <strong>${icon(review ? 'fileText' : 'alertTriangle')} ${pages} uploaded on ${sanitize(when)}</strong>
    <p>${sanitize(why)}</p>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
      <button type="button" class="btn btn-primary btn-sm" data-go="${b.action}"
              data-batch="${b.id}">${review ? 'Review now' : 'Finish reading'}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-go="discard"
              data-batch="${b.id}">Discard</button>
    </div>
  </div>`;
}

/** Resolves with the batch to continue, { action: 'upload' }, or null when
 *  the window was closed. Discard happens here and the list repaints. */
function chooseUnfinished(sb, list) {
  return new Promise((resolve) => {
    let open = [...list];
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const el = document.createElement('div');
    const paint = () => {
      el.innerHTML = `<p style="margin:0 0 12px">${open.length
        ? 'Some documents uploaded earlier for this patient are not finished. Pick up where they '
          + 'stopped, or upload new ones.'
        : 'Nothing earlier is left unfinished.'}</p>${open.map(unfinishedRow).join('')}`;
    };
    paint();
    el.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-go]');
      const batch = btn && open.find((b) => b.id === btn.dataset.batch);
      if (!batch) return;
      if (btn.dataset.go !== 'discard') { closeModal(); finish(batch); return; }
      btn.disabled = true;
      const { error } = await sb.from('document_batches')
        .update({ status: 'discarded', reviewed_at: new Date().toISOString() }).eq('id', batch.id);
      if (error) { btn.disabled = false; showToast(sanitize(error.message), 'error'); return; }
      open = open.filter((b) => b.id !== batch.id);
      showToast('Discarded. The pages are still on file.', 'info');
      paint();
    });
    showModal({
      title: 'Earlier uploads for this patient', content: el, size: 'md',
      footer: '<button class="btn btn-primary" id="dbu-new">Upload new documents</button>',
      onClose: () => finish(null),
    });
    document.getElementById('dbu-new').addEventListener('click', () => {
      closeModal();
      finish({ action: 'upload' });
    });
  });
}

async function continueBatch(sb, patient, patientId, batch) {
  const ui = openProgress(batch.action === 'review' ? 'Opening the review' : 'Finishing the read', 0);
  try {
    const result = batch.action === 'review'
      ? await loadBatchState(sb, batch)
      : await resumeBatch(sb, batch, ui.stage);
    await showBatchReview(sb, patient, patientId, result);
  } catch (e) {
    closeModal();
    showToast(sanitize(e.message || 'Could not finish reading those documents'), 'error', 12000);
  }
}

/**
 * Finish or review ONE earlier upload, for a button on a batch in the
 * patient's Documents tab (js/pages/patients.js renderDocumentsTab), which
 * lists these batches but has nothing to click on them.
 */
export async function openExistingBatch(batchId) {
  const sb = getSupabase();
  const { data: batch } = await sb.from('document_batches')
    .select('id, patient_id, status, page_count, note, uploaded_at').eq('id', batchId).single();
  if (!batch) { showToast('Could not find that upload', 'error'); return; }
  const { data: runs } = await sb.from('document_parse_runs')
    .select('batch_id, started_at, completed_at').eq('batch_id', batchId);
  const item = classifyBatch(batch, runs || [], Date.now());
  if (!item) {
    showToast(batch.status === 'reviewed' || batch.status === 'discarded'
      ? 'This upload is already closed.'
      : 'This upload is still being read. Try again in a few minutes.', 'info');
    return;
  }
  const patient = await loadPatient(sb, batch.patient_id);
  if (!patient) { showToast('Could not load the patient', 'error'); return; }
  await continueBatch(sb, patient, batch.patient_id, item);
}

// ============================================================
// Entry point
// ============================================================
let drawingNow = false;   // an upload is drawing its files, and may be asking a question

export async function openDocumentBatch(patientId) {
  if (drawingNow) {
    showToast('An upload is still being prepared. Finish it or close it first.', 'info');
    return;
  }
  const sb = getSupabase();
  // In parallel: the file picker only opens while the click that asked for it
  // still counts as recent, so every round trip in front of it is a risk on a
  // slow phone.
  const [patient, consented, unfinished] = await Promise.all([
    loadPatient(sb, patientId),
    hasDocumentConsent(patientId).catch(() => false),
    findUnfinishedBatches(sb, patientId).catch(() => []),
  ]);
  if (!patient) { showToast('Could not load the patient', 'error'); return; }

  if (unfinished.length) {
    const choice = await chooseUnfinished(sb, unfinished);
    if (!choice) return;
    if (choice.action !== 'upload') {
      await continueBatch(sb, patient, patientId, choice);
      return;
    }
  }

  if (!consented) {
    const method = await askConsent(patientId, patient.full_name);
    if (!method) { showToast('Recorded that they did not agree', 'info'); return; }
    await recordConsent(patientId, true, method);
  }

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*,application/pdf';
  picker.multiple = true;
  picker.addEventListener('change', () => {
    uploadPicked(sb, patient, patientId, [...(picker.files || [])]);
  });
  picker.click();
}

async function uploadPicked(sb, patient, patientId, files) {
  if (!files.length) return;
  if (files.length > MAX_FILES) {
    showToast(`That is more than ${MAX_FILES} files. Send them in two goes.`, 'error');
    return;
  }

  // Closing the window while the files are still being drawn stops the
  // upload: nothing has been written yet, so stopping costs nothing, and a
  // question on screen cannot be answered once the window is gone. After the
  // drawing, it carries on in the background exactly as it always did.
  let drawing = true;
  let stopped = false;
  const ui = openProgress('Reading the documents', files.length, () => {
    if (!drawing) return;
    stopped = true;
    ui.asker.cancel();
  });

  let result;
  drawingNow = true;
  try {
    result = await uploadBatch(patientId, files, ui.stage, {
      asker: ui.asker, onLeftOut: ui.leftOut,
      isCancelled: () => stopped, onDrawn: () => { drawing = false; drawingNow = false; },
    });
  } catch (e) {
    drawingNow = false;
    if (!stopped) closeModal();
    if (e instanceof FileProblem && e.kind === 'stopped') {
      showToast('Stopped. Nothing was uploaded.', 'info');
      return;
    }
    showToast(sanitize(e.message || 'Could not read those documents'), 'error', 12000);
    return;
  }
  await showBatchReview(sb, patient, patientId, result);
}
