// ============================================================
// Patient Navigator: HopeBot on WhatsApp, from the portal
//
// Asked for on 26 Sep 2026 by Aadrika, for the interns: "if interns can
// trigger to send hope bot message on whatsapp to the patients they call so
// the patients have access to hope bot where they can also directly upload it
// on whatsapp through hope bot chat".
//
// Two halves, both one tap from the call:
//
//   sendHopeBotInvite   asks the hopebot-invite Edge Function what it would
//       send (dry run: the masked number and the language), shows that, and
//       sends only on a second tap. The function decides who may send what
//       (the caller's own access, consent, do-not-contact, three days between
//       invites), so this file only relays its answer.
//
//   readWhatsappDocuments   papers the family sent HopeBot arrive in
//       whatsapp_documents (sql/148), not read. This fetches them from the
//       private bucket and runs them through the same reader and review as
//       any upload. They are marked read and linked to the new batch the
//       moment its pages are stored (docBatch.js onBatch), before the long
//       read, so a closed tab can never offer them twice.
// ============================================================

import { getSupabase } from '../supabase.js';
import { CONFIG } from '../config.js';
import { showModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';

const INVITE_URL = `${CONFIG.SUPABASE_URL}/functions/v1/hopebot-invite`;
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function callInvite(patientId, dryRun) {
  const { data: sess } = await getSupabase().auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) return { ok: false, error: 'Your sign-in has expired. Sign in again.' };
  try {
    const res = await fetch(INVITE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ patientId, dryRun }),
    });
    return await res.json().catch(() => ({ ok: false, error: `The HopeBot service answered ${res.status}.` }));
  } catch (e) {
    return { ok: false, error: 'Could not reach the HopeBot service. Check your internet and try again.' };
  }
}

/** Resolves true once an invite went out, false otherwise. */
export async function sendHopeBotInvite(patientId, patientName = '') {
  const preview = await callInvite(patientId, true);
  if (!preview.ok) {
    showToast(preview.error || 'HopeBot cannot be sent to this family.', 'warning', 9000);
    return false;
  }
  return await new Promise((resolve) => {
    const el = document.createElement('div');
    el.innerHTML = `
      <p style="margin:0 0 12px">${esc(patientName || 'The family')} will get one WhatsApp message from
      <strong>Jarurat Care Foundation (+91 93895 29263)</strong> on <strong class="tnum">${esc(preview.to)}</strong>,
      in ${preview.lang === 'hi' ? 'Hindi' : 'English'}.</p>
      <div class="doc-callout" style="margin-bottom:12px">
        <strong>${icon('message')} What it says</strong>
        <p>It follows up on today's call, tells them they can send photos or PDFs of their hospital papers in
        that chat so the care team can read them, and offers HopeBot for stays, money, food and hospitals.
        Two buttons: <em>Send my papers</em> and <em>Talk to HopeBot</em>.</p>
      </div>
      <p class="form-hint" style="margin:0">Papers they send there appear on this family's record as
      "sent on WhatsApp", ready for you to read. HopeBot asks for their consent before keeping anything.</p>`;
    showModal({
      title: 'Send HopeBot on WhatsApp', content: el, size: 'md',
      footer: `<button class="btn btn-secondary" id="hb-cancel">Cancel</button>
               <button class="btn btn-primary" id="hb-send">${icon('message')}Send it</button>`,
      onClose: () => resolve(false),
    });
    document.getElementById('hb-cancel')?.addEventListener('click', () => { closeModal(); resolve(false); });
    document.getElementById('hb-send')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>Sending…';
      const out = await callInvite(patientId, false);
      closeModal();
      if (out.ok) {
        showToast(`HopeBot sent to ${out.to}. Their papers will show here when they send them.`, 'success', 8000);
        resolve(true);
      } else {
        showToast(out.error || 'HopeBot was not sent.', 'error', 10000);
        resolve(false);
      }
    });
  });
}

/** Read every page the family sent on WhatsApp. Resolves true if an upload started. */
export async function readWhatsappDocuments(patientId) {
  const sb = getSupabase();
  const { data: rows, error } = await sb.from('whatsapp_documents')
    .select('id, storage_path, mime_type, file_name, received_at')
    .eq('patient_id', patientId).eq('status', 'waiting').order('received_at');
  if (error) { showToast('Could not load what they sent: ' + error.message, 'error'); return false; }
  if (!rows?.length) { showToast('Nothing from WhatsApp is waiting for this family.', 'info'); return false; }

  const { data: signed, error: sErr } = await sb.storage.from('patient-docs')
    .createSignedUrls(rows.map((r) => r.storage_path), 600);
  if (sErr) { showToast('Could not open what they sent: ' + sErr.message, 'error'); return false; }
  const files = [];
  for (const [i, r] of rows.entries()) {
    const url = (signed || []).find((s) => s.path === r.storage_path)?.signedUrl;
    if (!url) continue;
    try {
      const blob = await (await fetch(url)).blob();
      const ext = (r.storage_path.split('.').pop() || 'jpg').toLowerCase();
      files.push(new File([blob], r.file_name || `whatsapp-page-${i + 1}.${ext}`, { type: r.mime_type || blob.type }));
    } catch (e) { console.warn('[whatsappDocs] could not fetch', r.storage_path, e.message); }
  }
  if (!files.length) { showToast('Their pages could not be fetched. Try again in a minute.', 'error'); return false; }

  const me = (await sb.auth.getUser()).data?.user?.id || null;
  const { uploadDocumentsFor } = await import('../pages/docBatch.js');
  return await uploadDocumentsFor(patientId, files, {
    consentMethod: 'digital',
    onBatch: async (batchId) => {
      const { error: uErr } = await sb.from('whatsapp_documents')
        .update({ status: 'read', batch_id: batchId, handled_by: me, handled_at: new Date().toISOString() })
        .in('id', rows.map((r) => r.id));
      if (uErr) console.warn('[whatsappDocs] could not mark read:', uErr.message);
    },
  });
}
