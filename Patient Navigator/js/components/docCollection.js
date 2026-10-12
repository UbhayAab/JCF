// ============================================================
// Document collection (Fixboard #32, sql/183).
//
// "A button to mark when a patient is ready to share their documents and has
// given consent. Once I click on it, someone from our team can contact the
// patient and collect the required documents ... within two or three calls."
//
//   openReadyToShare     the consent script, how it was given, which papers
//                        the team needs; records a patient_consents row and
//                        opens (or adds to) the family's collection.
//   mountCollectStatus   one line on the record and the calling screen: the
//                        button, or who follows up, call N of 3, next call.
//   mountCollectionList  the follow-up list (the page, and the Calling Portal
//                        block): call, tap what happened, papers arrive.
// The database decides who sees what; everything shown goes through
// sanitize() before innerHTML.
// ============================================================
import { getSupabase } from '../supabase.js';
import { getUserRole, isImpersonating } from '../auth.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { showModal, closeModal, confirmModal } from './modal.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { DOCUMENT_TYPES } from '../utils/docTypes.js';
import { loadRoster, rosterSelectHTML, reasonText, historyHTML, forgetRoster } from './assignPicker.js';

const METHODS = [
  ['verbal_during_call', 'Verbally, on a call'],
  ['in_person', 'In person (at the hospital or a camp)'],
  ['written', 'In writing'],
  ['digital', 'Digitally (WhatsApp / form)'],
  ['guardian_consent', 'Given by a guardian'],
];
const methodLabel = (m) => (METHODS.find(([k]) => k === m)?.[1] || String(m || '').replace(/_/g, ' '));
const DEFAULT_NEEDED = ['medical_reports', 'hospital_case_paper'];
const DONE = { documents_arrived: 'Papers arrived', collected: 'All papers collected', not_needed: 'Not needed any more', declined: 'Does not want to share now' };
const isManager = () => ['admin', 'manager'].includes(getUserRole());
const timeIN = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const dayIN = (d) => {
  const x = new Date(d); const t = new Date();
  if (x.toDateString() === t.toDateString()) return 'today';
  const y = new Date(t); y.setDate(t.getDate() + 1);
  if (x.toDateString() === y.toDateString()) return 'tomorrow';
  return x.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};
const ago = (ms) => { const h = Math.floor(ms / 3600e3); const m = Math.round((ms % 3600e3) / 60e3); return h >= 24 ? `${Math.floor(h / 24)} d` : `${h ? `${h} h ` : ''}${m} min`; };
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : d; };
const telHref = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? `tel:+91${d}` : `tel:+${d}`; };

/**
 * "Ready to share documents (consent given)". Resolves the RPC answer, or
 * null when closed without saving. preferred: the consent method that is
 * true for the screen asking (a call, or the ground team in person).
 */
