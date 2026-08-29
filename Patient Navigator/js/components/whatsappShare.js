// ============================================================
// Patient Navigator: "Send resources on WhatsApp"
// A mentor on a call curates resources (filter by category, state,
// city, search; tick the ones that fit) and sends them straight to
// the patient / caregiver's WhatsApp, from the Jarurat Care business
// number, via the WPP resource-send edge function. Never a dump: the
// mentor picks exactly what to share.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { RESOURCE_CATEGORIES, resourceCategory } from '../utils/catalog.js';

const RESOURCE_SEND_URL = 'https://uhesnagqbmuyqiuzfhcv.supabase.co/functions/v1/resource-send';
const CAT_TONE = { accommodation: 'info', financial_aid: 'ok', travel: 'violet', food: 'warn', medicines: 'danger', other: 'neutral' };

// opts: { patient: {full_name, state, city, primary_language}, recipients: [{phone, label, name}] }
export async function openWhatsappShare({ patient = {}, recipients = [] } = {}) {
  const sb = getSupabase();
  const state = {
    rows: [], selected: new Set(), cat: 'all',
    stateF: patient.state || 'all', cityF: 'all', q: '',
    freeOnly: false, hasPhone: false, verifiedOnly: false,
    lang: /hind|^hi/i.test(patient.primary_language || '') ? 'hi' : 'en',
    recips: recipients.filter(r => r && r.phone),
    picked: new Set(recipients.length ? [0] : []),   // default: first number ticked
  };
  const FREE_RE = /\b(free|no charge|nominal|complimentary)\b|नि:?शुल्क|मुफ़्त/i;
  const isFree = (r) => FREE_RE.test([r.title, r.summary, r.eligibility].filter(Boolean).join(' '));
  const isVerified = (r) => r.verified_on && (Date.now() - new Date(r.verified_on).getTime()) / 86400000 <= 200;

  const el = document.createElement('div');
  el.innerHTML = `<div style="padding:6px 2px;color:var(--ink-3);font:var(--t-sm)">Opening the shelf…</div>`;
  showModal({ title: `Share resources on WhatsApp${patient.full_name ? ' · ' + sanitize(patient.full_name) : ''}`, content: el, size: 'xl' });

  try {
    const { data, error } = await sb.from('resources').select('*').eq('is_active', true).order('category').order('state');
    if (error) throw error;
    state.rows = data || [];
  } catch (e) {
    el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Couldn't open the library</h4><p>${sanitize(e.message)}</p></div>`;
    return;
  }
  if (!state.rows.length) {
    el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('mapPin')}</div><h4>No resources yet</h4><p>Add resources to the library first.</p></div>`;
    return;
  }

  paint();

  function filtered() {
    const q = state.q.toLowerCase();
    return state.rows.filter(r =>
      (state.cat === 'all' || r.category === state.cat) &&
      (state.stateF === 'all' || r.state === state.stateF) &&
      (state.cityF === 'all' || r.city === state.cityF) &&
      (!state.freeOnly || isFree(r)) &&
      (!state.hasPhone || !!r.contact_phone) &&
      (!state.verifiedOnly || isVerified(r)) &&
      (!q || [r.title, r.summary, r.city, r.state, r.eligibility].filter(Boolean).join(' ').toLowerCase().includes(q)));
  }
  // Cities available under the current state filter.
  function citiesForState() {
    return [...new Set(state.rows
      .filter(r => state.stateF === 'all' || r.state === state.stateF)
      .map(r => r.city).filter(Boolean))].sort();
  }

  function paint() {
    const states = [...new Set(state.rows.map(r => r.state).filter(Boolean))].sort();
    const list = filtered();
    const recipHTML = state.recips.length ? state.recips.map((r, i) => `
      <label class="wa-recip ${state.picked.has(i) ? 'on' : ''}" data-recip="${i}">
        <input type="checkbox" ${state.picked.has(i) ? 'checked' : ''} />
        <span>${icon('phone')}</span>
        <span style="flex:1;min-width:0"><span class="tnum" style="font-weight:600">${sanitize(r.phone)}</span>
        <span style="color:var(--ink-3);font-size:12px"> · ${sanitize(r.label || 'Number')}${r.name ? ' (' + sanitize(r.name) + ')' : ''}</span></span>
      </label>`).join('')
      : `<div style="color:var(--danger);font:var(--t-sm)">No phone number on file for this patient.</div>`;

    el.innerHTML = `
      <style>
        .wa-recip{display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid var(--line);border-radius:var(--r-sm);cursor:pointer;margin-bottom:6px;transition:all .15s}
        .wa-recip.on{border-color:var(--primary);background:var(--primary-soft)}
        .wa-recip svg{width:15px;height:15px;color:var(--ink-3)}
        .wa-res{display:flex;gap:11px;align-items:flex-start;padding:11px 12px;border:1px solid var(--line);border-radius:var(--r-sm);cursor:pointer;transition:all .15s}
        .wa-res.on{border-color:var(--primary);background:var(--primary-soft)}
        .wa-res input{margin-top:3px;width:18px;height:18px;flex:none;accent-color:var(--primary)}
        .wa-list{display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;padding-right:4px;margin-top:4px}
      </style>
      <div style="display:flex;flex-direction:column;gap:var(--s4)">
        <div>
          <div class="lever-group-title" style="margin-bottom:7px">Send to</div>
          ${recipHTML}
          <label class="check" style="margin-top:4px;font:var(--t-xs);color:var(--ink-3)">
            <span>Message language:</span>
            <select class="select" id="wa-lang" style="width:auto;min-width:110px;padding:4px 26px 4px 10px;font-size:12.5px">
              <option value="en" ${state.lang === 'en' ? 'selected' : ''}>English</option>
              <option value="hi" ${state.lang === 'hi' ? 'selected' : ''}>Hindi</option>
            </select>
          </label>
        </div>

        <div>
          <div class="lever-group-title" style="margin-bottom:7px">Pick what to send <span style="color:var(--ink-3);font-weight:400">(tick only what fits this family)</span></div>
          <div style="display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-bottom:9px">
            <div style="position:relative;flex:1;min-width:160px">
              <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--ink-3);display:inline-flex">${icon('search')}</span>
              <input class="input" id="wa-search" placeholder="Search: city, scheme, need…" value="${state.q.replace(/"/g, '&quot;')}" style="padding-left:32px" />
            </div>
            <select class="select" id="wa-state" style="width:auto;min-width:130px">
              <option value="all">All states</option>
              ${states.map(s => `<option value="${s}" ${state.stateF === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <select class="select" id="wa-city" style="width:auto;min-width:120px">
              <option value="all">All cities</option>
              ${citiesForState().map(c => `<option value="${c}" ${state.cityF === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="chip-row" id="wa-cats" style="margin-bottom:8px">
            <button type="button" class="fchip ${state.cat === 'all' ? 'on' : ''}" data-cat="all">All · ${state.rows.length}</button>
            ${RESOURCE_CATEGORIES.map(c => { const n = state.rows.filter(r => r.category === c.key).length; return n ? `<button type="button" class="fchip ${state.cat === c.key ? 'on' : ''}" data-cat="${c.key}">${c.label} · ${n}</button>` : ''; }).join('')}
          </div>
          <div class="chip-row" id="wa-toggles" style="margin-bottom:10px">
            <button type="button" class="fchip ${state.freeOnly ? 'on' : ''}" data-tog="freeOnly">${icon('check')}<span>Free / no-cost</span></button>
            <button type="button" class="fchip ${state.hasPhone ? 'on' : ''}" data-tog="hasPhone">${icon('phone')}<span>Has a number</span></button>
            <button type="button" class="fchip ${state.verifiedOnly ? 'on' : ''}" data-tog="verifiedOnly">${icon('shieldCheck')}<span>Verified recently</span></button>
          </div>
          <div class="wa-list" id="wa-list">
            ${list.length ? list.map(r => resRow(r)).join('') : `<div style="color:var(--ink-3);padding:16px;text-align:center">Nothing matches. Widen the filter.</div>`}
          </div>
          ${list.length > 60 ? `<div class="due-meta" style="margin-top:6px">Showing all ${list.length}: search or filter to narrow.</div>` : ''}
        </div>

        <div class="form-actions" style="margin-top:0">
          <span style="margin-right:auto;font:var(--t-sm);color:var(--ink-2)"><strong id="wa-count">${state.selected.size}</strong> selected${state.selected.size > 12 ? ' <span style="color:var(--warn)">(first 12 will send)</span>' : ''}</span>
          <button class="btn btn-secondary" id="wa-cancel">Cancel</button>
          <button class="btn btn-primary" id="wa-send" ${state.selected.size && state.picked.size ? '' : 'disabled'}>${icon('phone')}Send on WhatsApp</button>
        </div>
      </div>`;

    wire();
  }

  function resRow(r) {
    const cat = resourceCategory(r.category);
    const place = [r.city, r.state].filter(Boolean).join(', ');
    const on = state.selected.has(r.id);
    return `
      <label class="wa-res ${on ? 'on' : ''}" data-res="${r.id}">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="stat-ico ${CAT_TONE[r.category] || 'neutral'}" style="width:30px;height:30px;border-radius:8px;flex:none">${icon(cat.icon)}</span>
        <span style="flex:1;min-width:0">
          <span style="font:var(--t-body-strong);font-size:13.5px">${sanitize(r.title || 'Resource')}</span>
          <span style="display:block;font-size:11.5px;color:var(--ink-3);margin-top:1px">${cat.label}${place ? ' · ' + sanitize(place) : ''}${r.contact_phone ? ' · ' + sanitize(r.contact_phone) : ''}</span>
        </span>
      </label>`;
  }

  function wire() {
    let t = null;
    el.querySelector('#wa-search')?.addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); repaintList(); }, 220); });
    el.querySelector('#wa-state')?.addEventListener('change', (e) => { state.stateF = e.target.value; state.cityF = 'all'; paint(); });
    el.querySelector('#wa-city')?.addEventListener('change', (e) => { state.cityF = e.target.value; repaintList(); });
    el.querySelector('#wa-lang')?.addEventListener('change', (e) => { state.lang = e.target.value; });
    el.querySelectorAll('#wa-cats .fchip').forEach(c => c.addEventListener('click', () => { state.cat = c.dataset.cat; repaintList(); }));
    el.querySelectorAll('#wa-toggles .fchip').forEach(b => b.addEventListener('click', () => { state[b.dataset.tog] = !state[b.dataset.tog]; paint(); }));
    el.querySelectorAll('[data-recip]').forEach(l => l.addEventListener('change', () => {
      const i = Number(l.dataset.recip);
      if (l.querySelector('input').checked) state.picked.add(i); else state.picked.delete(i);
      l.classList.toggle('on', l.querySelector('input').checked);
      updateSend();
    }));
    bindResRows();
    el.querySelector('#wa-cancel')?.addEventListener('click', () => closeModal());
    el.querySelector('#wa-send')?.addEventListener('click', send);
  }

  function bindResRows() {
    el.querySelectorAll('[data-res]').forEach(l => l.addEventListener('change', () => {
      const id = l.dataset.res;
      if (l.querySelector('input').checked) state.selected.add(id); else state.selected.delete(id);
      l.classList.toggle('on', l.querySelector('input').checked);
      updateSend();
    }));
  }

  // Repaint only the list + count (keeps recipient/lang selections and focus intent)
  function repaintList() {
    const list = filtered();
    const listEl = el.querySelector('#wa-list');
    if (listEl) listEl.innerHTML = list.length ? list.map(r => resRow(r)).join('') : `<div style="color:var(--ink-3);padding:16px;text-align:center">Nothing matches. Widen the filter.</div>`;
    el.querySelectorAll('#wa-cats .fchip').forEach(c => c.classList.toggle('on', c.dataset.cat === state.cat));
    bindResRows();
    updateSend();
  }

  function updateSend() {
    const cnt = el.querySelector('#wa-count');
    if (cnt) cnt.innerHTML = state.selected.size + (state.selected.size > 12 ? '</strong> selected <span style="color:var(--warn)">(first 12 will send)' : '');
    const btn = el.querySelector('#wa-send');
    if (btn) btn.disabled = !(state.selected.size && state.picked.size);
  }

  async function send() {
    const btn = el.querySelector('#wa-send');
    const chosen = state.rows.filter(r => state.selected.has(r.id)).slice(0, 12);
    const recips = [...state.picked].map(i => state.recips[i]).filter(Boolean)
      .map(r => ({ phone: r.phone, name: r.name || patient.full_name }));
    if (!chosen.length || !recips.length) return;
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Sending…';
    try {
      const { data: sess } = await sb.auth.getSession();
      const token = sess?.session?.access_token;
      if (!token) { showToast('Your session expired. Please sign in again', 'error'); return; }
      const me = getCurrentProfile() || {};
      const payload = {
        patientName: patient.full_name || '',
        lang: state.lang,
        mentorId: me.id || null,
        pocName: me.full_name || null,
        pocPhone: me.phone || null,
        pnPatientId: patient.id || patient.patient_id || null,
        recipients: recips,
        resources: chosen.map(r => ({
          title: r.title, category: r.category, city: r.city, state: r.state,
          summary: r.summary, eligibility: r.eligibility, contact_phone: r.contact_phone, link: r.link, address: r.address,
        })),
      };
      const res = await fetch(RESOURCE_SEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      const results = body.results || [];
      const okN = results.filter(r => r.ok).length;
      const failN = results.length - okN;
      const windowClosed = results.some(r => !r.ok && /template_unavailable|window|re-?engagement|24/i.test(String(r.error || '')));

      if (res.ok && okN) {
        closeModal();
        let msg = `Sent ${chosen.length} resource${chosen.length === 1 ? '' : 's'} to ${okN} number${okN === 1 ? '' : 's'} on WhatsApp`;
        if (failN) msg += ` · ${failN} couldn't be reached`;
        showToast(msg, 'success');
      } else if (windowClosed) {
        showToast("Couldn't send yet. These numbers haven't messaged us on WhatsApp recently, so it needs our resource template, which is still in WhatsApp's review. Try again once it's approved.", 'warning', 7000);
        btn.disabled = false; btn.innerHTML = `${icon('phone')}Send on WhatsApp`;
      } else {
        showToast('Could not send: ' + (results[0]?.error || body.error || res.status), 'error');
        btn.disabled = false; btn.innerHTML = `${icon('phone')}Send on WhatsApp`;
      }
    } catch (e) {
      showToast('Could not send: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('phone')}Send on WhatsApp`;
    }
  }
}

// Build the recipient list from a patient-shaped object (phone_full, caregiver, phones[]).
export function recipientsFromPatient(p = {}) {
  const out = [];
  const seen = new Set();
  const add = (phone, label, name) => {
    if (!phone) return;
    const key = String(phone).replace(/\D/g, '');
    if (key.length < 8 || seen.has(key)) return;
    seen.add(key); out.push({ phone, label, name });
  };
  if (Array.isArray(p.phones) && p.phones.length) {
    const LBL = { patient: 'Patient', caregiver_1: 'Caregiver', caregiver_2: 'Caregiver', other: 'Other' };
    p.phones.forEach(ph => add(ph.phone, LBL[ph.label] || ph.label || 'Number', ph.label === 'patient' ? p.full_name : ph.contact_name));
  } else {
    add(p.phone_full || p.phone, 'Patient', p.full_name);
    add(p.caregiver_phone_full || p.caregiver_phone, 'Caregiver', p.caregiver_name);
  }
  return out;
}
