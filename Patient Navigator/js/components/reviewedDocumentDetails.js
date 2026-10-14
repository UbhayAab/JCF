// Reviewed document details live in child tables (sql/90, 93, 97, 103).
// Read them through the caller's care-scoped client. Nothing here updates a
// patient, interprets a result, or mixes these rows with manually typed fields.
const mounts = new WeakMap();
const LIMIT = 20;
const LINE_LIMIT = 200;
const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});
const moneyFormat = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2,
});

const present = (v) => v !== null && v !== undefined && v !== ''
  && (!Array.isArray(v) || v.length > 0);
const words = (v) => String(v ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const date = (v) => {
  if (!present(v)) return '';
  const raw = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+05:30` : raw);
  return Number.isNaN(d.getTime()) ? raw : dateFormat.format(d);
};
const money = (v) => present(v) && Number.isFinite(Number(v)) ? moneyFormat.format(Number(v)) : String(v ?? '');
const unit = (suffix) => (v) => present(v) ? `${v} ${suffix}` : '';
const enums = (map) => (v) => map[v] || words(v);
function text(v) {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join('\n');
  if (v && typeof v === 'object') return Object.entries(v)
    .filter(([, value]) => present(value)).map(([key, value]) => `${words(key)}: ${text(value)}`).join('; ');
  return String(v ?? '');
}
const field = (key, label, format = text) => ({ key, label, format });
const dates = (...keys) => keys.map(([key, label]) => field(key, label, date));

const SECTIONS = [
  { table: 'patient_regimens', label: 'Regimens', title: 'regimen_name', fields: [
    field('regimen_name', 'Regimen'), field('intent', 'Intent', words), field('plan_no', 'Plan number'),
    field('total_cycles', 'Planned cycles'), field('cycle_length_days', 'Cycle length', unit('days')),
    ...dates(['started_on', 'Started'], ['next_cycle_date', 'Next cycle date']),
    field('status', 'Status saved', words), field('stop_reason', 'Reason stopped'),
    field('margin_instructions', 'Margin instructions'), field('superseded_print', 'Earlier print'),
  ] },
  { table: 'patient_treatment_cycles', label: 'Treatment cycles', title: null, fields: [
    field('cycle_number', 'Cycle number'), ...dates(['administered_on', 'Administered']),
    field('source', 'Date read from', words),
  ] },
  { table: 'patient_medications', label: 'Medicines', title: 'name', fields: [
    field('name', 'Medicine'), field('dose_raw', 'Dose as written'), field('dose_value', 'Dose value'),
    field('dose_unit', 'Dose unit'), field('dose_basis', 'Dose basis', enums({ flat: 'Flat dose', per_m2: 'Per m²', per_kg: 'Per kg', auc: 'AUC' })),
    field('dose_per_m2_raw', 'Dose per m² as written'), field('route', 'Route'), field('frequency', 'Frequency'),
    field('days_of_cycle', 'Days of cycle'), field('is_supportive', 'Supportive medicine'), field('regimen', 'Regimen'),
    ...dates(['administered_on', 'Administered'], ['stopped_at', 'Stopped']), field('superseded_print', 'Earlier print'),
  ] },
  { table: 'patient_procedures', label: 'Surgery and radiotherapy', title: 'name', fields: [
    field('kind', 'Kind', words), field('name', 'Procedure'), ...dates(['performed_on', 'Performed']),
    field('dose_gy', 'Radiotherapy dose', unit('Gy')), field('fractions', 'Fractions'),
  ] },
  { table: 'patient_anthropometry', label: 'Measurements from documents', title: null, fields: [
    ...dates(['measured_on', 'Measured']), field('weight_kg', 'Weight', unit('kg')), field('height_cm', 'Height', unit('cm')),
    field('bsa_m2', 'Body surface area', unit('m²')), field('muac_cm', 'Mid-upper arm circumference', unit('cm')),
    field('tsf_mm', 'Triceps skinfold', unit('mm')), field('calf_circ_cm', 'Calf circumference', unit('cm')),
    field('measured_by', 'Measured by'), field('measurement_context', 'Context'),
  ] },
  { table: 'patient_lab_results', label: 'Laboratory results', title: 'analyte', fields: [
    field('analyte', 'Test'), field('panel', 'Panel'), field('value_text', 'Result as written'), field('value_num', 'Numeric result'),
    field('unit', 'Unit'), field('ref_text', 'Reference as written'), field('ref_low', 'Reference low'), field('ref_high', 'Reference high'),
    field('flag', 'Flag saved', words), field('flag_source', 'Flag source', enums({ report: 'Report', computed: 'Reference range calculation', disagree: 'Report and range disagree' })),
    field('specimen', 'Specimen'), field('lab_name', 'Laboratory'), ...dates(['collected_at', 'Collected'], ['reported_at', 'Reported']),
    field('reported_by', 'Reported by'), field('requisition_no', 'Requisition number'),
  ] },
  { table: 'patient_biomarkers', label: 'Biomarkers from documents', title: 'marker', fields: [
    field('marker', 'Marker'), field('result', 'Result'), field('score', 'Score'), field('interpretation', 'Interpretation saved'),
    field('method', 'Method'), ...dates(['tested_on', 'Tested']), field('report_no', 'Report number'),
  ] },
  { table: 'patient_cost_certificates', label: 'Cost certificates', title: 'issuing_hospital', fields: [
    field('issuing_hospital', 'Hospital'), field('certificate_no', 'Certificate number'), field('certificate_series_no', 'Series number'),
    field('aa_no', 'AA number'), ...dates(['issued_on', 'Issued'], ['valid_till', 'Valid until'], ['registration_date', 'Registered']),
    field('case_file_no', 'Case file number'), field('registration_category', 'Registration category'),
    field('patient_name_on_doc', 'Name on document'), field('age_on_doc', 'Age on document'), field('gender_on_doc', 'Gender on document'),
    field('dmg_name', 'Disease management group'), field('diagnosis', 'Diagnosis'), field('prescribed_treatment', 'Prescribed treatment'),
    field('treatment_details', 'Treatment details'), field('estimated_duration', 'Estimated duration'), field('intent', 'Intent', words),
    field('estimated_total_inr', 'Estimated total', money), field('total_in_words', 'Total in words'), field('signed_by', 'Signed by'),
  ] },
  { table: 'patient_imaging_studies', label: 'Imaging', title: 'study_description', fields: [
    field('modality', 'Modality'), field('study_description', 'Study'), ...dates(['study_date', 'Study date'], ['reported_on', 'Reported'], ['comparison_study_date', 'Comparison study date']),
    field('indication', 'Indication'), field('technique', 'Technique'), field('impression', 'Impression'), field('findings', 'Findings'),
    field('lesions', 'Lesions as saved'), field('reported_by', 'Reported by'), field('requisition_no', 'Requisition number'),
  ] },
  { table: 'patient_pathology_reports', label: 'Pathology', title: 'diagnosis', fields: [
    field('report_kind', 'Kind', words), field('path_no', 'Pathology number'), field('requisition_no', 'Requisition number'),
    field('supplement_no', 'Supplement number'), field('nature_of_material', 'Material'), field('gross_description', 'Gross description'),
    field('microscopic', 'Microscopy'), field('impression', 'Impression'), field('diagnosis', 'Diagnosis'), field('differentiation', 'Differentiation'),
    ...dates(['reported_on', 'Reported'], ['received_on', 'Received']), field('reported_by', 'Reported by'), field('laboratory', 'Laboratory'),
  ] },
  { table: 'patient_devices', label: 'Devices', title: 'kind', fields: [
    field('kind', 'Kind', words), field('device_type', 'Device type'), ...dates(['inserted_on', 'Inserted'], ['removed_on', 'Removed'], ['counselled_on', 'Counselled']),
    field('inserted_by', 'Inserted by'), field('insertion_site', 'Insertion site'), field('arm', 'Arm'), field('vein', 'Vein'),
    field('size_lumen', 'Size / lumen'), field('puncture_attempts', 'Puncture attempts'), field('length_inside_cm', 'Length inside', unit('cm')),
    field('length_outside_cm', 'Length outside', unit('cm')), field('tip_position', 'Tip position'), field('mid_arm_circ_cm', 'Mid-arm circumference', unit('cm')),
    field('make', 'Make'), field('model_ref', 'Model'), field('dimensions', 'Dimensions'), field('gtin', 'GTIN'), field('lot_no', 'Lot number'),
    field('removal_reason', 'Removal reason'), field('counselled_by', 'Counselled by'),
  ] },
  { table: 'patient_endoscopies', label: 'Endoscopy', title: 'procedure_name', fields: [
    field('procedure_name', 'Procedure'), ...dates(['performed_on', 'Performed'], ['follow_up_on', 'Follow-up date']),
    field('indication', 'Indication'), field('sedation', 'Sedation'), field('extent_reached', 'Extent reached'), field('findings', 'Findings'),
    field('endotherapy', 'Endotherapy'), field('sampling', 'Sampling'), field('complications', 'Complications'), field('impression', 'Impression'),
    field('advice', 'Advice'), field('performed_by', 'Performed by'),
  ] },
  { table: 'patient_scheme_enrolments', label: 'Schemes and assistance', title: 'scheme', fields: [
    field('scheme', 'Scheme'), field('status', 'Status saved', words), field('card_present', 'Card held'), field('category', 'Category'),
    field('issuing_state', 'Issuing state'), ...dates(['valid_till', 'Valid until'], ['sanctioned_on', 'Sanctioned']),
    field('annual_cover_inr', 'Annual cover', money), field('sanctioned_inr', 'Sanctioned amount', money), field('sanctioned_by', 'Sanctioned by'), field('note', 'Note'),
  ] },
];

function node(tag, value = '', className = '', style = '') {
  const el = document.createElement(tag);
  if (value !== '') el.textContent = String(value);
  if (className) el.className = className;
  if (style) el.style.cssText = style;
  return el;
}

function detailRow(def, row, source, sourceFailed, lines = []) {
  const box = node('article', '', 'doc-callout', 'overflow-wrap:anywhere;min-width:0');
  const titleField = def.fields.find((f) => f.key === def.title);
  box.append(node('strong', titleField && present(row[def.title]) ? titleField.format(row[def.title]) : def.label));
  let provenance = `Saved ${date(row.recorded_at) || 'on an unknown date'} from a reviewed document`;
  if (source) {
    provenance += ` (${words(source.doc_type || 'document')}${source.document_date ? ', dated ' + date(source.document_date) : ''})`;
    if (source.deleted_at) provenance += '. Original source erased';
  } else if (!sourceFailed) provenance += '. Source document details unavailable';
  box.append(node('p', provenance + '.', 'due-meta wraps', 'margin:6px 0'));
  const values = node('dl', '', '', 'display:grid;grid-template-columns:minmax(90px,0.7fr) minmax(0,1.3fr);gap:6px 12px;margin:10px 0 0');
  for (const f of def.fields) {
    if (f.key === def.title || !present(row[f.key])) continue;
    values.append(node('dt', f.label, 'info-label'), node('dd', f.format(row[f.key]), '', 'margin:0;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere'));
  }
  if (values.children.length) box.append(values);
  if (lines.length) {
    box.append(node('p', 'Cost breakdown saved', 'info-label', 'margin:12px 0 4px'));
    const list = node('ul', '', '', 'margin:0;padding-left:20px');
    for (const line of lines) list.append(node('li', `${line.head}: ${money(line.amount_inr)}`));
    box.append(list);
  }
  return box;
}

/** Mount a read-only panel. Opening a section loads it; the Overview never waits. */
export function mountReviewedDocumentDetails(host, { patientId, sb } = {}) {
  if (!host) return () => {};
  const token = {};
  mounts.set(host, token);
  const panel = node('details', '', 'card', 'padding:16px 18px;min-width:0');
  const heading = node('summary', '', '', 'cursor:pointer;overflow-wrap:anywhere');
  heading.append(node('strong', 'Details saved from documents'));
  panel.append(heading, node('p', 'Open a section to see details a reviewer saved, with their source and dates.', 'due-meta wraps', 'margin:10px 0'));
  host.replaceChildren(panel);
  const current = () => mounts.get(host) === token && host.isConnected && host.contains(panel);
  if (!patientId || !sb?.from) {
    panel.append(node('div', 'These saved details could not be loaded.', 'doc-callout doc-callout-danger'));
    return () => { if (mounts.get(host) === token) mounts.delete(host); };
  }

  for (const def of SECTIONS) {
    const section = node('details', '', '', 'padding:10px 0;border-top:1px solid var(--line)');
    const summary = node('summary', `${def.label} - open to load`, '', 'cursor:pointer;overflow-wrap:anywhere');
    const body = node('div', '', '', 'margin-top:10px;min-width:0');
    section.append(summary, body);
    panel.append(section);
    let loading = false;
    let loaded = false;

    const retry = () => {
      const button = node('button', 'Try again', 'btn btn-secondary btn-sm');
      button.type = 'button';
      button.addEventListener('click', () => load(true));
      body.append(button);
    };
    async function load(force = false) {
      if (!current() || loading || (loaded && !force)) return;
      loading = true;
      body.replaceChildren(node('p', 'Loading saved details...', 'due-meta wraps'));
      summary.textContent = `${def.label} - loading`;
      try {
        const columns = ['id', 'source_document', 'recorded_at', ...def.fields.map((f) => f.key)];
        const result = await sb.from(def.table).select([...new Set(columns)].join(','), { count: 'exact' })
          .eq('patient_id', patientId).not('source_document', 'is', null)
          .order('recorded_at', { ascending: false }).order('id', { ascending: false }).limit(LIMIT);
        if (!current()) return;
        if (result.error) throw result.error;
        const rows = result.data || [];
        const total = Number.isInteger(result.count) ? result.count : null;
        const sourceIds = [...new Set(rows.map((r) => r.source_document).filter(Boolean))];
        const extra = await Promise.allSettled([
          sourceIds.length ? sb.from('patient_documents').select('id,doc_type,document_date,deleted_at')
            .eq('patient_id', patientId).in('id', sourceIds).limit(LIMIT) : Promise.resolve({ data: [] }),
          def.table === 'patient_cost_certificates' && rows.length
            ? sb.from('patient_cost_certificate_lines').select('id,certificate_id,head,amount_inr,line_order', { count: 'exact' })
              .in('certificate_id', rows.map((r) => r.id)).order('certificate_id').order('line_order').order('id').limit(LINE_LIMIT)
            : Promise.resolve({ data: [] }),
        ]);
        if (!current()) return;
        const sourceResult = extra[0].status === 'fulfilled' ? extra[0].value : { error: true };
        const lineResult = extra[1].status === 'fulfilled' ? extra[1].value : { error: true };
        const sources = new Map((sourceResult.data || []).map((d) => [d.id, d]));
        const lines = lineResult.data || [];
        summary.textContent = total === null ? `${def.label} - ${rows.length} shown`
          : `${def.label} - ${total} saved ${total === 1 ? 'entry' : 'entries'}`;
        body.replaceChildren();
        body.append(node('p', total === null
          ? `Showing ${rows.length} latest saved entries, by date saved. Total count unavailable.`
          : rows.length < total ? `Latest ${rows.length} of ${total} saved entries, by date saved.`
            : `${total} saved ${total === 1 ? 'entry' : 'entries'}, by date saved.`, 'due-meta wraps'));
        if (sourceResult.error) body.append(node('div', 'Source document details could not be loaded. Saved values are shown below.', 'doc-callout doc-callout-danger'));
        if (lineResult.error) body.append(node('div', 'Cost breakdown could not be loaded. Certificate details are shown below.', 'doc-callout doc-callout-danger'));
        if (def.table === 'patient_cost_certificates' && rows.length && !lineResult.error) {
          const lineCount = Number.isInteger(lineResult.count) ? lineResult.count : null;
          body.append(node('p', lineCount === null
            ? `Showing ${lines.length} cost breakdown lines for these certificates. Total line count unavailable.`
            : `Showing ${lines.length} of ${lineCount} cost breakdown lines for these certificates.`, 'due-meta wraps'));
        }
        if (!rows.length) body.append(node('p', 'No details saved from documents in this section.', 'due-meta wraps'));
        for (const row of rows) body.append(detailRow(def, row, sources.get(row.source_document), !!sourceResult.error,
          lines.filter((line) => line.certificate_id === row.id)));
        loaded = true;
        if (sourceResult.error || lineResult.error) retry();
      } catch {
        if (!current()) return;
        summary.textContent = `${def.label} - could not load`;
        body.replaceChildren(node('div', 'Could not load these saved details. Try again.', 'doc-callout doc-callout-danger'));
        retry();
      } finally {
        loading = false;
      }
    }
    section.addEventListener('toggle', () => { if (section.open) load(); });
  }
  return () => { if (mounts.get(host) === token) mounts.delete(host); };
}