export function openReadyToShare(patientId, patientName, { preferred = 'verbal_during_call' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const el = document.createElement('div');
    el.innerHTML = `
      <p style="margin:0 0 12px">Mark this when ${sanitize(patientName || 'the family')} has agreed to share their papers with JCF.
      Someone from the team then calls them and collects the papers, within 2 or 3 calls.</p>
      <div class="doc-callout" style="margin-bottom:14px">
        <strong>Say this, in their language:</strong>
        <p style="margin:6px 0 0">"If you send me a photo of your hospital papers, we will read them so that we can help you better,
        and so you do not have to explain everything again on every call. We keep them safely. You can tell us to delete them at
        any time. Is that all right?"</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="rs-method">How did they agree?</label>
        <select class="form-select" id="rs-method">${METHODS.map(([k, l]) => `<option value="${k}" ${k === preferred ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="form-group">
        <div class="form-label">Which papers does the team need?</div>
        <div class="rs-docs" style="display:flex;flex-wrap:wrap;gap:6px">
          ${DOCUMENT_TYPES.map((d) => `<label class="fchip ${DEFAULT_NEEDED.includes(d.key) ? 'on' : ''}" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
            <input type="checkbox" value="${d.key}" ${DEFAULT_NEEDED.includes(d.key) ? 'checked' : ''} style="margin:0" />${sanitize(d.label)}</label>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="rs-note">Anything the caller should know? (optional)</label>
        <textarea class="form-input" id="rs-note" rows="2" maxlength="1000" placeholder="e.g. reports are with the son in Delhi; call after 5 pm"></textarea>
      </div>
      <div class="due-meta" id="rs-err" style="color:var(--danger);min-height:1em"></div>`;
    el.querySelectorAll('.rs-docs input').forEach((cb) => cb.addEventListener('change', () => cb.closest('label').classList.toggle('on', cb.checked)));
    let saving = false;
    showModal({
      title: 'Ready to share documents', content: el, size: 'md',
      footer: `<button class="btn btn-ghost" id="rs-cancel" type="button">Cancel</button>
               <button class="btn btn-primary" id="rs-save" type="button">${icon('checkCircle')}They agreed: mark ready</button>`,
      // Closed while saving: the save still finishes and answers.
      onClose: () => { if (!done && !saving) { done = true; resolve(null); } },
    });
    document.getElementById('rs-cancel')?.addEventListener('click', () => { done = true; closeModal(); resolve(null); });
    document.getElementById('rs-save')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; saving = true;
      const needed = [...el.querySelectorAll('.rs-docs input:checked')].map((x) => x.value);
      try {
        const { data, error } = await getSupabase().rpc('document_collection_mark', {
          p_patient: patientId, p_method: el.querySelector('#rs-method').value, p_needed: needed,
          p_note: el.querySelector('#rs-note').value || null,
        });
        if (error) throw error;
        done = true; saving = false;
        if (el.isConnected) closeModal();
        showToast(data?.already_open
          ? 'Updated. They were already on the Document collection list.'
          : data?.assigned_name
            ? `Marked. ${data.assigned_name} follows up, first call within a working day.`
            : 'Marked. A manager will pick who follows up.', 'success', 4000);
        resolve(data);
      } catch (err) {
        btn.disabled = false; saving = false;
        if (!el.isConnected) { done = true; resolve(null); showToast(err.message || 'Could not save.', 'error'); return; }
        el.querySelector('#rs-err').textContent = err.message || 'Could not save. Try again.';
      }
    });
  });
}

/** One line on the record or the call: the button, or where it stands. */
export async function mountCollectStatus(el, patientId, { patientName = '', preferred = 'verbal_during_call', onChange = null } = {}) {
  if (!el || !patientId) return;
  let c = null;
  try {
    const { data, error } = await getSupabase().rpc('document_collection_for_patient', { p_patient: patientId });
    if (error) throw error;
    c = data;
  } catch (e) {
    // Not deployed yet, or a network blip: the page around it still works.
    console.warn('[documents] collection status unavailable:', e.message);
    el.hidden = true; return;
  }
  if (!el.isConnected) return;
  // Not someone who cares for this family: nothing to show or press.
  if (c && c.visible === false) { el.hidden = true; el.innerHTML = ''; return; }
  const open = c && c.state === 'open';
  const recent = c && !open && c.done_at && Date.now() - Date.parse(c.done_at) < 30 * 86400e3;
  let line;
  if (open) {
    const due = c.next_due_at ? (Date.parse(c.next_due_at) < Date.now()
      ? `<span class="badge badge-danger">Next call overdue ${ago(Date.now() - Date.parse(c.next_due_at))}</span>`
      : `<span class="badge badge-info">Next call by ${timeIN(c.next_due_at)} ${dayIN(c.next_due_at)}</span>`) : '';
    line = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="badge badge-ok">${icon('fileText')}Ready to share documents</span>${due}</div>
      <div class="due-meta wraps" style="margin-top:4px">${c.assigned_to_me ? 'You follow up' : c.assigned_name ? `${sanitize(c.assigned_name)} follows up` : 'Waiting for a manager to pick who follows up'}
        · call ${Number(c.attempts) + (Number(c.attempts) < 3 ? 1 : 0)} of 3 · marked ${formatRelativeTime(c.marked_at)}${c.marked_by_name ? ` by ${sanitize(c.marked_by_name)}` : ''}
        · <a href="#doccollect">Document collection</a></div>`;
  } else if (isImpersonating()) {
    line = '<div class="due-meta wraps">Viewing as someone else: Ready to share documents is off.</div>';
  } else {
    line = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary btn-sm" data-ready>${icon('checkCircle')}Ready to share documents (consent given)</button>
        ${recent ? `<span class="due-meta">${sanitize(DONE[c.done_reason] || 'Closed')} ${formatRelativeTime(c.done_at)}</span>` : ''}</div>
      ${recent ? '' : '<div class="due-meta wraps" style="margin-top:4px">When the family agrees to share their papers: someone from the team then calls and collects them, within 2 or 3 calls.</div>'}`;
  }
  el.hidden = false;
  el.innerHTML = `<div class="card doc-collect-status" style="padding:10px 14px;margin:0 0 12px">${line}</div>`;
  el.querySelector('[data-ready]')?.addEventListener('click', async () => {
    const r = await openReadyToShare(patientId, patientName, { preferred });
    if (r) { await mountCollectStatus(el, patientId, { patientName, preferred, onChange }); onChange?.(r); }
  });
}

