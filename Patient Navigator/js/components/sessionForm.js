// ============================================================
// Patient Navigator: Saturday group-session log (shared modal)
// Nutrition one Saturday, well-being the next: logged so the
// circles show up in analytics and on the dashboard.
// ============================================================

import { getSupabase } from '../supabase.js';
import { getCurrentProfile } from '../auth.js';
import { showToast } from './toast.js';
import { showModal, closeModal } from './modal.js';
import { icon } from './icons.js';

export function nextSaturday(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d;
}

// Suggest the alternating type based on the most recent logged session.
export async function suggestNextSession() {
  const sb = getSupabase();
  try {
    const { data } = await sb.from('group_sessions')
      .select('session_type, session_date').order('session_date', { ascending: false }).limit(1);
    const last = data?.[0];
    const type = last?.session_type === 'nutrition' ? 'wellbeing' : 'nutrition';
    return { date: nextSaturday(), type, last };
  } catch { return { date: nextSaturday(), type: 'nutrition', last: null }; }
}

export function openSessionForm({ onSaved = null, defaults = {} } = {}) {
  const me = getCurrentProfile();
  const date = defaults.date || nextSaturday();
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 var(--s4)">Log the WhatsApp-group circle after it happens: topic, turnout, what landed.</p>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Date</label>
        <input class="form-input" type="date" id="gs-date" value="${date.toISOString().slice(0, 10)}" /></div>
      <div class="form-group"><label class="form-label">Type</label>
        <select class="form-select" id="gs-type">
          <option value="nutrition" ${defaults.type === 'nutrition' ? 'selected' : ''}>Nutrition circle</option>
          <option value="wellbeing" ${defaults.type === 'wellbeing' ? 'selected' : ''}>Well-being circle</option>
          <option value="other">Other</option>
        </select></div>
      <div class="form-group"><label class="form-label">People reached</label>
        <input class="form-input" type="number" min="0" id="gs-attendees" placeholder="attendees" /></div>
    </div>
    <div class="form-group"><label class="form-label">Topic</label>
      <input class="form-input" id="gs-topic" placeholder="e.g., Eating through chemo week · Managing scan anxiety" /></div>
    <div class="form-group"><label class="form-label">Notes: what worked, questions asked</label>
      <textarea class="form-input form-textarea" id="gs-notes"></textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="gs-cancel">Cancel</button>
      <button class="btn btn-primary" id="gs-save">${icon('check')}Log session</button>
    </div>`;
  showModal({ title: 'Saturday circle', content: el, size: 'lg' });
  el.querySelector('#gs-cancel').addEventListener('click', () => closeModal());
  el.querySelector('#gs-save').addEventListener('click', async () => {
    const dateV = el.querySelector('#gs-date').value;
    if (!dateV) { showToast('Pick the session date', 'warning'); return; }
    const btn = el.querySelector('#gs-save');
    btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
    try {
      const { error } = await getSupabase().from('group_sessions').insert({
        session_date: dateV,
        session_type: el.querySelector('#gs-type').value,
        topic: el.querySelector('#gs-topic').value.trim() || null,
        attendees_count: Number(el.querySelector('#gs-attendees').value) || null,
        notes: el.querySelector('#gs-notes').value.trim() || null,
        facilitator_id: me?.id || null,
        created_by: me?.id || null,
      });
      if (error) throw error;
      closeModal(); showToast('Session logged. It now counts in analytics', 'success');
      if (typeof onSaved === 'function') onSaved();
    } catch (e) {
      showToast('Could not log: ' + e.message, 'error');
      btn.disabled = false; btn.innerHTML = `${icon('check')}Log session`;
    }
  });
}
