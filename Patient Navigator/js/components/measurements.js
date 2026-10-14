// Dated patient measurements. AI results are proposals; only an explicit save writes.
import { getSupabase } from '../supabase.js';
import { getUserRole } from '../auth.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (v) => v === null || v === undefined || v === '' ? null : Number(v);
const fmt = (v) => number(v) === null ? 'Not recorded' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const day = (v) => validMeasurementDate(v) ? new Date(`${v}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Date needed';
export function measurementToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function validMeasurementDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
    && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
}
export function normalizeMeasurement(values, today = measurementToday()) {
  const measured_on = String(values.measured_on ?? '').trim();
  if (!validMeasurementDate(measured_on) || measured_on > today || measured_on < '1900-01-01') throw new Error('Enter a real measurement date, no later than today.');
  const weight_kg = number(values.weight_kg), height_cm = number(values.height_cm);
  if (weight_kg !== null && (!Number.isFinite(weight_kg) || weight_kg < 15 || weight_kg > 250)) throw new Error('Weight must be between 15 and 250 kg.');
  if (height_cm !== null && (!Number.isFinite(height_cm) || height_cm < 60 || height_cm > 230)) throw new Error('Height must be between 60 and 230 cm.');
  if (weight_kg === null && height_cm === null) throw new Error('Enter weight or height, or both.');
  return { measured_on, weight_kg, height_cm };
}
export function measurementBmi(row) {
  const w = number(row?.weight_kg), h = number(row?.height_cm);
  return Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? Math.round(w / (h / 100) ** 2 * 10) / 10 : null;
}
export function summarizeMeasurements(rows = []) {
  const sorted = rows.filter((r) => validMeasurementDate(r.measured_on)).slice().sort((a, b) => a.measured_on.localeCompare(b.measured_on));
  const weights = sorted.filter((r) => number(r.weight_kg) !== null && Number.isFinite(number(r.weight_kg)));
  const heights = sorted.filter((r) => number(r.height_cm) !== null && Number.isFinite(number(r.height_cm)));
  const first = weights[0], latest = weights.at(-1), height = heights.at(-1);
  const change = first && latest && weights.length > 1 ? Number(latest.weight_kg) - Number(first.weight_kg) : null;
  return { rows: sorted, weights, latest, height, change, percent: change !== null && Number(first.weight_kg) > 0 ? change / Number(first.weight_kg) * 100 : null };
}
export function measurementSource(row, field) {
  const p = row.measurement_provenance?.[field];
  if (p?.kind === 'call') return 'Reviewed call';
  if (p?.kind === 'document') return 'Reviewed document';
  if (p?.kind === 'manual') return 'Manual entry';
  if (p) return 'Earlier entry';
  return row.source_document ? 'Reviewed document' : 'Earlier entry';
}
export function measurementTrend(rows) {
  const { weights } = summarizeMeasurements(rows);
  if (weights.length < 2) return '<p class="due-meta">A weight trend appears after two dated weights.</p>';
  const times = weights.map((r) => Date.parse(`${r.measured_on}T00:00:00Z`));
  const values = weights.map((r) => Number(r.weight_kg));
  const low = Math.min(...values), high = Math.max(...values), pad = Math.max(1, (high - low) * .15);
  const yLow = low - pad, yHigh = high + pad;
  const x = (t) => 72 + (t - times[0]) / Math.max(1, times.at(-1) - times[0]) * 416;
  const y = (v) => 132 - (v - yLow) / (yHigh - yLow) * 108;
  const points = weights.map((r, i) => `${x(times[i]).toFixed(1)},${y(values[i]).toFixed(1)}`).join(' ');
  return `<svg class="measurements-trend" viewBox="0 0 540 174" role="img" aria-label="Weight in kilograms over time. Exact dates and values are listed below." style="width:100%;max-height:230px;display:block;overflow:visible">
    <line x1="72" y1="132" x2="488" y2="132" stroke="var(--line)"/><line x1="72" y1="24" x2="72" y2="132" stroke="var(--line)"/>
    <text x="64" y="28" text-anchor="end" fill="var(--ink-2)" font-size="13">${esc(fmt(yHigh))}</text><text x="64" y="132" text-anchor="end" fill="var(--ink-2)" font-size="13">${esc(fmt(yLow))}</text><text x="64" y="157" text-anchor="end" fill="var(--ink-2)" font-size="12">kg</text>
    <polyline points="${points}" fill="none" stroke="var(--primary,var(--ink))" stroke-width="3"/>
    ${weights.map((r, i) => `<circle cx="${x(times[i]).toFixed(1)}" cy="${y(values[i]).toFixed(1)}" r="4" fill="var(--primary,var(--ink))"><title>${esc(day(r.measured_on))}: ${esc(fmt(r.weight_kg))} kg</title></circle>`).join('')}
    <text x="72" y="163" fill="var(--ink-2)" font-size="12">${esc(day(weights[0].measured_on))}</text><text x="488" y="163" text-anchor="end" fill="var(--ink-2)" font-size="12">${esc(day(weights.at(-1).measured_on))}</text></svg>`;
}
export function measurementHistoryHTML(rows) {
  const s = summarizeMeasurements(rows);
  const signed = (v) => `${v > 0 ? '+' : ''}${fmt(v)}`;
  return `<div class="kv measurements-summary" style="margin-bottom:12px">
    <div><div class="k">Latest weight</div><div class="v">${s.latest ? `${esc(fmt(s.latest.weight_kg))} kg` : 'Not recorded'}</div>${s.latest ? `<div class="due-meta">${esc(day(s.latest.measured_on))}</div>` : ''}</div>
    <div><div class="k">Latest height</div><div class="v">${s.height ? `${esc(fmt(s.height.height_cm))} cm` : 'Not recorded'}</div>${s.height ? `<div class="due-meta">${esc(day(s.height.measured_on))}</div>` : ''}</div>
    <div><div class="k">Overall weight change</div><div class="v">${s.change === null ? 'Two weights needed' : `${esc(signed(s.change))} kg (${esc(signed(s.percent))}%)`}</div>${s.change !== null ? `<div class="due-meta">Since ${esc(day(s.weights[0].measured_on))}</div>` : ''}</div>
    <div><div class="k">BMI at latest weight</div><div class="v">${s.latest && measurementBmi(s.latest) !== null ? esc(fmt(measurementBmi(s.latest))) : 'Same-date weight and height needed'}</div></div></div>
    ${measurementTrend(rows)}
    ${s.rows.length ? `<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">Measurement history (${s.rows.length})</summary><div style="overflow-x:auto;margin-top:10px"><table style="width:100%;font:var(--t-xs);border-collapse:collapse"><thead><tr>${['Date','Weight','Height','BMI','Source'].map((x) => `<th style="text-align:left;padding:8px;border-bottom:1px solid var(--line)">${x}</th>`).join('')}</tr></thead><tbody>${s.rows.slice().reverse().map((r) => `<tr><td style="padding:8px;white-space:nowrap">${esc(day(r.measured_on))}</td><td style="padding:8px;white-space:nowrap">${r.weight_kg == null ? '-' : `${esc(fmt(r.weight_kg))} kg`}</td><td style="padding:8px;white-space:nowrap">${r.height_cm == null ? '-' : `${esc(fmt(r.height_cm))} cm`}</td><td style="padding:8px">${measurementBmi(r) === null ? '-' : esc(fmt(measurementBmi(r)))}</td><td style="padding:8px">${[r.weight_kg != null ? `Weight: ${measurementSource(r,'weight_kg')}` : '', r.height_cm != null ? `Height: ${measurementSource(r,'height_cm')}` : ''].filter(Boolean).map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div></details>` : '<p class="due-meta">No measurements recorded yet.</p>'}`;
}

// A pure write boundary for local tests and all entry points. No suggestion calls it automatically.
export async function saveMeasurement(sb, patientId, values, { recordingId = null, overwrite = false, expectedVersion = null, allowed = () => true } = {}) {
  if (!allowed()) throw new Error('This measurement form is no longer active. Open the family record again.');
  const cleaned = normalizeMeasurement(values);
  const { data, error } = await sb.rpc('record_patient_measurement', { p_patient: patientId, p_measured_on: cleaned.measured_on,
    p_weight_kg: cleaned.weight_kg, p_height_cm: cleaned.height_cm, p_recording: recordingId,
    p_overwrite: overwrite, p_expected_version: expectedVersion });
  if (error) throw error;
  if (!data || !['saved', 'conflict'].includes(data.status)) throw new Error('Measurements could not be saved. Please try again.');
  return data;
}

// Inline in both Overview and an existing call modal: never opens a second modal.
export function mountMeasurementEditor(mount, patientId, opts = {}) {
  if (getUserRole() === 'content') { mount.innerHTML = ''; return { dispose() {} }; }
  const state = opts.state || { values: { measured_on: opts.suggestion ? (opts.suggestion.measured_on || '') : measurementToday(),
    weight_kg: opts.suggestion?.weight_kg ?? '', height_cm: opts.suggestion?.height_cm ?? '' } };
  let disposed = false;
  const active = () => !disposed && mount.isConnected && (!opts.allowed || opts.allowed());
  const render = () => {
    if (disposed) return;
    if (state.saved || state.skipped) { mount.innerHTML = `<p class="due-meta" role="status">${state.saved ? 'Measurements saved to the family record.' : 'Suggestion skipped. Nothing saved.'}</p>`; return; }
    mount.innerHTML = `${opts.suggestion ? `<p class="due-meta" style="overflow-wrap:anywhere">From the call${opts.suggestion.at ? ` at ${esc(opts.suggestion.at)}` : ''}: "${esc(opts.suggestion.evidence || '')}"</p><p class="due-meta">Check that these are the patient's measurements. Confirm when they were measured.</p>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin:10px 0">
      <label class="form-group" style="min-width:0;margin:0">Measured on<input class="form-input" data-measure="measured_on" aria-label="Measurement date" type="date" min="1900-01-01" max="${measurementToday()}" value="${esc(state.values.measured_on)}" ${state.saving ? 'disabled' : ''}></label>
      <label class="form-group" style="min-width:0;margin:0">Weight (kg)<input class="form-input" data-measure="weight_kg" aria-label="Weight in kilograms" type="number" inputmode="decimal" min="15" max="250" step="any" value="${esc(state.values.weight_kg)}" ${state.saving ? 'disabled' : ''}></label>
      <label class="form-group" style="min-width:0;margin:0">Height (cm)<input class="form-input" data-measure="height_cm" aria-label="Height in centimetres" type="number" inputmode="decimal" min="60" max="230" step="any" value="${esc(state.values.height_cm)}" ${state.saving ? 'disabled' : ''}></label></div>
      <p class="due-meta" data-measure-hint>${state.conflict ? `Already on ${esc(day(state.conflict.measured_on))}: ${state.conflict.weight_kg == null ? 'no weight' : `${esc(fmt(state.conflict.weight_kg))} kg`}, ${state.conflict.height_cm == null ? 'no height' : `${esc(fmt(state.conflict.height_cm))} cm`}. Numbers entered here replace the same fields. Blank fields and other measurements stay as they are.` : 'Enter one or both. BMI uses height and weight recorded on the same date.'}</p>
      ${state.conflict ? '<label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0;font:var(--t-xs)"><input type="checkbox" data-confirm-merge> I checked the existing entry. Save these values to that date.</label>' : ''}
      <p data-measure-error role="alert" style="color:var(--danger);font:var(--t-xs);overflow-wrap:anywhere">${esc(state.error || '')}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-primary btn-sm" data-measure-save ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving...' : state.conflict ? 'Confirm and save measurements' : 'Save measurements'}</button>${opts.suggestion ? `<button type="button" class="btn btn-ghost btn-sm" data-measure-skip ${state.saving ? 'disabled' : ''}>Skip suggestion</button>` : ''}</div>`;
    mount.querySelectorAll('[data-measure]').forEach((input) => input.addEventListener('input', () => {
      state.values[input.dataset.measure] = input.value;
      if (state.conflict) {
        state.conflict = null; state.error = '';
        mount.querySelector('[data-confirm-merge]')?.closest('label')?.remove();
        mount.querySelector('[data-measure-save]').textContent = 'Save measurements';
        mount.querySelector('[data-measure-error]').textContent = '';
        mount.querySelector('[data-measure-hint]').textContent = 'Values changed. Save to check the entry for this date again.';
      }
    }));
    mount.querySelector('[data-measure-skip]')?.addEventListener('click', () => { state.skipped = true; render(); });
    mount.querySelector('[data-measure-save]').addEventListener('click', async () => {
      if (state.saving || !active()) return;
      if (state.conflict && !mount.querySelector('[data-confirm-merge]')?.checked) { state.error = 'Check the confirmation box after reviewing the existing entry.'; mount.querySelector('[data-measure-error]').textContent = state.error; return; }
      const existing = state.conflict;
      state.saving = true; state.error = ''; render();
      try {
        const data = await saveMeasurement(opts.sb || getSupabase(), patientId, state.values, { recordingId: opts.recordingId,
          overwrite: !!existing, expectedVersion: existing?.measurement_version ?? null, allowed: active });
        if (data.status === 'conflict') { state.conflict = data.existing; state.error = existing ? 'This entry changed while you were checking it. Review the latest numbers and confirm again.' : ''; }
        else {
          state.saved = true;
          if (active()) { window.dispatchEvent(new CustomEvent('pn-measurements-saved', { detail: { patientId, sourceMount: mount } })); opts.onSaved?.(data); }
        }
      } catch (e) { state.error = e.message || 'Could not save measurements.'; }
      finally { state.saving = false; render(); opts.onStateChanged?.(); }
    });
  };
  render();
  return { dispose() { disposed = true; } };
}

export function mountCallMeasurements(mount, patientId, { suggestions = [], recordingId, state = {}, allowed, sb, onStateChanged } = {}) {
  if (!mount) return { dispose() {} };
  if (getUserRole() === 'content' || !recordingId || !Array.isArray(suggestions)) { mount.innerHTML = ''; return { dispose() {} }; }
  suggestions = suggestions.filter((s) => s && typeof s === 'object' && (s.weight_kg != null || s.height_cm != null)).slice(0,12);
  if (!suggestions.length) return { dispose() {} };
  mount.innerHTML = `<div class="pn-measures" style="border-top:1px solid var(--line);margin:12px 0;padding-top:12px"><strong>Measurements mentioned</strong><p class="due-meta">Review each suggestion, then save or skip it. Only entries marked saved are added to the family record.</p>${suggestions.map((_, i) => `<div data-call-measure="${i}" style="padding:10px 0;border-top:1px solid var(--line)"></div>`).join('')}</div>`;
  const editors = suggestions.map((s, i) => {
    state[i] ||= { values: { measured_on: s.measured_on || '', weight_kg: s.weight_kg ?? '', height_cm: s.height_cm ?? '' } };
    return mountMeasurementEditor(mount.querySelector(`[data-call-measure="${i}"]`), patientId, { suggestion: s, recordingId, state: state[i], allowed, sb, onStateChanged });
  });
  return { dispose() { editors.forEach((e) => e.dispose()); } };
}

export async function mountMeasurements(mount, patient, { onSaved, sb = getSupabase() } = {}) {
  if (!mount) return;
  if (getUserRole() === 'content') { mount.innerHTML = ''; return; }
  let editor;
  const load = async () => {
    const data = []; let error = null, after = null;
    // The unique(patient_id,measured_on) key makes this a stable cursor. Fetch
    // until empty, even if the API's configured cap is below our requested page.
    while (mount.isConnected) {
      let query = sb.from('patient_anthropometry').select('id,measured_on,weight_kg,height_cm,source_document,measurement_provenance,measurement_version,recorded_at').eq('patient_id', patient.id).order('measured_on').limit(1000);
      if (after) query = query.gt('measured_on', after);
      const result = await query;
      if (result.error) { error = result.error; break; }
      const batch = result.data || [];
      if (!batch.length) break;
      const next = batch.at(-1).measured_on;
      if (!validMeasurementDate(next) || (after && next <= after)) { error = { message: 'The history could not be loaded completely. Please try again.' }; break; }
      data.push(...batch); after = next;
    }
    if (!mount.isConnected) return;
    editor?.dispose();
    mount.innerHTML = `<div class="card pn-measures"><div class="card-header"><div class="card-title">Height and weight</div></div>${error ? `<p role="alert" class="due-meta">Could not load measurements. ${esc(error.message)}</p><button type="button" class="btn btn-secondary btn-sm" data-measure-retry>Try again</button>` : measurementHistoryHTML(data || [])}<details style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">Add or correct measurements</summary><div data-measure-editor style="margin-top:10px"></div></details></div>`;
    mount.querySelector('[data-measure-retry]')?.addEventListener('click', load);
    editor = mountMeasurementEditor(mount.querySelector('[data-measure-editor]'), patient.id, { sb, onSaved: () => { if (onSaved) onSaved(); else load(); } });
  };
  await load();
  if (!mount.isConnected) return;
  // A saved call can sit over this record. Refresh its history on acceptance.
  // The listener holds a WeakRef, so navigating away does not retain the record.
  measurementRefreshers.set(mount, load);
  const ref = new WeakRef(mount);
  const refresh = (event) => {
    const current = ref.deref();
    if (!current?.isConnected) { window.removeEventListener('pn-measurements-saved', refresh); return; }
    if (event.detail?.patientId === patient.id && !current.contains(event.detail?.sourceMount)) measurementRefreshers.get(current)?.();
  };
  window.addEventListener('pn-measurements-saved', refresh);
  return { dispose() { window.removeEventListener('pn-measurements-saved', refresh); editor?.dispose(); measurementRefreshers.delete(mount); } };
}
const measurementRefreshers = new WeakMap();
