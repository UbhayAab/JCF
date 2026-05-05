// ============================================================
// Patient Navigator — SPA Router (Hash-based)
// ============================================================

const routes = {};
let currentRoute = null;
let authGuard = null;
let roleGuard = null;

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

// Get current route
export function getCurrentRoute() { return currentRoute; }

// Get route params from hash (e.g., #patients/abc-123 → { id: 'abc-123' })
export function getRouteParams() {
  const hash = window.location.hash.slice(1) || 'login';
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
  const path = hash.slice(1) || 'login';
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
