// ============================================================
// Patient Navigator: Resource Library
// The shelf of real-world help: stays near treatment, financial
// aid, travel concessions, meals, medicines. Mentors read these
// out on calls; managers keep them verified. Scaffold stage:
// sample rows (is_sample) stand in until the scraped directory
// lands. Columns already match: state · city · category.
// ============================================================

import { getSupabase, mustWrite } from '../supabase.js';
import { getCurrentProfile, isManagerOrAdmin } from '../auth.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { RESOURCE_CATEGORIES, resourceCategory } from '../utils/catalog.js';

const CAT_TONE = {
  accommodation: 'info', financial_aid: 'ok', clinical: 'info', trials: 'violet',
  travel: 'violet', food: 'warn', medicines: 'danger', nutrition: 'ok',
  counselling: 'violet', caregiver: 'warn', community: 'info', palliative: 'neutral',
  other: 'neutral',
};

let rows = [];
let catFilter = 'all';
let stateFilter = 'all';
let query = '';
let containerEl = null;

export async function renderResources(container) {
  containerEl = container;
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Resource Library</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Real help you can offer on a call: a stay near the hospital, a fund, a meal, a train concession. Filter to their state and read it out.</p>
      </div>
      ${isManagerOrAdmin() ? `<button class="btn btn-primary btn-sm" id="rs-add">${icon('plus')}Add resource</button>` : ''}
    </div>
    <div id="rs-body"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Opening the shelf…</div></div>`;
  container.querySelector('#rs-add')?.addEventListener('click', () => openResourceModal(null));
  await load();
}

async function load() {
  const sb = getSupabase();
  const body = containerEl?.querySelector('#rs-body');
  if (!body) return;
  try {
    const { data, error } = await sb.from('resources')
      .select('*')
      .eq('is_active', true)
      .order('category')
      .order('state');
    if (error) throw error;
    rows = data || [];
    paint();
  } catch (e) {
    body.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Could not open the library</h4><p>${e.message}</p></div>`;
  }
}

