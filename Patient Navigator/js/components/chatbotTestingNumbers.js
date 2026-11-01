// Multiple owner declarations with explicit manager review for testing counts.
// Confirmed primary identity and actual patient/caregiver records stay separate.
import { getCurrentUser, getCurrentProfile, getRealProfile, isImpersonating } from '../auth.js';
import { getSupabase } from '../supabase.js';
import { normalizeTeamPhone, formatTeamPhone } from './phonePrompt.js';
import { sanitize } from '../utils/validators.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mounts = new WeakMap();
const manager = p => ['admin', 'manager'].includes(p?.role);
const activeMember = p => p?.is_active === true && (p.ends_on == null || typeof p.ends_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.ends_on) && p.ends_on >= new Date(Date.now() + 19800000).toISOString().slice(0, 10));
const integer = n => Number.isSafeInteger(n) && n >= 0;
const statsOK = s => s && ['entries', 'unique_numbers', 'declared_entries', 'revoked_entries', 'inactive_owner_entries']
  .every(k => integer(s[k])) && (s.confirmed_classification === null || integer(s.confirmed_classification) && s.confirmed_classification <= s.unique_numbers && integer(s.confirmed_entries) && s.confirmed_entries <= s.entries) && s.entries === s.declared_entries
  && s.unique_numbers <= s.entries;
const date = text => Number.isFinite(Date.parse(text || '')) ? new Date(text).toLocaleString('en-IN') : 'Time unavailable';
const STATUS = { approved_testing: 'Confirmed internal testing', declared_unverified: 'Declared - not verified', family_conflict: 'Family record conflict - not classified',
  shared_review: 'Shared declaration - needs review', revoked: 'Revoked', inactive_owner: 'Inactive owner - not counted' };

// Component-local layout: content width, not device width, controls stacking.
// Avoid the global data-table minimum width and never truncate status/provenance.
const REGISTRY_STYLE = `
  .pn-testing-list { display:grid; gap:12px; list-style:none; padding:0; margin:12px 0; min-width:0; }
  .pn-testing-entry { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));
    align-items:start; gap:12px; padding:14px; margin:0; min-width:0;
    border:1px solid var(--line,#ddd); border-radius:var(--r-md,12px); background:var(--surface,#fff);
    color:var(--ink,inherit); font:var(--t-sm,14px/1.45 sans-serif); line-height:1.45; }
  .pn-testing-entry .pn-testing-field { display:grid; align-content:start; gap:4px; min-width:0; max-width:100%; overflow-wrap:anywhere; }
  .pn-testing-entry .pn-testing-field-label { font-size:12px; font-weight:600; color:var(--ink-3,inherit); }
  .pn-testing-entry p { margin:0; min-width:0; overflow-wrap:anywhere; }
  .pn-testing-entry .badge { width:fit-content; max-width:100%; height:auto; white-space:normal;
    overflow-wrap:anywhere; text-align:left; line-height:1.4; }
  .pn-testing-entry .pn-testing-actions { display:flex; flex-wrap:wrap; align-items:flex-start; gap:8px; }
  .pn-testing-entry .pn-testing-actions .btn { min-width:44px; min-height:44px; max-width:100%; white-space:normal; }
`;

