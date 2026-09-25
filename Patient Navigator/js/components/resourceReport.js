// ============================================================
// Patient Navigator: "What happened when the family tried them?"
//
// 24 Sep 2026, intern Vaishnavi: a family named two organisations from the
// financial resource PDF that fitted them and never picked up the phone.
// There was nowhere in the portal to write that down, so nothing learned it
// and the next family was sent the same numbers. The same complaint had been
// open since 24 Aug (work queue C2.2 to C2.7).
//
// This is the place to write it down, from the patient record, on the call:
// type three letters, tap the organisation, tap what happened, Save. One
// family can name several organisations in one go, and one that is not on
// our shelf (the old PDF or Sheet) can be recorded by the name the family
// used.
//
// It writes through public.report_resource_outcome() (sql/142), which runs as
// the signed-in mentor under RLS. Anything but "Helped" holds the
// organisation back from every WhatsApp send until somebody rings it and gets
// an answer, and puts it on the re-check list on the Resource Library page.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';

// The closed list. Each one is a field report that had nowhere to go:
// C2.3 no answer, C2.2 age limit, C2.4 office visit, C2.5 full, C2.7 papers.
export const OUTCOMES = [
  { key: 'no_answer',           label: 'Did not answer' },
  { key: 'age_limit',           label: 'Declined: age limit' },
  { key: 'must_visit_office',   label: 'Declined: must visit the office' },
  { key: 'full',                label: 'No rooms or places left' },
  { key: 'asked_for_documents', label: 'Asked for ration card or other papers' },
  { key: 'other',               label: 'Did not help, other reason' },
  { key: 'helped',              label: 'Helped' },
];

// Every reason that can be stored, including the ones families send on
// WhatsApp through HopeBot, in the mentor's words.
const LABELS = {
  ...Object.fromEntries(OUTCOMES.map((o) => [o.key, o.label])),
  did_not_help: 'Did not help',
  turned_away: 'Turned the family away',
  asked_for_money: 'Asked the family for money',
  too_far: 'Too far for the family',
  not_eligible: 'Said the family was not eligible',
  wrong_details: 'Our details for them were wrong',
};

export const reportLabel = (key) => LABELS[key] || String(key || '').replace(/_/g, ' ');

