// ============================================================
// Patient Navigator: the document viewer
//
// Asked for on 28 Sep 2026 by the interns, through Aadrika: "an option to view
// the relevant documents directly on the dashboard ... without having to switch
// between different sections/platforms". Until this file, the only screen that
// ever drew a document page was the review step straight after an upload. The
// Documents tab said "Laboratory report, 2 pages" with nothing to click, so the
// way to actually read a report was to go back to the family's WhatsApp thread.
//
// Every page lives in the private patient-docs bucket as
// <patient>/<batch>/p000.jpg with a p000_t.jpg thumbnail beside it (see
// storePages in docBatch.js). Storage RLS is the access check
// (patient_docs_read = can_care_for_patient), and so are the three table
// reads, so this file can only sign pages the viewer may already open.
//
// document_pages.orientation is how far a page must turn CLOCKWISE to read
// upright; the segmenter reports it (prompt_segment_v2.md) and 9 of 173 pages
// on 29 Sep needed turning. The big view draws the page onto a canvas already
// turned, so fit-to-screen and zoom both work on the upright page. A canvas
// drawn from another origin cannot be READ back, but it displays normally,
// which is all this needs.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showModal } from './modal.js';
import { icon } from './icons.js';
import { docClassLabel, uploadStatusLabel } from '../utils/docClasses.js';
import { roleLabel } from '../utils/formatters.js';

const BUCKET = 'patient-docs';
const SIGN_SECONDS = 3600;
const MAX_BATCHES = 40;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const IST = 'Asia/Kolkata';
export function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
export function fmtDayTime(ts) {
  if (!ts) return '';
  return `${fmtDay(ts)}, ${new Date(ts).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' })}`;
}
/** "today", "yesterday", "5 days ago": how long since, in IST calendar days. */
export function daysAgo(ts) {
  if (!ts) return '';
  const day = (t) => new Date(new Date(t).toLocaleString('en-US', { timeZone: IST })).setHours(0, 0, 0, 0);
  const n = Math.round((day(Date.now()) - day(ts)) / 86400000);
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

/** One line for get_call_context().documents, the same words on every screen. */
export function describeDocuments(d) {
  if (!d || !d.uploads) return 'No documents uploaded yet';
  const bits = [`${d.uploads} upload${d.uploads === 1 ? '' : 's'}`, `${d.pages} page${d.pages === 1 ? '' : 's'}`];
  if (d.last_upload_at) bits.push(`last ${fmtDay(d.last_upload_at)} (${daysAgo(d.last_upload_at)})${d.last_upload_by ? ' by ' + d.last_upload_by : ''}`);
  return bits.join(' · ');
}

async function loadPages(sb, patientId) {
  const [bRes, dRes, pRes] = await Promise.all([
    sb.from('document_batches')
      .select('id, uploaded_at, status, page_count, source_files, uploaded_by, uploader:profiles!document_batches_uploaded_by_fkey(full_name, role)')
      .eq('patient_id', patientId).is('deleted_at', null).neq('status', 'discarded')
      .order('uploaded_at', { ascending: false }).limit(MAX_BATCHES),
    sb.from('patient_documents')
      .select('id, batch_id, doc_index, doc_type, document_date, page_count')
      .eq('patient_id', patientId).is('deleted_at', null).limit(500),
    sb.from('document_pages')
      .select('id, batch_id, document_id, page_index, thumb_path, storage_path, orientation, doc_class')
      .eq('patient_id', patientId).is('duplicate_of', null).order('page_index').limit(800),
  ]);
  const err = bRes.error || dRes.error || pRes.error;
  if (err) throw new Error(err.message);
  return { batches: bRes.data || [], documents: dRes.data || [], pages: pRes.data || [] };
}

// Batch, then document, then page: the order a person reads a family's file in.
// Pages the sorter never placed in a document (a read that stopped early) are
// still the family's pages, so they show under their upload as "Other pages".
function arrange({ batches, documents, pages }, onlyBatch) {
  const byPage = (a, b) => a.page_index - b.page_index;
  const groups = [];
  for (const b of batches) {
    if (onlyBatch && b.id !== onlyBatch) continue;
    const docs = documents.filter((d) => d.batch_id === b.id)
      .sort((x, y) => (x.doc_index ?? 0) - (y.doc_index ?? 0));
    const mine = pages.filter((p) => p.batch_id === b.id);
    const sections = docs.map((d) => ({ doc: d, pages: mine.filter((p) => p.document_id === d.id).sort(byPage) }))
      .filter((s) => s.pages.length);
    const placed = new Set(sections.flatMap((s) => s.pages.map((p) => p.id)));
    const loose = mine.filter((p) => !placed.has(p.id)).sort(byPage);
    if (loose.length) sections.push({ doc: null, pages: loose });
    if (sections.length) groups.push({ batch: b, sections });
  }
  const sequence = [];
  for (const g of groups) {
    for (const s of g.sections) {
      s.pages.forEach((p, i) => {
        p.seq = sequence.length;
        sequence.push({
          page: p, batch: g.batch, n: i + 1, of: s.pages.length,
          title: s.doc ? docClassLabel(s.doc.doc_type) : (p.doc_class ? docClassLabel(p.doc_class) : 'Other pages'),
          dated: s.doc?.document_date || null,
        });
      });
    }
  }
  return { groups, sequence };
}

async function signAll(sb, paths) {
  const out = {};
  const list = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(list.slice(i, i + 200), SIGN_SECONDS);
    if (error) throw new Error(error.message);
    for (const r of data || []) if (r.signedUrl) out[r.path] = r.signedUrl;
  }
  return out;
}

