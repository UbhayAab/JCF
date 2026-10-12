// ============================================================
// Patient Navigator: WhatsApp leads (HopeBot profiles)
//
// People who finished the HopeBot onboarding (name, city, cancer type,
// stage) land in hopebot_leads, phone-keyed. A lead is NOT a patient:
// nothing here feeds the registry or the impact numbers. Staff call them
// and either mark contacted or convert by hand into a real patient record.
// Since sql/172 HopeBot also pushes what each family wrote, the sorter's
// tags and a short summary (hopebot_family_digest, calling roles only), and
// the families who asked for a call sit on top (components/hopebotFamily.js).
// Since sql/182 (Fixboard #31) a family that is not a PN family has ONE
// caller: a caller reads only their own (row security), a manager reads all
// and gives a family to someone with the Caller select.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { mountHopebotRequests, digestHTML, cancerLabel, stageLabel } from '../components/hopebotFamily.js';
import { getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { loadRoster, rosterSelectHTML, forgetRoster } from '../components/assignPicker.js';

let rows = [];
let digests = new Map(); // lead_id -> what they wrote, tags, summary (sql/172)
let filter = 'new'; // new | contacted | all | nocaller (managers)
let roster = null;  // managers: who can take a family (hopebot_assignable)
let searchQ = '';

export async function renderLeads(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>WhatsApp leads</h1>
        <p class="header-subtitle" style="margin:4px 0 0">${isManagerOrAdmin()
          ? 'Everyone who wrote to HopeBot on WhatsApp: what they asked, who is waiting for a call, and which caller has them.'
          : 'The families who wrote to HopeBot on WhatsApp and are yours to call: what they asked, and who is waiting for a call.'}</p>
      </div>
      <button class="btn btn-secondary btn-sm" id="wl-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div id="wl-requests" style="margin-bottom:var(--s4)"></div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:var(--s2)">
      <div class="chip-row" id="wl-filter">
        <button type="button" class="fchip" data-f="new">New</button>
        <button type="button" class="fchip" data-f="contacted">Contacted</button>
        <button type="button" class="fchip" data-f="all">All</button>
        ${isManagerOrAdmin() ? '<button type="button" class="fchip" data-f="nocaller">No caller yet</button>' : ''}
      </div>
      <div class="table-search" style="max-width:420px;flex:1 1 260px">
        ${icon('search')}
        <input class="form-input" id="wl-search" type="search" autocomplete="off"
          placeholder="Name, phone, city, cancer type…" aria-label="Search leads" />
      </div>
    </div>
    <div id="wl-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading leads…</div></div>`;

  // A bare `load` here received the click EVENT as its container and threw on
  // container.querySelector, so Refresh never refreshed anything.
  container.querySelector('#wl-refresh')?.addEventListener('click', () => {
    mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads' });
    load(container);
  });
  container.querySelectorAll('#wl-filter .fchip').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.f;
    paint(container);
  }));
  container.querySelector('#wl-search')?.addEventListener('input', (e) => {
    searchQ = e.target.value.trim().toLowerCase();
    paint(container);
  });
  mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads' });
  await load(container);
}

async function load(container) {
  const body = container.querySelector('#wl-body');
  try {
    // Newest ACTIVITY first, not newest signup: when someone asks HopeBot for a
    // volunteer call, their lead is reopened with the request in `notes`, and
    // it has to come to the top instead of staying where it first landed.
    const { data, error } = await getSupabase().from('hopebot_leads')
      .select('*').order('updated_at', { ascending: false }).limit(300);
    if (error) throw error;
    rows = data || [];
    // Only the calling roles read these; for anyone else this is simply empty.
    const { data: dg } = await getSupabase().from('hopebot_family_digest')
      .select('lead_id, counts, recent, summary, summary_at, report_reading').limit(1000);
    digests = new Map((dg || []).map(d => [d.lead_id, d]));
    if (isManagerOrAdmin()) {
      try { roster = await loadRoster('cgmp'); } catch (e) { roster = null; console.warn('[leads] roster:', e.message); }
    }
  } catch (e) {
    if (body) body.innerHTML = `<div class="empty"><h4>Could not load leads</h4><p>${sanitize(e.message)}</p></div>`;
    return;
  }
  paint(container);
}

function visible() {
  return rows
    .filter(r => filter === 'all' ? true : filter === 'contacted' ? r.contacted
      : filter === 'nocaller' ? !r.patient_id && !r.assigned_to : !r.contacted)
    .filter(r => !searchQ || [r.name, r.phone, r.city, r.cancer_type, r.stage, r.notes, digests.get(r.id)?.summary]
      .filter(Boolean).join(' ').toLowerCase().includes(searchQ));
}

