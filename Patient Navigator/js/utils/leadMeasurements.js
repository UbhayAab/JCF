// Optional intake measurements, in the same cm/kg/date format as the dashboard.
// Keep bounds in parity with components/measurements.js and native223.
export function leadMeasurementToday() {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
const value=v=>String(v??'').trim();
export function hasLeadMeasurement(row) {
  return ['weight_kg','height_cm','measured_on'].some(k=>value(row[k])!=='');
}
export function normalizeLeadRows(rows,today=leadMeasurementToday()) {
  return rows.map((row,i)=>{
    if(!hasLeadMeasurement(row))return {...row};
    const fail=message=>{throw Error(`Row ${i+1}: ${message}`);};
    const num=k=>value(row[k])===''?null:Number(row[k]);
    const weight_kg=num('weight_kg'),height_cm=num('height_cm'),measured_on=value(row.measured_on);
    if(weight_kg===null&&height_cm===null)fail('Enter height or weight, or clear the measurement date.');
    if(weight_kg!==null&&(!Number.isFinite(weight_kg)||weight_kg<15||weight_kg>250))fail('Weight must be between 15 and 250 kg.');
    if(height_cm!==null&&(!Number.isFinite(height_cm)||height_cm<60||height_cm>230))fail('Height must be between 60 and 230 cm.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(measured_on)||!Number.isFinite(Date.parse(`${measured_on}T00:00:00Z`))
      ||new Date(`${measured_on}T00:00:00Z`).toISOString().slice(0,10)!==measured_on||measured_on<'1900-01-01'||measured_on>today)fail('Enter a real measurement date, no later than today.');
    if(!['true','yes','1'].includes(value(row.measurement_consent).toLowerCase()))fail('Confirm that the family consented to recording these details and measurements.');
    return {...row,weight_kg,height_cm,measured_on,measurement_consent:true};
  });
}
export function leadMeasurementFields(prefix) {
  if(!/^[a-z][a-z0-9-]*$/.test(prefix))throw Error('Invalid form prefix');
  return `<fieldset style="min-width:0;border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0">
    <legend>Measurements (optional)</legend><div class="row" style="display:flex;gap:12px;flex-wrap:wrap">
    <div class="field" style="flex:1;min-width:120px"><label for="${prefix}-height">Height (cm)</label><input class="input" id="${prefix}-height" type="number" inputmode="decimal" min="60" max="230" step="any"></div>
    <div class="field" style="flex:1;min-width:120px"><label for="${prefix}-weight">Weight (kg)</label><input class="input" id="${prefix}-weight" type="number" inputmode="decimal" min="15" max="250" step="any"></div>
    <div class="field" style="flex:1;min-width:160px"><label for="${prefix}-measured">Measurement date</label><input class="input" id="${prefix}-measured" type="date" min="1900-01-01" max="${leadMeasurementToday()}"></div></div>
    <p class="form-hint">Leave blank if unavailable. If entering either measurement, use the actual date measured. These appear in the patient's measurement history.</p>
    <label style="display:flex;gap:8px;align-items:flex-start"><input id="${prefix}-measure-consent" type="checkbox"><span>The family consented to recording these patient details and measurements.</span></label>
    </fieldset>`;
}
export function readLeadMeasurement(root,prefix) {
  return {height_cm:root.querySelector(`#${prefix}-height`)?.value||'',weight_kg:root.querySelector(`#${prefix}-weight`)?.value||'',
    measured_on:root.querySelector(`#${prefix}-measured`)?.value||'',measurement_consent:root.querySelector(`#${prefix}-measure-consent`)?.checked===true};
}