// Closed shape checks prevent a partial, cross-account or stale response from
// becoming zero counts or a successful empty list. Authority remains in the RPC.
export function validTestingSnapshot(data, actor, query, mode) {
  if (!data || data.schema !== 1 || data.actor_id !== actor || !['not_established','manager_reviewed'].includes(data.classification)
    || data.manager !== (mode === 'manager') || data.mode !== mode
    || data.group !== query.p_group || data.page !== query.p_page || data.limit !== query.p_limit
    || data.history !== query.p_history || data.owner_id !== query.p_owner
    || !integer(data.total_matching) || !statsOK(data.selection_summary)
    || !Array.isArray(data.entries) || data.entries.length > query.p_limit
    || !Array.isArray(data.members) || !Number.isFinite(Date.parse(data.as_of || ''))) return false;
  if (mode === 'manager' ? !statsOK(data.team_summary) : data.team_summary !== null) return false;
  if (mode === 'self' && (data.owner_id !== actor || data.members.some(m => m.id !== actor))) return false;
  const members = new Map();
  for (const m of data.members) {
    if (!UUID.test(m?.id || '') || members.has(m.id) || typeof m.full_name !== 'string'
      || typeof m.is_active !== 'boolean' || !integer(m.entries) || !integer(m.unique_numbers)
      || m.unique_numbers > m.entries) return false;
    members.set(m.id, m);
  }
  const ids = new Set();
  for (const e of data.entries) {
    if (!UUID.test(e?.id || '') || ids.has(e.id) || !members.has(e.owner_id)
      || query.p_owner && e.owner_id !== query.p_owner || mode === 'self' && e.owner_id !== actor
      || typeof e.owner_name !== 'string' || typeof e.owner_active !== 'boolean'
      || typeof e.phone !== 'string' || normalizeTeamPhone(e.phone) !== e.phone
      || !['testing', 'internal'].includes(e.purpose) || typeof e.label !== 'string' || e.label.length > 80
      || !Number.isSafeInteger(e.revision) || e.revision < 1 || !Object.hasOwn(STATUS, e.status)
      || !UUID.test(e.created_by || '') || !UUID.test(e.updated_by || '')) return false;
    if (mode === 'self' && (e.family_conflict !== null || e.shared_conflict !== null)) return false;
    if (!query.p_history && e.revoked_at !== null) return false;
    ids.add(e.id);
  }
  const expectedLength = Math.min(query.p_limit, Math.max(0, data.total_matching - query.p_page * query.p_limit));
  return data.entries.length === expectedLength;
}

