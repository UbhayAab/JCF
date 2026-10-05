// ============================================================
// Patient Navigator: erase a family's stored files (admin only).
//
// DPDPA: the consent script promises deletion on request. The database
// (sql/155) lists the files and records who erased what, when and why, never
// the content. The files themselves can only be deleted through the Storage
// API, so the deletion runs here, in the admin's own session, under the
// storage policy that lets only an admin delete. finish() then reads what is
// still stored, so a deletion that silently failed shows up as "partial"
// instead of a success.
//
// Loaded on use (await import(...)) by the patient record and the Admin page.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { sanitize } from '../utils/validators.js';

// The Storage API takes up to 1,000 names per request; 100 keeps each small.
const CHUNK = 100;
const CONFIRM_WORD = 'ERASE';
const REASONS = [
  'The family asked for their data to be deleted (DPDPA)',
  'The family withdrew consent for their documents',
  'Test or duplicate record',
  'Leftover files of a family that no longer exists',
  'Pages of an upload that was discarded or failed',
];

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function removeAll(sb, objects) {
  const byBucket = new Map();
  for (const o of objects || []) {
    if (!byBucket.has(o.bucket)) byBucket.set(o.bucket, []);
    byBucket.get(o.bucket).push(o.name);
  }
  const problems = [];
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += CHUNK) {
      const { error } = await sb.storage.from(bucket).remove(names.slice(i, i + CHUNK));
      if (error) problems.push(error.message);
    }
  }
  return problems;
}

/**
 * Count, confirm, erase, and report. `batchId` narrows it to one upload.
 * `label` names what is being erased in the dialog ("PAT-2026-01234",
 * "a family that no longer exists").
 */
export async function openEraseFiles({ patientId, batchId = null, label = 'this family', defaultReason = REASONS[0], onDone } = {}) {
  const sb = getSupabase();
  let preview;
  try {
    const { data, error } = await sb.rpc('start_patient_file_erasure', {
      p_patient_id: patientId, p_reason: null, p_batch_id: batchId, p_dry_run: true,
    });
    if (error) throw error;
    preview = data || {};
  } catch (e) {
    showToast('Could not count the stored files: ' + sanitize(e.message), 'error', 8000);
    return;
  }
  if (!preview.files) {
    // An earlier erasure whose files went but whose finish never ran (a closed
    // tab, a dropped connection): finish it now, so its uploads stop showing.
    if (preview.unfinished) {
      try {
        const { data, error } = await sb.rpc('finish_patient_file_erasure', { p_erasure_id: preview.unfinished });
        if (error) throw error;
        showToast(`Finished the earlier erasure: ${plural(data.files_removed, 'file', 'files')} erased. The record keeps who, when and why.`, 'success', 6000);
        if (typeof onDone === 'function') onDone(data);
      } catch (e) {
        showToast('Could not finish the earlier erasure: ' + sanitize(e.message), 'error', 8000);
      }
      return;
    }
    showToast(`Nothing is stored for ${sanitize(label)}. There is nothing to erase.`, 'info');
    return;
  }

  const what = batchId ? 'this upload' : 'this family';
  const body = document.createElement('div');
  body.innerHTML = `
    <p style="margin:0 0 10px">${plural(preview.files, 'file is', 'files are')} stored for
      <strong>${sanitize(label)}</strong> (${fmtBytes(preview.bytes)}): every page and thumbnail${batchId ? '' : ', WhatsApp file and call recording'} of ${what}.
      Erasing deletes them for good. It cannot be undone.</p>
    <p class="text-muted" style="margin:0 0 14px;font-size:13px">The record keeps who erased them, when and why, and a
      fingerprint of each file, never its name or content. Values already read off the documents into the record stay.</p>
    <div class="form-group">
      <label class="form-label" for="ef-reason">Why</label>
      <select class="form-select" id="ef-reason">
        ${REASONS.map((r) => `<option ${r === defaultReason ? 'selected' : ''}>${sanitize(r)}</option>`).join('')}
        <option value="">Something else (write it below)</option>
      </select>
      <input class="form-input" id="ef-other" maxlength="300" placeholder="The reason, in a few words" style="margin-top:8px;display:none" />
    </div>
    <div class="form-group">
      <label class="form-label" for="ef-confirm">Type ${CONFIRM_WORD} to confirm</label>
      <input class="form-input" id="ef-confirm" autocomplete="off" spellcheck="false" style="max-width:200px" />
    </div>
    <p id="ef-progress" class="text-muted" style="margin:6px 0 0;font-size:13px" aria-live="polite"></p>`;

  const overlay = showModal({
    title: 'Erase stored files',
    content: body,
    footer: `
      <button class="btn btn-secondary" data-ef-cancel>Cancel</button>
      <button class="btn btn-danger" data-ef-go disabled>Erase ${plural(preview.files, 'file', 'files')}</button>`,
  });
  const $ = (sel) => overlay.querySelector(sel);
  const reasonText = () => ($('#ef-reason').value || $('#ef-other').value).trim();
  const refresh = () => {
    $('#ef-other').style.display = $('#ef-reason').value ? 'none' : '';
    $('[data-ef-go]').disabled = !($('#ef-confirm').value.trim().toUpperCase() === CONFIRM_WORD && reasonText().length >= 3);
  };
  $('#ef-reason').addEventListener('change', refresh);
  $('#ef-other').addEventListener('input', refresh);
  $('#ef-confirm').addEventListener('input', refresh);
  $('[data-ef-cancel]').addEventListener('click', () => closeModal());

  $('[data-ef-go]').addEventListener('click', async () => {
    const go = $('[data-ef-go]');
    const progress = $('#ef-progress');
    go.disabled = true;
    $('[data-ef-cancel]').disabled = true;
    go.textContent = 'Erasing…';
    let result;
    try {
      const { data: started, error: sErr } = await sb.rpc('start_patient_file_erasure', {
        p_patient_id: patientId, p_reason: reasonText(), p_batch_id: batchId, p_dry_run: false,
      });
      if (sErr) throw sErr;
      progress.textContent = `Deleting ${plural(started.files, 'file', 'files')}…`;
      const problems = await removeAll(sb, started.objects);
      const { data: finished, error: fErr } = await sb.rpc('finish_patient_file_erasure', { p_erasure_id: started.erasure_id });
      if (fErr) throw fErr;
      result = { ...finished, problems };
    } catch (e) {
      showToast('The erasure stopped: ' + sanitize(e.message) + '. Nothing is hidden; run it again.', 'error', 10000);
      closeModal();
      if (typeof onDone === 'function') onDone(null);
      return;
    }
    closeModal();
    if (result.status === 'done') {
      showToast(`Erased ${plural(result.files_removed, 'file', 'files')}. The record keeps who, when and why.`, 'success', 6000);
    } else {
      const why = result.problems?.length ? ` (${sanitize(result.problems[0])})` : '';
      showToast(`Erased ${result.files_removed} of ${result.files_found}; ${plural(result.files_left, 'file is', 'files are')} still stored${why}. Run it again.`, 'warning', 10000);
    }
    if (result.new_since_start) {
      showToast(`${plural(result.new_since_start, 'file was', 'files were')} added while this ran and ${result.new_since_start === 1 ? 'is' : 'are'} still stored.`, 'warning', 10000);
    }
    if (typeof onDone === 'function') onDone(result);
  });
  $('#ef-confirm').focus();
}
