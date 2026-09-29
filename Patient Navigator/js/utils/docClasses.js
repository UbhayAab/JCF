// ============================================================
// Patient Navigator: what the document reader calls each kind of page
//
// These are the classes the segmenter sorts an upload into
// (supabase/functions/doc-parse/schema_segment_v2.json), stored on
// patient_documents.doc_type and document_pages.doc_class. They are NOT the
// papers-a-family-holds vocabulary in docTypes.js, which is about what a
// scheme asks for.
//
// docBatch.js keeps its own copy for the review screen; this is the one every
// other screen reads, so the viewer, the portal and the upload log say the
// same word for the same page.
// ============================================================

export const DOC_CLASS_LABELS = {
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
  other: 'Other document', unknown: 'Unidentified page',
};

/** A class this file has not heard of shows as itself, readably. */
export function docClassLabel(cls) {
  return DOC_CLASS_LABELS[cls] || (cls ? String(cls).replace(/_/g, ' ') : 'Document');
}

// What a batch's status means to the person looking at it. Same words as the
// Documents tab (patients.js BATCH_STATUS) so the two never disagree.
export const UPLOAD_STATUS = {
  uploading: 'still uploading',
  segmenting: 'sorting the pages',
  extracting: 'being read',
  ready_for_review: 'read, waiting for review',
  reviewed: 'reviewed',
  discarded: 'discarded',
  failed: 'could not be read',
};
export const uploadStatusLabel = (s) => UPLOAD_STATUS[s] || String(s || '').replace(/_/g, ' ');
