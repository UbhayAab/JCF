// ============================================================
// Patient Navigator - Fresh start: hard reset, and "are you on the latest?"
//
// WHY THIS EXISTS. Staff keep reporting bugs that were fixed days ago. The
// deploy is real, the fix is live, and the device is still running an older
// shell. The service worker is network-first with a 3.5s timeout, so on a
// hospital wifi that times out it serves the cached copy - correctly, by
// design - and a phone that has been offline or flaky can sit on an old
// index.html, and therefore on old ?v= asset URLs, for a long time. Telling
// someone to "clear your cache" over the phone does not work; on Android
// Chrome it is five screens deep, and in the installed PWA there is no menu
// to do it from at all.
//
// So: one button that empties everything this origin owns and reloads.
//
// THE BUILD NUMBER IS READ FROM THE DOM ON PURPOSE. index.html already carries
// it on the module script tag as ?v=..., and a deploy already bumps that
// alongside APP_BUILD and the service worker cache name. Declaring it a fourth
// time in a config file would mean a fourth thing to forget, and the failure
// mode of forgetting is this exact bug.
// ============================================================

const STYLE_ID = 'freshstart-style';

// ---- which build is this device actually running ----

export function runningBuild() {
  const el = document.querySelector('script[src*="js/app.js"]');
  const m = /[?&]v=([^&"']+)/.exec(el?.getAttribute('src') || '');
  return m ? m[1] : 'unknown';
}

// The deployed build, read past every cache. `cache: 'no-store'` keeps it out
// of the HTTP cache and the cache-busting query keeps it out of the service
// worker's, which is the one that actually matters here.
export async function deployedBuild() {
  try {
    const res = await fetch(`./index.html?freshcheck=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = /script[^>]+js\/app\.js\?v=([^&"']+)/.exec(html);
    return m ? m[1] : null;
  } catch {
    return null;   // offline is not stale; say nothing
  }
}

// ---- the wipe ----

// Every step is individually try/caught. A browser that refuses one storage
// API (Safari private mode throws on IndexedDB, some Android WebViews have no
// caches API) must not abort the whole reset, because the one thing that will
// definitely help - unregistering the service worker - would then never run.
async function clearServiceWorkers(report) {
  try {
    if (!('serviceWorker' in navigator)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
    report(`service workers: ${regs.length}`);
  } catch (e) { report(`service workers: failed (${e.name})`); }
}

async function clearCaches(report) {
  try {
    if (!('caches' in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
    report(`caches: ${keys.length}`);
  } catch (e) { report(`caches: failed (${e.name})`); }
}

function clearWebStorage(report) {
  let n = 0;
  try { n += localStorage.length; localStorage.clear(); } catch { /* blocked */ }
  try { n += sessionStorage.length; sessionStorage.clear(); } catch { /* blocked */ }
  report(`storage keys: ${n}`);
}

async function clearIndexedDb(report) {
  try {
    // indexedDB.databases() is unsupported on Firefox before 126 and on older
    // Safari. Supabase keeps its auth token in localStorage, not IDB, so a
    // browser that cannot enumerate loses nothing that matters here.
    if (!window.indexedDB?.databases) { report('indexeddb: cannot enumerate'); return; }
    const dbs = (await indexedDB.databases()).filter((d) => d.name);
    // A database with a live connection answers `blocked`, not `success`: the
    // delete is queued and completes when that connection closes, which the
    // reload at the end of this function guarantees. Verified in a browser:
    // blocked here, gone after the reload. It is reported separately rather
    // than counted as deleted, because claiming a wipe that has not happened
    // yet is exactly the kind of false assurance this button exists to end.
    const outcomes = await Promise.all(dbs.map((d) => new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(d.name);
      req.onsuccess = () => resolve('deleted');
      req.onerror = () => resolve('error');
      req.onblocked = () => resolve('blocked');
      setTimeout(() => resolve('blocked'), 1500);
    })));
    const deleted = outcomes.filter((o) => o === 'deleted').length;
    const blocked = outcomes.length - deleted;
    report(`indexeddb: ${deleted} deleted${blocked ? `, ${blocked} queued until reload` : ''}`);
  } catch (e) { report(`indexeddb: failed (${e.name})`); }
}

// Cookies are scoped by path as well as name, and this app is served from a
// sub-path (/JCF/Patient Navigator/), so expiring at the current path alone
// leaves cookies set at a parent path alive. Every ancestor path is swept.
function clearCookies(report) {
  try {
    const raw = document.cookie ? document.cookie.split(';') : [];
    const segs = location.pathname.split('/').filter(Boolean);
    const paths = ['/', ...segs.map((_, i) => `/${segs.slice(0, i + 1).join('/')}/`)];
    const hostParts = location.hostname.split('.');
    const domains = [undefined, location.hostname,
      ...(hostParts.length > 2 ? [`.${hostParts.slice(-2).join('.')}`] : [])];
    for (const c of raw) {
      const name = c.split('=')[0].trim();
      if (!name) continue;
      for (const p of paths) {
        for (const d of domains) {
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}${d ? `; domain=${d}` : ''}`;
        }
      }
    }
    report(`cookies: ${raw.length}`);
  } catch (e) { report(`cookies: failed (${e.name})`); }
}

