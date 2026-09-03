// ============================================================
// Patient Navigator: "Send resources on WhatsApp"
//
// REWRITTEN, 27 August 2026, against three field reports from Tata Memorial:
// patients cannot understand the list; patients need it in Hindi; and NGOs
// keep declining the people we send them.
//
// What this screen used to do: load all 617 resource rows, let a mentor tick
// up to twelve, and post `title + summary + eligibility` for each to an edge
// function. The only patient-derived filter in the whole flow was the state.
// So an adult could be sent a children's fund, a family with no ration card
// could be sent a scheme that requires one, and what arrived was staff prose.
//
// What it does now:
//
//   MATCHES.       public.match_resources() (sql/101) decides, per patient,
//                  what is even possible: age, state, gender, budget, and
//                  whether the place is open. Ruled-out rows are still shown,
//                  greyed, with the reason, because the mentor knows things
//                  the database does not and must be able to override.
//
//   EXPLAINS.      Every row carries why it is on the list and what might
//                  still go wrong at the counter.
//
//   WRITES PLAINLY.js/utils/resourceMessage.js turns the match into five
//                  named slots per resource: what you get, who it is for,
//                  papers to carry, one thing to do, what to expect. Three
//                  blocks, numbered, so a navigator can say "look at
//                  number 3".
//
//   SPEAKS HINDI.  js/i18n/ holds the catalogue. The language is chosen per
//                  patient, saved on the patient record, and the mentor sees
//                  the exact message before it goes.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { resourceCategory } from '../utils/catalog.js';
import { LANGUAGES, normaliseLang, wasGuessed, languageLabel } from '../i18n/index.js';
import { planMessage, renderMessage, DEFAULT_MAX_BLOCKS, HARD_MAX_BLOCKS } from '../utils/resourceMessage.js';
import { fitBadge, reasonLabels } from '../utils/matchReasons.js';
import { DOCUMENT_TYPES } from '../utils/docTypes.js';

// A WhatsApp bold run: an asterisk pair, within one line.
const BOLD_RE = /\*([^*\n]+)\*/g;

const RESOURCE_SEND_URL = 'https://uhesnagqbmuyqiuzfhcv.supabase.co/functions/v1/resource-send';

// Two shelves, because those are the two the library actually holds and the
// two the field reports are about. sql/74 permits eleven more; they have zero
// rows and a chip with zero behind it is a promise we cannot keep.
const SHELVES = [
  { key: 'accommodation', label: 'A place to stay' },
  { key: 'financial_aid', label: 'Money for treatment' },
];