function dueBadge(x) {
  if (x.closed) return `<span class="badge badge-neutral">${sanitize(DONE[x.done_reason] || 'Closed')}</span>`;
  if (x.unassigned) return '<span class="badge badge-warn"><span class="dot"></span>Not assigned yet</span>';
  if (!x.next_due_at) return '';
  const late = Date.now() - Date.parse(x.next_due_at);
  const what = x.callback_at ? 'Call back' : x.attempts > 0 ? 'Next call' : 'First call';
  if (late > 0) return `<span class="badge badge-danger"><span class="dot"></span>${what}: overdue ${ago(late)}</span>`;
  return `<span class="badge ${late > -3600e3 ? 'badge-warn' : 'badge-info'}"><span class="dot"></span>${what}${x.callback_at ? '' : ' by'} ${timeIN(x.next_due_at)} ${dayIN(x.next_due_at)}</span>`;
}

const OUTCOMES = [
  ['reached', 'Reached: they will send', 'btn-primary'],
  ['no_answer', 'No answer', 'btn-secondary'],
  ['call_back', 'Call back later', 'btn-secondary'],
  ['collected', 'All papers collected', 'btn-secondary'],
  ['not_needed', 'Not needed', 'btn-ghost'],
  ['declined', 'Does not want to share now', 'btn-ghost'],
];

