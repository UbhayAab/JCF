// ============================================================
// Patient Navigator: Theme engine (light · dark · colorful)
// The whole app is token-driven (css/variables.css), so switching
// modes just stamps data-theme on <html>; every view re-skins for
// free. Choice persists in localStorage and applies before first
// paint via the inline bootstrap in index.html (no flash).
// ============================================================

const KEY = 'jcf_theme';
export const THEMES = ['light', 'dark', 'colorful'];
const META = {
  light: '#F6F2EA',
  dark: '#0A1516',
  colorful: '#EEEAFF',
};

export function getTheme() {
  try {
    // ?theme= override (handy for support: "open your app in dark to check")
    const q = new URLSearchParams(location.search).get('theme');
    if (THEMES.includes(q)) return q;
    const t = localStorage.getItem(KEY);
    if (THEMES.includes(t)) return t;
  } catch {}
  return 'light';
}

export function setTheme(mode) {
  if (!THEMES.includes(mode)) mode = 'light';
  const root = document.documentElement;
  // 'light' is the :root default → no attribute needed, but we set it
  // explicitly so [data-theme] selectors and the switcher stay in sync.
  root.setAttribute('data-theme', mode);
  try { localStorage.setItem(KEY, mode); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META[mode] || META.light);
  // let theme-aware widgets (charts, canvases) recolour
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: mode } }));
}

export function initTheme() { setTheme(getTheme()); }

const SW_ICONS = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  colorful: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="12" r="2.5"/><circle cx="8.5" cy="7.5" r="2.5"/><circle cx="6.5" cy="12.5" r="2.5"/><path d="M12 22a10 10 0 1 1 0-20 8.5 8.5 0 0 1 0 17c-1.5 0-1.5 1-1.5 1.5S11 22 12 22z"/></svg>',
};
const SW_LABEL = { light: 'Light', dark: 'Dark', colorful: 'Colorful' };

// Segmented 3-way switch. Returns the element; wires itself.
export function renderThemeSwitch() {
  const cur = getTheme();
  const el = document.createElement('div');
  el.className = 'theme-switch';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Colour theme');
  el.innerHTML = THEMES.map(t => `
    <button type="button" class="theme-opt ${t === cur ? 'on' : ''}" data-theme-opt="${t}"
            title="${SW_LABEL[t]} theme" aria-label="${SW_LABEL[t]} theme" aria-pressed="${t === cur}">
      ${SW_ICONS[t]}
    </button>`).join('');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-opt]');
    if (!btn) return;
    const mode = btn.dataset.themeOpt;
    setTheme(mode);
    el.querySelectorAll('.theme-opt').forEach(b => {
      const on = b.dataset.themeOpt === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
  });
  return el;
}
