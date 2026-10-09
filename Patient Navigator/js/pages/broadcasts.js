// ============================================================
// Patient Navigator: WhatsApp messages (Fixboard #24, asked by Aadrika)
//
// A manager writes one message, picks who gets it and when, and HopeBot sends
// it on WhatsApp at that time. Patient Navigator decides WHO: the groups come
// from its own call data, and consent, do-not-call, blocking, a WhatsApp STOP
// and a valid mobile are checked when the message is saved and again when it
// goes out. HopeBot decides HOW: Meta-approved formats, the sending, replies
// and STOP. The contract is sql/168; nothing on this page sends anything.
// ============================================================
import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { showModal, closeModal, confirmModal } from '../components/modal.js';
import { CIRCLE_FIELDS, indiaInput, indiaISO } from '../utils/circleMessage.js';

const AUDIENCES = [
  { k: 'connected_week', label: 'Families we spoke to this week' },
  { k: 'connected_15', label: 'Families we last spoke to 15+ days ago' },
  { k: 'connected_30', label: 'Families we last spoke to 30+ days ago' },
  { k: 'all_active', label: 'All active families' },
  { k: 'interns', label: 'Interns' },
  { k: 'hopebot_session_reminders', label: 'People who told HopeBot they will join' },
];
const AUD = Object.fromEntries(AUDIENCES.map(a => [a.k, a.label]));
const WHY = {
  no_consent: 'no consent yet', do_not_call: 'marked do not call', blacklisted: 'blocked',
  opted_out: 'said STOP on WhatsApp', bad_number: 'no valid mobile', inactive: 'not active',
  number_not_confirmed: 'number not confirmed', not_on_a_calling_team: 'not on a calling team', not_found: 'not found',
};
const STATUS = {
  draft: ['Draft', 'neutral'], scheduled: ['Scheduled', 'info'], sending: ['Sending', 'warn'],
  sent: ['Sent', 'ok'], cancelled: ['Stopped', 'neutral'],
  awaiting_approval: ['Waiting for WhatsApp approval', 'warn'], missed: ['Missed: approval was not ready', 'warn'],
};
const NAME_TOKEN = '{first_name}';
const SHOW_MAX = 400;
const HOPEBOT_LIST = 'hopebot_session_reminders';
const PAGE = 1000;

// Supabase answers at most 1000 rows a request, so a long list is read in pages.
async function readAll(make) {
  const out = [];
  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    if (error) return { data: out, error };
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { data: out, error: null };
}

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const TEMPLATE_FIELDS = {
  wellness_session_invite: ['First name', 'Session date', 'Session time'],
  wellness_session_reminder: ['First name', 'Session time', 'Joining link'],
  care_session_invite_v1: ['First name', 'Session title', 'Session date', 'Session time', 'Joining link'],
};
const TEMPLATE_LABELS = {
  wellness_session_invite: 'Wellness reminder: date and time',
  wellness_session_reminder: 'Wellness starts in 5 minutes',
  care_session_invite_v1: 'Session invitation with a link',
};
const humanTpl = (name) => TEMPLATE_LABELS[name] || String(name || '').replace(/_/g, ' ');
const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Friday 6 pm, the Saturday circle's invite time, unless one is being edited.
function defaultWhen(existing) {
  if (existing?.scheduled_for) return indiaInput(existing.scheduled_for);
  const d = new Date(Date.now() + 330 * 60000);
  d.setUTCSeconds(0, 0);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  d.setUTCHours(18, 0);
  if (d.getTime() - 330 * 60000 - Date.now() < 10 * 60000) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0,16);
}