// {"no_answer": 2, "helped": 1} -> ["Did not answer, reported 2 times", "Helped, reported once"]
export function reportSummary(counts) {
  return Object.entries(counts || {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => (a[0] === 'helped') - (b[0] === 'helped') || b[1] - a[1])
    .map(([k, n]) => `${reportLabel(k)}, reported ${Number(n) === 1 ? 'once' : `${n} times`}`);
}

// Shelf search by name. Every word must appear, in any order, so
// "madat trust" finds "Madat Charitable Trust".
export async function searchShelf(text, limit = 8) {
  const words = String(text || '').replace(/[%_*,()\\"'.:]/g, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 4);
  if (!words.length || words.join('').length < 3) return [];
  let query = getSupabase().from('resources')
    .select('id, title, category, city, state, contact_phone')
    .eq('is_active', true);
  for (const w of words) query = query.ilike('title', `%${w}%`);
  const { data, error } = await query.order('title').limit(limit);
  if (error) throw error;
  return data || [];
}

const CATEGORY_WORD = { financial_aid: 'Money', accommodation: 'Stay' };

// One stylesheet, injected once on import, because this markup appears both
// in the modal and on the Resource Library page. .rr-note is a note that
// WRAPS: .due-meta is forced onto one truncated line on a phone.
(function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('rr-styles')) return;
  const s = document.createElement('style');
  s.id = 'rr-styles';
  s.textContent = `
    .rr-note{font:var(--t-xs);color:var(--ink-3);line-height:1.55}
    .rr-res{display:flex;flex-direction:column;gap:5px;margin-top:6px}
    .rr-res button{justify-content:flex-start;text-align:left;padding:8px 11px}
    .rr-pick{border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 12px;display:flex;flex-direction:column;gap:9px}
    .rr-pick .chip-row{gap:6px}
    .rr-pick .fchip{padding:6px 11px}
    .rr-pick .fchip.good.on{background:var(--ok);border-color:var(--ok)}
    .rr-hist{display:flex;flex-direction:column;gap:5px}
    .rr-hist div{font:var(--t-xs);color:var(--ink-2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}`;
  document.head.appendChild(s);
})();

// opts: { patient: { id, patient_code }, resource: { id, title, ... } | null, onSaved }
export async function openResourceReport({ patient = {}, resource = null, onSaved = null } = {}) {
  const sb = getSupabase();
  const me = getCurrentProfile() || {};
  const patientId = patient.id || null;
  const st = {
    picks: [],        // { key, resourceId, name, where, outcome, note }
    results: [],
    typed: '',
    sent: [],         // organisations we sent this family on WhatsApp
    history: [],      // what is already recorded for this family
    historyReady: false,
    busy: false,
  };
  // Declared before the first paint: the modal is live while the first load
  // is awaited, and a keystroke then must not meet a variable still in its
  // temporal dead zone (the browser test caught exactly that).
  let searchTimer = null;
  let searchSeq = 0;
  if (resource?.id) addPick({ resourceId: resource.id, name: resource.title, where: whereOf(resource) });

  const el = document.createElement('div');
  showModal({
    title: `What happened with an organisation${patient.patient_code ? ' · ' + esc(patient.patient_code) : ''}`,
    content: el, size: 'lg',
  });
  paint();
  el.querySelector('#rr-q')?.focus();
  await Promise.all([loadSent(), loadHistory()]);
  paint();
  focusSearch();

  // ------------------------------------------------------------ data
  async function loadSent() {
    if (!patientId) return;
    try {
      const { data } = await sb.from('resource_sends').select('resource_ids, created_at')
        .eq('patient_id', patientId).order('created_at', { ascending: false }).limit(6);
      const ids = [...new Set((data || []).flatMap((s) => s.resource_ids || []))].slice(0, 12);
      if (!ids.length) return;
      const { data: rows } = await sb.from('resources')
        .select('id, title, category, city, state').in('id', ids).eq('is_active', true);
      st.sent = rows || [];
    } catch { st.sent = []; }
  }

  async function loadHistory() {
    if (!patientId) { st.historyReady = true; return; }
    try {
      const { data, error } = await sb.from('resource_feedback')
        .select('id, resource_id, org_name, verdict, reason, source, reported_by, created_by, closed_at, created_at')
        .eq('patient_id', patientId).order('created_at', { ascending: false }).limit(20);
      if (error) throw error;
      const ids = [...new Set((data || []).map((f) => f.resource_id).filter(Boolean))];
      const titles = new Map();
      if (ids.length) {
        const { data: rows } = await sb.from('resources').select('id, title').in('id', ids);
        (rows || []).forEach((r) => titles.set(r.id, r.title));
      }
      st.history = (data || []).map((f) => ({ ...f, title: titles.get(f.resource_id) || f.org_name || 'An organisation' }));
    } catch { st.history = []; }
    st.historyReady = true;
  }

  // ------------------------------------------------------------ picks
  function addPick({ resourceId = null, name, where = '' }) {
    const key = resourceId ? `r:${resourceId}` : `n:${normName(name)}`;
    if (st.picks.some((p) => p.key === key)) return;
    st.picks.push({ key, resourceId, name: name || '', where, outcome: null, note: '' });
  }

  // ------------------------------------------------------------ paint
  function paint() {
    const exact = st.results.some((r) => normName(r.title) === normName(st.typed));
    const canName = normName(st.typed).length >= 3 && !exact;
    const ready = st.picks.length && st.picks.every(pickReady);
    el.innerHTML = `
      <p class="rr-note" style="margin:0 0 var(--s3)">Pick every organisation the family told you about, then what happened.
        Anything except "Helped" stops us sending it to any family until somebody rings them and gets through.</p>

      ${st.sent.length ? `
        <div class="form-group" style="margin-bottom:var(--s3)">
          <label class="form-label">We sent this family on WhatsApp</label>
          <div class="chip-row" id="rr-sent">
            ${st.sent.map((r) => `<button type="button" class="fchip" data-sent="${esc(r.id)}">${esc(clean(r.title))}</button>`).join('')}
          </div>
        </div>` : ''}

      <div class="form-group" style="margin-bottom:var(--s3)">
        <label class="form-label" for="rr-q">Organisation</label>
        <input class="input" id="rr-q" autocomplete="off" placeholder="Type 3 letters of its name" value="${esc(st.typed)}" />
        <div class="rr-res" id="rr-results">
          ${st.results.map((r) => `
            <button type="button" class="btn btn-ghost" data-pick="${esc(r.id)}">
              <span><strong>${esc(clean(r.title))}</strong>
              <span style="color:var(--ink-3);font-size:11.5px"> &middot; ${esc(whereOf(r))}</span></span>
            </button>`).join('')}
          ${canName ? `
            <button type="button" class="btn btn-ghost" id="rr-name" style="border:1px dashed var(--line)">
              <span>${icon('plus')} Not on our list: record <strong>"${esc(st.typed.trim())}"</strong> as the family named it</span>
            </button>` : ''}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:9px" id="rr-picks">
        ${st.picks.map((p, i) => pickHTML(p, i)).join('')}
      </div>

      ${historyHTML()}

      <div class="form-actions">
        <button class="btn btn-secondary" id="rr-cancel">Cancel</button>
        <button class="btn btn-primary" id="rr-save" ${ready && !st.busy ? '' : 'disabled'}>
          ${st.busy ? '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>' : icon('check')}
          ${st.picks.length > 1 ? `Save ${st.picks.length} reports` : 'Save'}</button>
      </div>`;
    wire();
  }

  function pickHTML(p, i) {
    return `
      <div class="rr-pick" data-i="${i}">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font:var(--t-body-strong);font-size:14px;flex:1">${esc(clean(p.name))}
            <span style="color:var(--ink-3);font-weight:400;font-size:11.5px">${p.resourceId ? ` &middot; ${esc(p.where)}` : ' &middot; not on our shelf'}</span></span>
          <button type="button" class="btn btn-ghost btn-sm" data-drop="${i}" aria-label="Remove" style="padding:3px 7px">${icon('x')}</button>
        </div>
        <div class="chip-row" role="radiogroup" aria-label="What happened">
          ${OUTCOMES.map((o) => `<button type="button" role="radio" aria-checked="${p.outcome === o.key}"
              class="fchip ${o.key === 'helped' ? 'good' : ''} ${p.outcome === o.key ? 'on' : ''}"
              data-out="${o.key}" data-i="${i}">${o.label}</button>`).join('')}
        </div>
        ${p.outcome === 'other' ? `
          <input class="input" data-note="${i}" value="${esc(p.note)}"
                 placeholder="How did it not help? (required) Do not write the family's name or number." />` : ''}
      </div>`;
  }

  function historyHTML() {
    if (!patientId || !st.historyReady || !st.history.length) return '';
    const dayAgo = Date.now() - 86400000;
    return `
      <div class="form-group" style="margin-top:var(--s4)">
        <label class="form-label">Already recorded for this family</label>
        <div class="rr-hist">
          ${st.history.map((h) => `<div>
            <span class="badge badge-${h.verdict === 'helped' ? 'ok' : 'danger'}">${esc(reportLabel(h.reason || h.verdict))}</span>
            <span>${esc(clean(h.title))}</span>
            <span style="color:var(--ink-3)">${esc(shortDate(h.created_at))}${h.source === 'whatsapp' ? ' &middot; the family, on WhatsApp' : ''}</span>
            ${canUndo(h, me.id, dayAgo)
              ? `<button type="button" class="btn btn-ghost btn-sm" data-undo="${esc(h.id)}" style="padding:2px 8px;font-size:11.5px">Undo</button>` : ''}
          </div>`).join('')}
        </div>
      </div>`;
  }

  // ------------------------------------------------------------ wiring
  function wire() {
    const input = el.querySelector('#rr-q');
    input?.addEventListener('input', (e) => {
      st.typed = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 220);
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (st.results[0]) pickResult(st.results[0].id);
    });
    el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pickResult(b.dataset.pick)));
    el.querySelectorAll('[data-sent]').forEach((b) => b.addEventListener('click', () => {
      const r = st.sent.find((x) => x.id === b.dataset.sent);
      if (r) { addPick({ resourceId: r.id, name: r.title, where: whereOf(r) }); paint(); }
    }));
    el.querySelector('#rr-name')?.addEventListener('click', () => {
      addPick({ name: st.typed.trim().replace(/\s+/g, ' ') });
      st.typed = ''; st.results = [];
      paint();
    });
    el.querySelectorAll('[data-out]').forEach((b) => b.addEventListener('click', () => {
      const p = st.picks[Number(b.dataset.i)];
      if (!p) return;
      p.outcome = b.dataset.out;
      paint();
      if (p.outcome === 'other') el.querySelector(`[data-note="${b.dataset.i}"]`)?.focus();
    }));
    el.querySelectorAll('[data-note]').forEach((inp) => inp.addEventListener('input', (e) => {
      const p = st.picks[Number(inp.dataset.note)];
      if (p) p.note = e.target.value;
      const btn = el.querySelector('#rr-save');
      if (btn) btn.disabled = !(st.picks.length && st.picks.every(pickReady)) || st.busy;
    }));
    el.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => {
      st.picks.splice(Number(b.dataset.drop), 1);
      paint();
    }));
    el.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', () => undo(b.dataset.undo)));
    el.querySelector('#rr-cancel')?.addEventListener('click', () => closeModal());
    el.querySelector('#rr-save')?.addEventListener('click', save);
  }

  async function runSearch() {
    const seq = ++searchSeq;
    let rows = [];
    try { rows = await searchShelf(st.typed); } catch (e) { showToast('Search failed: ' + e.message, 'error'); }
    if (seq !== searchSeq) return;          // a newer keystroke already won
    st.results = rows;
    paint();
    focusSearch();
  }

  function focusSearch() {
    const input = el.querySelector('#rr-q');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  function pickResult(id) {
    const r = st.results.find((x) => x.id === id);
    if (!r) return;
    addPick({ resourceId: r.id, name: r.title, where: whereOf(r) });
    st.typed = ''; st.results = [];
    paint();
  }

  async function undo(id) {
    const { error } = await sb.from('resource_feedback').delete().eq('id', id);
    if (error) { showToast('Could not undo: ' + error.message, 'error'); return; }
    showToast('Removed', 'info', 2000);
    await loadHistory();
    paint();
  }

  async function save() {
    if (st.busy || !st.picks.length || !st.picks.every(pickReady)) return;
    st.busy = true; paint();
    let saved = 0; let held = 0;
    const failed = [];
    for (const p of st.picks) {
      const { error } = await sb.rpc('report_resource_outcome', {
        p_outcome: p.outcome,
        p_resource: p.resourceId || null,
        p_org_name: p.resourceId ? null : p.name,
        p_patient: patientId,
        p_note: p.note.trim() || null,
      });
      if (error) { failed.push({ p, msg: friendly(error.message) }); continue; }
      saved++;
      if (p.outcome !== 'helped') held++;
    }
    st.busy = false;
    if (failed.length) {
      st.picks = failed.map((f) => f.p);
      paint();
      showToast(`${saved ? `Saved ${saved}. ` : ''}Could not save ${failed.map((f) => clean(f.p.name)).join(', ')}: ${failed[0].msg}`, 'error', 7000);
      return;
    }
    closeModal();
    showToast(held
      ? `Saved. ${held === 1 ? 'That organisation is' : `Those ${held} organisations are`} held back from WhatsApp until somebody rings and gets an answer.`
      : 'Saved. Thank you: this helps the next family.', 'success', 5000);
    if (typeof onSaved === 'function') onSaved();
  }
}