/**
 * Empty everything this origin owns, then reload onto the live build.
 * Returns the step-by-step report, which is also logged, so a user on a call
 * with support can read out what actually happened.
 */
export async function hardReset({ reload = true } = {}) {
  const steps = [];
  const report = (s) => { steps.push(s); console.log(`[freshstart] ${s}`); };
  report(`was running build ${runningBuild()}`);

  // Sign out BEFORE the wipe. Clearing the token without telling Supabase
  // leaves a session alive server-side and the next load in a half-signed-in
  // state, which is its own confusing bug report.
  // getSupabase(), not a `supabase` binding: this module exports a factory.
  // Destructuring the wrong name threw, the catch swallowed it, and the step
  // silently logged "skipped" on every reset. Caught by testing the wipe in a
  // real browser rather than reading the code.
  try {
    const { getSupabase } = await import('./supabase.js');
    await getSupabase().auth.signOut({ scope: 'local' });
    report('signed out');
  } catch (e) { report(`sign out: skipped (${e.name})`); }

  await clearServiceWorkers(report);
  await clearCaches(report);
  await clearIndexedDb(report);
  clearWebStorage(report);
  clearCookies(report);

  if (reload) {
    // replace(), not assign(), so Back cannot return to the dead shell. The
    // query string forces a fresh navigation past any HTTP cache; app.js
    // strips it once booted.
    const url = `${location.pathname}?fresh=${Date.now()}`;
    report('reloading');
    setTimeout(() => location.replace(url), 400);
  }
  return steps;
}

// Boot helper: take the ?fresh= marker off the address bar so it is not
// bookmarked or shared.
export function tidyFreshMarker() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has('fresh')) return false;
    u.searchParams.delete('fresh');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    return true;
  } catch { return false; }
}

