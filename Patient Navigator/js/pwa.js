// ============================================================
// Patient Navigator - PWA install + service worker.
//
// The install offer used to be a popup that appeared over the app and had
// to be dismissed. It is now a plain button that sits in the sidebar:
//   In a browser tab  -> "Install app" is there whenever they want it
//   In the installed app -> it is not rendered at all
//   Android / Chromium -> one tap, the real install prompt
//   iOS Safari         -> a short Share -> Add to Home Screen how-to,
//                         because iOS has no programmatic install
// Nothing pops up on its own and there is nothing to dismiss.
// ============================================================

const STYLE_ID = 'pwa-install-style';

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
    || window.navigator.standalone === true
    // The Android WebView wrapper is an installed app by any useful definition.
    || !!window.CarcinomeNative;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

let deferredPrompt = null;
let installed = false;
// Mount points that asked for the button before the browser told us whether
// installing is possible. Re-rendered when that changes.
const mounts = new Set();

export function initPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW register failed', e));
    });
  }
  if (isStandalone()) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();          // no browser-chrome popup; our button owns this
    deferredPrompt = e;
    repaintAll();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installed = true;
    repaintAll();
  });
}

// Can this browser actually install us? Chromium answers by firing
// beforeinstallprompt; iOS never does, but Add to Home Screen still works.
export function canOfferInstall() {
  return !installed && !isStandalone() && (!!deferredPrompt || isIOS());
}

// Render the install control into `el` (a container the caller owns). Safe to
// call on every sidebar render; it is a no-op inside the installed app.
export function mountInstallButton(el) {
  if (!el) return;
  mounts.add(el);
  paint(el);
}

function repaintAll() {
  for (const el of [...mounts]) {
    if (!el.isConnected) { mounts.delete(el); continue; }
    paint(el);
  }
}

function paint(el) {
  if (!canOfferInstall()) { el.innerHTML = ''; return; }
  injectStyle();
  el.innerHTML = `
    <button class="pwa-install-btn" type="button" title="Install Patient Navigator on this device">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span>Install app</span>
    </button>`;
  el.querySelector('.pwa-install-btn')?.addEventListener('click', promptInstall);
}

export async function promptInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    try {
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') installed = true;
    } catch { /* the user closed it; nothing to do */ }
    deferredPrompt = null;
    repaintAll();
    return;
  }
  if (isIOS()) showIosSheet();
}

// iOS gives no install API at all, so the honest thing is to show the two
// taps it actually takes.
function showIosSheet() {
  if (document.getElementById('pwa-ios-sheet')) return;
  injectStyle();
  const wrap = document.createElement('div');
  wrap.id = 'pwa-ios-sheet';
  wrap.innerHTML = `
    <div class="pwa-sheet-back"></div>
    <div class="pwa-sheet" role="dialog" aria-modal="true" aria-label="Install on iPhone">
      <div class="pwa-sheet-h">
        <span class="pwa-sheet-ico" style="background-image:url('./icons/icon-192.png')"></span>
        <div>
          <div class="pwa-sheet-t">Install Jarurat Care</div>
          <div class="pwa-sheet-s">Two taps in Safari, and it opens like an app.</div>
        </div>
      </div>
      <ol class="pwa-steps">
        <li>Tap the <b>Share</b> button at the bottom of Safari
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><polyline points="8 8 12 4 16 8"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>
        </li>
        <li>Scroll down and choose <b>Add to Home Screen</b></li>
        <li>Tap <b>Add</b> - it appears with your other apps</li>
      </ol>
      <button class="pwa-sheet-btn" id="pwa-sheet-close">Got it</button>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.pwa-sheet-back')?.addEventListener('click', close);
  wrap.querySelector('#pwa-sheet-close')?.addEventListener('click', close);
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .pwa-install-btn{display:flex;align-items:center;gap:9px;width:100%;padding:9px 11px;margin-bottom:8px;
      font-family:inherit;font-size:13px;font-weight:600;color:var(--ink-2);cursor:pointer;
      background:var(--surface-3,rgba(127,127,127,.09));border:1px solid var(--line-2,rgba(127,127,127,.22));
      border-radius:var(--r-sm,9px);transition:background .15s,color .15s}
    .pwa-install-btn:hover{background:var(--surface-4,rgba(127,127,127,.16));color:var(--ink)}
    .pwa-install-btn:active{transform:translateY(1px)}
    .pwa-install-btn svg{width:16px;height:16px;flex:none}

    #pwa-ios-sheet{position:fixed;inset:0;z-index:400;display:grid;place-items:end center}
    #pwa-ios-sheet .pwa-sheet-back{position:absolute;inset:0;background:rgba(8,20,19,.5);backdrop-filter:blur(2px)}
    #pwa-ios-sheet .pwa-sheet{position:relative;width:min(460px,calc(100% - 20px));
      margin:0 0 calc(14px + env(safe-area-inset-bottom,0px));padding:18px;
      background:var(--surface,#fff);border:1px solid var(--line-2,rgba(127,127,127,.22));
      border-radius:var(--r-lg,16px);box-shadow:0 18px 50px rgba(6,26,25,.34);
      animation:pwaUp .34s cubic-bezier(.16,1,.3,1) both}
    @keyframes pwaUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
    #pwa-ios-sheet .pwa-sheet-h{display:flex;align-items:center;gap:12px;margin-bottom:14px}
    #pwa-ios-sheet .pwa-sheet-ico{width:44px;height:44px;border-radius:12px;flex:none;background-size:cover}
    #pwa-ios-sheet .pwa-sheet-t{font:var(--t-body-strong,600 15px/1.3 system-ui);color:var(--ink,#12201f)}
    #pwa-ios-sheet .pwa-sheet-s{font:var(--t-xs,400 12px/1.4 system-ui);color:var(--ink-3,#6b7a78);margin-top:2px}
    #pwa-ios-sheet .pwa-steps{margin:0 0 16px;padding-left:20px;display:flex;flex-direction:column;gap:9px;
      font-size:13.5px;line-height:1.45;color:var(--ink-2,#334746)}
    #pwa-ios-sheet .pwa-steps b{color:var(--ink,#12201f)}
    #pwa-ios-sheet .pwa-steps svg{width:15px;height:15px;vertical-align:-3px;margin-left:2px}
    #pwa-ios-sheet .pwa-sheet-btn{width:100%;padding:11px;font-family:inherit;font-size:14px;font-weight:600;
      color:var(--ink-inv,#fff);background:var(--ink,#12201f);border:none;border-radius:var(--r-sm,9px);cursor:pointer}
  `;
  document.head.appendChild(s);
}