const uploaderLine = (b) => {
  const u = b.uploader;
  if (!u?.full_name) return b.uploaded_by ? 'by a team member' : 'sent in on WhatsApp';
  return `by ${esc(u.full_name)}${u.role ? ' · ' + esc(roleLabel(u.role)) : ''}`;
};
const statusTone = (s) => (s === 'reviewed' ? 'ok' : s === 'ready_for_review' ? 'warn' : s === 'failed' ? 'danger' : 'neutral');

function listHTML(groups, thumbs, totalPages, filtered) {
  return `
    <div class="dv-summary">
      <span>${groups.length} upload${groups.length === 1 ? '' : 's'} · ${totalPages} page${totalPages === 1 ? '' : 's'}. Tap a page to read it.</span>
      ${filtered ? `<button type="button" class="btn btn-ghost btn-sm" data-dv-all>${icon('fileText')}Show every upload for this family</button>` : ''}
    </div>
    ${groups.map((g) => `
      <section class="dv-batch">
        <header class="dv-batch-head">
          <div style="min-width:0">
            <div class="dv-batch-title">Uploaded ${esc(fmtDayTime(g.batch.uploaded_at))}</div>
            <div class="due-meta">${uploaderLine(g.batch)} · ${esc(daysAgo(g.batch.uploaded_at))}</div>
          </div>
          <span class="badge badge-${statusTone(g.batch.status)}">${esc(uploadStatusLabel(g.batch.status))}</span>
        </header>
        ${g.sections.map((s) => `
          <div class="dv-doc">
            <div class="dv-doc-title">${esc(s.doc ? docClassLabel(s.doc.doc_type) : 'Other pages')}
              <span class="due-meta">${s.doc?.document_date ? 'dated ' + esc(fmtDay(s.doc.document_date)) + ' · ' : ''}${s.pages.length} page${s.pages.length === 1 ? '' : 's'}</span></div>
            <div class="dv-thumbs">
              ${s.pages.map((p, i) => {
                const deg = ((Number(p.orientation) || 0) % 360 + 360) % 360;
                const url = thumbs[p.thumb_path] || thumbs[p.storage_path];
                return `<button type="button" class="dv-thumb" data-seq="${p.seq}" aria-label="${esc(s.doc ? docClassLabel(s.doc.doc_type) : 'Page')}, page ${i + 1}">
                  ${url ? `<img loading="lazy" alt="" src="${esc(url)}" class="${deg % 180 ? 'dv-side' : ''}" style="${deg ? `transform:rotate(${deg}deg)` : ''}">`
                        : `<span class="dv-thumb-missing">${icon('fileText')}</span>`}
                  <span class="dv-thumb-n">${i + 1}</span>
                </button>`;
              }).join('')}
            </div>
          </div>`).join('')}
      </section>`).join('')}`;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The page image did not load. The link may have expired: close and open the documents again.'));
    img.src = url;
  });
}