// ============================================================
// UI
// ============================================================

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .fs-block { display:flex; flex-direction:column; gap:6px; }
    .fs-build { font-size:11px; opacity:.6; letter-spacing:.02em; text-align:center; }
    .fs-btn {
      display:flex; align-items:center; justify-content:center; gap:8px; width:100%;
      padding:10px 12px; border-radius:10px; font:inherit; font-size:13px; font-weight:600;
      cursor:pointer; border:1px solid var(--border, #d7d7de);
      background:var(--surface, #fff); color:var(--text, #1b1b1f);
      min-height:44px;                      /* a real tap target on a phone */
    }
    .fs-btn:hover { background:var(--surface-2, #f4f4f7); }
    .fs-btn svg { width:16px; height:16px; flex:none; }
    .fs-btn[disabled] { opacity:.6; cursor:progress; }

    /* The update bar. Fixed, so it is seen on a phone without opening the
       drawer, which is the whole point: people never find a menu item. */
    .fs-bar {
      position:fixed; left:0; right:0; top:0; z-index:9999;
      display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      padding:calc(10px + env(safe-area-inset-top,0px)) 14px 10px;
      background:var(--primary, #006469); color:#fff; font-size:13px; line-height:1.35;
      box-shadow:0 2px 10px rgba(0,0,0,.18);
    }
    .fs-bar-text { flex:1 1 180px; min-width:0; }
    .fs-bar-actions { display:flex; gap:8px; flex:none; }
    .fs-bar button {
      font:inherit; font-size:13px; font-weight:700; border-radius:8px; cursor:pointer;
      padding:8px 14px; min-height:40px; border:0;
    }
    .fs-bar .fs-now { background:#fff; color:var(--primary, #006469); }
    .fs-bar .fs-later { background:transparent; color:#fff; border:1px solid rgba(255,255,255,.55); font-weight:600; }
    @media (max-width:420px) {
      .fs-bar { font-size:12.5px; }
      .fs-bar-actions { width:100%; }
      .fs-bar-actions button { flex:1; }
    }
    .fs-doing { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center;
      background:rgba(12,12,16,.72); color:#fff; font-size:14px; text-align:center; padding:24px; }
  `;
  document.head.appendChild(s);
}

const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

function overlay(text) {
  injectStyle();
  const d = document.createElement('div');
  d.className = 'fs-doing';
  d.textContent = text;
  document.body.appendChild(d);
  return d;
}

async function confirmAndReset(btn) {
  const ok = window.confirm(
    'Reset this app?\n\n'
    + 'This clears everything Patient Navigator has stored on this device - cached files, '
    + 'saved settings and your sign-in - and reloads the newest version.\n\n'
    + 'Nothing on the server is affected. No patient data is deleted. '
    + 'You will need to sign in again.',
  );
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting...'; }
  overlay('Clearing this device and reloading the latest version...');
  await hardReset({ reload: true });
}

/** Build label + reset button. Safe to call on every sidebar render. */
export function mountFreshStart(el) {
  if (!el) return;
  injectStyle();
  el.innerHTML = `
    <div class="fs-block">
      <button class="fs-btn" type="button" id="${el.id}-reset"
              title="Clear this device and load the newest version">
        ${ICON_REFRESH}<span>Update / Reset app</span>
      </button>
      <div class="fs-build">Build ${runningBuild()}</div>
    </div>`;
  el.querySelector(`#${el.id}-reset`)?.addEventListener('click', (e) => confirmAndReset(e.currentTarget));
}

let barShown = false;

function showUpdateBar(deployed) {
  if (barShown) return;
  barShown = true;
  injectStyle();
  const bar = document.createElement('div');
  bar.className = 'fs-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `
    <div class="fs-bar-text">
      <strong>A newer version is available.</strong>
      You are on ${runningBuild()}, the latest is ${deployed}.
    </div>
    <div class="fs-bar-actions">
      <button class="fs-now" type="button">Update now</button>
      <button class="fs-later" type="button">Later</button>
    </div>`;
  // Push the app down rather than covering its header.
  const pad = () => { document.body.style.paddingTop = `${bar.offsetHeight}px`; };
  bar.querySelector('.fs-now').addEventListener('click', async () => {
    overlay('Updating to the latest version...');
    await hardReset({ reload: true });
  });
  bar.querySelector('.fs-later').addEventListener('click', () => {
    bar.remove();
    document.body.style.paddingTop = '';
    // Only for this page view. A stale build is a real bug, so "Later" must
    // not be a way to live on one for ever.
    try { sessionStorage.setItem('fs_update_snoozed', '1'); } catch { /* blocked */ }
  });
  document.body.appendChild(bar);
  pad();
  window.addEventListener('resize', pad);
}

async function checkOnce() {
  if (barShown) return;
  try { if (sessionStorage.getItem('fs_update_snoozed')) return; } catch { /* blocked */ }
  const running = runningBuild();
  if (running === 'unknown') return;
  const deployed = await deployedBuild();
  if (!deployed || deployed === running) return;
  console.log(`[freshstart] stale: running ${running}, deployed ${deployed}`);
  showUpdateBar(deployed);
}

const CHECK_EVERY_MS = 15 * 60 * 1000;

/**
 * Watch for a newer deploy: once shortly after boot, whenever the tab is
 * brought back to the front, and every fifteen minutes. The visibility hook is
 * the one that matters on a phone, where the installed app is resumed far more
 * often than it is cold-started.
 */
export function startUpdateWatch() {
  tidyFreshMarker();
  setTimeout(checkOnce, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkOnce();
  });
  setInterval(checkOnce, CHECK_EVERY_MS);
}