function paint() {
  const body = containerEl?.querySelector('#rs-body');
  if (!body) return;
  const states = [...new Set(rows.map(r => r.state).filter(Boolean))].sort();
  const allSample = rows.length > 0 && rows.every(r => r.is_sample);

  const q = query.toLowerCase();
  const filtered = rows.filter(r =>
    (catFilter === 'all' || r.category === catFilter) &&
    (stateFilter === 'all' || r.state === stateFilter) &&
    (!q || [r.title, r.summary, r.city, r.state, r.eligibility].filter(Boolean).join(' ').toLowerCase().includes(q)));

  body.innerHTML = `
    ${allSample ? `
      <div class="card" style="padding:13px 16px;margin-bottom:var(--s5);display:flex;align-items:center;gap:11px;border-left:4px solid var(--gold-deep);background:var(--gold-soft)">
        <span style="width:18px;height:18px;display:inline-flex;flex:none;color:var(--gold-deep)">${icon('info')}</span>
        <div style="font:var(--t-sm);color:var(--ink-2)"><strong>Sample entries.</strong> This is the shape of the library. The verified, scraped directory will replace these rows soon. Nothing here should be read to a patient yet.</div>
      </div>` : ''}

    <div class="card" style="padding:14px 16px;margin-bottom:var(--s5);display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      <div style="position:relative;flex:1;min-width:200px">
        <span style="position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:var(--ink-3);display:inline-flex">${icon('search')}</span>
        <input class="input" id="rs-search" placeholder="Search the shelf: city, scheme, need…" value="${query.replace(/"/g, '&quot;')}" style="padding-left:34px;width:100%" />
      </div>
      <select class="select" id="rs-state" style="width:auto;min-width:150px">
        <option value="all">All states</option>
        ${states.map(s => `<option value="${s}" ${stateFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>

    <div class="chip-row" id="rs-cats" style="margin-bottom:var(--s5)">
      <button class="fchip ${catFilter === 'all' ? 'on' : ''}" data-cat="all">All · ${rows.length}</button>
      ${RESOURCE_CATEGORIES.map(c => {
        const n = rows.filter(r => r.category === c.key).length;
        return n ? `<button class="fchip ${catFilter === c.key ? 'on' : ''}" data-cat="${c.key}">${c.label} · ${n}</button>` : '';
      }).join('')}
    </div>

    ${filtered.length === 0 ? `
      <div class="empty" style="padding:44px 20px">
        <div class="ico-wrap">${icon('search')}</div>
        <h4>Nothing on this shelf yet</h4>
        <p>${rows.length ? 'Try a different filter or search.' : 'The directory is empty. Resources appear here once added.'}</p>
      </div>` : `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--s4)">
        ${filtered.map(r => resourceCard(r)).join('')}
      </div>`}`;

  // wire
  const search = body.querySelector('#rs-search');
  let t = null;
  search?.addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { query = e.target.value.trim(); paintKeepFocus(); }, 250); });
  body.querySelector('#rs-state')?.addEventListener('change', (e) => { stateFilter = e.target.value; paint(); });
  body.querySelectorAll('#rs-cats .fchip').forEach(ch => ch.addEventListener('click', () => { catFilter = ch.dataset.cat; paint(); }));
  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openResourceModal(rows.find(x => x.id === b.dataset.edit))));
}

// repaint but put the cursor back in the search box (typing continuity)
function paintKeepFocus() {
  paint();
  const s = containerEl?.querySelector('#rs-search');
  if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

function verifiedBadge(r) {
  if (!r.verified_on) return `<span class="badge badge-neutral">Unverified</span>`;
  const d = new Date(r.verified_on);
  const label = d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const stale = (Date.now() - d.getTime()) / 86400000 > 180;
  return `<span class="badge ${stale ? 'badge-warn' : 'badge-ok'}" title="${stale ? 'Older than 6 months: reconfirm before sharing' : 'Confirmed by the team'}">${stale ? 'Recheck · ' : 'Verified · '}${label}</span>`;
}

function resourceCard(r) {
  const cat = resourceCategory(r.category);
  const place = [r.city, r.state].filter(Boolean).join(', ');
  return `
    <div class="card" style="padding:18px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="stat-ico ${CAT_TONE[r.category] || 'neutral'}" style="width:36px;height:36px;border-radius:10px">${icon(cat.icon)}</span>
        <span class="due-meta" style="text-transform:uppercase;letter-spacing:0.06em;font-weight:700">${cat.label}</span>
        <span style="flex:1"></span>
        ${r.is_sample ? `<span class="badge badge-violet" title="Placeholder entry: not real yet">Sample</span>` : ''}
        ${isManagerOrAdmin() ? `<button class="btn btn-ghost btn-sm" data-edit="${r.id}" title="Edit" style="padding:4px 7px">${icon('edit')}</button>` : ''}
      </div>
      <div>
        <div style="font:var(--t-body-strong);font-size:15px;line-height:1.35">${r.title}</div>
        ${place ? `<div class="due-meta" style="display:flex;align-items:center;gap:5px;margin-top:4px"><span style="width:13px;height:13px;display:inline-flex;flex:none">${icon('mapPin')}</span>${place}</div>` : ''}
      </div>
      ${r.summary ? `<p style="font:var(--t-sm);color:var(--ink-2);margin:0">${r.summary}</p>` : ''}
      ${r.eligibility ? `<div style="font:var(--t-xs);color:var(--ink-3);padding:8px 11px;background:var(--surface-2);border-radius:var(--r-sm)"><strong style="color:var(--ink-2)">Who it's for:</strong> ${r.eligibility}</div>` : ''}
      <div style="margin-top:auto;padding-top:10px;border-top:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${r.contact_phone ? `<a href="tel:${r.contact_phone.replace(/\s/g, '')}" class="btn btn-ghost btn-sm" style="gap:6px;padding:4px 8px">${icon('phone')}<span class="tnum">${r.contact_phone}</span></a>` : ''}
        ${r.link ? `<a href="${r.link}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" style="gap:6px;padding:4px 8px">${icon('arrowRight')}Details</a>` : ''}
        <span style="flex:1"></span>
        ${verifiedBadge(r)}
      </div>
      ${r.address ? `<div class="due-meta">${r.address}</div>` : ''}
    </div>`;
}

// ---- Add / edit (managers & admins) ----
function openResourceModal(existing) {
  const me = getCurrentProfile();
  const r = existing || {};
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="form-row">
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">Title <span class="req">*</span></label>
        <input class="input" id="rm-title" value="${(r.title || '').replace(/"/g, '&quot;')}" placeholder="e.g., Free dharamshala near XYZ Cancer Centre" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Category <span class="req">*</span></label>
        <select class="select" id="rm-cat">${RESOURCE_CATEGORIES.map(c => `<option value="${c.key}" ${r.category === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Verified on</label>
        <input class="input" type="date" id="rm-verified" value="${r.verified_on || new Date().toISOString().slice(0, 10)}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">State</label>
        <input class="input" id="rm-state" value="${r.state || ''}" placeholder="e.g., Maharashtra (or All India)" /></div>
      <div class="form-group"><label class="form-label">City</label>
        <input class="input" id="rm-city" value="${r.city || ''}" placeholder="e.g., Mumbai" /></div>
    </div>
    <div class="form-group"><label class="form-label">Summary</label>
      <textarea class="textarea" id="rm-summary" placeholder="One short paragraph a mentor can read out on a call…">${r.summary || ''}</textarea></div>
    <div class="form-group"><label class="form-label">Who it's for / documents needed</label>
      <input class="input" id="rm-elig" value="${(r.eligibility || '').replace(/"/g, '&quot;')}" placeholder="e.g., BPL card + treatment letter" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Contact phone</label>
        <input class="input" id="rm-phone" value="${r.contact_phone || ''}" /></div>
      <div class="form-group"><label class="form-label">Link</label>
        <input class="input" id="rm-link" value="${r.link || ''}" placeholder="https://…" /></div>
    </div>
    <div class="form-group"><label class="form-label">Address</label>
      <input class="input" id="rm-address" value="${(r.address || '').replace(/"/g, '&quot;')}" /></div>

    <div class="fsec" style="margin-top:var(--s5)"><span class="fsec-ico">${icon('arrowRight')}</span>
      <div><h4>The steps to actually get it</h4>
      <div class="fsec-sub">This is the part families cannot find on their own. Write it the way you would say it on the phone.</div></div></div>
    <div class="form-group"><label class="form-label">How to apply, step by step</label>
      <textarea class="textarea" id="rm-apply" rows="4" placeholder="1. Call the number and ask for the medical social worker.&#10;2. Take the referral letter from your treating hospital.&#10;3. They allot a room the same day if one is free…">${r.how_to_apply || ''}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Papers to carry</label>
        <input class="input" id="rm-docs" value="${(r.documents_needed || '').replace(/"/g, '&quot;')}" placeholder="Aadhaar, BPL card, treatment letter…" /></div>
      <div class="form-group"><label class="form-label">Ask for (person or desk)</label>
        <input class="input" id="rm-who" value="${(r.who_to_ask || '').replace(/"/g, '&quot;')}" placeholder="e.g., the MSW desk, 2nd floor" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">WhatsApp</label>
        <input class="input" id="rm-wa" value="${r.whatsapp || ''}" placeholder="10-digit number" /></div>
      <div class="form-group"><label class="form-label">Email</label>
        <input class="input" id="rm-email" value="${r.email || ''}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Cost to the family</label>
        <select class="select" id="rm-cost">
          ${[['free', 'Free'], ['subsidised', 'Subsidised / discounted'], ['paid', 'Paid'], ['unknown', 'Not known yet']]
            .map(([k, l]) => `<option value="${k}" ${(r.cost || 'unknown') === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">Starting price (₹, if paid)</label>
        <input class="input" id="rm-price" type="number" min="0" step="1" value="${r.price_from ?? ''}" /></div>
    </div>
    <div class="form-group"><label class="form-label">Show this to which families?</label>
      <div class="chip-row" id="rm-tracks">
        ${[['A', 'A · needs free / very low cost'], ['B', 'B · can manage some of it'], ['C', 'C · cost is not the worry']]
          .map(([k, l]) => `<button type="button" class="fchip${(r.tracks || ['A', 'B', 'C']).includes(k) ? ' on' : ''}" data-track="${k}">${l}</button>`).join('')}
      </div>
      <div class="due-meta" style="margin-top:6px">Leave all three on if it suits everyone.</div></div>
    <div class="form-group"><label class="form-checkbox">
      <input type="checkbox" id="rm-public" ${r.is_public === false ? '' : 'checked'} />
      <span>Show on the public link families can open without signing in</span></label></div>

    <div class="form-actions">
      ${existing ? `<button class="btn btn-ghost" id="rm-retire" style="color:var(--danger);margin-right:auto">${icon('trash')}Retire</button>` : ''}
      <button class="btn btn-secondary" id="rm-cancel">Cancel</button>
      <button class="btn btn-primary" id="rm-save">${icon('check')}${existing ? 'Save changes' : 'Add to the shelf'}</button>
    </div>`;
  showModal({ title: existing ? 'Edit resource' : 'Add a resource', content: el, size: 'xl' });

  el.querySelector('#rm-cancel').addEventListener('click', () => closeModal());
  el.querySelectorAll('#rm-tracks .fchip').forEach(b =>
    b.addEventListener('click', () => b.classList.toggle('on')));
  el.querySelector('#rm-retire')?.addEventListener('click', async () => {
    try {
      await mustWrite(getSupabase().from('resources').update({ is_active: false }).eq('id', existing.id), 'resource');
      closeModal(); showToast('Retired from the shelf', 'info'); await load();
    } catch (e) { showToast('Could not retire: ' + e.message, 'error'); }
  });
  el.querySelector('#rm-save').addEventListener('click', async () => {
    const v = (id) => el.querySelector('#' + id)?.value.trim() || null;
    const title = v('rm-title');
    if (!title) { showToast('A title is required', 'warning'); return; }
    const btn = el.querySelector('#rm-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    const tracks = [...el.querySelectorAll('#rm-tracks .fchip.on')].map(b => b.dataset.track);
    const price = el.querySelector('#rm-price').value.trim();
    const patch = {
      title, category: v('rm-cat') || 'other', state: v('rm-state'), city: v('rm-city'),
      summary: v('rm-summary'), eligibility: v('rm-elig'), contact_phone: v('rm-phone'),
      link: v('rm-link'), address: v('rm-address'), verified_on: v('rm-verified'),
      how_to_apply: v('rm-apply'), documents_needed: v('rm-docs'), who_to_ask: v('rm-who'),
      whatsapp: v('rm-wa'), email: v('rm-email'),
      cost: v('rm-cost') || 'unknown',
      price_from: price === '' ? null : Number(price),
      tracks: tracks.length ? tracks : ['A', 'B', 'C'],
      is_public: el.querySelector('#rm-public').checked,
      is_sample: false,   // any human add/edit makes the entry real
    };
    try {
      const sb = getSupabase();
      if (existing) {
        await mustWrite(sb.from('resources').update(patch).eq('id', existing.id), 'resource');
      } else {
        const { error } = await sb.from('resources').insert({ ...patch, created_by: me.id });
        if (error) throw error;
      }
      closeModal();
      showToast(existing ? 'Resource updated' : 'Added. Mentors can see it now', 'success');
      await load();
    } catch (e) {
      showToast('Could not save: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}${existing ? 'Save changes' : 'Add to the shelf'}`;
    }
  });
}
