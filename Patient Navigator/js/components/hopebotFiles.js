import { getSupabase } from '../supabase.js';
import { getCurrentUser } from '../auth.js';
import { sanitize } from '../utils/validators.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';

const when = (value) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

export async function mountHopebotFiles(mount) {
  if (!mount) return;
  const me = getCurrentUser()?.id;
  const sb = getSupabase();
  const { data, error } = await sb.rpc('hopebot_upload_queue_list');
  if (!mount.isConnected || getCurrentUser()?.id !== me) return;
  if (error) { mount.textContent = 'WhatsApp filing queue is unavailable. Refresh to try again.'; return; }
  mount.innerHTML = `<details class="card" style="padding:16px;margin-bottom:16px" ${data.length ? 'open' : ''}>
    <summary style="font-weight:600;cursor:pointer">WhatsApp files waiting to be filed (${data.length})</summary>
    <p>These originals are safe in HopeBot. A missing or shared number needs a manager to choose the patient. No message is sent to the family when you file a document.</p>
    <label class="form-label" for="hb-queue-last4">Find files by the sender's last 4 digits</label>
    <input class="form-input" id="hb-queue-last4" data-hb-queue-search inputmode="numeric" maxlength="4" autocomplete="off" placeholder="Last 4 digits" value="${sanitize(mount.dataset.hbLast4Filter || '')}">
    <p data-hb-queue-count role="status" aria-live="polite"></p>
    <div data-hb-queue-rows></div>
    <button class="btn btn-ghost btn-sm" type="button" data-hb-files-refresh>Refresh files</button></details>`;
  const search = mount.querySelector('[data-hb-queue-search]');
  const paint = () => {
    const term = search.value.replace(/\D/g, '').slice(0, 4);
    search.value = term;
    mount.dataset.hbLast4Filter = term;
    const shown = data.filter((row) => !term || String(row.sender_last4 || '').includes(term));
    mount.querySelector('[data-hb-queue-count]').textContent = term
      ? `${shown.length} of ${data.length} files match these digits.` : `${data.length} files waiting.`;
    mount.querySelector('[data-hb-queue-rows]').innerHTML = shown.length ? shown.map((row) => `<div data-hb-queue-row="${sanitize(row.media_id)}" data-hb-last4="${sanitize(row.sender_last4)}" style="border-top:1px solid var(--line);padding:12px 0;overflow-wrap:anywhere">
      <strong>Sender ending ${sanitize(row.sender_last4)} - ${row.mime === 'application/pdf' ? 'PDF' : 'Image'}</strong>
      <div>Via WhatsApp ${sanitize(when(row.received_at))}</div>
      <p>${sanitize(row.reason || (row.state === 'filing' || row.state === 'ready' ? 'Filing is pending. It moves to Documents after filing succeeds.' : 'Choose the correct patient.'))}</p>
      ${row.patient_name ? `<p>Selected patient: ${sanitize(row.patient_name)}</p>` : ''}
      <button type="button" class="btn btn-secondary btn-sm" data-hb-file="${sanitize(row.media_id)}" ${['ready','filing'].includes(row.state) ? 'disabled' : ''}>Choose patient and file</button>
    </div>`).join('') : `<p>${term ? 'No waiting files match these digits. Check the number or clear the search.' : 'No files need a patient choice.'}</p>`;
    mount.querySelectorAll('[data-hb-file]').forEach((button) => button.onclick = () => assignFile(data.find((row) => row.media_id === button.dataset.hbFile), () => mountHopebotFiles(mount)));
  };
  search.oninput = paint;
  paint();
  mount.querySelector('[data-hb-files-refresh]').onclick = () => mountHopebotFiles(mount);
}