export function mountChatbotTestingNumbers(host, { mode = 'self', activeOwners = true, current = () => true } = {}) {
  const mount = {}, actorUser = getCurrentUser(), actor = actorUser?.id, real = getRealProfile();
  mounts.set(host, mount);
  host.style.minWidth = '0'; host.style.maxWidth = '100%';
  const actorRole = real?.role;
  const ownActor = () => UUID.test(actor || '') && getCurrentUser() === actorUser && getCurrentUser()?.id === actor && getRealProfile()?.id === actor
    && activeMember(getRealProfile()) && getRealProfile()?.role === actorRole
    && getCurrentProfile()?.id === actor && !isImpersonating();
  const owned = () => mounts.get(host) === mount && host.isConnected && current();
  const allowed = () => owned() && ownActor() && (mode !== 'manager' || manager(getRealProfile()));
  const invalidate = () => { if (owned()) host.textContent = 'Account or view changed. Reopen this page to manage testing numbers.'; };
  if (!ownActor() || !['self', 'manager'].includes(mode) || mode === 'manager' && !manager(real)) {
    host.textContent = isImpersonating() ? 'Exit Open as to manage testing numbers with your own account.'
      : mode === 'manager' && ownActor() ? 'Only an active manager or admin can open team testing numbers.'
      : 'An active own-account sign-in is required.';
    return;
  }
  let selectedOwner = mode === 'self' ? actor : null, page = 0, history = false, request = 0, version = 0;
  let snapshot = null, editor = null;
  const query = () => ({ p_owner: selectedOwner, p_group: mode === 'manager' && !activeOwners ? 'inactive' : 'active',
    p_history: history, p_page: page, p_limit: 25, p_mode: mode });
  const message = (text, error = false) => {
    const node = host.querySelector('[data-testing-message]');
    if (node) { node.textContent = text; node.setAttribute('role', error ? 'alert' : 'status'); }
  };
  const errorText = code => code === '23505' ? 'Already registered on this account. Refresh to maintain the existing entry.'
    : code === '40001' ? 'This entry changed. Refresh before saving again.'
    : code === '42501' ? 'This action is not permitted with the current account.'
    : code === '22023' ? 'Check the number, label, purpose and on-behalf reason.'
    : 'The save could not be confirmed. Refresh before trying again.';
  const summary = (s, title) => `<div class="card" style="margin:12px 0;overflow-wrap:anywhere"><h4>${title}</h4>
    <p>${s.entries} active registration entries; ${s.unique_numbers} distinct numbers.</p>
    <p class="form-hint">${s.confirmed_classification === null ? `${s.declared_entries} declarations awaiting verification. Confirmed classification: not established.` : `${s.confirmed_classification} distinct numbers confirmed for internal testing; ${s.entries-s.confirmed_entries} entries awaiting review or blocked by a family match.`}</p>
    <p class="form-hint">${s.revoked_entries} revoked entries; ${s.inactive_owner_entries} unrevoked entries with inactive owners, excluded from active counts.</p></div>`;

  async function load() {
    if (!allowed()) { invalidate(); return; }
    const serial = ++request, q = query(); ++version; editor = null;
    host.innerHTML = '<p role="status">Loading registered testing numbers and counts...</p>';
    try {
      const res = await getSupabase().rpc('chatbot_testing_numbers_snapshot', q);
      if (!allowed()) { invalidate(); return; }
      if (serial !== request) return;
      if (res.error || !validTestingSnapshot(res.data, actor, q, mode)) throw new Error('unavailable');
      snapshot = res.data; paint();
    } catch {
      if (!allowed()) { invalidate(); return; }
      if (serial !== request) return;
      snapshot = null;
      host.innerHTML = '<p role="alert">Could not load registered testing numbers or counts. No zero or confirmed classification is assumed.</p><button type="button" class="btn btn-secondary" data-testing-retry>Retry testing numbers</button>';
      host.querySelector('[data-testing-retry]').addEventListener('click', load);
    }
  }
  function paint() {
    if (!allowed() || !snapshot) { invalidate(); return; }
    const painted = ++version, members = snapshot.members;
    const selected = members.find(m => m.id === selectedOwner);
    const target = editor ? members.find(m => m.id === editor.owner_id) : selected;
    const onBehalf = !!target && target.id !== actor;
    const canSave = !!target?.is_active;
    host.innerHTML = `<style>${REGISTRY_STYLE}</style><h3>Chatbot testing numbers</h3>
      <p>Register numbers used for testing or internal conversations. A manager confirms internal use before a number is separated from family leads and routine engagement counts.</p>
      <p class="form-hint">Your confirmed primary WhatsApp number stays separate. Register it here only if you also use it for testing. Patient and caregiver records always retain their existing handling.</p>
      <div data-testing-message role="status" style="overflow-wrap:anywhere"></div>
      ${mode === 'manager' ? `${summary(snapshot.team_summary, activeOwners ? 'Active team registrations' : 'Inactive-owner records')}
        <p class="form-hint">Global distinct numbers are counted once, even when several owners declare one number. Per-member distinct counts must not be summed as a team distinct total.</p>
        <label class="form-label" for="testing-owner">Member</label><select class="form-select" id="testing-owner" data-testing-owner>
        <option value="">All ${activeOwners ? 'active' : 'inactive'} members</option>${members.map(m => `<option value="${sanitize(m.id)}" ${m.id === selectedOwner ? 'selected' : ''}>${sanitize(m.full_name)} (${m.entries} active entries, ${m.unique_numbers} distinct)</option>`).join('')}</select>` : ''}
      ${summary(snapshot.selection_summary, mode === 'self' ? 'My registrations' : selected ? `${sanitize(selected.full_name)}: registrations` : 'Selected registrations')}
      <p class="form-hint">Snapshot ${sanitize(date(snapshot.as_of))}. ${snapshot.review_available ? 'Patient and caregiver matches always keep their family handling. Editing a registration requires fresh confirmation.' : 'Family and shared-number conflicts are visible to managers for review; no registration is classified as confirmed.'}</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0"><label><input type="checkbox" data-testing-history ${history ? 'checked' : ''}> Include revoked history</label>
        <button type="button" class="btn btn-secondary btn-sm" data-testing-refresh>Refresh testing numbers</button></div>
      <ul class="pn-testing-list" aria-label="Registered testing numbers">
      ${snapshot.entries.map(e => `<li class="pn-testing-entry" data-testing-entry="${e.id}">
        <div class="pn-testing-field" data-testing-field="owner"><span class="pn-testing-field-label">Owner / number</span>
          <p><strong>${sanitize(e.owner_name)}</strong><br><span data-testing-phone>${sanitize(formatTeamPhone(e.phone))}</span></p></div>
        <div class="pn-testing-field" data-testing-field="declaration"><span class="pn-testing-field-label">Declaration</span>
          <p data-testing-label>${sanitize(e.label || 'No label')}</p><p>${e.purpose === 'testing' ? 'Chatbot testing' : 'Internal interaction'}</p>
          <span class="badge badge-neutral" data-testing-status>${sanitize(STATUS[e.status])}</span>
          ${e.reviewed_at ? `<p>Reviewed by ${sanitize(e.reviewed_by_name || 'Manager')}<br>${sanitize(date(e.reviewed_at))}</p>` : ''}
          ${mode === 'manager' && e.family_conflict && e.shared_conflict ? '<p>Also shared with another registration; no owner is preferred.</p>' : ''}</div>
        <div class="pn-testing-field" data-testing-field="provenance"><span class="pn-testing-field-label">Provenance</span>
          <p>Declared by ${sanitize(e.created_by_name || 'Recorded actor')}<br><span data-testing-declared-at>${sanitize(date(e.created_at))}</span></p>
          <p>Last changed by ${sanitize(e.updated_by_name || 'Recorded actor')}<br><span data-testing-changed-at>${sanitize(date(e.updated_at))}</span>; revision ${e.revision}</p></div>
        <div class="pn-testing-field" data-testing-field="actions"><span class="pn-testing-field-label">Actions</span>
          ${e.revoked_at ? '<p>Retained history</p>' : `<div class="pn-testing-actions"><button type="button" class="btn btn-ghost btn-sm" data-testing-edit="${e.id}" ${e.owner_active ? '' : 'disabled'}>Edit</button><button type="button" class="btn btn-ghost btn-sm" data-testing-revoke="${e.id}">Revoke</button>${mode === 'manager' && snapshot.review_available && e.owner_active ? `<button type="button" class="btn btn-secondary btn-sm" data-testing-review="${e.id}" ${e.family_conflict && !e.review_confirmed ? 'disabled' : ''}>${e.review_confirmed ? 'Clear confirmation' : 'Confirm internal use'}</button>` : ''}</div>`}</div>
      </li>`).join('') || '<li>No entries in this view.</li>'}
      </ul>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0"><button type="button" class="btn btn-secondary btn-sm" data-testing-prev ${page ? '' : 'disabled'}>Previous registrations</button>
        <span>Page ${page + 1}; ${snapshot.total_matching} matching stored entries</span><button type="button" class="btn btn-secondary btn-sm" data-testing-next ${(page + 1) * 25 >= snapshot.total_matching ? 'disabled' : ''}>Next registrations</button></div>
      ${mode === 'manager' && !target ? '<p>Choose a member to register a number on their behalf.</p>' : ''}
      ${target ? `<h4>${editor?.action === 'review' ? editor.review_confirmed ? 'Clear confirmation of' : 'Confirm internal use of' : editor?.action === 'revoke' ? 'Revoke' : editor ? 'Edit' : 'Add'} registration for ${sanitize(target.full_name)}</h4>
      <p class="form-hint">${onBehalf ? 'You are acting explicitly on this member\'s behalf. Your own account is recorded as the actor.' : 'You are maintaining your own declarations.'}</p>
      <form data-testing-form>
        ${editor?.action === 'review' ? `<p>${editor.review_confirmed ? 'Stop classifying' : 'Classify'} the registration ending ${sanitize(editor.phone.slice(-4))} as internal testing. This never grants staff access.</p><label class="form-label">Review reason<input class="form-input" name="reason" minlength="3" maxlength="300" required></label>` : editor?.action === 'revoke' ? `<p>Revoke the declaration ending ${sanitize(editor.phone.slice(-4))}? Its provenance remains; no patient or primary phone changes.</p>` : `<div class="form-group"><label class="form-label">Testing/internal phone number<input class="form-input" name="phone" type="tel" inputmode="tel" autocomplete="off" maxlength="24" required value="${sanitize(editor?.phone || '')}"></label></div>
        <div class="form-group"><label class="form-label">Purpose<select class="form-select" name="purpose"><option value="testing" ${editor?.purpose !== 'internal' ? 'selected' : ''}>Chatbot testing</option><option value="internal" ${editor?.purpose === 'internal' ? 'selected' : ''}>Internal interaction</option></select></label></div>
        <div class="form-group"><label class="form-label">Label (optional)<input class="form-input" name="label" maxlength="80" value="${sanitize(editor?.label || '')}"></label></div>`}
        ${onBehalf && editor?.action !== 'review' ? '<div class="form-group"><label class="form-label">Reason for acting on their behalf<input class="form-input" name="reason" minlength="3" maxlength="300" required></label></div>' : ''}
        <button type="submit" class="btn btn-primary" ${!canSave && editor?.action !== 'revoke' ? 'disabled' : ''}>${editor?.action === 'review' ? editor.review_confirmed ? 'Clear testing confirmation' : 'Confirm testing registration' : editor?.action === 'revoke' ? 'Revoke registration' : 'Save unverified declaration'}</button>
        ${editor ? '<button type="button" class="btn btn-secondary" data-testing-cancel>Cancel registration edit</button>' : ''}
      </form>` : ''}`;
    const act = fn => () => { if (!allowed() || painted !== version) { invalidate(); return; } fn(); };
    host.querySelector('[data-testing-owner]')?.addEventListener('change', act(() => { selectedOwner = host.querySelector('[data-testing-owner]').value || null; page = 0; load(); }));
    host.querySelector('[data-testing-history]').addEventListener('change', act(() => { history = host.querySelector('[data-testing-history]').checked; page = 0; load(); }));
    host.querySelector('[data-testing-refresh]').addEventListener('click', act(load));
    host.querySelector('[data-testing-prev]').addEventListener('click', act(() => { page = Math.max(0, page - 1); load(); }));
    host.querySelector('[data-testing-next]').addEventListener('click', act(() => { page++; load(); }));
    host.querySelector('[data-testing-cancel]')?.addEventListener('click', act(() => { editor = null; paint(); }));
    for (const action of ['edit', 'revoke', 'review']) for (const button of host.querySelectorAll(`[data-testing-${action}]`))
      button.addEventListener('click', act(() => { const entry = snapshot.entries.find(e => e.id === button.dataset[action === 'edit' ? 'testingEdit' : action === 'review' ? 'testingReview' : 'testingRevoke']);
        if (entry && !entry.revoked_at) { editor = { ...entry, action }; paint(); host.querySelector('[data-testing-form]')?.scrollIntoView({ block: 'nearest' }); } }));
    host.querySelector('[data-testing-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (!allowed() || painted !== version) { invalidate(); return; }
      const form = event.currentTarget, entry = editor && { ...editor }, owner = target.id;
      if (form.dataset.saving === 'yes') return;
      const reason = form.elements.reason?.value.trim() || null;
      if ((onBehalf || entry?.action === 'review') && (!reason || reason.length < 3 || reason.length > 300)) { message('Give a short on-behalf reason.', true); return; }
      let name, args;
      if (entry?.action === 'review') {
        name = 'review_chatbot_testing_number'; args = { p_entry: entry.id, p_revision: entry.revision, p_confirm: !entry.review_confirmed, p_reason: reason };
      } else if (entry?.action === 'revoke') {
        name = 'revoke_chatbot_testing_number'; args = { p_entry: entry.id, p_revision: entry.revision, p_reason: reason };
      } else {
        const phone = form.elements.phone.value.trim(), purpose = form.elements.purpose.value, label = form.elements.label.value.trim();
        if (!normalizeTeamPhone(phone) || !['testing', 'internal'].includes(purpose) || label.length > 80) { message('Check the phone number, purpose and label.', true); return; }
        name = 'save_chatbot_testing_number'; args = { p_owner: owner, p_phone: phone, p_purpose: purpose, p_label: label,
          p_entry: entry?.id || null, p_revision: entry?.revision ?? null, p_reason: reason };
      }
      const submit = form.querySelector('[type=submit]'); form.dataset.saving = 'yes'; submit.disabled = true; message('Saving declaration...');
      try {
        const res = await getSupabase().rpc(name, args);
        if (!allowed()) { invalidate(); return; }
        if (painted !== version) return;
        if (res.error) { message(errorText(res.error.code), true); form.dataset.saving = ''; submit.disabled = false; return; }
        if (!UUID.test(res.data?.id || '') || entry && res.data.id !== entry.id
          || !Number.isSafeInteger(res.data?.revision) || res.data.revision !== (entry?.action === 'review' ? entry.revision : (entry?.revision || 0) + 1)
          || (entry?.action === 'review' ? res.data.review_confirmed !== !entry.review_confirmed : res.data.classification !== 'not_established') || entry?.action === 'revoke' && res.data.revoked !== true)
          throw new Error('unconfirmed');
        page = 0; await load();
        if (allowed() && snapshot) message(entry?.action === 'review' ? 'Testing confirmation saved.' : snapshot.review_available ? 'Declaration saved. A manager must confirm its current revision for testing exclusion.' : 'Declaration saved. Classification is still not established.');
      } catch {
        if (!allowed()) { invalidate(); return; }
        if (painted !== version) return;
        message('The save outcome could not be confirmed. Refresh before trying again.', true); form.dataset.saving = ''; submit.disabled = false;
      }
    });
  }
  load();
}