// opts: { patient: {id|patient_id, full_name, ...}, recipients: [{phone, label, name}] }
export async function openWhatsappShare({ patient = {}, recipients = [] } = {}) {
  const sb = getSupabase();
  const patientId = patient.id || patient.patient_id || null;

  const state = {
    patient: { ...patient },
    byId: new Map(),          // resource id -> full row
    matches: [],              // rows from match_resources()
    selected: new Set(),
    shelf: 'accommodation',
    showRuledOut: false,
    editingDocs: false,
    needAmount: '',           // "they have Rs 400 in hand"
    maxBlocks: DEFAULT_MAX_BLOCKS,
    lang: 'en',
    langGuessed: false,
    recips: recipients.filter(r => r && r.phone),
    picked: new Set(recipients.length ? [0] : []),
    loadError: null,
  };

  const el = document.createElement('div');
  el.innerHTML = `<div style="padding:6px 2px;color:var(--ink-3);font:var(--t-sm)">Working out what this family is eligible for…</div>`;
  showModal({
    title: `Send help on WhatsApp${patient.full_name ? ' · ' + sanitize(patient.full_name) : ''}`,
    content: el, size: 'xl',
  });

  await loadEverything();
  paint();

  // ------------------------------------------------------------
  // data
  // ------------------------------------------------------------
  async function loadEverything() {
    try {
      // The full patient row, because both call sites pass a different
      // subset and the matcher needs age, documents_held and the language
      // preference. Fetched here so neither caller has to change.
      if (patientId) {
        const { data: p } = await sb.from('patients')
          .select('id, full_name, age, gender, state, city, primary_language, message_language, treating_hospital, documents_held, documents_asked_on, aid_amount_needed_inr')
          .eq('id', patientId).maybeSingle();
        if (p) state.patient = { ...state.patient, ...p };
      }

      state.lang = pickLanguage(state.patient);
      state.langGuessed = !state.patient.message_language && wasGuessed(state.patient.primary_language);

      const { data: rows, error } = await sb.from('resources').select('*').eq('is_active', true);
      if (error) throw error;
      (rows || []).forEach(r => state.byId.set(r.id, r));

      await runMatch();
    } catch (e) {
      state.loadError = e.message;
    }
  }

  async function runMatch() {
    if (!patientId) { state.matches = []; return; }
    const need = state.needAmount === '' ? null : Number(state.needAmount);
    const { data, error } = await sb.rpc('match_resources', {
      p_patient_id: patientId,
      p_category: state.shelf,
      p_amount_needed: (need != null && isFinite(need) && need > 0) ? need : null,
      p_limit: 60,
    });
    if (error) throw error;
    state.matches = data || [];

    // Pre-tick the best three that are actually eligible. A mentor starts
    // from a plan, not from an empty list of 617 rows.
    state.selected = new Set(state.matches.filter(m => m.included).slice(0, DEFAULT_MAX_BLOCKS).map(m => m.resource_id));
  }

  function pickLanguage(p) {
    if (p.message_language) return p.message_language;
    return normaliseLang(p.primary_language) || 'en';
  }

  // Function declarations, not const arrows: paint() runs before this point
  // in the source and a const would still be in its temporal dead zone. That
  // failure looks exactly like "the modal never loaded".
  function included() { return state.matches.filter(m => m.included); }
  function ruledOut() { return state.matches.filter(m => !m.included); }

  // The order they were ticked in is not the order they should be read in.
  // The matcher already ranked them, so the message follows the match rank.
  function chosenItems() {
    return state.matches
      .filter(m => state.selected.has(m.resource_id))
      .map(m => ({ resource: state.byId.get(m.resource_id), match: m }))
      .filter(x => x.resource);
  }

  function currentPlan() {
    const me = getCurrentProfile() || {};
    return planMessage({
      patient: state.patient,
      poc: { full_name: me.full_name, phone: me.phone },
      items: chosenItems(),
      totalAvailable: included().length,
      maxBlocks: state.maxBlocks,
    });
  }

  // ------------------------------------------------------------
  // paint
  // ------------------------------------------------------------
  function paint() {
    if (state.loadError) {
      el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div>
        <h4>Could not work out the matches</h4><p>${sanitize(state.loadError)}</p></div>`;
      return;
    }
    if (!patientId) {
      el.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div>
        <h4>No patient record</h4><p>Matching needs the patient's age, state and papers. Open this from the patient record.</p></div>`;
      return;
    }

    const inc = included();
    const out = ruledOut();

    el.innerHTML = `
      <style>
        .wa-recip{display:flex;align-items:center;gap:9px;padding:9px 12px;border:1px solid var(--line);border-radius:var(--r-sm);cursor:pointer;margin-bottom:6px;transition:all .15s}
        .wa-recip.on{border-color:var(--primary);background:var(--primary-soft)}
        .wa-recip svg{width:15px;height:15px;color:var(--ink-3)}
        .wa-res{display:flex;gap:11px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-sm);cursor:pointer;transition:all .15s}
        .wa-res.on{border-color:var(--primary);background:var(--primary-soft)}
        .wa-res.out{opacity:.55}
        .wa-res input{margin-top:3px;width:18px;height:18px;flex:none;accent-color:var(--primary)}
        .wa-list{display:flex;flex-direction:column;gap:7px;max-height:300px;overflow-y:auto;padding-right:4px;margin-top:4px}
        .wa-why{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
        .wa-why span{font-size:10.5px;line-height:1.5;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--ink-3)}
        .wa-why span.good{color:var(--ok);border-color:var(--ok)}
        .wa-why span.warn{color:var(--warn);border-color:var(--warn)}
        .wa-why span.bad{color:var(--danger);border-color:var(--danger)}
        .wa-grid{display:grid;grid-template-columns:1fr 340px;gap:var(--s4);align-items:start}
        @media (max-width:900px){.wa-grid{grid-template-columns:1fr}}
        .wa-preview{background:#0b141a;border-radius:12px;padding:12px;max-height:430px;overflow-y:auto}
        .wa-bubble{background:#005c4b;color:#e9edef;border-radius:8px 0 8px 8px;padding:9px 11px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
        .wa-lang{display:inline-flex;gap:0;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden}
        .wa-lang button{padding:5px 13px;border:0;background:transparent;color:var(--ink-2);font:var(--t-sm);cursor:pointer}
        .wa-lang button.on{background:var(--primary);color:#fff}
      </style>

      <div style="display:flex;flex-direction:column;gap:var(--s4)">

        <div>
          <div class="lever-group-title" style="margin-bottom:7px">Send to</div>
          ${recipientsHTML()}
        </div>

        <div class="wa-grid">
          <div>
            <div class="lever-group-title" style="margin-bottom:7px">
              What ${sanitize(firstName(state.patient.full_name) || 'this family')} is eligible for
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:9px">
              <div class="chip-row" id="wa-shelf">
                ${SHELVES.map(s => `<button type="button" class="fchip ${state.shelf === s.key ? 'on' : ''}" data-shelf="${s.key}">${s.label}</button>`).join('')}
              </div>
              <label style="display:flex;align-items:center;gap:6px;font:var(--t-xs);color:var(--ink-3);margin-left:auto">
                <span>They can pay up to Rs</span>
                <input class="input" id="wa-need" inputmode="numeric" placeholder="any"
                       value="${sanitize(String(state.needAmount))}" style="width:78px;padding:4px 8px;font-size:12.5px" />
              </label>
            </div>

            ${matchSummaryHTML(inc, out)}
            ${papersHTML()}

            <div class="wa-list" id="wa-list">
              ${inc.length
                ? inc.map(m => resRow(m, false)).join('')
                : `<div style="color:var(--ink-3);padding:16px;text-align:center">Nothing on this shelf fits this family yet. Look at the ruled-out list below and override if you know better.</div>`}
              ${out.length ? `
                <button type="button" class="btn btn-ghost btn-sm" id="wa-toggle-out" style="align-self:flex-start;margin-top:4px">
                  ${state.showRuledOut ? 'Hide' : 'Show'} ${out.length} ruled out
                </button>` : ''}
              ${state.showRuledOut ? out.map(m => resRow(m, true)).join('') : ''}
            </div>
          </div>

          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;flex-wrap:wrap">
              <span class="lever-group-title" style="margin:0">What they will read</span>
              <span style="flex:1"></span>
              <div class="wa-lang" id="wa-lang">
                ${LANGUAGES.map(l => `<button type="button" data-lang="${l.code}" class="${state.lang === l.code ? 'on' : ''}">${l.native}</button>`).join('')}
              </div>
            </div>
            ${langNoteHTML()}
            <div class="wa-preview" id="wa-preview">${previewHTML()}</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px;font:var(--t-xs);color:var(--ink-3)">
              <span>Show</span>
              <select class="select" id="wa-blocks" style="width:auto;padding:3px 24px 3px 8px;font-size:12px">
                ${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${state.maxBlocks === n ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
              <span>of the ${state.selected.size} ticked${state.selected.size > state.maxBlocks ? ', the rest are offered in the last line' : ''}</span>
            </div>
          </div>
        </div>

        <div class="form-actions" style="margin-top:0">
          <span style="margin-right:auto;font:var(--t-sm);color:var(--ink-2)">
            <strong>${Math.min(state.selected.size, state.maxBlocks)}</strong> in the message${overrideNoteHTML()}
          </span>
          <button class="btn btn-secondary" id="wa-cancel">Cancel</button>
          <button class="btn btn-primary" id="wa-send" ${state.selected.size && state.picked.size ? '' : 'disabled'}>${icon('phone')}Send on WhatsApp</button>
        </div>
      </div>`;

    wire();
  }

  function recipientsHTML() {
    if (!state.recips.length) return `<div style="color:var(--danger);font:var(--t-sm)">No phone number on file for this patient.</div>`;
    return state.recips.map((r, i) => `
      <label class="wa-recip ${state.picked.has(i) ? 'on' : ''}" data-recip="${i}">
        <input type="checkbox" ${state.picked.has(i) ? 'checked' : ''} />
        <span>${icon('phone')}</span>
        <span style="flex:1;min-width:0"><span class="tnum" style="font-weight:600">${sanitize(r.phone)}</span>
        <span style="color:var(--ink-3);font-size:12px"> · ${sanitize(r.label || 'Number')}${r.name ? ' (' + sanitize(r.name) + ')' : ''}</span></span>
      </label>`).join('');
  }

  // Says out loud what the matcher removed and why. A shorter list with no
  // explanation is how a mentor stops trusting the tool.
  function matchSummaryHTML(inc, out) {
    const p = state.patient;
    const bits = [];
    if (p.age != null) bits.push(`age ${p.age}`);
    if (p.state) bits.push(sanitize(p.state));
    if (p.documents_asked_on) bits.push(`${(p.documents_held || []).length} papers on file`);
    else bits.push(`<span style="color:var(--warn)">papers never asked</span>`);
    if (state.needAmount) bits.push(`up to Rs ${sanitize(String(state.needAmount))}`);
    return `<div class="due-meta" id="wa-match-summary" style="margin-bottom:7px">
      Matched on ${bits.join(' · ')} &nbsp;|&nbsp; <strong>${inc.length}</strong> fit, ${out.length} ruled out
    </div>`;
  }

  // The ration-card complaint cannot be fixed without knowing what the family
  // holds, and nowhere in the product asked. This is the right place to ask:
  // the mentor is on the phone with them at this exact moment, it is a two
  // minute question, and the answer changes the list on screen immediately.
  function papersHTML() {
    const held = new Set(state.patient.documents_held || []);
    const asked = state.patient.documents_asked_on;
    if (!state.editingDocs) {
      const names = [...held].map(k => (DOCUMENT_TYPES.find(d => d.key === k) || {}).label || k);
      return `<div class="due-meta" style="margin-bottom:9px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${asked ? (names.length ? 'Papers they have: ' + sanitize(names.join(', ')) : 'Asked, and they hold none of them')
                      : '<span style="color:var(--warn)">Nobody has asked this family what papers they have</span>'}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="wa-docs-edit" style="padding:2px 8px;font-size:11.5px">
          ${asked ? 'Change' : 'Ask them now'}</button>
      </div>`;
    }
    return `<div style="border:1px solid var(--line);border-radius:var(--r-sm);padding:10px 11px;margin-bottom:9px">
      <div class="due-meta" style="margin-bottom:7px">Tick what they actually have in their hand. The ones marked with a dot are the ones families most often do not have.</div>
      <div class="chip-row" id="wa-docs">
        ${DOCUMENT_TYPES.map(d => `<button type="button" class="fchip ${held.has(d.key) ? 'on' : ''}" data-doc="${d.key}">${d.commonlyMissing ? '&middot; ' : ''}${d.label}</button>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:9px">
        <button type="button" class="btn btn-primary btn-sm" id="wa-docs-save">Save and match again</button>
        <button type="button" class="btn btn-secondary btn-sm" id="wa-docs-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function langNoteHTML() {
    const p = state.patient;
    if (p.message_language) {
      return `<div class="due-meta" style="margin-bottom:6px">Saved preference for this family: ${sanitize(languageLabel(p.message_language))}</div>`;
    }
    if (state.langGuessed) {
      return `<div class="due-meta" style="margin-bottom:6px;color:var(--warn)">
        Their language is recorded as "${sanitize(p.primary_language || '')}", which we do not have a catalogue for. Showing Hindi. Change it if that is wrong.</div>`;
    }
    return `<div class="due-meta" style="margin-bottom:6px">From their record: ${sanitize(p.primary_language || 'no language recorded')}. Changing this saves it on the patient.</div>`;
  }

  function overrideNoteHTML() {
    const overridden = [...state.selected].filter(id => {
      const m = state.matches.find(x => x.resource_id === id);
      return m && !m.included;
    }).length;
    return overridden ? ` · <span style="color:var(--warn)">${overridden} you overrode</span>` : '';
  }

  function resRow(m, isOut) {
    const r = state.byId.get(m.resource_id) || {};
    const cat = resourceCategory(r.category);
    const on = state.selected.has(m.resource_id);
    const badge = fitBadge(m.fit);
    const why = isOut
      ? reasonLabels(m.excluded_because).map(x => `<span class="bad">${sanitize(x)}</span>`)
      : reasonLabels(m.reasons).slice(0, 3).map(x => `<span class="good">${sanitize(x)}</span>`)
          .concat(reasonLabels(m.blockers).slice(0, 3).map(x => `<span class="warn">${sanitize(x)}</span>`));
    const place = [r.city, r.state].filter(Boolean).join(', ');
    return `
      <label class="wa-res ${on ? 'on' : ''} ${isOut ? 'out' : ''}" data-res="${m.resource_id}">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span style="flex:1;min-width:0">
          <span style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            <span style="font:var(--t-body-strong);font-size:13.5px">${sanitize(cleanTitle(r.title) || 'Resource')}</span>
            <span class="badge badge-${badge.tone}">${badge.label}</span>
          </span>
          <span style="display:block;font-size:11.5px;color:var(--ink-3);margin-top:1px">${cat.label}${place ? ' · ' + sanitize(place) : ''}${r.contact_phone ? ' · ' + sanitize(r.contact_phone) : ''}</span>
          ${why.length ? `<span class="wa-why">${why.join('')}</span>` : ''}
        </span>
      </label>`;
  }

  // Exactly what the patient will receive, in a WhatsApp bubble, so nobody
  // has to imagine it. This is the whole reason the preview exists: eleven
  // messages have ever been sent from this product and nobody in the team
  // has seen one rendered.
  function previewHTML() {
    if (!state.selected.size) {
      return `<div style="color:#8696a0;font-size:12.5px;padding:8px">Tick something on the left and the message appears here.</div>`;
    }
    const out = renderMessage(currentPlan(), state.lang);
    const warn = out.fallbacks.length
      ? `<div style="color:#f0b232;font-size:11px;margin-bottom:7px">${out.fallbacks.length} line${out.fallbacks.length === 1 ? '' : 's'} fell back to English: ${sanitize(out.fallbacks.join(', '))}</div>`
      : '';
    // WhatsApp renders *text* in bold. Showing the raw asterisks in a preview
    // that claims to be "exactly what they will receive" would be a lie by
    // one character, so the preview renders it the way the phone will.
    const body = sanitize(out.text).replace(BOLD_RE, '<strong>$1</strong>');
    return warn + `<div class="wa-bubble">${body}</div>`;
  }

  function repaintPreview() {
    const p = el.querySelector('#wa-preview');
    if (p) p.innerHTML = previewHTML();
    const btn = el.querySelector('#wa-send');
    if (btn) btn.disabled = !(state.selected.size && state.picked.size);
  }

  // ------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------
  function wire() {
    el.querySelectorAll('#wa-shelf .fchip').forEach(c => c.addEventListener('click', async () => {
      state.shelf = c.dataset.shelf;
      await refetch();
    }));

    let t = null;
    el.querySelector('#wa-need')?.addEventListener('input', (e) => {
      clearTimeout(t);
      const v = e.target.value.replace(/[^0-9]/g, '');
      t = setTimeout(async () => { state.needAmount = v; await refetch(); }, 450);
    });

    el.querySelector('#wa-toggle-out')?.addEventListener('click', () => { state.showRuledOut = !state.showRuledOut; paint(); });

    el.querySelector('#wa-docs-edit')?.addEventListener('click', () => { state.editingDocs = true; paint(); });
    el.querySelector('#wa-docs-cancel')?.addEventListener('click', () => { state.editingDocs = false; paint(); });
    el.querySelectorAll('#wa-docs .fchip').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
    el.querySelector('#wa-docs-save')?.addEventListener('click', async () => {
      const held = [...el.querySelectorAll('#wa-docs .fchip.on')].map(b => b.dataset.doc);
      const me = getCurrentProfile() || {};
      const { error } = await sb.from('patients').update({
        documents_held: held,
        // Everything in the vocabulary that was NOT ticked has now been
        // asked about and answered no. That is a different fact from "we
        // never asked" and the matcher treats it differently.
        documents_missing: DOCUMENT_TYPES.map(d => d.key).filter(k => !held.includes(k)),
        documents_asked_on: new Date().toISOString().slice(0, 10),
        documents_asked_by: me.id || null,
      }).eq('id', patientId);
      if (error) { showToast('Could not save the papers: ' + error.message, 'error'); return; }
      state.patient.documents_held = held;
      state.patient.documents_asked_on = new Date().toISOString().slice(0, 10);
      state.editingDocs = false;
      showToast(held.length ? `Saved ${held.length} paper${held.length === 1 ? '' : 's'}, matching again` : 'Saved, matching again', 'success', 2400);
      await refetch();
    });

    el.querySelectorAll('#wa-lang button').forEach(b => b.addEventListener('click', async () => {
      state.lang = b.dataset.lang;
      el.querySelectorAll('#wa-lang button').forEach(x => x.classList.toggle('on', x === b));
      repaintPreview();
      await saveLanguagePreference(state.lang);
    }));

    el.querySelector('#wa-blocks')?.addEventListener('change', (e) => {
      state.maxBlocks = Math.min(Number(e.target.value) || DEFAULT_MAX_BLOCKS, HARD_MAX_BLOCKS);
      paint();
    });

    el.querySelectorAll('[data-recip]').forEach(l => l.addEventListener('change', () => {
      const i = Number(l.dataset.recip);
      if (l.querySelector('input').checked) state.picked.add(i); else state.picked.delete(i);
      l.classList.toggle('on', l.querySelector('input').checked);
      repaintPreview();
    }));

    el.querySelectorAll('[data-res]').forEach(l => l.addEventListener('change', () => {
      const id = l.dataset.res;
      if (l.querySelector('input').checked) state.selected.add(id); else state.selected.delete(id);
      l.classList.toggle('on', l.querySelector('input').checked);
      paint();
    }));

    el.querySelector('#wa-cancel')?.addEventListener('click', () => closeModal());
    el.querySelector('#wa-send')?.addEventListener('click', send);
  }

  async function refetch() {
    try { await runMatch(); state.loadError = null; }
    catch (e) { state.loadError = e.message; }
    paint();
  }

  // The family chooses, once, and it sticks. Two siblings on the same list
  // will not always want the same language and the record has to be able to
  // say so.
  async function saveLanguagePreference(code) {
    if (!patientId || state.patient.message_language === code) return;
    const { error } = await sb.from('patients').update({ message_language: code }).eq('id', patientId);
    if (error) { showToast('Could not save the language on the record: ' + error.message, 'warning'); return; }
    state.patient.message_language = code;
    state.langGuessed = false;
    showToast(`${languageLabel(code)} saved for this family`, 'success', 2200);
  }

  async function send() {
    const btn = el.querySelector('#wa-send');
    const plan = currentPlan();
    const rendered = renderMessage(plan, state.lang);
    const items = chosenItems().slice(0, state.maxBlocks);
    const recips = [...state.picked].map(i => state.recips[i]).filter(Boolean)
      .map(r => ({ phone: r.phone, name: r.name || state.patient.full_name }));
    if (!items.length || !recips.length) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Sending…';
    try {
      const { data: sess } = await sb.auth.getSession();
      const token = sess?.session?.access_token;
      if (!token) { showToast('Your session expired. Please sign in again', 'error'); return; }
      const me = getCurrentProfile() || {};

      const payload = {
        patientName: state.patient.full_name || '',
        lang: state.lang,
        mentorId: me.id || null,
        pocName: me.full_name || null,
        pocPhone: me.phone || null,
        pnPatientId: patientId,
        recipients: recips,
        // The whole message, already written, already in the family's
        // language. The remote function no longer has to compose anything,
        // and the mentor has read the exact string that will arrive.
        messageText: rendered.text,
        templateId: plan.templateId || 'resource_list_v2',
        // The same message as structure, so the remote side can map it onto
        // an approved WhatsApp template's variables without re-parsing text.
        blocks: plan.blocks.map(b => ({ n: b.n, name: b.name, place: b.place })),
        // Kept for the existing edge function, which builds its own body from
        // these fields. Removing it would break sending until that function
        // is redeployed, and that lives in the carcinome_wpp project.
        resources: items.map(({ resource: r }) => ({
          title: r.title, category: r.category, city: r.city, state: r.state,
          summary: r.summary, eligibility: r.eligibility, contact_phone: r.contact_phone,
          link: r.link, address: r.address,
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
        let msg = `Sent ${items.length} ${items.length === 1 ? 'place' : 'places'} to ${okN} number${okN === 1 ? '' : 's'} in ${languageLabel(state.lang)}`;
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

// Registered organisation names carry en dashes (sql/82 explains why they are
// not rewritten in the database). They are still not going on screen.
const cleanTitle = (s) => String(s || '').replace(/[\u2013\u2014]/g, '-');
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';

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
