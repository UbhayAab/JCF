// ============================================================
// Patient Navigator: WhatsApp leads (HopeBot profiles)
//
// People who finished the HopeBot onboarding (name, city, cancer type,
// stage) land in hopebot_leads, phone-keyed. A lead is NOT a patient:
// nothing here feeds the registry or the impact numbers. Staff call them
// and either mark contacted or convert by hand into a real patient record.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { sanitize } from '../utils/validators.js';
import { formatRelativeTime } from '../utils/formatters.js';

let rows = [];
let filter = 'new'; // new | contacted | all
let searchQ = '';

export async function renderLeads(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>WhatsApp leads</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Finished the HopeBot profile on WhatsApp, or asked HopeBot for a call. Call them before they go cold.</p>
      </div>
      <button class="btn btn-secondary btn-sm" id="wl-refresh">${icon('refresh')}Refresh</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:var(--s2)">
      <div class="chip-row" id="wl-filter">
        <button type="button" class="fchip" data-f="new">New</button>
        <button type="button" class="fchip" data-f="contacted">Contacted</button>
        <button type="button" class="fchip" data-f="all">All</button>
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
  container.querySelector('#wl-refresh')?.addEventListener('click', () => load(container));
  container.querySelectorAll('#wl-filter .fchip').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.f;
    paint(container);
  }));
  container.querySelector('#wl-search')?.addEventListener('input', (e) => {
    searchQ = e.target.value.trim().toLowerCase();
    paint(container);
  });
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
  } catch (e) {
    if (body) body.innerHTML = `<div class="empty"><h4>Could not load leads</h4><p>${sanitize(e.message)}</p></div>`;
    return;
  }
  paint(container);
}

function visible() {
  return rows
    .filter(r => filter === 'all' ? true : filter === 'contacted' ? r.contacted : !r.contacted)
    .filter(r => !searchQ || [r.name, r.phone, r.city, r.cancer_type, r.stage, r.notes]
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
      ${fresh ? 'Nothing under this filter.' : 'No WhatsApp leads yet. They appear here when someone finishes the HopeBot profile.'}</div>`;
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
          <span class="due-meta">${formatRelativeTime(r.updated_at || r.created_at)}</span>
          <button class="btn ${r.contacted ? 'btn-secondary' : 'btn-primary'} btn-sm" data-lead="${r.id}" data-to="${r.contacted ? 0 : 1}">
            ${r.contacted ? 'Reopen' : 'Mark contacted'}
          </button>
        </div>
        <div class="due-meta" style="margin-top:4px">${[
          r.role === 'caregiver' ? 'Caregiver' : r.role === 'patient' ? 'Patient' : null,
          r.city && r.city !== 'other' ? sanitize(r.city) : 'City not pinned',
          r.cancer_type ? sanitize(r.cancer_type) : null,
          r.stage && r.stage !== 'unknown' ? 'Stage ' + sanitize(r.stage) : null,
          r.lang === 'hi' ? 'Hindi' : 'English',
        ].filter(Boolean).join(' · ')}</div>
        ${r.notes ? `<div class="due-meta" style="margin-top:6px;color:var(--ink-1);white-space:pre-wrap">${sanitize(r.notes)}</div>` : ''}
      </div>`).join('')}
    </div>`;
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
