/* ============================================================
   anim.js: shared motion engine (vanilla, dependency-free)
   • [data-reveal]            staggered entrance on load / scroll
   • [data-reveal-group]      auto-staggers its [data-reveal] children
   • [data-count]             number count-up when revealed
   • .scorebar .fill[data-w]  width fill when revealed
   • [data-tilt]              subtle pointer-reactive 3D tilt
   • AnimKit.enter(container) page transition + auto-reveal:
     called by the router on every route render, so every page
     gets staggered entrances without touching its markup
   • soft ink ripple on press for all interactive controls
   • header glass-on-scroll state
   ============================================================ */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- stagger groups: assign incremental animation-delay ---- */
  function applyStagger(root) {
    (root || document).querySelectorAll('[data-reveal-group]').forEach(function (g) {
      var step = parseFloat(g.getAttribute('data-stagger')) || 70;
      var base = parseFloat(g.getAttribute('data-delay')) || 0;
      var kids = g.querySelectorAll('[data-reveal]');
      kids.forEach(function (k, i) {
        if (!k.style.animationDelay) k.style.animationDelay = (base + i * step) + 'ms';
      });
    });
  }

  /* ---- count-up ---- */
  function countUp(el) {
    if (el.__counted) return; el.__counted = true;
    var target = parseFloat(el.getAttribute('data-count'));
    var dec = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    if (reduce) { el.textContent = prefix + target.toFixed(dec) + suffix; return; }
    var dur = parseInt(el.getAttribute('data-dur') || '1100', 10);
    var t0 = null;
    function ease(t) { return 1 - Math.pow(1 - t, 3); }
    function frame(ts) {
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      var v = target * ease(p);
      el.textContent = prefix + v.toFixed(dec) + suffix;
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = prefix + target.toFixed(dec) + suffix;
    }
    requestAnimationFrame(frame);
  }

  /* ---- scorebar fill ---- */
  function fillBars(el) {
    el.querySelectorAll('.scorebar .fill[data-w]').forEach(function (f) {
      requestAnimationFrame(function () { f.style.width = f.getAttribute('data-w'); });
    });
    if (el.matches && el.matches('.scorebar')) {
      var f = el.querySelector('.fill[data-w]');
      if (f) requestAnimationFrame(function () { f.style.width = f.getAttribute('data-w'); });
    }
  }

  /* ---- reveal observer ---- */
  function revealEl(el) {
    el.classList.add('in');
    if (el.hasAttribute('data-count')) countUp(el);
    el.querySelectorAll && el.querySelectorAll('[data-count]').forEach(countUp);
    fillBars(el);
  }

  var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { revealEl(e.target); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }) : null;

  function observeAll(root) {
    var els = (root || document).querySelectorAll('[data-reveal]');
    if (!io || reduce) { els.forEach(revealEl); return; }
    els.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.95) revealEl(el);
      else io.observe(el);
    });
    // standalone count-ups not wrapped in a reveal
    (root || document).querySelectorAll('[data-count]').forEach(function (el) {
      if (!el.closest('[data-reveal]')) {
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight) countUp(el); else io.observe(el);
      }
    });
  }

  /* ----------------------------------------------------------
     Auto-reveal: pages that never adopted [data-reveal] still
     get a staggered entrance. Tags top-level structural blocks
     only, capped, and only when the page brought none itself.
     ---------------------------------------------------------- */
  var AUTO_SEL = [
    '.page-header', '.greet', '.quick .qa', '.hero-card', '.stat-card', '.stat',
    '.qstat', '.chart-card', '.team-card', '.measure-card', '.user-card',
    '.page-content > .card', '.dash > .card', '.dash-grid .card', '.side-col > .card',
    '.content-grid > .card', '.portal-grid .card', '.detail-head', '.kv',
    '.table-container', '.user-list', '.chip-row', '.queue-stats', '.tabs', '.detail-tabs'
  ].join(', ');

  function autoReveal(container) {
    if (!container) return;
    if (container.querySelector('[data-reveal]')) return; // page manages its own
    var limit = window.innerHeight * 1.6; // only choreograph near the fold: deep content just shows
    var els = container.querySelectorAll(AUTO_SEL);
    var n = 0;
    els.forEach(function (el) {
      if (n >= 26) return;
      if (el.closest('.modal, .modal-overlay')) return;
      if (el.closest('[data-reveal]')) return; // never nest reveals
      if (el.getBoundingClientRect().top > limit) return;
      el.setAttribute('data-reveal', '');
      el.style.animationDelay = Math.min(n * 55, 480) + 'ms';
      n++;
    });
  }

  /* ---- page transition: rise the container, stagger its blocks ---- */
  function enter(container) {
    if (!container) return;
    if (!reduce && !document.documentElement.classList.contains('anim-frozen')) {
      container.classList.remove('page-enter');
      void container.offsetWidth; // restart the animation
      container.classList.add('page-enter');
    }
    autoReveal(container);
    applyStagger(container);
    observeAll(container);
    // safety sweep for EVERY page: whatever hasn't revealed shortly after
    // render becomes visible anyway. A quirky IntersectionObserver (older
    // WebViews) must never leave sections blank.
    setTimeout(function () {
      if (!container.isConnected) return;
      container.querySelectorAll('[data-reveal]:not(.in)').forEach(revealEl);
    }, 1200);
  }

  /* ----------------------------------------------------------
     Soft ink ripple on press: delegated, works for content
     rendered at any time. Skipped for coarse errors + reduced
     motion; ripple inherits currentColor (soft-light blend).
     ---------------------------------------------------------- */
  var RIPPLE_SEL = '.btn, .qa, .quick-action-btn, .callbtn, .nav-item, .bottom-nav-item, ' +
                   '.seg-btn, .recep-btn, .yn, .fchip, .tab, .dtab, .svc, .fab, .cg-call, .stepper button';
  function initRipple() {
    if (reduce) return;
    document.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      var host = e.target.closest ? e.target.closest(RIPPLE_SEL) : null;
      if (!host || host.disabled) return;
      var cs = getComputedStyle(host);
      if (cs.position === 'static' || cs.overflow !== 'hidden') host.classList.add('ripple-host');
      var r = host.getBoundingClientRect();
      var d = Math.max(r.width, r.height) * 1.1;
      var s = document.createElement('span');
      s.className = 'ink-ripple';
      s.style.width = s.style.height = d + 'px';
      s.style.left = (e.clientX - r.left - d / 2) + 'px';
      s.style.top = (e.clientY - r.top - d / 2) + 'px';
      host.appendChild(s);
      s.addEventListener('animationend', function () { s.remove(); });
      setTimeout(function () { if (s.isConnected) s.remove(); }, 700); // safety
    }, { passive: true });
  }

  /* ---- header condenses into glass once the page scrolls ---- */
  function initHeaderScroll() {
    var ticking = false;
    function apply() {
      ticking = false;
      var h = document.querySelector('.header');
      if (h) h.classList.toggle('scrolled', window.scrollY > 8);
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(apply); }
    }, { passive: true });
    apply();
  }

  /* ---- pointer tilt ---- */
  function initTilt() {
    if (reduce || matchMedia('(pointer: coarse)').matches) return;
    document.querySelectorAll('[data-tilt]').forEach(function (el) {
      var max = parseFloat(el.getAttribute('data-tilt')) || 5;
      el.style.transformStyle = 'preserve-3d';
      el.style.transition = 'transform 200ms cubic-bezier(0.22,0.68,0.16,1)';
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = 'perspective(900px) rotateX(' + (-py * max) + 'deg) rotateY(' + (px * max) + 'deg) translateY(-4px)';
      });
      el.addEventListener('pointerleave', function () { el.style.transform = ''; });
    });
  }

  function boot() { applyStagger(); observeAll(); initTilt(); initRipple(); initHeaderScroll(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ----------------------------------------------------------
     Frozen-timeline guard: if CSS animations aren't advancing
     (backgrounded tab, some embedded renderers), force all
     entrance states to their visible end. Content is never
     left stuck at opacity:0.
     ---------------------------------------------------------- */
  (function timelineGuard() {
    if (reduce) { document.documentElement.classList.add('anim-frozen'); return; }
    var start = 0;
    try { start = document.timeline.currentTime || 0; } catch (e) {}
    setTimeout(function () {
      var now = 0;
      try { now = document.timeline.currentTime || 0; } catch (e) {}
      if (now <= start) document.documentElement.classList.add('anim-frozen');
    }, 280);
  })();

  /* expose for the router / dynamic content */
  window.AnimKit = {
    refresh: function (root) { applyStagger(root); observeAll(root); },
    enter: enter,
    reveal: revealEl,
    countUp: countUp,
    tilt: initTilt
  };
})();