function paint(container) {
  const body = container.querySelector('#wl-body');
  if (!body) return;
  container.querySelectorAll('#wl-filter .fchip').forEach(b =>
    b.classList.toggle('on', b.dataset.f === filter));
  const list = visible();
  const fresh = rows.filter(r => !r.contacted).length;
  if (!list.length) {
    body.innerHTML = `<div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">
      ${fresh ? 'Nothing under this filter.' : 'No WhatsApp leads yet. They appear here when someone writes to HopeBot.'}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="due-meta" style="margin-bottom:8px">${fresh} new lead${fresh === 1 ? '' : 's'}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
    ${list.map(r => `
      <div class="card" style="padding:12px 14px;${r.contacted ? 'opacity:.65' : ''}">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-weight:700">${sanitize(r.name || 'Unknown')}</span>
          <a class="tnum" href="tel:${sanitize(String(r.phone).replace(/[^+\d]/g, ''))}">${sanitize(r.phone)}</a>
          ${r.contacted ? '<span class="badge badge-ok">Contacted</span>' : '<span class="badge badge-info">New</span>'}
          <span style="flex:1"></span>
          ${r.patient_id ? `<a class="due-meta" href="#patients/${sanitize(r.patient_id)}">Already a PN family</a>` : ''}
          <span class="due-meta">${r.last_message_at ? 'wrote ' + formatRelativeTime(r.last_message_at) : formatRelativeTime(r.updated_at || r.created_at)}</span>
          <button class="btn ${r.contacted ? 'btn-secondary' : 'btn-primary'} btn-sm" data-lead="${r.id}" data-to="${r.contacted ? 0 : 1}">
            ${r.contacted ? 'Reopen' : 'Mark contacted'}
          </button>
        </div>
        ${callerLine(r)}
        <div class="due-meta" style="margin-top:4px">${[
          r.role === 'caregiver' ? 'Caregiver' : r.role === 'patient' ? 'Patient' : null,
          r.city && r.city !== 'other' ? sanitize(r.city) : 'City not pinned',
          r.cancer_type ? sanitize(cancerLabel(r.cancer_type)) : null,
          r.stage && r.stage !== 'unknown' ? sanitize(/^stage_|pata_nahi/.test(r.stage) ? stageLabel(r.stage) : 'Stage ' + r.stage) : null,
          r.lang === 'hi' ? 'Hindi' : 'English',
        ].filter(Boolean).join(' · ')}</div>
        ${r.notes ? `<div class="due-meta" style="margin-top:6px;color:var(--ink-1);white-space:pre-wrap">${sanitize(r.notes)}</div>` : ''}
        ${digestHTML(digests.get(r.id))}
      </div>`).join('')}
    </div>`;
  body.querySelectorAll('[data-lead-assign]').forEach(sel => sel.addEventListener('change', async () => {
    sel.disabled = true;
    try {
      const { error } = await getSupabase().rpc('hopebot_lead_assign', { p_lead: sel.dataset.leadAssign, p_to: sel.value || null });
      if (error) throw error;
      forgetRoster();
      showToast(sel.value ? 'Given to them. Their open call requests went with it.' : 'No caller now.', 'success', 2500);
    } catch (e) {
      showToast(e.message || 'Could not assign.', 'error');
    }
    await load(container);
    mountHopebotRequests(container.querySelector('#wl-requests'), { mode: 'leads' });
  }));
  body.querySelectorAll('[data-lead]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const { error } = await getSupabase().from('hopebot_leads')
        .update({ contacted: b.dataset.to === '1', updated_at: new Date().toISOString() })
        .eq('id', b.dataset.lead);
      if (error) throw error;
      rows = rows.map(r => r.id === b.dataset.lead ? { ...r, contacted: b.dataset.to === '1' } : r);
      showToast(b.dataset.to === '1' ? 'Marked contacted' : 'Reopened', 'success', 2000);
    } catch (e) {
      showToast('Could not update: ' + e.message, 'error');
    }
    paint(container);
  }));
}

// Who calls this family. A PN family is called by its own caregiver (their
// record says who); a WhatsApp-only family has one caller (sql/182).
function callerLine(r) {
  if (r.patient_id) return '';
  if (isManagerOrAdmin() && roster) {
    return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
      <span class="due-meta">Caregiver mentor</span>${rosterSelectHTML(roster, r.assigned_to, { attr: 'data-lead-assign', id: r.id, auto: 'Nobody yet', onlyTeam: true })}</div>`;
  }
  if (r.assigned_to && r.assigned_to === getCurrentProfile()?.id) return '<div style="margin-top:6px"><span class="badge badge-ok">Yours to call</span></div>';
  return '';
}