// ============================================================
// The re-check list: whoever maintains resources works from this
// ============================================================
// public.v_resource_needs_recheck (sql/142): one row per organisation a
// family could not reach or that turned them away, since the last time
// somebody rang it and got an answer, plus one row per organisation a family
// named that is not on our shelf at all. Those come from the old PDF and the
// Sheet it is built from, which is why this list downloads as a CSV: the
// Sheet can only be corrected by a person, outside the portal.

export async function loadRecheck() {
  const { data, error } = await getSupabase().from('v_resource_needs_recheck').select('*');
  if (error) throw error;
  return (data || []).sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'on_shelf' ? -1 : 1)
    || new Date(b.last_reported_at || 0) - new Date(a.last_reported_at || 0));
}

export function recheckHTML(rows, { isManager = false } = {}) {
  if (!rows.length) {
    return `<div class="empty" style="padding:36px 20px"><div class="ico-wrap">${icon('checkCircle')}</div>
      <h4>Nothing is held back</h4>
      <p>Every organisation a family reported has since been rung and answered.</p></div>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:var(--s3)">${rows.map((x, i) => recheckRowHTML(x, i, isManager)).join('')}</div>`;
}

function recheckRowHTML(x, i, isManager) {
  const onShelf = x.kind === 'on_shelf';
  const where = [(x.categories || '').split(', ').map((c) => CATEGORY_WORD[c] || c).filter(Boolean).join(' and '),
    x.city || x.state].filter(Boolean).join(' · ');
  const answered = x.last_answered_at
    ? `Last answered when we rang: ${shortDate(x.last_answered_at)}.`
    : 'Nobody has rung them and got through since.';
  const rings = x.unanswered_rings_since
    ? ` ${x.unanswered_rings_since} ring${x.unanswered_rings_since === 1 ? '' : 's'} with no answer since the first report.` : '';
  const actions = onShelf
    ? `<button type="button" class="btn btn-primary btn-sm" data-rc-ring="${i}">${icon('phoneCall')}Ring them</button>
       ${isManager ? `<button type="button" class="btn btn-secondary btn-sm" data-rc-edit="${i}">${icon('edit')}Edit</button>` : ''}`
    : (isManager
      ? `<button type="button" class="btn btn-secondary btn-sm" data-rc-add="${i}">${icon('plus')}Add to the shelf</button>
         <button type="button" class="btn btn-secondary btn-sm" data-rc-link="${i}">It is on the shelf as...</button>
         <button type="button" class="btn btn-ghost btn-sm" data-rc-close="${i}">Removed from the Sheet</button>`
      : '<span class="rr-note">A manager corrects the Sheet, then closes this here.</span>');
  return `
    <div class="card" style="padding:13px 15px;display:flex;flex-direction:column;gap:7px;border-left:4px solid var(${onShelf ? '--danger' : '--warn'})" data-rc="${i}">
      <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
        <span class="badge badge-${onShelf ? 'danger' : 'warn'}">${onShelf ? 'Held back from WhatsApp' : 'Not on our shelf'}</span>
        <strong style="font-size:14.5px">${esc(clean(x.organisation))}</strong>
        ${where ? `<span class="due-meta">${esc(where)}</span>` : ''}
        <span style="flex:1"></span>
        ${x.contact_phone ? `<a class="btn btn-ghost btn-sm tnum" href="tel:${esc(String(x.contact_phone).replace(/\s/g, ''))}" style="padding:3px 8px">${icon('phone')}${esc(x.contact_phone)}</a>` : ''}
      </div>
      <div style="font:var(--t-sm);color:var(--ink-1)">${esc(reportSummary(x.open_reasons).join(' · ') || 'Reported')}</div>
      <div class="rr-note">First reported ${esc(shortDate(x.first_reported_at))}, latest ${esc(shortDate(x.last_reported_at))}. ${onShelf ? answered + rings : 'It is not in the portal, so it can only reach a family through the old PDF or the Sheet.'}</div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">${actions}</div>
    </div>`;
}

// handlers: { onRing(row), onEdit(row), onAdd(row), onChanged() }
export function wireRecheck(root, rows, handlers = {}) {
  const at = (attr) => root.querySelectorAll(`[${attr}]`);
  const row = (b, attr) => rows[Number(b.getAttribute(attr))];
  at('data-rc-ring').forEach((b) => b.addEventListener('click', () => handlers.onRing?.(row(b, 'data-rc-ring'))));
  at('data-rc-edit').forEach((b) => b.addEventListener('click', () => handlers.onEdit?.(row(b, 'data-rc-edit'))));
  at('data-rc-add').forEach((b) => b.addEventListener('click', () => handlers.onAdd?.(row(b, 'data-rc-add'))));
  at('data-rc-link').forEach((b) => b.addEventListener('click', () => openLinkPicker(row(b, 'data-rc-link'), handlers.onChanged)));
  at('data-rc-close').forEach((b) => b.addEventListener('click', () => openCloseForm(row(b, 'data-rc-close'), handlers.onChanged)));
}

// A name from the PDF that is really an entry we already hold under another
// spelling: point the reports at it, and the hold and the re-check follow.
function openLinkPicker(x, onChanged) {
  const el = document.createElement('div');
  el.innerHTML = `
    <p class="rr-note" style="margin:0 0 var(--s3)">Families called it <strong>${esc(clean(x.organisation))}</strong>. Find the entry on our shelf that is the same organisation.</p>
    <input class="input" id="lp-q" autocomplete="off" placeholder="Type 3 letters of its name on the shelf" />
    <div class="rr-res" id="lp-res" style="display:flex;flex-direction:column;gap:5px;margin-top:6px"></div>
    <div class="form-actions"><button class="btn btn-secondary" id="lp-cancel">Cancel</button></div>`;
  showModal({ title: 'Link to a shelf entry', content: el, size: 'md' });
  el.querySelector('#lp-cancel').addEventListener('click', () => closeModal());
  const out = el.querySelector('#lp-res');
  let t = null;
  el.querySelector('#lp-q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      let rows = [];
      try { rows = await searchShelf(e.target.value); } catch (err) { out.innerHTML = `<div class="due-meta">${esc(err.message)}</div>`; return; }
      out.innerHTML = rows.map((r) => `<button type="button" class="btn btn-ghost" data-lp="${esc(r.id)}" style="justify-content:flex-start;text-align:left">
        <span><strong>${esc(clean(r.title))}</strong> <span style="color:var(--ink-3);font-size:11.5px">&middot; ${esc(whereOf(r))}</span></span></button>`).join('')
        || '<div class="due-meta">Nothing on the shelf by that name.</div>';
      out.querySelectorAll('[data-lp]').forEach((b) => b.addEventListener('click', async () => {
        const { data, error } = await getSupabase().rpc('attach_org_reports', { p_org_name: x.organisation, p_resource: b.dataset.lp });
        if (error) { showToast('Could not link: ' + error.message, 'error'); return; }
        closeModal();
        showToast(`Linked ${data} report${data === 1 ? '' : 's'}. It is held back until somebody rings and gets an answer.`, 'success', 5000);
        onChanged?.();
      }));
    }, 250);
  });
  el.querySelector('#lp-q').focus();
}

