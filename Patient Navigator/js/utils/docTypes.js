// ============================================================
// Patient Navigator: the document vocabulary, staff side
//
// Mirrors public.document_types from sql/96. The database is the source of
// truth and the trigger there is what actually enforces the vocabulary; this
// is the label a mentor sees without a round trip, and the order the tick
// boxes appear in when she asks the family what they hold.
//
// The PATIENT-facing wording of the same keys lives in js/i18n/ under
// `doc.<key>`, in every language. These two lists must carry the same keys.
// scripts/_verify_96_resources.mjs checks that they do, against the live
// table, and fails loudly if anyone adds a document type to one and not the
// others.
//
// `commonly_missing` marks the papers the 24 August field report says
// families turn up without. Those are the ones worth asking about first.
// ============================================================

export const DOCUMENT_TYPES = [
  { key: 'aadhaar',                label: 'Aadhaar card',                    commonlyMissing: false },
  { key: 'ration_card',            label: 'Ration card',                     commonlyMissing: true  },
  { key: 'bpl_card',               label: 'BPL / yellow ration card',        commonlyMissing: true  },
  { key: 'income_certificate',     label: 'Income certificate',              commonlyMissing: true  },
  { key: 'domicile',               label: 'Domicile certificate',            commonlyMissing: true  },
  { key: 'caste_certificate',      label: 'Caste certificate',               commonlyMissing: true  },
  { key: 'disability_certificate', label: 'Disability certificate',          commonlyMissing: true  },
  { key: 'abha',                   label: 'ABHA health ID',                  commonlyMissing: false },
  { key: 'pan',                    label: 'PAN card',                        commonlyMissing: false },
  { key: 'bank_account',           label: 'Bank passbook or account',        commonlyMissing: false },
  { key: 'scheme_enrolment',       label: 'Existing scheme card',            commonlyMissing: false },
  { key: 'hospital_case_paper',    label: 'Hospital case paper',             commonlyMissing: false },
  { key: 'doctor_letter',          label: 'Letter from the doctor',          commonlyMissing: false },
  { key: 'medical_reports',        label: 'Medical reports',                 commonlyMissing: false },
  { key: 'cost_estimate',          label: 'Treatment cost estimate',         commonlyMissing: false },
  { key: 'referral_letter',        label: 'Referral from the hospital',      commonlyMissing: false },
  { key: 'address_proof',          label: 'Address proof',                   commonlyMissing: false },
  { key: 'passport_photo',         label: 'Passport photos',                 commonlyMissing: false },
  { key: 'photo_id',               label: 'Any photo ID',                    commonlyMissing: false },
];

export const DOC_LABELS = Object.fromEntries(DOCUMENT_TYPES.map(d => [d.key, d.label]));
export const docLabel = (key) => DOC_LABELS[key] || key;
