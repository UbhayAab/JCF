// One presentation refresh for verified/expired training state. Clinical forms
// on still-permitted routes are retained; dashboard links and revoked routes
// are reevaluated through the normal router and current native actor.
import { getUserRole } from '../auth.js';
import * as probation224 from '../utils/probation.js';
import { renderSidebar } from './sidebar.js';
import { getCurrentRoute, initRouter } from '../router.js';
import * as dashboard224 from '../pages/dashboard.js';
// Optional namespace reads keep a mixed old/new cached module graph linkable.
const PROBATION_EVENT224 = probation224.PROBATION_EVENT224 || 'pn:probation-access224';
let bound = false;
export function bindProbationPresentation224() {
  if (bound) return;
  bound = true;
  window.addEventListener(PROBATION_EVENT224, event => {
    const container = document.getElementById('page-content');
    if (!container || document.hidden) return;
    renderSidebar();
    const current = getCurrentRoute();
    if (current === 'dashboard') dashboard224.restrictDashboardActions224?.(container);
    if (event.detail?.phase === 'expired' || !current) return;
    if (current === 'dashboard' || !probation224.routeOpen(location.hash.slice(1), getUserRole())) {
      initRouter();
    }
  });
}
