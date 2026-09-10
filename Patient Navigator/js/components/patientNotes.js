// ============================================================
// Patient Navigator: the ground team's note stream
//
// Asked for on 08/09 by the Ground POC lead: "add a Notes section under
// Ground POC access in the dashboard, where the Ground POC can add relevant
// patient notes. This will allow the CGMP team to review the notes BEFORE
// contacting the patient."
//
// The word that decides the design is "before". A note the mentor reads after
// the call is a record; a note she reads before it changes the call. So this
// is one self-contained panel that mounts into whatever surface is in front of
// her at the moment she is about to dial:
//
//   the calling portal   left column, above the log form  (3-line hook)
//   the patient record   its own Notes tab
//   this morning         a line per patient on the brief card
//
// It reads through get_patient_notes_for_call (sql/125), NOT through plain
// patient_notes RLS, for the same reason calling.js uses RPCs everywhere: a
// coverage caller and anyone dialling an unassigned new lead hold a queue
// claim but fail the patients policy, and would get an empty panel with no
// error. The queue claim is the authorisation.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime, roleLabel } from '../utils/formatters.js';

// Who a note came from, said the way a mentor would say it.
const SOURCE_LABEL = {
  ground_poc: 'Ground team',
  uploader: 'Intake',
  system: 'Automatic',
};
const sourceOf = (n) =>
  SOURCE_LABEL[n.author_role] || (n.author_role ? roleLabel(n.author_role) : 'Team');

// A ground POC writes in paragraphs. Escape first, then give the line breaks
// back, or the whole note arrives as one run-on wall the mentor skips.
const nl2br = (s) => sanitize(s).replace(/\n/g, '<br>');

const KIND_TONE = { engagement: 'warn', handover: 'primary', ground: 'gold', general: 'neutral' };

export async function fetchPatientNotes(patientId) {
  const { data, error } = await getSupabase()
    .rpc('get_patient_notes_for_call', { p_patient_id: patientId });
  if (error) throw error;
  return data || [];
}

// One note, read-only. Used by the portal panel and the patient tab.
function noteRow(n, { canAck = false } = {}) {
  const ground = n.author_role === 'ground_poc';
  return `
    <div class="hist-row" data-note="${n.id}"
         style="flex-direction:column;gap:5px;align-items:stretch;${ground ? 'border-left:3px solid var(--gold);padding-left:10px' : ''}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="badge badge-${KIND_TONE[n.kind] || 'neutral'}">${sanitize(sourceOf(n))}</span>
        ${n.pinned ? `<span class="badge badge-danger">Read this first</span>` : ''}
        <span class="hist-meta">${sanitize(n.author_name || 'Unknown')} · ${formatRelativeTime(n.created_at)}</span>
        ${n.acknowledged_at
          ? `<span class="hist-meta" style="color:var(--ok)">Read by ${sanitize(n.acknowledged_by_name || 'a mentor')}</span>`
          : (canAck ? `<button type="button" class="btn btn-ghost btn-sm" data-ack-note="${n.id}"
                style="padding:1px 8px;font-size:12px">Mark read</button>` : '')}
      </div>
      <div class="hist-note">${nl2br(n.body)}</div>
    </div>`;
}

// ---- The panel -----------------------------------------------------------
// mount     an element to fill (it is emptied first)
// patientId the patient
// opts.compact   portal / brief styling: no heading chrome, capped height
// opts.canWrite  show the composer (true on the patient record, false mid-call
//                by default, because a mentor mid-call has the log form for
//                her own words and this stream is what somebody else told her)
// opts.title     panel heading
export async function renderNotesPanel(mount, patientId, opts = {}) {
  if (!mount) return;
  const { compact = false, canWrite = true, canAck = true,
          title = 'Notes from the ground team' } = opts;

  mount.innerHTML = `<div class="${compact ? 'strategy' : 'card'}" style="${compact ? '' : 'padding:16px 18px'}">
      <div class="info-label" style="margin-bottom:8px">${sanitize(title)}</div>
      <div class="due-meta">Loading…</div></div>`;

  let notes = [];
  let failed = null;
  try {
    notes = await fetchPatientNotes(patientId);
  } catch (e) {
    // An error and "nobody has written anything" are the same picture unless
    // this is checked, and the second one is a sentence a mentor acts on.
    // Same rule as sql/73 / brief.js.
    failed = e.message;
  }

  const composer = canWrite ? `
    <div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
      <textarea class="textarea" id="pn-body" rows="3"
        placeholder="What should the mentor know before she calls? What you saw, what the family said, the best time to reach them…"
        style="width:100%"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
        <span class="hist-meta" id="pn-count">0 / 4000</span>
        <button class="btn btn-primary btn-sm" id="pn-save">${icon('check')}Add note</button>
      </div>
    </div>` : '';

  const body = failed
    ? `<div class="due-meta" style="color:var(--danger)">Could not load the notes: ${sanitize(failed)}.
         That is not the same as there being none.</div>`
    : (notes.length
        ? `<div style="${compact ? 'max-height:260px;overflow-y:auto;padding-right:6px;' : ''}display:flex;flex-direction:column;gap:8px">
             ${notes.map(n => noteRow(n, { canAck })).join('')}
           </div>`
        : `<div class="due-meta">Nothing from the ground team yet.</div>`);

  mount.innerHTML = `
    <div class="${compact ? 'strategy' : 'card'}" style="${compact ? '' : 'padding:16px 18px'}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="strategy-ico">${icon('fileText')}</span>
        <div class="info-label" style="margin:0">${sanitize(title)}${notes.length ? ` · ${notes.length}` : ''}</div>
      </div>
      ${body}
      ${composer}
    </div>`;

  mount.querySelectorAll('[data-ack-note]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const { error } = await getSupabase().rpc('acknowledge_patient_note', { p_note_id: b.dataset.ackNote });
      if (error) throw error;
      await renderNotesPanel(mount, patientId, opts);
    } catch (e) { showToast('Could not mark it read: ' + e.message, 'error'); b.disabled = false; }
  }));

  if (!canWrite) return;
  const ta = mount.querySelector('#pn-body');
  const counter = mount.querySelector('#pn-count');
  ta?.addEventListener('input', () => { counter.textContent = `${ta.value.length} / 4000`; });
  mount.querySelector('#pn-save')?.addEventListener('click', async () => {
    const text = (ta?.value || '').trim();
    if (!text) { showToast('Write something first.', 'warning'); return; }
    const btn = mount.querySelector('#pn-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Saving…';
    try {
      const { error } = await getSupabase().rpc('add_patient_note', {
        p_patient_id: patientId, p_body: text, p_kind: opts.kind || 'ground',
      });
      if (error) throw error;
      showToast('Saved. The mentor sees it before she calls.', 'success');
      await renderNotesPanel(mount, patientId, opts);
    } catch (e) {
      showToast('Could not save the note: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}Add note`;
    }
  });
}

// Read-only, tiny: the one line the calling portal and the morning brief show
// without the mentor having to open anything.
export function groundNoteLine(n) {
  return `<div class="brief-line">${icon('fileText')}
    <span><strong style="color:var(--ink-2)">${sanitize(sourceOf(n))}</strong>
    ${sanitize(n.body).slice(0, 240)}${(n.body || '').length > 240 ? '…' : ''}</span></div>`;
}