function openCloseForm(x, onChanged) {
  const el = document.createElement('div');
  el.innerHTML = `
    <p class="rr-note" style="margin:0 0 var(--s3)">Close the reports about <strong>${esc(clean(x.organisation))}</strong> once the Sheet and the PDF no longer send families to it.</p>
    <div class="form-group"><label class="form-label" for="cf-note">What was done</label>
      <input class="input" id="cf-note" value="Removed from the Sheet on ${esc(shortDate(new Date().toISOString()))}" /></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cf-cancel">Cancel</button>
      <button class="btn btn-primary" id="cf-save">${icon('check')}Close these reports</button>
    </div>`;
  showModal({ title: 'Removed from the Sheet', content: el, size: 'md' });
  el.querySelector('#cf-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#cf-save').addEventListener('click', async () => {
    const note = el.querySelector('#cf-note').value.trim();
    const { data, error } = await getSupabase().rpc('close_org_reports', { p_org_name: x.organisation, p_note: note });
    if (error) { showToast('Could not close: ' + error.message, 'error'); return; }
    closeModal();
    showToast(`Closed ${data} report${data === 1 ? '' : 's'}`, 'success');
    onChanged?.();
  });
}

// The Sheet is corrected by a person, so it gets a sheet. One row per
// organisation, in the order a person fixing the Sheet needs it.
export function recheckCsvColumns() {
  return [
    { label: 'Organisation', accessor: (x) => clean(x.organisation) },
    { label: 'On our shelf', accessor: (x) => (x.kind === 'on_shelf' ? 'Yes' : 'No') },
    { label: 'What to do in the Sheet', accessor: (x) => (x.kind === 'on_shelf'
      ? 'Mark as not answering until we ring them and get through; do not send it until then'
      : 'Not in the portal: remove it from the Sheet, or add it to the portal so it can be checked') },
    { label: 'Category', accessor: (x) => (x.categories || '').split(', ').map((c) => CATEGORY_WORD[c] || c).filter(Boolean).join(' and ') },
    { label: 'City', accessor: (x) => x.city || '' },
    { label: 'State', accessor: (x) => x.state || '' },
    { label: 'Phone', accessor: (x) => x.contact_phone || '' },
    { label: 'What families reported', accessor: (x) => reportSummary(x.open_reasons).join('; ') },
    { label: 'Reports since the last answered call', accessor: (x) => x.open_reports },
    { label: 'First reported', accessor: (x) => isoDay(x.first_reported_at) },
    { label: 'Last reported', accessor: (x) => isoDay(x.last_reported_at) },
    { label: 'Last answered when we rang', accessor: (x) => isoDay(x.last_answered_at) || 'Never' },
    { label: 'Rings with no answer since', accessor: (x) => x.unanswered_rings_since || 0 },
  ];
}