function cardHTML(x, roster) {
  const name = x.patient_name || x.patient_code || 'Name not on file';
  const canAct = !isImpersonating() && !x.closed && (x.assigned_to_me || x.marked_by_me || isManager());
  const last = [x.last_whatsapp_at ? `WhatsApp file ${formatRelativeTime(x.last_whatsapp_at)}` : null,
    x.last_upload_at ? `upload ${formatRelativeTime(x.last_upload_at)}` : null].filter(Boolean).join(' · ');
  return `
    <div class="card dc-item" data-dc="${sanitize(x.id)}" style="padding:12px 14px;${x.closed ? 'opacity:.7;' : ''}${x.overdue ? 'border-color:var(--danger);' : ''}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${dueBadge(x)}
        <a href="#patients/${sanitize(x.patient_id)}" style="font-weight:700;color:var(--ink-1)">${sanitize(name)}</a>
        <span style="flex:1"></span>
        <span class="due-meta">marked ${formatRelativeTime(x.marked_at)}${x.marked_by_name ? ` by ${sanitize(x.marked_by_name.split(' ')[0])}` : ''}</span>
      </div>
      <div class="due-meta wraps" style="margin-top:4px">Consent: ${sanitize(methodLabel(x.method))}${x.consent_stands === false ? ' · <span style="color:var(--danger)">later withdrawn</span>' : ''}</div>
      ${(x.needed_labels || []).length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
        ${x.needed_labels.map((d) => `<span class="badge badge-neutral">${sanitize(d.label)}</span>`).join('')}</div>` : ''}
      <div class="due-meta wraps" style="margin-top:6px">${x.closed
        ? `${sanitize(DONE[x.done_reason] || 'Closed')} ${formatRelativeTime(x.done_at)}${x.done_by_name ? `, ${sanitize(x.done_by_name.split(' ')[0])}` : ''}`
        : `Call ${Math.min(Number(x.attempts) + 1, 3)} of 3${x.attempts ? ` · ${x.attempts} made, last ${formatRelativeTime(x.last_attempt_at)}` : ''}`}
        ${!x.closed && !x.assigned_to_me && x.assigned_name ? ` · ${sanitize(x.assigned_name.split(' ')[0])} follows up${reasonText(x.assign_reason) ? ` (${sanitize(reasonText(x.assign_reason))})` : ''}` : ''}
        ${!x.closed && x.assigned_to_me ? ' · <span class="badge badge-ok">Yours</span>' : ''}</div>
      ${x.stuck ? '<div class="due-meta wraps" style="margin-top:4px;color:var(--clay)">Three calls and no papers yet. Talk to your manager about what is stopping them.</div>' : ''}
      ${last ? `<div class="due-meta wraps" style="margin-top:4px">Last papers: ${last}</div>` : ''}
      ${x.note ? `<div class="due-meta wraps" style="margin-top:4px;color:var(--ink-1)">Note: ${sanitize(x.note)}</div>` : ''}
      <div style="margin-top:10px">
        ${canAct ? `
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            ${x.phone ? `<a class="btn btn-gold btn-sm" href="${sanitize(telHref(x.phone))}">${icon('phoneCall')}${sanitize(fmtPhone(x.phone))}</a>` : ''}
            <button type="button" class="btn btn-secondary btn-sm" data-dc-invite title="WhatsApp them the HopeBot link to send their papers">${icon('message')}Send HopeBot papers link</button>
          </div>
          <textarea class="form-input dc-note" rows="2" maxlength="1000" placeholder="What did they say? (optional)" style="margin-top:8px;width:100%"></textarea>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            ${OUTCOMES.map(([v, l, cls]) => `<button type="button" class="btn ${cls} btn-sm" data-dc-out="${v}">${l}</button>`).join('')}
          </div>` : ''}
        ${!isImpersonating() && x.closed && x.done_reason !== 'declined' && (x.assigned_to_me || x.marked_by_me || isManager()) ? '<button type="button" class="btn btn-secondary btn-sm" data-dc-reopen>Still missing some: reopen</button>' : ''}
        ${!isImpersonating() && !x.closed && isManager() && roster ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">
          <span class="due-meta">Assign to</span>${rosterSelectHTML(roster, x.assigned_to, { attr: 'data-dc-assign', id: x.id, count: 'open_collections', currentName: x.assigned_name, onlyTeam: true })}</div>` : ''}
        ${isManager() ? historyHTML(x.events) : ''}
      </div>
    </div>`;
}

/**
 * The follow-up list. opts.compact (Calling Portal): only what is due within
 * the day, hidden when there is none. opts.scope 'mine' | 'all' (managers).
 */
