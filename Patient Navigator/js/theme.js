// ============================================================
// Patient Navigator: Theme engine (light · dark · colorful)
// The whole app is token-driven (css/variables.css), so switching
// modes just stamps data-theme on <html>; every view re-skins for
// free. Choice persists in localStorage and applies before first
// paint via the inline bootstrap in index.html (no flash).
// ============================================================

const KEY = 'jcf_theme';
export const THEMES = ['light', 'dark', 'colorful', 'classic'];
const META = {
  light: '#FFDFCA',
  dark: '#1A110C',
  colorful: '#FFCDB0',
  classic: '#F6F2EA',
};

// Classic is the previous look and keeps its own type (Archivo + Spline Sans
// Mono). The stylesheet is added the first time classic is on, so the other
// themes never download those fonts. index.html adds the same link (same id)
// before first paint when classic is the saved theme.
const CLASSIC_FONTS_ID = 'classic-fonts';
const CLASSIC_FONTS = 'https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&family=Spline+Sans+Mono:ital,wght@0,400..700;1,400..700&display=swap';
function loadClassicFonts() {
  if (document.getElementById(CLASSIC_FONTS_ID)) return;
  const link = document.createElement('link');
  link.id = CLASSIC_FONTS_ID;
  link.rel = 'stylesheet';
  link.href = CLASSIC_FONTS;
  document.head.appendChild(link);
}

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
  if (mode === 'classic') loadClassicFonts();
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
  classic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
};
const SW_LABEL = { light: 'Light', dark: 'Dark', colorful: 'Colorful', classic: 'Classic' };
const SW_TITLE = { light: 'Light theme', dark: 'Dark theme', colorful: 'Colorful theme', classic: 'Classic theme (the previous look)' };

// The header control. Wide screens get a segmented row of icons; phones get
// one native select (CSS shows one or the other), because four 44px buttons
// do not fit beside "Refresh" and the profile button at 360-390px. Both drive
// setTheme and stay in step with each other.
export function renderThemeSwitch() {
  const cur = getTheme();
  const el = document.createElement('div');
  el.className = 'theme-control';
  el.innerHTML = `
    <div class="theme-switch" role="group" aria-label="Colour theme">
      ${THEMES.map(t => `
        <button type="button" class="theme-opt ${t === cur ? 'on' : ''}" data-theme-opt="${t}"
                title="${SW_TITLE[t]}" aria-label="${SW_TITLE[t]}" aria-pressed="${t === cur}">
          ${SW_ICONS[t]}
        </button>`).join('')}
    </div>
    <label class="theme-select-wrap">
      <span class="theme-select-ico" aria-hidden="true">${SW_ICONS[cur]}</span>
      <select class="theme-select" aria-label="Colour theme">
        ${THEMES.map(t => `<option value="${t}" ${t === cur ? 'selected' : ''}>${SW_LABEL[t]}</option>`).join('')}
      </select>
    </label>`;
  const select = el.querySelector('.theme-select');
  const ico = el.querySelector('.theme-select-ico');
  const sync = (mode) => {
    el.querySelectorAll('.theme-opt').forEach(b => {
      const on = b.dataset.themeOpt === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
    select.value = mode;
    ico.innerHTML = SW_ICONS[mode];
  };
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-opt]');
    if (!btn) return;
    setTheme(btn.dataset.themeOpt);
    sync(btn.dataset.themeOpt);
  });
  select.addEventListener('change', () => {
    setTheme(select.value);
    sync(select.value);
  });
  return el;
}
