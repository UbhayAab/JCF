// ============================================================
// Patient Navigator: Document reads (review queue)
//
// WHAT THIS IS. Mentors have been writing down which papers a family holds,
// in prose, on the call, for months. 6,113 call logs, notes on 836 of the 871
// patients. None of it ever reached patients.documents_held, so the resource
// matcher could not filter on any of it and an NGO that demands an Ayushman
// card looked identical to one that does not.
//
// tools/read_documents_from_calls.cjs reads those notes and stages what it
// found in patient_document_reads. This screen is the human half. NOTHING
// reaches the patient record until someone here agrees.
//
// WHY A HUMAN AT ALL. An invented eligibility fact silently HIDES help from a
// family that qualified, and that failure is invisible: nobody ever sees the
// list they were not shown. So every read carries the mentor's own sentence,
// and the reviewer judges the sentence, not the machine.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';

let rows = [];
let filter = 'high';   // high | all
const busy = new Set();

const DOC_LABEL = {
  ration_card: 'Ration card',
  bpl_card: 'BPL card',
  scheme_enrolment: 'Ayushman / scheme card',
  income_certificate: 'Income certificate',
  domicile: 'Domicile certificate',
  caste_certificate: 'Caste certificate',
  disability_certificate: 'Disability certificate',
  aadhaar: 'Aadhaar',
  bank_account: 'Bank account',
};
const INCOME_LABEL = {
  bpl: 'Below poverty line',
  very_low: 'Very low income',
  low: 'Low income',
};

const label = (k) => DOC_LABEL[k] || k;

export async function renderDocReads(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Document reads</h1>
        <p class="header-subtitle" style="margin:4px 0 0">
          What our own call notes say a family holds. Agree and it goes on the patient record, where the resource matcher can use it.
        </p>
      </div>
      <button class="btn btn-secondary btn-sm" id="dr-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:var(--s2)">
      <div class="chip-row" id="dr-filter">
        <button type="button" class="fchip" data-f="high">High confidence</button>
        <button type="button" class="fchip" data-f="all">All pending</button>
      </div>
      <span class="due-meta" id="dr-count"></span>
    </div>
    <div id="dr-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading…</div></div>`;

  container.querySelector('#dr-refresh')?.addEventListener('click', () => load(container));
  container.querySelectorAll('#dr-filter .fchip').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    paint(container);
  }));
  await load(container);
}

async function load(container) {
  const body = container.querySelector('#dr-body');
  try {
    const { data, error } = await getSupabase()
      .from('v_document_reads_pending').select('*').limit(300);
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    if (body) body.innerHTML = `<div class="empty"><h4>Could not load the queue</h4><p>${sanitize(e.message)}</p></div>`;
    return;
  }
  paint(container);
}

const visible = () => (filter === 'all' ? rows : rows.filter((r) => r.confidence === 'high'));

function paint(container) {
  const body = container.querySelector('#dr-body');
  const count = container.querySelector('#dr-count');
  if (!body) return;
  container.querySelectorAll('#dr-filter .fchip')
    .forEach((b) => b.classList.toggle('active', b.dataset.f === filter));

  const list = visible();
  if (count) {
    const high = rows.filter((r) => r.confidence === 'high').length;
    count.textContent = rows.length ? `${rows.length} waiting, ${high} high confidence` : '';
  }

  if (!list.length) {
    body.innerHTML = `<div class="empty">
      <h4>Nothing waiting</h4>
      <p>${rows.length ? 'No high-confidence reads left. Switch to All pending to see the rest.'
    : 'Every staged read has been reviewed. Re-run the reader after the next round of calls.'}</p></div>`;
    return;
  }

  body.innerHTML = `<div class="due-list">
    ${list.map((r) => {
    const held = (r.documents_held || []).map((k) => `<span class="badge badge-ok">${sanitize(label(k))}</span>`).join(' ');
    const absent = (r.documents_absent || []).map((k) => `<span class="badge badge-warn">No ${sanitize(label(k))}</span>`).join(' ');
    const inc = r.income_band ? `<span class="badge badge-info">${sanitize(INCOME_LABEL[r.income_band] || r.income_band)}</span>` : '';
    const conf = r.confidence === 'high' ? 'badge-ok' : r.confidence === 'medium' ? 'badge-info' : 'badge-warn';
    return `
      <div class="due-item" data-row="${sanitize(r.patient_id)}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <strong>${sanitize(r.full_name || r.patient_code || 'Unnamed')}</strong>
          <span class="due-meta">${sanitize(r.patient_code || '')}${r.city ? ' · ' + sanitize(r.city) : ''}</span>
          <span class="badge ${conf}">${sanitize(r.confidence || '')}</span>
          <span style="flex:1"></span>
          <span class="due-meta">${formatRelativeTime(r.read_at)}</span>
        </div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${held}${absent}${inc}</div>
        <!-- The mentor's own words. The reviewer is judging THIS, not the machine. -->
        <blockquote style="margin:8px 0 0;padding:8px 10px;border-left:3px solid var(--border,#d7d7de);
          background:var(--surface-2,rgba(127,127,127,.07));border-radius:0 8px 8px 0;
          font-size:13px;line-height:1.45;color:var(--ink-2,inherit)">
          ${r.quote ? sanitize(r.quote) : '<em>No quote found. Do not agree without opening the call log.</em>'}
        </blockquote>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-agree="${sanitize(r.patient_id)}">Agree, add to record</button>
          <button class="btn btn-secondary btn-sm" data-reject="${sanitize(r.patient_id)}">Not right</button>
          <a class="btn btn-secondary btn-sm" href="#patients/${sanitize(r.patient_id)}">Open patient</a>
        </div>
      </div>`;
  }).join('')}
  </div>`;

  body.querySelectorAll('[data-agree]').forEach((b) => b.addEventListener('click', () => decide(container, b, b.dataset.agree, true)));
  body.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => decide(container, b, b.dataset.reject, false)));
}

async function decide(container, btn, patientId, agreed) {
  if (busy.has(patientId)) return;
  busy.add(patientId);
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = agreed ? 'Adding…' : 'Dismissing…';
  try {
    const me = getCurrentProfile();
    const { error } = await getSupabase().from('patient_document_reads')
      .update({ agreed, checked_by: me?.id || null, checked_at: new Date().toISOString() })
      .eq('patient_id', patientId);
    if (error) throw error;

    // Agreeing and changing the registry are two steps on purpose: sql/133
    // refuses to promote anything not already marked agreed, so a failure here
    // leaves a reviewed row that can be promoted again rather than a patient
    // record half-written.
    if (agreed) {
      const { error: pErr } = await getSupabase().rpc('promote_document_read', { p_patient: patientId });
      if (pErr) throw new Error(`Marked agreed, but the record was not updated: ${pErr.message}`);
    }
    rows = rows.filter((r) => r.patient_id !== patientId);
    showToast(agreed ? 'Added to the patient record' : 'Dismissed', 'success', 2000);
    paint(container);
  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = original;
  } finally {
    busy.delete(patientId);
  }
}
