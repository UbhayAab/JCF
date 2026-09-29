// ============================================================
// Patient Navigator: what a caller sees before she dials
//
// Reported 28 Sep 2026 by Aadrika, for the interns:
//   "The flag reason for the patients is not visible when we start taking the
//    call from the calling portal and we have to search separately after the
//    call because before taking the call, the patient is not visible at all
//    in the list."
// and, from the interns directly, "an option to mark/highlight one number as
// the primary or important contact number".
//
// The portal showed a band ("Needs attention: Concern open, this week") and
// never WHAT was flagged, and today's list showed a name and nothing else.
// Everything here renders one row of get_call_context() (sql/146). That RPC
// already filters every row through can_care_for_patient(), so nothing in this
// file decides who may see what: the database did, before the row arrived.
// ============================================================

import { getSupabase } from '../supabase.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';
import { concernReason, concernSeverity } from '../utils/catalog.js';
import { describeDocuments, fmtDay, daysAgo } from './docViewer.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** patient_id -> get_call_context row, for any number of families (100 per call). */
export async function loadCallContext(patientIds) {
  const ids = [...new Set((patientIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const sb = getSupabase();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.rpc('get_call_context', { p_patient_ids: ids.slice(i, i + 100) });
    if (error) throw error;
    for (const r of data || []) out.set(r.patient_id, r);
  }
  return out;
}

// Who put the flag there, in words that stay true for every role: a manual
// flag can come from a manager as easily as a mentor, and an automatic one
// names the person whose entry set it off (a screening, a call, an upload).
const flagOrigin = (f) => {
  const who = f.raised_by || '';
  if (f.from_document) return `Read off a document${who ? ' (' + who + ')' : ''}`;
  if (f.source === 'auto') return `Raised automatically${who ? ' from an entry by ' + who : ''}`;
  return who ? `Flagged by ${who}` : 'Flagged by the team';
};

/** Every open flag, most severe first, with the note someone actually wrote. */
export function flagCardHTML(flags, { title = '' } = {}) {
  const list = Array.isArray(flags) ? flags : [];
  if (!list.length) return '';
  const urgent = list.some((f) => f.severity === 'urgent');
  const head = title || (list.length === 1
    ? 'Flagged: read this before you dial'
    : `${list.length} open flags: read these before you dial`);
  return `
    <div class="flagcard ${urgent ? 'is-urgent' : ''}" data-flagcard>
      <div class="flagcard-head">${icon('flag')}<strong>${esc(head)}</strong></div>
      ${list.map((f) => {
        const r = concernReason(f.reason);
        const s = concernSeverity(f.severity);
        return `<div class="flag-item sev-${esc(f.severity)}">
          <div class="flag-item-head">
            <b>${esc(r.label)}</b>
            <span class="badge badge-${esc(s.tone)}">${esc(s.label)}</span>
            ${f.status === 'acknowledged' ? '<span class="badge badge-neutral">seen by a supervisor</span>' : ''}
            ${f.reassign_requested ? '<span class="badge badge-info">hand-over asked for</span>' : ''}
            ${f.resolve_requested ? '<span class="badge badge-neutral">marked resolved, awaiting review</span>' : ''}
          </div>
          ${f.note ? `<div class="flag-note">${esc(f.note)}</div>` : ''}
          <div class="flag-by">${esc(flagOrigin(f))} · ${esc(fmtDay(f.raised_at))} (${esc(daysAgo(f.raised_at))})</div>
        </div>`;
      }).join('')}
    </div>`;
}

/** The one-line version for a row in today's list: the worst flag, a count, the last upload. */
export function flagChipsHTML(ctx) {
  if (!ctx) return '';
  const flags = ctx.flags || [];
  const chips = [];
  if (flags.length) {
    const first = flags[0];
    chips.push(`<span class="wl-chip sev-${esc(first.severity)}" title="${esc(first.note || '')}">${icon('flag')}${esc(concernReason(first.reason).label)}</span>`);
    if (flags.length > 1) {
      chips.push(`<span class="wl-chip sev-${esc(flags[1].severity)}">+${flags.length - 1} more flag${flags.length > 2 ? 's' : ''}</span>`);
    }
  }
  const d = ctx.documents || {};
  if (d.last_upload_at) {
    chips.push(`<span class="wl-chip is-doc" title="${esc(describeDocuments(d))}">${icon('fileText')}Last document ${esc(fmtDay(d.last_upload_at))}</span>`);
  }
  return chips.length ? `<div class="wl-chips">${chips.join('')}</div>` : '';
}

const PHONE_LABEL = { patient: 'Patient', caregiver_1: 'Caregiver 1', caregiver_2: 'Caregiver 2', other: 'Other' };

/** The number to ring first: the one marked main, else the first in dial order. */
export function mainPhone(phones) {
  const list = (Array.isArray(phones) ? phones : []).filter((p) => p && p.phone);
  return list.find((p) => p.is_primary) || list[0] || null;
}

/** Every number the family gave, main one first, each with a Make main button. */
export function phoneListHTML(phones, { canEdit = true, dial = true } = {}) {
  const list = (Array.isArray(phones) ? phones : []).filter((p) => p && p.phone);
  if (!list.length) return '';
  return `<div class="ph-list" data-ph-list>${list.map((ph) => {
    const tel = String(ph.phone).replace(/\s/g, '');
    const who = `${PHONE_LABEL[ph.label] || ph.label || 'Number'}${ph.contact_name && ph.label !== 'patient' ? ' · ' + ph.contact_name : ''}${ph.relationship ? ' (' + ph.relationship + ')' : ''}`;
    const action = !canEdit || !ph.id || list.length < 2 ? ''
      : ph.is_primary
        ? `<button type="button" class="btn btn-ghost btn-sm ph-make" data-ph-clear="1" title="Go back to the usual order: patient, then caregivers">Unmark</button>`
        : `<button type="button" class="btn btn-ghost btn-sm ph-make" data-ph-make="${esc(ph.id)}" title="Everyone rings this number first from now on">${icon('star')}Make main</button>`;
    return `<div class="ph-row ${ph.is_primary ? 'is-main' : ''}">
      ${dial ? `<a class="ph-num" href="tel:${esc(tel)}">${esc(ph.phone)}</a>` : `<span class="ph-num">${esc(ph.phone)}</span>`}
      <span class="ph-who">${esc(who)}</span>
      ${ph.is_primary ? `<span class="ph-main-badge">${icon('star')}Main number</span>` : ''}
      ${action}
    </div>`;
  }).join('')}</div>`;
}

/** Wire the Make main / Unmark buttons inside `root`. onChanged(phoneIdOrNull) runs after the save. */
export function wirePhoneList(root, patientId, onChanged) {
  if (!root || !patientId) return;
  root.querySelectorAll('[data-ph-make],[data-ph-clear]').forEach((btn) => btn.addEventListener('click', async () => {
    const phoneId = btn.dataset.phMake || null;
    btn.disabled = true;
    try {
      const { error } = await getSupabase().rpc('set_primary_phone', { p_patient_id: patientId, p_phone_id: phoneId });
      if (error) throw error;
      showToast(phoneId
        ? 'Main number set. Everyone on the team rings it first from now on.'
        : 'Main number cleared. The usual order is back: patient, then caregivers.', 'success');
      if (onChanged) await onChanged(phoneId);
    } catch (e) {
      showToast('Could not change the main number: ' + (e.message || e), 'error');
      btn.disabled = false;
    }
  }));
}

/** Documents in one line, with View and Upload. */
export function docStripHTML(documents, { canUpload = true } = {}) {
  const d = documents || {};
  const extra = [
    d.waiting_review ? `${d.waiting_review} waiting for review` : '',
    d.still_reading ? `${d.still_reading} still being read` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="docstrip" data-docstrip>
    <span class="stat-ico ${d.uploads ? 'info' : 'neutral'}" style="width:32px;height:32px;border-radius:9px">${icon('fileText')}</span>
    <div class="docstrip-text">
      <div class="info-label">Documents</div>
      <div class="info-value">${esc(describeDocuments(d))}</div>
      ${extra ? `<div class="due-meta">${esc(extra)}</div>` : ''}
    </div>
    ${d.uploads ? `<button type="button" class="btn btn-secondary btn-sm" data-doc-view>${icon('eye')}View documents</button>` : ''}
    ${canUpload ? `<button type="button" class="btn btn-ghost btn-sm" data-doc-upload>${icon('upload')}Upload</button>` : ''}
  </div>`;
}