// ------------------------------------------------------------ helpers
// Mirrors the rf_undo policy (sql/142): only the person who first wrote the
// report, only while nobody else has revised it, never once closed, for a day.
function canUndo(h, myId, dayAgo) {
  return h.source === 'mentor' && !!myId && h.created_by === myId && h.reported_by === myId
    && !h.closed_at && new Date(h.created_at).getTime() > dayAgo;
}

function pickReady(p) {
  return !!p.outcome && (p.outcome !== 'other' || p.note.trim().length >= 3);
}

function friendly(msg) {
  if (/report_resource_outcome/.test(msg) && /(does not exist|Could not find)/i.test(msg)) {
    return 'the database has not been updated for this yet (sql/142). Nothing was saved.';
  }
  return msg;
}

function whereOf(r) {
  return [CATEGORY_WORD[r.category] || '', r.city || r.state || ''].filter(Boolean).join(', ') || 'on the shelf';
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const shortDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '');
// The day in India, as YYYY-MM-DD, so a report at 1 am IST is not filed
// under the previous day.
const isoDay = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Dash characters in stored text never reach the screen (sql/142 also
// rewrites them in the database; this covers rows written before it ran).
const clean = (s) => String(s ?? '').replace(/[\u2010-\u2015\u2212]/g, '-');