export async function renderBroadcasts(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>WhatsApp messages</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Write one message, choose who gets it and when. HopeBot sends it on WhatsApp at that time.</p>
      </div>
      <button class="btn btn-primary btn-sm" id="wb-new">${icon('plus')}New message</button>
    </div>
    <p class="muted" style="margin:0 0 var(--s4);color:var(--ink-2)">A family gets a message only with consent, a valid mobile and no do-not-call or STOP, checked again when it goes out. Until messages to families are switched on, HopeBot sends only to the team's own numbers and shows families as held.</p>
    <div id="wb-list"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading messages…</div></div>`;
  container.querySelector('#wb-new').addEventListener('click', () => openBroadcastComposer(container));
  await loadList(container);
}

async function loadList(container) {
  const box = container.querySelector('#wb-list');
  if (!box) return;
  const { data, error } = await getSupabase().rpc('broadcasts_list', { p_limit: 50 });
  if (!box.isConnected) return;
  if (error) { box.innerHTML = `<div class="card" style="padding:20px">Could not load the messages: ${sanitize(error.message)}</div>`; return; }
  if (!data?.length) {
    box.innerHTML = '<div class="card" style="padding:28px;text-align:center"><p style="margin:0">No WhatsApp messages yet. Tap <strong>New message</strong> to write the first one.</p></div>';
    return;
  }
  box.innerHTML = data.map(rowHTML).join('');
  box.querySelectorAll('[data-wb-edit]').forEach(b => b.addEventListener('click', () =>
    openBroadcastComposer(container, data.find(x => x.id === b.dataset.wbEdit))));
  box.querySelectorAll('[data-wb-stop]').forEach(b => b.addEventListener('click', () => {
    const row = data.find(x => x.id === b.dataset.wbStop);
    confirmModal(`Stop <strong>${sanitize(row.title)}</strong>? Nobody who has not had it yet will get it.`, async () => {
      const { data: res, error: err } = await getSupabase().rpc('broadcast_cancel', { p_id: row.id });
      if (err) { showToast(err.message, 'error'); return; }
      showToast(`Stopped. ${res?.stopped ?? 0} ${res?.stopped === 1 ? 'person' : 'people'} will not get it.`, 'success');
      loadList(container);
    }, { title: 'Stop this message', confirmLabel: 'Stop it' });
  }));
}

function rowHTML(b) {
  const [label, tone] = STATUS[b.status] || [b.status, 'neutral'];
  const editable = b.status === 'draft' || ['scheduled','awaiting_approval'].includes(b.status) && new Date(b.scheduled_for) - Date.now() > 60000;
  const stoppable = ['draft', 'scheduled', 'sending','awaiting_approval'].includes(b.status);
  const counts = [
    b.audience_kind === HOPEBOT_LIST ? "HopeBot's list" : `${b.total} ${b.total === 1 ? 'person' : 'people'}`,
    b.waiting && `${b.waiting} waiting`, b.sent && `${b.sent} sent`, b.delivered && `${b.delivered} delivered`,
    b.read && `${b.read} read`, b.failed && `${b.failed} failed`, b.held && `${b.held} held`,
    b.skipped && `${b.skipped} skipped`, b.cancelled && `${b.cancelled} stopped`,
  ].filter(Boolean);
  return `
    <div class="card" style="padding:14px 18px;margin-bottom:var(--s3);display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1 1 260px;min-width:0">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <strong>${sanitize(b.title)}</strong><span class="badge badge-${tone}">${label}</span>
        </div>
        <div style="margin-top:4px;color:var(--ink-2)">${sanitize(fmtWhen(b.scheduled_for))} · ${sanitize(AUD[b.audience_kind] || b.audience_kind)} · ${sanitize(humanTpl(b.template_name))}</div>
        <div style="margin-top:2px;color:var(--ink-3);font-size:12.5px">${counts.map(c => sanitize(c)).join(' · ')}${b.created_by_name ? ` · by ${sanitize(b.created_by_name)}` : ''}</div>
      </div>
      <div style="display:flex;gap:6px">
        ${editable ? `<button class="btn btn-secondary btn-sm" data-wb-edit="${b.id}">${icon('edit')}Edit</button>` : ''}
        ${stoppable ? `<button class="btn btn-ghost btn-sm" data-wb-stop="${b.id}">Stop</button>` : ''}
      </div>
    </div>`;
}

export async function openBroadcastComposer(container, existing = null, preset = {}) {
  const sb = getSupabase();
  const el = document.createElement('div');
  el.innerHTML = '<div class="sk skeleton-row"></div>';
  showModal({ title: existing ? 'Edit WhatsApp message' : 'New WhatsApp message', content: el, size: 'lg' });
  const [tplR, recR, circleR] = await Promise.all([
    sb.from('wa_templates').select('name, language, category, body, variables_count').eq('approved', true),
    existing
      ? readAll(() => sb.from('wa_broadcast_recipients').select('recipient_id').eq('broadcast_id', existing.id).order('recipient_id'))
      : Promise.resolve({ data: [] }),
    sb.from('wa_circle_templates').select('template_name,label,language,body,parameter_keys,status').in('status',['requested','submitting','pending','approved']),
  ]);
  if (tplR.error) { el.innerHTML = `<p style="margin:0">Could not read the message formats: ${sanitize(tplR.error.message)}</p>`; return; }
  if(circleR.error){el.innerHTML=`<p>Could not read custom wording: ${sanitize(circleR.error.message)}</p>`;return;}
  const custom = (circleR.data||[]).map(t=>({...t,name:t.template_name,variables_count:t.parameter_keys.length,custom:true,
    approved:(tplR.data||[]).some(a=>a.name===t.template_name&&a.language===t.language&&a.body===t.body)}));
  const tpls = [...(tplR.data || []).filter(t => t.language === 'en'&&!custom.some(c=>c.name===t.name)),...custom];
  if (!tpls.length) {
    el.innerHTML = '<p style="margin:0">There is no approved WhatsApp format yet. HopeBot adds them here once WhatsApp approves them. A general announcement needs its own approval first.</p>';
    return;
  }
  const state = {
    id: existing?.id || null,
    tpl: tpls.some(t => t.name === (existing?.template_name||preset.template_name)) ? (existing?.template_name||preset.template_name) : (tpls.find(t=>t.name==='care_session_invite_v1')||tpls[0]).name,
    vars: existing?.variables ? [...existing.variables] : [...(preset.variables||[])],
    kind: existing?.audience_kind || 'connected_week',
    picked: new Set((recR.data || []).map(r => r.recipient_id)),
    autoTick: false,         // managers explicitly choose recipients for each new message
    people: [],
    q: '',
  };

  el.innerHTML = `
    <div class="form-group"><label class="form-label" for="wb-title">Name, for the team</label>
      <input class="form-input" id="wb-title" maxlength="120" placeholder="Saturday circle invitation" value="${sanitize(existing?.title||preset.title)}"></div>
    <div class="form-group"><label class="form-label" for="wb-tpl">Message (formats approved on WhatsApp)</label>
      <select class="form-select" id="wb-tpl">${tpls.map(t => `<option value="${sanitize(t.name)}"${t.name === state.tpl ? ' selected' : ''}>${sanitize(t.label||humanTpl(t.name))}${t.custom&&!t.approved?' (approval pending)':''}</option>`).join('')}</select>
      <p id="wb-template-help" style="margin:8px 0 0;color:var(--ink-2);font-size:13px"></p></div>
    <div id="wb-blanks"></div>
    <div class="form-group" id="wb-session-group"><label class="form-label" for="wb-session">Session starts (India time, optional helper)</label>
      <input class="form-input" id="wb-session" type="datetime-local"><p class="form-hint">Fills the session date and time above. Delivery time below is when the invitation should go out.</p></div>
    <div class="form-group"><label class="form-label" for="wb-aud">Who gets it</label>
      <select class="form-select" id="wb-aud">${AUDIENCES.map(a => `<option value="${a.k}"${a.k === state.kind ? ' selected' : ''}>${a.label}</option>`).join('')}</select></div>
    <div id="wb-people" style="margin-bottom:var(--s4)"></div>
    <div class="form-group"><label class="form-label" for="wb-when">When (India time)</label>
      <input class="form-input" id="wb-when" type="datetime-local" value="${defaultWhen(existing)}"><p class="form-hint">Delivery between 9 AM and before 9 PM IST, at least 2 minutes ahead and within 60 days. HopeBot checks every minute; consent, quiet hours and sending limits can hold delivery.</p></div>
    <div class="form-label" style="margin-bottom:6px">What they will see</div>
    <div class="card" id="wb-preview" style="padding:12px 14px;background:var(--surface-2);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)"></div>
    <div style="display:flex;justify-content:flex-end;gap:var(--s2);margin-top:var(--s4);flex-wrap:wrap">
      <button class="btn btn-secondary" id="wb-close" type="button">Close</button>
      <button class="btn btn-secondary" id="wb-draft" type="button">Save as draft</button>
      <button class="btn btn-primary" id="wb-schedule" type="button">${icon('clock')}Schedule</button>
    </div>`;

  const tplNow = () => tpls.find(t => t.name === state.tpl);
  const firstName = () => {
    const p = state.people.find(x => state.picked.has(x.recipient_id));
    return p?.name ? String(p.name).trim().split(/\s+/)[0] : 'Asha';
  };
  const preview = () => {
    const t = tplNow();
    const text = String(t?.body || '').replace(/\{\{(\d+)\}\}/g, (m, n) => {
      const v = state.vars[Number(n) - 1];
      return v ? v.split(NAME_TOKEN).join(firstName()) : `[blank ${n}]`;
    });
    el.querySelector('#wb-preview').textContent = text || 'No text for this format yet.';
  };
  const paintBlanks = () => {
    const t = tplNow();
    const n = t?.variables_count || 0;
    const fields = t?.custom?t.parameter_keys.map(k=>CIRCLE_FIELDS[k]):TEMPLATE_FIELDS[t?.name] || [];
    el.querySelector('#wb-session-group').hidden=!fields.includes('Session date')||!fields.includes('Session time');
    el.querySelector('#wb-template-help').textContent = t?.custom
      ? (t.approved?'Your custom wording is approved. Set the session details below.':'This wording is waiting for WhatsApp approval. Scheduling holds it until approval; a missed approval deadline never sends a late invitation.')
      : t?.name === 'wellness_session_invite'
      ? 'This approved format says "reminder" and includes a date and time, with no joining link. For a new invitation with a link, choose the session invitation format when it is approved.'
      : t?.name === 'wellness_session_reminder'
        ? 'Use this only 5 minutes before the wellness session starts. Put the joining link in the Joining link field.'
        : 'Customize the fields below, including a link when the format has a Joining link field. The surrounding wording is approved by WhatsApp; different wording needs a new approved format.';
    state.vars = Array.from({ length: n }, (_, i) => state.vars[i] ?? (fields[i] === 'First name' ? NAME_TOKEN : ''));
    el.querySelector('#wb-blanks').innerHTML = n ? `
      <div class="form-label" style="margin-bottom:6px">Fill in the blanks</div>
      ${state.vars.map((v, i) => `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <label for="wb-var-${i}" style="flex:0 0 90px;color:var(--ink-3)">${sanitize(fields[i] || `Blank ${i + 1}`)}</label>
          <input class="form-input" id="wb-var-${i}" data-var="${i}" maxlength="500" ${fields[i] === 'Joining link' ? 'type="url" placeholder="https://..."' : 'type="text"'} value="${sanitize(v)}" style="flex:1 1 140px;min-width:0">
          ${!fields.length || fields[i]==='First name' ? `<button class="btn btn-ghost btn-sm" type="button" data-name-var="${i}" title="Each person sees their own first name here">Their name</button>` : ''}
        </div>`).join('')}` : '';
    el.querySelectorAll('[data-var]').forEach(inp => inp.addEventListener('input', () => {
      state.vars[Number(inp.dataset.var)] = inp.value;
      preview();
    }));
    el.querySelectorAll('[data-name-var]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.nameVar);
      state.vars[i] = NAME_TOKEN;
      el.querySelector(`[data-var="${i}"]`).value = NAME_TOKEN;
      preview();
    }));
    preview();
  };

  const paintList = () => {
    const list = el.querySelector('#wb-list-box');
    if (!list) return;
    const q = state.q.toLowerCase();
    const shown = state.people.filter(p => !q || String(p.name || '').toLowerCase().includes(q) || String(p.code || '').toLowerCase().includes(q));
    list.innerHTML = shown.slice(0, SHOW_MAX).map(p => `
      <label style="display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);${p.eligible ? 'cursor:pointer' : 'opacity:.6'}">
        <input type="checkbox" data-pid="${p.recipient_id}"${state.picked.has(p.recipient_id) ? ' checked' : ''}${p.eligible ? '' : ' disabled'}>
        <span style="flex:1;min-width:0">${sanitize(p.name || 'No name')}${p.code ? ` <span style="color:var(--ink-3)">${sanitize(p.code)}</span>` : ''}</span>
        <span style="font-size:12px;color:var(--ink-3);text-align:right">${p.eligible
          ? sanitize([p.last_connected_at ? `spoke ${formatRelativeTime(p.last_connected_at)}` : '', p.language === 'hi' ? 'Hindi' : ''].filter(Boolean).join(' · '))
          : sanitize(WHY[p.why_not] || p.why_not || '')}</span>
      </label>`).join('') + (shown.length ? '' : '<p style="padding:12px;margin:0">Nobody here matches.</p>')
      + (shown.length > SHOW_MAX ? `<p style="padding:8px 12px;margin:0;color:var(--ink-3)">Showing ${SHOW_MAX} of ${shown.length}. Search to find someone.</p>` : '');
    list.querySelectorAll('[data-pid]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) state.picked.add(cb.dataset.pid); else state.picked.delete(cb.dataset.pid);
      paintCount();
      preview();
    }));
    paintCount();
  };
  const paintCount = () => {
    const c = el.querySelector('#wb-count');
    if (c) c.innerHTML = `<strong>${state.picked.size}</strong> ticked · ${state.people.filter(p => p.eligible).length} of ${state.people.length} can get it`;
  };

  const loadPeople = async () => {
    const box = el.querySelector('#wb-people');
    if (state.kind === HOPEBOT_LIST) {
      state.people = [];
      state.picked.clear();
      box.innerHTML = '<p style="margin:0;color:var(--ink-2)">HopeBot sends this to everyone who replied to the session code on WhatsApp. That list stays with HopeBot, so there is nobody to tick here.</p>';
      preview();
      return;
    }
    box.innerHTML = '<div class="sk skeleton-row"></div>';
    const kind = state.kind;
    const { data, error } = await readAll(() => sb.rpc('broadcast_audience', { p_kind: kind, p_search: null, p_limit: 5000 }));
    if (kind !== state.kind || !box.isConnected) return;
    if (error) { box.innerHTML = `<p style="margin:0">Could not load this group: ${sanitize(error.message)}</p>`; return; }
    const seen = new Set();
    state.people = (data || []).filter(p => !seen.has(p.recipient_id) && seen.add(p.recipient_id));
    const inGroup = new Set(state.people.map(p => p.recipient_id));
    for (const id of [...state.picked]) if (!inGroup.has(id)) state.picked.delete(id);
    if (state.autoTick) state.people.forEach(p => { if (p.eligible) state.picked.add(p.recipient_id); });
    box.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <div class="table-search" style="flex:1 1 220px">${icon('search')}
          <input class="form-input" id="wb-q" type="search" autocomplete="off" placeholder="Search by name or ID" aria-label="Search this group"></div>
        <button class="btn btn-ghost btn-sm" id="wb-all" type="button">Tick everyone who can get it</button>
        <button class="btn btn-ghost btn-sm" id="wb-none" type="button">Untick all</button>
      </div>
      <div id="wb-count" style="margin-bottom:6px;color:var(--ink-2)"></div>
      <div id="wb-list-box" style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-md)"></div>`;
    box.querySelector('#wb-q').addEventListener('input', (e) => { state.q = e.target.value.trim(); paintList(); });
    box.querySelector('#wb-all').addEventListener('click', () => {
      state.people.forEach(p => { if (p.eligible) state.picked.add(p.recipient_id); });
      paintList();
      preview();
    });
    box.querySelector('#wb-none').addEventListener('click', () => { state.picked.clear(); paintList(); preview(); });
    paintList();
    preview();
  };

  const save = async (schedule) => {
    const title = el.querySelector('#wb-title').value.trim();
    const whenStr = el.querySelector('#wb-when').value;
    const iso = indiaISO(whenStr);
    const when = iso ? new Date(iso) : null;
    if (!title) { showToast('Give the message a short name first.', 'error'); return; }
    if (state.vars.some(v => !String(v || '').trim())) { showToast('Fill in every blank.', 'error'); return; }
    const invalidLink = [...el.querySelectorAll('[data-var][type="url"]')].find(inp => !/^https?:\/\//i.test(inp.value.trim()) || !inp.checkValidity());
    if (invalidLink) { showToast('Use a complete joining link starting with https:// or http://.', 'error'); invalidLink.focus(); return; }
    if (!when || Number.isNaN(when.getTime())) { showToast('Pick a date and time.', 'error'); return; }
    if(schedule && (Number(whenStr.slice(11,13))<9||Number(whenStr.slice(11,13))>=21)){showToast('Choose delivery from 9 AM to before 9 PM India time.','error');return;}
    if (schedule && state.kind !== HOPEBOT_LIST && !state.picked.size) { showToast('Tick at least one person.', 'error'); return; }
    const buttons = el.querySelectorAll('#wb-draft, #wb-schedule');
    buttons.forEach(b => { b.disabled = true; });
    const { data, error } = await sb.rpc('broadcast_save', { p: {
      id: state.id, title, template_name: state.tpl, variables: state.vars, audience_kind: state.kind,
      scheduled_for: when.toISOString(), recipient_ids: [...state.picked], schedule } });
    buttons.forEach(b => { b.disabled = false; });
    if (error) { showToast(error.message, 'error'); return; }
    closeModal();
    const who = state.kind === HOPEBOT_LIST ? "HopeBot's list" : `${data.kept} ${data.kept === 1 ? 'person' : 'people'}`;
    const left = data.left_out ? ` ${data.left_out} left out: they cannot get WhatsApp messages now.` : '';
    showToast(schedule ? `${data.status==='awaiting_approval'?'Waiting for approval. Planned':'Scheduled'} for ${fmtWhen(when.toISOString())}, to ${who}.${left}` : `Saved as a draft.${left}`, 'success');
    loadList(container);
  };

  el.querySelector('#wb-tpl').addEventListener('change', (e) => { state.tpl = e.target.value; state.vars = []; paintBlanks(); });
  el.querySelector('#wb-session').addEventListener('change',e=>{
    const iso=indiaISO(e.target.value);if(!iso)return;
    const t=tplNow();const fields=t.custom?t.parameter_keys.map(k=>CIRCLE_FIELDS[k]):TEMPLATE_FIELDS[t.name]||[];
    const locale=t.language==='hi'?'hi-IN':'en-IN';
    for(const [label,format] of [['Session date',{weekday:'long',day:'numeric',month:'long'}],['Session time',{hour:'numeric',minute:'2-digit',hour12:true}]]){
      const i=fields.indexOf(label);if(i<0)continue;
      state.vars[i]=new Date(iso).toLocaleString(locale,{timeZone:'Asia/Kolkata',...format});el.querySelector(`[data-var="${i}"]`).value=state.vars[i];
    }
    preview();
  });
  el.querySelector('#wb-aud').addEventListener('change', (e) => { state.kind = e.target.value; state.picked.clear(); state.autoTick = false; loadPeople(); });
  el.querySelector('#wb-close').addEventListener('click', () => closeModal());
  el.querySelector('#wb-draft').addEventListener('click', () => save(false));
  el.querySelector('#wb-schedule').addEventListener('click', () => save(true));
  paintBlanks();
  await loadPeople();
  state.autoTick = false;
}
