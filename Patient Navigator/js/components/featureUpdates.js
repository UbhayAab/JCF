import { getSupabase } from '../supabase.js';
import { getCurrentUser, isManagerOrAdmin, isAdmin, isImpersonating } from '../auth.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';
import { navigate } from '../router.js';

const safeRoute = r => /^[a-z][a-z0-9_-]*$/.test(r || '');

export async function maybeShowFeatureUpdate() {
  if (!isManagerOrAdmin() || isImpersonating()) return;
  const uid = getCurrentUser()?.id;
  if (!uid) return;
  const { data, error } = await getSupabase().rpc('feature_updates', { p_unread: true });
  if (error || !data?.length) return;
  // Phone confirmation and active work take priority. Never replace another sheet.
  const openWhenFree = () => {
    if (getCurrentUser()?.id !== uid || isImpersonating()) return;
    if (document.querySelector('.modal-overlay')) { setTimeout(openWhenFree, 1200); return; }
    showUpdate(data[0]);
  };
  openWhenFree();
}

function showUpdate(update) {
  const action = safeRoute(update.action_route) && update.action_label;
  const el = document.createElement('div');
  el.innerHTML = `<p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 20px">${sanitize(update.body)}</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn btn-secondary" data-later>Later</button>
      <button class="btn btn-secondary" data-ack>Got it</button>
      ${action ? `<button class="btn btn-primary" data-open>${sanitize(update.action_label)}</button>` : ''}
    </div>`;
  showModal({ title: sanitize(update.title), content: el });
  el.querySelector('[data-later]').onclick = () => closeModal();
  const acknowledge = async open => {
    el.querySelectorAll('button').forEach(b => b.disabled = true);
    const { error } = await getSupabase().rpc('feature_ack', { p_slug: update.slug, p_version: update.version });
    el.querySelectorAll('button').forEach(b => b.disabled = false);
    if (error) { showToast('Could not save acknowledgement. Try again when connected.', 'error'); return; }
    closeModal();
    if (open && safeRoute(update.action_route)) navigate(update.action_route);
  };
  el.querySelector('[data-ack]').onclick = () => acknowledge(false);
  el.querySelector('[data-open]')?.addEventListener('click', () => acknowledge(true));
}

export async function renderFeatureUpdates(container) {
  container.innerHTML = `<div class="page-header"><div><h1>What's new</h1><p>Feature updates for managers. Read them again here anytime.</p></div>
    ${isAdmin() && !isImpersonating() ? '<button class="btn btn-primary" id="fu-publish">Publish an update</button>' : ''}</div><div id="fu-list">Loading updates...</div>`;
  const { data, error } = await getSupabase().rpc('feature_updates', { p_unread: false });
  if (!container.isConnected) return;
  container.querySelector('#fu-list').innerHTML = error ? `<p>${sanitize(error.message)}</p>` : (data || []).map(a => `<article class="card" style="padding:20px;margin-bottom:12px;overflow-wrap:anywhere">
    <h3>${sanitize(a.title)}</h3><p style="white-space:pre-wrap">${sanitize(a.body)}</p>
    ${safeRoute(a.action_route) && a.action_label ? `<a class="btn btn-secondary" href="#${a.action_route}">${sanitize(a.action_label)}</a>` : ''}</article>`).join('') || '<p>No published updates yet.</p>';
  container.querySelector('#fu-publish')?.addEventListener('click', () => {
    const el = document.createElement('div');
    el.innerHTML = `<p>Managers see each new version on their next login. Reuse the update key to publish a revised version.</p>
      ${[['slug','Update key','feature-name'],['title','Title',''],['action_label','Button label (optional)',''],['action_route','Page route (optional)','']].map(([k,l,v]) => `<div class="form-group"><label class="form-label" for="fu-${k}">${l}</label><input class="form-input" id="fu-${k}" value="${v}"></div>`).join('')}
      <div class="form-group"><label class="form-label" for="fu-body">Update text</label><textarea class="form-input" id="fu-body" rows="6" maxlength="2000"></textarea></div><button class="btn btn-primary" id="fu-save">Publish to managers</button>`;
    showModal({ title: 'Publish feature update', content: el });
    el.querySelector('#fu-save').onclick = async e => {
      const p = Object.fromEntries(['slug','title','body','action_label','action_route'].map(k => [k,el.querySelector(`#fu-${k}`).value.trim()]));
      if (!/^[a-z0-9_-]{1,80}$/.test(p.slug) || !p.title || p.title.length>120 || !p.body || p.action_route && !safeRoute(p.action_route)) { showToast('Use a short update key, title, text and a valid page route.', 'error'); return; }
      e.target.disabled = true;
      const { error } = await getSupabase().rpc('feature_publish', { p });
      e.target.disabled = false;
      if (error) { showToast(error.message,'error'); return; }
      closeModal(); showToast('Published. Managers will see this on their next login.','success'); renderFeatureUpdates(container);
    };
  });
}