export async function mountCollectionList(el, { scope = 'mine', compact = false, doneDays = 14, onCount = null } = {}) {
  if (!el) return;
  let all = []; let roster = null; let filter = 'open';
  const load = async () => {
    const { data, error } = await getSupabase().rpc('document_collection_list', { p_scope: scope, p_done_days: compact ? 0 : doneDays });
    if (error) throw error;
    all = Array.isArray(data) ? data : [];
    if (isManager() && !compact) {
      try { roster = await loadRoster('cgmp'); } catch (e) { roster = null; console.warn('[documents] roster:', e.message); }
    }
  };
  const paint = () => {
    if (!el.isConnected) return;
    const open = all.filter((x) => !x.closed);
    const soon = open.filter((x) => x.assigned_to_me && (x.overdue || (x.next_due_at && Date.parse(x.next_due_at) < Date.now() + 12 * 3600e3)));
    onCount?.(open.filter((x) => x.overdue).length);
    if (compact) {
      if (!soon.length) { el.hidden = true; el.innerHTML = ''; return; }
      el.hidden = false;
      el.innerHTML = `
        <div class="card card-flush">
          <div class="card-head"><h3>Documents to collect</h3><span class="badge ${soon.some((x) => x.overdue) ? 'badge-danger' : 'badge-info'}">${soon.length} due</span></div>
          <div style="padding:0 var(--s5) var(--s4)">
            <div class="due-meta wraps" style="margin-bottom:10px">These families agreed to share their papers. Call, collect them, tap what happened.</div>
            <div style="display:flex;flex-direction:column;gap:8px">${soon.map((x) => cardHTML(x, null)).join('')}</div>
            <a class="due-meta" href="#doccollect" style="display:inline-block;margin-top:8px">Open the full Document collection list</a>
          </div>
        </div>`;
      wire(); return;
    }
    const closed = all.filter((x) => x.closed);
    const shown = filter === 'open' ? open : filter === 'late' ? open.filter((x) => x.overdue)
      : filter === 'stuck' ? open.filter((x) => x.stuck) : filter === 'unassigned' ? open.filter((x) => x.unassigned) : closed;
    const chips = [['open', `Open ${open.length}`], ['late', `Due now ${open.filter((x) => x.overdue).length}`],
      ['stuck', `3 calls, no papers ${open.filter((x) => x.stuck).length}`],
      ...(isManager() ? [['unassigned', `Not assigned ${open.filter((x) => x.unassigned).length}`]] : []),
      ['done', `Done, last 14 days ${closed.length}`]];
    el.innerHTML = `
      <div class="chip-row" style="margin-bottom:12px">${chips.map(([k, l]) => `<button type="button" class="fchip ${filter === k ? 'on' : ''}" data-dcf="${k}">${l}</button>`).join('')}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${shown.map((x) => cardHTML(x, roster)).join('') || `<div class="card" style="padding:24px;text-align:center;color:var(--ink-3)">${
          all.length ? 'Nothing under this filter.' : 'No family is waiting for document collection. Mark a family on their record when they agree to share their papers.'}</div>`}
      </div>`;
    wire();
  };
  const act = async (btn, fn, args, msg) => {
    btn.disabled = true;
    try {
      const { error } = await getSupabase().rpc(fn, args);
      if (error) throw error;
      if (msg) showToast(msg, 'success', 3000);
    } catch (e) {
      showToast(e.message || 'That did not work. Try again.', 'error');
    }
    try { await load(); } catch {}
    paint();
  };
  const wire = () => {
    el.querySelectorAll('[data-dcf]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.dcf; paint(); }));
    el.querySelectorAll('.dc-item').forEach((card) => {
      const id = card.dataset.dc;
      const x = all.find((r) => r.id === id) || {};
      card.querySelectorAll('[data-dc-out]').forEach((b) => b.addEventListener('click', async (e) => {
        const btn = e.currentTarget; const out = btn.dataset.dcOut;
        const note = card.querySelector('.dc-note')?.value || null;
        let back = null;
        if (out === 'call_back') {
          const { pickCallbackTime } = await import('./callbackPicker.js');
          back = await pickCallbackTime(x.patient_name || 'they');
          if (!back) return;
        }
        const run = () => act(btn, 'document_collection_log', { p_id: id, p_outcome: out, p_note: note, p_callback_at: back }, {
          reached: 'Logged. The next call is due in 2 working days, unless the papers come first.',
          no_answer: 'Logged. Try again in about 4 working hours.',
          call_back: 'Logged. It comes due at the time they asked for.',
          collected: 'Done. Thank you.', not_needed: 'Closed.', declined: 'Recorded. Mark them ready again if they change their mind.',
        }[out]);
        if (out === 'declined') {
          confirmModal('This records that the family said no. Their papers cannot be uploaded until they agree again.', run,
            { title: 'Does not want to share now?', confirmLabel: 'Yes, they said no' });
          return;
        }
        run();
      }));
      card.querySelector('[data-dc-reopen]')?.addEventListener('click', (e) => act(e.currentTarget, 'document_collection_reopen', { p_id: id, p_note: null }, 'Reopened.'));
      card.querySelector('[data-dc-assign]')?.addEventListener('change', (e) => {
        forgetRoster();
        act(e.currentTarget, 'document_collection_assign', { p_id: id, p_to: e.currentTarget.value || null }, e.currentTarget.value ? 'Assigned.' : 'Back to automatic.');
      });
      card.querySelector('[data-dc-invite]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const { sendHopeBotInvite } = await import('./whatsappDocs.js');
          await sendHopeBotInvite(x.patient_id, x.patient_name || '');
        } catch (err) {
          showToast(err.message || 'Could not open the HopeBot invite. Try again.', 'error');
        } finally { btn.disabled = false; }
      });
    });
  };
  try {
    await load();
  } catch (e) {
    console.warn('[documents] collection list unavailable:', e.message);
    if (compact) { el.hidden = true; return; }
    el.innerHTML = `<div class="empty"><h4>Could not load the list</h4><p>${sanitize(e.message)}</p></div>`;
    return;
  }
  paint();
}
