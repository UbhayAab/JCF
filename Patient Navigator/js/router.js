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
export function getRouteParams() {
  // A route may carry a query string (analytics uses ?f=<encoded filters> so a
  // filtered view can be shared as a link). It is never part of the path.
  const hash = (window.location.hash.slice(1).split('?')[0]) || 'login';
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

// Handle route change
async function handleRouteChange() {
  const hash = window.location.hash || '#login';
  if (hash !== currentHash) { previousHash = currentHash; currentHash = hash; }
  const basePath = getBasePath(hash);
  const route = routes[basePath];

  if (!route) {
    navigate('dashboard');
    return;
  }

  // Auth guard
  if (route.requiresAuth !== false && authGuard) {
    const isAuthed = await authGuard();
    if (!isAuthed) {
      navigate('login');
      return;
    }
  }

  // Role guard
  if (route.roles && roleGuard) {
    const hasRole = await roleGuard(route.roles);
    if (!hasRole) {
      navigate('dashboard');
      return;
    }
  }

  currentRoute = basePath;

  // Call the route handler
  const container = document.getElementById('page-content');
  if (container && route.handler) {
    await route.handler(container, getRouteParams());
    // Page transition + auto-staggered reveals for every route render.
    window.AnimKit?.enter?.(container);
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
