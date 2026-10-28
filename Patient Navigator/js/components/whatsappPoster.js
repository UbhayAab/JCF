import { getSupabase } from '../supabase.js';

export const POSTER_LIMIT = 5 * 1024 * 1024;
export function posterMime(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) return 'image/png';
  return null;
}
export async function validatePoster(file) {
  if (!file || !['image/jpeg','image/png'].includes(file.type) || file.size < 1 || file.size > POSTER_LIMIT)
    throw new Error('Choose a JPG or PNG up to 5 MB.');
  if (posterMime(new Uint8Array(await file.slice(0, 12).arrayBuffer())) !== file.type)
    throw new Error('This file does not contain a valid JPG or PNG image.');
}

/** One private, immutable upload and a local preview. No public object URL leaves the browser. */
export function mountPosterControl(mount, { patientId = null, existing = null, onChange = () => {} } = {}) {
  mount.innerHTML = `<label class="form-label">Attach poster (optional)
    <input class="form-input" type="file" accept="image/jpeg,image/png" data-poster-file></label>
    <p class="form-hint">JPG or PNG, up to 5 MB. Review the poster before scheduling.</p>
    <img data-poster-preview alt="Selected WhatsApp poster" hidden style="display:none;max-width:100%;max-height:320px;object-fit:contain;border-radius:8px">
    <button type="button" class="btn btn-ghost btn-sm" data-poster-remove hidden style="display:none">Remove poster</button>
    <p data-poster-status role="status" aria-live="polite"></p>
    <p data-poster-counts role="status" aria-live="polite"></p>`;
  const sb = getSupabase();
  const input = mount.querySelector('[data-poster-file]');
  const image = mount.querySelector('[data-poster-preview]');
  const status = mount.querySelector('[data-poster-status]');
  const counts = mount.querySelector('[data-poster-counts]');
  const remove = mount.querySelector('[data-poster-remove]');
  let poster = existing; let busy = false; let failed = false; let localUrl = null; let generation = 0; let estimateGeneration = 0;
  const release = () => { if (localUrl) URL.revokeObjectURL(localUrl); localUrl = null; };
  const show = (url) => { image.src = url; image.hidden = false; image.style.display = 'block'; remove.hidden = false; remove.style.display = ''; };
  if (existing?.storage_path) sb.storage.from('wa-posters').createSignedUrl(existing.storage_path, 1800).then(({ data, error }) => {
    if (poster === existing && !error && data?.signedUrl) show(data.signedUrl);
  });
  input.onchange = async () => {
    const version = ++generation; const file = input.files?.[0]; release(); poster = null; failed = false; counts.textContent = '';
    image.removeAttribute('src'); image.hidden = true; image.style.display = 'none'; remove.hidden = !file; remove.style.display = file ? '' : 'none';
    if (!file) { busy = false; status.textContent = ''; onChange(); return; }
    busy = true; status.textContent = 'Checking poster...'; onChange();
    try {
      await validatePoster(file);
      if (version !== generation) return;
      localUrl = URL.createObjectURL(file); show(localUrl); status.textContent = 'Saving poster privately...';
      const started = await sb.rpc('whatsapp_poster_begin', { p_patient: patientId, p_mime: file.type, p_size: file.size, p_name: file.name });
      if (started.error) throw started.error;
      if (version !== generation) return;
      const upload = await sb.storage.from('wa-posters').upload(started.data.path, file, { contentType: file.type, upsert: false });
      if (upload.error) throw upload.error;
      if (version !== generation) return;
      const done = await sb.rpc('whatsapp_poster_finish', { p_id: started.data.id });
      if (done.error) throw done.error;
      if (version !== generation) return;
      poster = done.data; status.textContent = 'Poster saved privately. Check the preview above.';
    } catch (error) {
      if (version !== generation) return;
      failed = true; status.textContent = error.message || 'The poster could not be saved. Choose it again.';
      image.hidden = true; image.style.display = 'none';
    } finally { if (version === generation) { busy = false; onChange(); } }
  };
  remove.onclick = () => {
    generation += 1; estimateGeneration += 1; release(); poster = null; failed = false; busy = false;
    input.value = ''; image.removeAttribute('src'); image.hidden = true; image.style.display = 'none'; remove.hidden = true; remove.style.display = 'none';
    status.textContent = 'Poster removed from this message.'; counts.textContent = ''; onChange();
  };
  return {
    dispose() { generation += 1; release(); },
    id() { if (busy || failed) throw new Error(busy ? 'Wait for the poster to finish saving.' : 'Choose a valid poster or remove it before saving.'); return poster?.id || null; },
    async estimate(template, when, recipients = []) {
      const version = ++estimateGeneration;
      if (!poster || !when || !template) { counts.textContent = ''; return null; }
      counts.textContent = 'Checking who can receive the poster...';
      const { data, error } = await sb.rpc('whatsapp_poster_preview', { p_patient: patientId, p_template: template.name,
        p_language: template.language || 'en', p_when: when, p_recipients: recipients });
      if (version !== estimateGeneration) return null;
      if (error) { counts.textContent = 'Delivery counts could not be checked. Reload before scheduling.'; return null; }
      counts.textContent = `${data.poster} with poster; ${data.text_only} text only; ${data.held} held; ${data.unknown} window not confirmed. `
        + (data.held ? 'Family sending can be held while WhatsApp messages are switched off. ' : '')
        + (data.image_template ? 'An approved image format carries the poster. ' : 'Without an approved image format, the poster goes separately only inside an open 24-hour window. ')
        + (data.unknown ? 'An unconfirmed window is counted as text only until HopeBot checks it. ' : '')
        + data.note;
      return data;
    },
  };
}
