// ============================================================
// Patient Navigator: the theme picker
// The five shared JCF themes (Auto, Light, Dark, Classic, High contrast)
// come from js/theme.mjs and css/themes.css, copied unchanged from the
// shared set (Fixboard #17). js/theme-boot.js applies the saved choice
// before first paint under the key jcf_theme; a saved "colorful" from the
// old picker is not one of the five, so it falls back to Auto.
// This module only draws PN's header control for them.
// ============================================================
import { THEMES, initTheme as initShared, setTheme, currentTheme } from './theme.mjs';

const KEY = 'jcf_theme';

export function initTheme() { initShared(KEY); }

const swatch = (id) => `<span class="theme-swatch" data-for="${id}" aria-hidden="true"></span>`;
// A native select is as wide as its longest option: "High contrast" pushed the
// 390px phone header past its width and squeezed the menu button to a speck.
const PHONE_LABEL = { contrast: 'Contrast' };

// The header control. Wide screens get a segmented row of swatches; phones get
// one native select (CSS shows one or the other), because five 44px buttons do
// not fit beside "Refresh" and the profile button at 360-390px. Both drive
// setTheme and stay in step with each other and with Auto following the device.
export function renderThemeSwitch() {
  const cur = currentTheme();
  const el = document.createElement('div');
  el.className = 'theme-control';
  el.innerHTML = `
    <div class="theme-switch" role="group" aria-label="Colour theme">
      ${THEMES.map((t) => `
        <button type="button" class="theme-opt ${t.id === cur ? 'on' : ''}" data-theme-opt="${t.id}"
                title="${t.label}: ${t.hint}" aria-label="${t.label} theme" aria-pressed="${t.id === cur}">
          ${swatch(t.id)}
        </button>`).join('')}
    </div>
    <label class="theme-select-wrap">
      <span class="theme-select-ico">${swatch(cur)}</span>
      <select class="theme-select" aria-label="Colour theme">
        ${THEMES.map((t) => `<option value="${t.id}" title="${t.label}: ${t.hint}" ${t.id === cur ? 'selected' : ''}>${PHONE_LABEL[t.id] || t.label}</option>`).join('')}
      </select>
    </label>`;
  const select = el.querySelector('.theme-select');
  const ico = el.querySelector('.theme-select-ico');
  const sync = (id) => {
    el.querySelectorAll('.theme-opt').forEach((b) => {
      const on = b.dataset.themeOpt === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    });
    select.value = id;
    ico.innerHTML = swatch(id);
  };
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-opt]');
    if (btn) setTheme(btn.dataset.themeOpt);
  });
  select.addEventListener('change', () => setTheme(select.value));
  window.addEventListener('themechange', () => sync(currentTheme()));
  return el;
}