// Fit the drawn page inside the stage (contain), or show it at full size when
// zoomed. Sized in pixels on purpose: a percentage max-height on a grid item
// resolves against a content-sized row, so CSS alone let a tall page overflow
// the stage at laptop width while passing on a phone, where width is the
// tighter limit (caught by tools/call_context_live_check.mjs --desktop).
// The stage takes the height left under the bar, above Previous / Next, so
// both stay on screen whatever the title wraps to. CSS sets a sane default;
// this corrects it once the real header height is known.
function sizeStage(root, stage) {
  if (!root || !stage) return;
  const nav = root.querySelector('.dv-nav');
  const navH = nav ? nav.getBoundingClientRect().height : 44;
  const room = window.innerHeight - stage.getBoundingClientRect().top - navH - 34;
  stage.style.height = `${Math.round(Math.max(220, Math.min(room, 760)))}px`;
}

function fitCanvas(canvas, stage, zoomed) {
  if (!canvas || !stage) return;
  if (zoomed) {
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    return;
  }
  const w = Math.max(stage.clientWidth - 2, 50);
  const h = Math.max(stage.clientHeight - 2, 50);
  const s = Math.min(w / canvas.width, h / canvas.height, 1);
  canvas.style.width = `${Math.floor(canvas.width * s)}px`;
  canvas.style.height = `${Math.floor(canvas.height * s)}px`;
}

function drawTurned(canvas, img, deg) {
  const side = deg % 180 !== 0;
  canvas.width = side ? img.naturalHeight : img.naturalWidth;
  canvas.height = side ? img.naturalWidth : img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.restore();
}

/**
 * Open every page uploaded for one family.
 *   patientId    required
 *   patientName  for the title
 *   batchId      show one upload only, with a way back to all of them
 *   onUpload     if given, the empty state offers an Upload button that calls it
 */