function assignFile(row, refresh) {
  const me = getCurrentUser()?.id;
  const el = document.createElement('div');
  el.innerHTML = `<p>File the ${row.mime === 'application/pdf' ? 'PDF' : 'image'} received ${sanitize(when(row.received_at))} from the sender ending <strong>${sanitize(row.sender_last4)}</strong>.</p>
    <label class="form-label" for="hb-file-search">Find the patient by name</label>
    <input class="form-input" id="hb-file-search" maxlength="100" autocomplete="off">
    <button class="btn btn-secondary btn-sm" id="hb-file-find" type="button">Find patient</button>
    <label class="form-label" for="hb-file-patient">Correct patient</label>
    <select class="form-select" id="hb-file-patient"><option value="">Search first</option></select>
    <label style="display:flex;gap:8px;margin:16px 0"><input type="checkbox" id="hb-file-consent"><span>I checked the correct patient and the family agreed to store these documents for this patient.</span></label>
    <p id="hb-file-error" role="alert"></p><button class="btn btn-primary" id="hb-file-save" type="button">File for this patient</button>`;
  const modal = showModal({ title: 'File a WhatsApp document', content: el });
  el.querySelector('#hb-file-find').onclick = async () => {
    const term = el.querySelector('#hb-file-search').value.trim();
    const error = el.querySelector('#hb-file-error');
    if (term.length < 2) { error.textContent = 'Enter at least two letters of the patient name.'; return; }
    const out = await getSupabase().from('patients').select('id,full_name,patient_code').eq('is_active', true).eq('is_demo', false).ilike('full_name', `%${term}%`).limit(20);
    if (!el.isConnected || getCurrentUser()?.id !== me) return;
    error.textContent = out.error ? 'The search could not finish. Try again.' : !out.data.length ? 'No patient matched. Check the name or add the patient first.' : '';
    el.querySelector('#hb-file-patient').innerHTML = '<option value="">Choose the patient</option>' + (out.data || []).map((p) => `<option value="${sanitize(p.id)}">${sanitize(p.full_name)} (${sanitize(p.patient_code)})</option>`).join('');
  };
  el.querySelector('#hb-file-save').onclick = async (event) => {
    const patient = el.querySelector('#hb-file-patient').value;
    const agreed = el.querySelector('#hb-file-consent').checked;
    const error = el.querySelector('#hb-file-error');
    if (!patient || !agreed) { error.textContent = 'Choose the correct patient and confirm the family agreed.'; return; }
    event.currentTarget.disabled = true;
    const out = await getSupabase().rpc('hopebot_upload_assign', { p_media: row.media_id, p_patient: patient, p_agreed: agreed });
    if (!el.isConnected || getCurrentUser()?.id !== me) return;
    if (out.error) { event.target.disabled = false; error.textContent = out.error.message; return; }
    if (modal.closeOwnedModal) modal.closeOwnedModal(); else closeModal();
    showToast('Filing requested. Refresh to see it move into the patient Documents.', 'info');
    await refresh();
  };
}

export async function mountWhatsappOriginals(mount, patientId) {
  if (!mount) return;
  const me = getCurrentUser()?.id;
  const sb = getSupabase();
  const { data, error } = await sb.from('whatsapp_documents').select('id,storage_path,mime_type,file_name,received_at,status')
    .eq('patient_id', patientId).neq('status', 'discarded').order('received_at', { ascending: false }).limit(100);
  if (!mount.isConnected || getCurrentUser()?.id !== me) return;
  if (error) { mount.textContent = 'WhatsApp originals could not load. Refresh to try again.'; return; }
  mount.innerHTML = data.length ? `<div class="doc-callout"><strong>Originals via WhatsApp</strong>${data.map((row) => `<div style="padding:10px 0;border-top:1px solid var(--line);overflow-wrap:anywhere">
    <div>${sanitize(row.file_name || (row.mime_type === 'application/pdf' ? 'Report PDF' : 'Report image'))}</div>
    <div>Via WhatsApp ${sanitize(when(row.received_at))} - ${row.status === 'read' ? 'Sent to the reader' : 'Not read yet'}</div>
    <button type="button" class="btn btn-secondary btn-sm" data-hb-original="${sanitize(row.id)}">View original</button></div>`).join('')}</div>` : '';
  mount.querySelectorAll('[data-hb-original]').forEach((button) => button.onclick = async () => {
    const row = data.find((item) => item.id === button.dataset.hbOriginal);
    const out = await sb.storage.from('patient-docs').createSignedUrl(row.storage_path, 300);
    if (!mount.isConnected || getCurrentUser()?.id !== me) return;
    if (out.error || !out.data?.signedUrl) { showToast('The original could not open. Refresh and try again.', 'warning'); return; }
    const a = document.createElement('a'); a.href = out.data.signedUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
  });
}
