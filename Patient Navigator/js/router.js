// ============================================================
// Patient Navigator: SPA Router (Hash-based)
// ============================================================

const routes = {};
let currentRoute = null;
let authGuard = null;
let roleGuard = null;

// The full hash we were on before the current one, or null if this is the
// first route of the session (a deep link, a refresh, or a fresh login).
// goBack() is the only reader. See the comment there.
let previousHash = null;
let currentHash = null;

// Register a route
export function registerRoute(path, handler, options = {}) {
  routes[path] = { handler, ...options };
}

// Set auth guard callback
export function setAuthGuard(fn) { authGuard = fn; }
export function setRoleGuard(fn) { roleGuard = fn; }

// Fixboard #23: a route can be closed to someone for now (on probation). The
// gate answers with where to go instead, or nothing. app.js installs it
// through a dynamic import, so a phone holding an older app.js or router.js
// simply runs without a gate rather than failing to boot.
let routeGate = null;
export function setRouteGate(fn) { routeGate = fn; }

// Navigate to a route
export function navigate(path) {
  window.location.hash = path;
}

// Go back to wherever the user actually came from, falling back to a fixed
// route when there is nowhere to go back to.
//
// Reported from the field: "while checking the call logs of interns when we
// hit back button it automatically land into patient section". The patient
// detail page's Back button was a hard-coded navigate('patients'), so all nine
// screens that link into #patients/<id> - Calls, Concerns, Dashboard, Team,
// Nutrition, Brief, Intake, the calling portal - dumped you in the patients
// list instead of back where you were.
//
// history.back() is only used when we have recorded an in-app route change,
// which means our own hash entry is on the stack and back() cannot walk off
// the site. A deep link or a refresh has no previousHash and takes the
// fallback.
export function goBack(fallback = 'dashboard') {
  if (previousHash && previousHash !== currentHash) window.history.back();
  else navigate(fallback);
}

// Get current route
export function getCurrentRoute() { return currentRoute; }

// Get route params from hash (e.g., #patients/abc-123 → { id: 'abc-123' })
export function getRouteParams(requestHash = window.location.hash) {
  // A route may carry a query string (analytics uses ?f=<encoded filters> so a
  // filtered view can be shared as a link). It is never part of the path.
  const hash = (requestHash.slice(1).split('?')[0]) || 'login';
  const parts = hash.split('/');
  const params = {};

  // Check for ID patterns (UUID or similar)
  if (parts.length >= 2) {
    params.id = parts.slice(1).join('/');
  }

  return params;
}

// Get the base route path (without params)
function getBasePath(hash) {
  const path = hash.slice(1).split('?')[0] || 'login';
  // Try exact match first
  if (routes[path]) return path;

  // Try matching with wildcard (e.g., patients/:id)
  const parts = path.split('/');
  for (let i = parts.length; i > 0; i--) {
    const base = parts.slice(0, i).join('/');
    if (routes[base]) return base;
  }

  // Try parent routes
  if (parts.length > 1) {
    const parent = parts[0];
    if (routes[parent]) return parent;
  }

  return 'dashboard'; // fallback
}

// A navigation owns a connected page element. Local async handler writes to
// an obsolete page then remain detached instead of blanking a newer form.
let routeGeneration = 0;
function showRouteError(container, retry) {
  container.innerHTML = '<section class="card" role="alert"><h2>This page could not load</h2><p>Your sign-in has been kept. Check your connection and try again.</p><button class="btn btn-primary" type="button" data-route-retry>Try again</button></section>';
  container.querySelector('[data-route-retry]')?.addEventListener('click', retry, { once: true });
}

async function handleRouteChange() {
  const generation = ++routeGeneration;
  const hash = window.location.hash || '#login';
  const active = () => generation === routeGeneration && (window.location.hash || '#login') === hash;
  if (hash !== currentHash) { previousHash = currentHash; currentHash = hash; }
  const basePath = getBasePath(hash);
  const route = routes[basePath];
  let container;
  try {
    if (!route) { if (active()) navigate('dashboard'); return; }
    if (route.requiresAuth !== false && authGuard) {
      const allowed = await authGuard();
      if (!active()) return;
      if (!allowed) { navigate('login'); return; }
    }
    if (route.roles && roleGuard) {
      const allowed = await roleGuard(route.roles);
      if (!active()) return;
      if (!allowed) { navigate('dashboard'); return; }
    }
    if (routeGate && route.requiresAuth !== false) {
      const to = await routeGate(hash.slice(1));
      if (!active()) return;
      if (to && to !== basePath) { navigate(to); return; }
    }
    if (!active()) return;
    currentRoute = basePath;
    const old = document.getElementById('page-content');
    if (old && route.handler) {
      container = old.cloneNode(false);
      old.replaceWith(container); // connected BEFORE any handler ID lookup
      await route.handler(container, getRouteParams(hash));
      if (active()) window.AnimKit?.enter?.(container);
    }
  } catch {
    if (!active()) return; // obsolete failures cannot overwrite the new page
    container ||= document.getElementById('page-content');
    if (container?.isConnected) showRouteError(container, () => { if (active()) handleRouteChange(); });
  }
}

// Initialize router (idempotent)
let routerInitialized = false;
export function initRouter() {
  if (routerInitialized) {
    handleRouteChange(); // Just re-evaluate current route
    return;
  }
  routerInitialized = true;
  window.addEventListener('hashchange', handleRouteChange);
  // Handle initial route
  handleRouteChange();
}