export async function openDocumentViewer({ patientId, patientName = '', batchId = null, onUpload = null } = {}) {
  if (!patientId) return;
  const sb = getSupabase();
  const root = document.createElement('div');
  root.className = 'dv';
  root.innerHTML = `<div class="dv-loading"><span class="spinner"></span> Opening the documents…</div>`;
  showModal({ title: `Documents${patientName ? ' · ' + esc(patientName) : ''}`, content: root, size: 'xl' });

  let data;
  try { data = await loadPages(sb, patientId); }
  catch (e) {
    root.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div>
      <h4>We could not load the documents</h4><p>${esc(e.message)}</p>
      <p class="form-hint">This is not the same as there being none. Do not upload them again until someone has looked at this.</p></div>`;
    return;
  }

  let only = batchId;
  let arranged = arrange(data, only);
  if (only && !arranged.groups.length) { only = null; arranged = arrange(data, null); }
  if (!arranged.groups.length) {
    root.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('fileText')}</div>
      <h4>No documents uploaded yet</h4>
      <p>Nothing has been uploaded for this family, or every upload was discarded.</p>
      ${onUpload ? `<button type="button" class="btn btn-primary" data-dv-upload>${icon('upload')}Upload documents</button>` : ''}</div>`;
    root.querySelector('[data-dv-upload]')?.addEventListener('click', () => onUpload());
    return;
  }

  let thumbs = {};
  try { thumbs = await signAll(sb, data.pages.map((p) => p.thumb_path || p.storage_path)); }
  catch (e) { console.warn('[docViewer] thumbnails not signed:', e.message); }

  const full = {};           // storage_path -> signed URL, signed on first open
  const turn = {};           // page id -> degrees the viewer has turned it to
  let at = -1;
  let zoom = false;

  const showList = () => {
    at = -1;
    const pages = arranged.sequence.length;
    root.innerHTML = listHTML(arranged.groups, thumbs, pages, !!only);
    root.querySelectorAll('[data-seq]').forEach((b) => b.addEventListener('click', () => showPage(Number(b.dataset.seq))));
    root.querySelector('[data-dv-all]')?.addEventListener('click', () => {
      only = null; arranged = arrange(data, null); showList();
    });
  };

  const showPage = async (i) => {
    const item = arranged.sequence[i];
    if (!item) return;
    at = i; zoom = false;
    const p = item.page;
    const deg = turn[p.id] ?? (((Number(p.orientation) || 0) % 360) + 360) % 360;
    root.innerHTML = `
      <div class="dv-bar">
        <button type="button" class="btn btn-ghost btn-sm" data-dv-back>${icon('arrowLeft')}All pages</button>
        <div class="dv-bar-title">
          <strong>${esc(item.title)}</strong>
          <span class="due-meta">page ${item.n} of ${item.of}${item.dated ? ' · dated ' + esc(fmtDay(item.dated)) : ''} · uploaded ${esc(fmtDay(item.batch.uploaded_at))} ${uploaderLine(item.batch)}</span>
        </div>
        <div class="dv-bar-tools">
          <button type="button" class="btn btn-ghost btn-sm btn-icon" data-dv-turn="-90" title="Turn left" aria-label="Turn left">${icon('rotateCcw')}</button>
          <button type="button" class="btn btn-ghost btn-sm btn-icon" data-dv-turn="90" title="Turn right" aria-label="Turn right">${icon('rotateCw')}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-dv-zoom>${icon('search')}Zoom</button>
        </div>
      </div>
      <div class="dv-stage" data-dv-stage><span class="dv-loading"><span class="spinner"></span> Loading the page…</span></div>
      <div class="dv-nav">
        <button type="button" class="btn btn-secondary btn-sm" data-dv-prev ${i === 0 ? 'disabled' : ''}>${icon('chevronLeft')}Previous</button>
        <span class="due-meta">${i + 1} of ${arranged.sequence.length}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-dv-next ${i === arranged.sequence.length - 1 ? 'disabled' : ''}>Next${icon('chevronRight')}</button>
      </div>`;
    // A long list leaves the sheet scrolled down; the page view starts at the top.
    const sheet = root.closest('.modal');
    if (sheet) sheet.scrollTop = 0;
    root.querySelector('[data-dv-back]').addEventListener('click', showList);
    root.querySelector('[data-dv-prev]').addEventListener('click', () => showPage(i - 1));
    root.querySelector('[data-dv-next]').addEventListener('click', () => showPage(i + 1));
    const stage = root.querySelector('[data-dv-stage]');
    sizeStage(root, stage);
    root.querySelector('[data-dv-zoom]').addEventListener('click', (e) => {
      zoom = !zoom;
      stage.classList.toggle('dv-zoomed', zoom);
      e.currentTarget.classList.toggle('active', zoom);
      fitCanvas(stage.querySelector('canvas'), stage, zoom);
    });

    try {
      if (!full[p.storage_path]) {
        const { data: s, error } = await sb.storage.from(BUCKET).createSignedUrl(p.storage_path, SIGN_SECONDS);
        if (error || !s?.signedUrl) throw new Error(error?.message || 'This page could not be opened.');
        full[p.storage_path] = s.signedUrl;
      }
      const img = await loadImage(full[p.storage_path]);
      if (at !== i) return;              // the viewer moved on while this loaded
      const canvas = document.createElement('canvas');
      canvas.className = 'dv-page';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${item.title}, page ${item.n}`);
      drawTurned(canvas, img, deg);
      stage.innerHTML = '';
      stage.appendChild(canvas);
      fitCanvas(canvas, stage, zoom);
      root.querySelectorAll('[data-dv-turn]').forEach((b) => b.addEventListener('click', () => {
        const next = ((turn[p.id] ?? deg) + Number(b.dataset.dvTurn) + 360) % 360;
        turn[p.id] = next;
        drawTurned(canvas, img, next);
        fitCanvas(canvas, stage, zoom);
      }));
    } catch (e) {
      if (at !== i) return;
      stage.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><p>${esc(e.message)}</p></div>`;
    }
  };

  // Arrow keys page through while a page is open, and a resized window (a
  // phone turned sideways) refits the page. Both go when the modal does.
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (at < 0) return;
    if (e.key === 'ArrowLeft' && at > 0) showPage(at - 1);
    if (e.key === 'ArrowRight' && at < arranged.sequence.length - 1) showPage(at + 1);
  };
  const onResize = () => {
    if (!root.isConnected) { window.removeEventListener('resize', onResize); return; }
    const stage = root.querySelector('[data-dv-stage]');
    sizeStage(root, stage);
    fitCanvas(stage?.querySelector('canvas'), stage, zoom);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  showList();
}
