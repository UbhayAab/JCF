import { getSupabase } from '../supabase.js';
import { sanitize } from '../utils/validators.js';
import { formatDate } from '../utils/formatters.js';

const LABELS = {
  patient_concerns: 'Flag', call_queue: 'Call to make', care_sessions: 'Care session',
  document_collections: 'Document follow-up', hopebot_requests: 'HopeBot call request',
  first_call_onboarding: 'First-call invitation',
};
const RESULT = {
  restored: 'Restored after status correction', changed_since: 'Kept the later change',
  outbound_cancelled: 'Invitation stays cancelled', row_missing: 'Item no longer exists',
};

export async function mountDeceasedWork(mount, patientId) {
  if (!mount) return;
  const { data, error } = await getSupabase().from('patient_deceased_work')
    .select('id,table_name,closed_at,restored_at,restore_result')
    .eq('patient_id', patientId).order('id', { ascending: false }).limit(100);
  if (!mount.isConnected) return;
  if (error) { console.warn('[status work]', error.message); return; }
  if (!data?.length) { mount.innerHTML = ''; return; }
  const current = data.filter(r => !r.restored_at).length;
  mount.innerHTML = `<div class="card" style="margin-bottom:var(--s5)">
    <div class="card-header"><div class="card-title">Work after status change</div></div>
    <p class="due-meta" style="margin:0 0 10px">${current
      ? `${current} item${current === 1 ? '' : 's'} closed automatically when this patient was marked deceased.`
      : 'The deceased status was corrected. Unchanged care work was restored.'}
      Later changes are kept. Old invitations stay cancelled.</p>
    <details><summary style="cursor:pointer">Recent closure history${data.length === 100 ? ' (latest 100 items)' : ''}</summary>
      <div style="display:grid;gap:8px;margin-top:12px">${data.map(r => `<div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap">
        <span>${LABELS[r.table_name] || 'Care work'} - ${sanitize(formatDate(r.closed_at))}</span>
        <span class="due-meta">${RESULT[r.restore_result] || 'Closed after deceased status'}</span>
      </div>`).join('')}</div>
    </details></div>`;
}
