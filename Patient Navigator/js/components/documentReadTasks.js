// Session-local document work. Navigating within the app leaves it running;
// closing the tab can stop it. Stored batches remain recoverable on the record.
import { getCurrentUser } from '../auth.js';
import { getSupabase } from '../supabase.js';
import { CONFIG } from '../config.js';
import { sanitize } from '../utils/validators.js';

let generation = 0;
let sequence = 0;
let owner = null;
let panel = null;
let subscribed = false;
let collapsed = false;
const tasks = new Map();
export class DocumentTaskStopped extends Error {
  constructor() { super('This document task stopped when the signed-in account changed.'); this.name = 'DocumentTaskStopped'; }
}

function clear() {
  generation++;
  for (const task of tasks.values()) {
    task.controller.abort();
    try { task.onStop?.(); } catch { /* finish clearing every owned task */ }
  }
  tasks.clear();
  panel?.remove(); panel = null;
  owner = null;
  collapsed = false;
}
function watchSession() {
  if (subscribed) return;
  subscribed = true;
  getSupabase().auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || (session?.user?.id && owner && session.user.id !== owner)) clear();
  });
  window.addEventListener('beforeunload', (event) => {
    if ([...tasks.values()].some((t) => ['preparing', 'running', 'saving'].includes(t.state))) {
      event.preventDefault(); event.returnValue = '';
    }
  });
}
function paint() {
  const shown = [...tasks.values()].filter((t) => t.visible);
  if (!shown.length) { panel?.remove(); panel = null; return; }
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'doc-work-panel card';
    panel.setAttribute('aria-label', 'Document reading');
    panel.style.cssText = 'position:fixed;right:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:60;width:min(360px,calc(100vw - 24px));max-height:35vh;overflow:auto;padding:12px;box-shadow:var(--shadow-lg);font-size:13px';
    document.body.appendChild(panel);
  }
  panel.style.width = collapsed ? 'auto' : 'min(360px,calc(100vw - 24px))';
  if (collapsed) {
    const ready = shown.filter((t) => t.state === 'ready').length;
    panel.innerHTML = `<button class="btn btn-ghost btn-sm" data-doc-expand>Document reading (${shown.length})${ready ? ` - ${ready} ready` : ''}</button>`;
    panel.querySelector('[data-doc-expand]').addEventListener('click', () => { collapsed = false; paint(); });
    return;
  }
  panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><strong>Document reading</strong><button class="btn btn-ghost btn-sm" data-doc-collapse>Hide status</button></div><p class="form-hint" style="margin:4px 0 8px">Keep this tab open. You can use other pages.</p>`
    + shown.map((t) => `<div data-doc-task="${t.id}" style="border-top:1px solid var(--line);padding-top:8px;margin-top:8px;overflow-wrap:anywhere">
      <strong>${sanitize(t.label)}</strong><div role="status">${sanitize(t.message)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        ${t.action ? `<button class="btn btn-primary btn-sm" data-doc-action="${t.id}">${sanitize(t.actionLabel)}</button>` : ''}
        ${['ready', 'failed', 'saved'].includes(t.state) ? `<button class="btn btn-ghost btn-sm" data-doc-dismiss="${t.id}" aria-label="Dismiss document status">Dismiss</button>` : ''}
      </div></div>`).join('');
  panel.querySelector('[data-doc-collapse]').addEventListener('click', () => { collapsed = true; paint(); });
  panel.querySelectorAll('[data-doc-action]').forEach((button) => button.addEventListener('click', async () => {
    const task = tasks.get(Number(button.dataset.docAction));
    if (!task?.active() || !task.action) return;
    button.disabled = true;
    try { await task.action(); } finally { if (task.active()) paint(); }
  }));
  panel.querySelectorAll('[data-doc-dismiss]').forEach((button) => button.addEventListener('click', () => {
    tasks.get(Number(button.dataset.docDismiss))?.remove();
  }));
}

export function beginDocumentTask(label, patientId, { batchId = null, visible = true } = {}) {
  const uid = getCurrentUser()?.id;
  if (!uid) throw new DocumentTaskStopped();
  if (owner && owner !== uid) clear();
  owner = uid;
  watchSession();
  const born = generation;
  const task = {
    id: ++sequence, uid, patientId, label: label || 'Patient documents', visible,
    state: visible ? 'preparing' : 'selecting', message: 'Preparing files...', batchId: null,
    controller: new AbortController(), onStop: null, action: null, actionLabel: '',
    active() { return born === generation && !this.controller.signal.aborted && getCurrentUser()?.id === uid; },
    check() { if (!this.active()) throw new DocumentTaskStopped(); },
    expose(label = this.label) { this.check(); this.visible = true; this.label = label; paint(); },
    attachBatch(id) {
      this.check();
      for (const other of tasks.values()) {
        if (other.id !== this.id && other.batchId === id && other.uid === uid) {
          other.controller.abort();
          try { other.onStop?.(); } catch { /* the old identity is stopped regardless */ }
          tasks.delete(other.id);
        }
      }
      this.batchId = id; paint();
    },
    set(state, message, action = null, actionLabel = '') {
      if (!this.active()) return;
      this.state = state; this.message = message; this.action = action; this.actionLabel = actionLabel; paint();
    },
    remove() {
      this.controller.abort();
      try { this.onStop?.(); } catch { /* remove all owned UI even if a callback failed */ }
      tasks.delete(this.id); paint();
    },
    async refreshToken() {
      this.check();
      const { data, error } = await getSupabase().auth.getSession();
      this.check();
      if (error || data?.session?.user?.id !== uid || !data.session.access_token) {
        this.remove();
        throw new DocumentTaskStopped();
      }
      this.token = data.session.access_token;
      return this.token;
    },
    async client() {
      this.check();
      if (this.sb) return this.sb;
      await this.refreshToken();
      // Fix the initiating identity for every request. A later sign-in must
      // never supply its token to an older upload still unwinding.
      this.sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${this.token}` }, fetch: async (url, options = {}) => {
          this.check();
          await this.refreshToken();
          this.check();
          const headers = new Headers(options.headers);
          headers.set('Authorization', `Bearer ${this.token}`);
          let response;
          try { response = await fetch(url, { ...options, headers, signal: this.controller.signal }); }
          catch (error) { this.check(); throw error; }
          this.check(); return response;
        } },
      });
      return this.sb;
    },
  };
  tasks.set(task.id, task); paint();
  if (batchId) task.attachBatch(batchId);
  return task;
}
