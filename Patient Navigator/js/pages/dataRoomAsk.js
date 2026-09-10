// ============================================================
// Data room: the plain-English tab, and the shared-files tab.
//
// Someone types a question, the `data-room` Edge Function writes SQL, the
// database runs it under a role that can read eleven de-identified views and
// do nothing else, and the rows come back as a table you can download.
//
// THE ONE UI DECISION THAT MATTERS
// The generated SQL is always visible, never behind a "show details" nobody
// clicks. Not because people will read it, but because the person they
// forward the number to can. A number whose provenance is invisible gets
// trusted more than it should, and the whole risk of this feature is a
// plausible wrong answer travelling further than it deserves.
//
// The SQL box is also EDITABLE and re-runnable. When the model gets it nearly
// right, fixing one clause beats rephrasing the question five times, and the
// same validator guards the edited version.
// ============================================================

import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { exportToCSV } from '../utils/formatters.js';
import { exportToXLSX } from '../utils/xlsx.js';

const FN = 'data-room';

// Questions that show the shape of what this can do, including the two that
// teach the most: one where the naive column is the wrong one, and one it will
// refuse. People copy the examples, so the examples are the documentation.
const EXAMPLES = [
  'How many new patients did we add each month, with a running total?',
  'Break down the needs our mentors recorded by category, for Maharashtra only',
  'On the calls the AI read, how many needs did the mentor tick list miss?',
  'For each type of support, how many did we record and how many were delivered?',
  'How many patients have more than one malnutrition reading?',
  'Which states do our patients come from, biggest first?',
];

let lastResult = null;   // { rows, columns, sql, title }

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function callFunction(payload) {
  const sb = getSupabase();
  const { data, error } = await sb.functions.invoke(FN, { body: payload });
  if (error) {
    // A non-2xx from the function still carries a useful body.
    let body = null;
    try { body = await error.context?.json?.(); } catch { /* not json */ }
    if (body) return body;
    throw new Error(error.message || 'The Data room assistant could not be reached.');
  }
  return data;
}

// Rows come back as an array of objects with whatever shape the query made.
// Columns are derived from the first row, in key order, which is the order the
// SELECT listed them.
function columnsOf(rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]).map((k) => ({
    label: k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    accessor: (r) => (r[k] === null || r[k] === undefined ? ''
      : typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]),
  }));
}

function renderTable(rows, cap = 50) {
  if (!rows.length) return '<p style="font:var(--t-xs);color:var(--ink-3)">The query ran and matched nothing. That is an answer too: there are no rows for it.</p>';
  const keys = Object.keys(rows[0]);
  const head = keys.map((k) => `<th style="text-align:left;padding:7px 10px;white-space:nowrap;position:sticky;top:0;background:var(--surface-2);font:var(--t-xs);color:var(--ink-2)">${esc(k)}</th>`).join('');
  const body = rows.slice(0, cap).map((r) => `<tr>${keys.map((k) => {
    const val = r[k];
    const num = typeof val === 'number' || (val !== null && val !== '' && !isNaN(Number(val)));
    return `<td class="${num ? 'tnum' : ''}" style="padding:6px 10px;border-top:1px solid var(--line);font:var(--t-xs);${num ? 'text-align:right' : ''}">${esc(val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : val)}</td>`;
  }).join('')}</tr>`).join('');
  return `<div style="overflow:auto;max-height:420px;border:1px solid var(--line);border-radius:var(--r2)">
      <table style="width:100%;border-collapse:collapse"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div>
    ${rows.length > cap ? `<p style="font:var(--t-xs);color:var(--ink-3);margin:8px 0 0">Showing the first ${cap} of ${rows.length.toLocaleString('en-IN')} rows. The download has all of them.</p>` : ''}`;
}

export function renderAskTab(host) {
  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--s4)">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:4px">
        <span style="width:17px;height:17px;display:inline-flex;flex:none;color:var(--ink-3)">${icon('chart')}</span>
        <strong style="font:var(--t-body-strong)">Ask for the data you want, in plain English</strong>
      </div>
      <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 12px">
        Describe the table you need and this writes the query, runs it, and hands it back as Excel or CSV.
        It works on de-identified data only: patients appear as patient codes, never names or phone numbers.
        <strong>If it cannot answer something exactly, it says so instead of guessing.</strong>
      </p>
      <textarea id="dr-q" class="form-input" rows="3" placeholder="e.g. How many financial-aid needs did our team record in West Bengal, month by month?"
        style="width:100%;resize:vertical;font:var(--t-body)"></textarea>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0">
        ${EXAMPLES.map((e) => `<button class="btn btn-ghost btn-sm dr-eg" data-q="${esc(e)}" style="font:var(--t-xs)">${esc(e)}</button>`).join('')}
      </div>
      <div style="display:flex;gap:var(--s3);align-items:center">
        <button class="btn btn-primary" id="dr-ask">${icon('search')}Ask</button>
        <span id="dr-status" style="font:var(--t-xs);color:var(--ink-3)"></span>
      </div>
    </div>
    <div id="dr-answer"></div>`;

  const q = host.querySelector('#dr-q');
  const status = host.querySelector('#dr-status');
  const answer = host.querySelector('#dr-answer');
  const askBtn = host.querySelector('#dr-ask');

  host.querySelectorAll('.dr-eg').forEach((b) => b.addEventListener('click', () => {
    q.value = b.dataset.q; q.focus();
  }));

  async function submit(payload, label) {
    askBtn.disabled = true;
    status.textContent = label;
    answer.innerHTML = '<div class="card" style="display:flex;align-items:center;gap:10px"><div class="spinner"></div><span style="font:var(--t-xs);color:var(--ink-3)">Working out the query, then running it…</span></div>';
    try {
      const res = await callFunction(payload);
      renderAnswer(res);
    } catch (e) {
      answer.innerHTML = `<div class="card" style="border-left:4px solid var(--danger)"><strong style="font:var(--t-body-strong)">Could not reach the Data room assistant</strong>
        <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0">${esc(e.message)}</p></div>`;
    } finally {
      askBtn.disabled = false; status.textContent = '';
    }
  }

  function renderAnswer(res) {
    // ---- a refusal is a first-class answer and gets the same care ----
    if (!res || res.ok === false) {
      answer.innerHTML = `
        <div class="card" style="border-left:4px solid var(--warn);background:var(--warn-soft)">
          <div style="display:flex;align-items:center;gap:9px;margin-bottom:6px">
            <span style="width:17px;height:17px;display:inline-flex;flex:none;color:var(--warn)">${icon('alertTriangle')}</span>
            <strong style="font:var(--t-body-strong)">I did not answer that, on purpose</strong>
          </div>
          <p style="font:var(--t-body);color:var(--ink-1);margin:0">${esc(res?.reason || 'No reason was given.')}</p>
          ${res?.sql ? `<details style="margin-top:10px"><summary style="font:var(--t-xs);color:var(--ink-3);cursor:pointer">The query it tried to write</summary>
            <pre style="font:var(--t-mono-xs);background:var(--surface-2);padding:10px;border-radius:var(--r2);overflow:auto;margin:6px 0 0">${esc(res.sql)}</pre></details>` : ''}
        </div>`;
      return;
    }

    const rows = res.rows || [];
    lastResult = { rows, columns: columnsOf(rows), sql: res.sql || '', title: res.title || 'Data room query' };

    answer.innerHTML = `
      <div class="card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div style="min-width:0">
            <strong style="font:var(--t-h3)">${esc(res.title || 'Result')}</strong>
            <p style="font:var(--t-xs);color:var(--ink-2);margin:4px 0 0;max-width:70ch">${esc(res.explanation || '')}</p>
          </div>
          <div style="display:flex;gap:8px;flex:none">
            <button class="btn btn-primary btn-sm" id="dr-xlsx">${icon('download')}Excel</button>
            <button class="btn btn-ghost btn-sm" id="dr-csv">${icon('download')}CSV</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin:12px 0 8px">
          <span class="tnum badge badge-ok">${(res.row_count ?? rows.length).toLocaleString('en-IN')} rows</span>
          <span style="font:var(--t-xs);color:var(--ink-3)">${res.ms ? `${res.ms} ms` : ''}</span>
          ${res.truncated ? '<span class="badge badge-warn">Cut at the row limit: narrow the question to see the rest</span>' : ''}
        </div>
        ${renderTable(rows)}
      </div>

      <div class="card" style="margin-top:var(--s4)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
          <strong style="font:var(--t-body-strong)">The query it ran</strong>
          <span style="font:var(--t-xs);color:var(--ink-3)">Edit it and re-run if it is nearly right</span>
        </div>
        <textarea id="dr-sql" class="form-input" rows="6" spellcheck="false"
          style="width:100%;font:var(--t-mono-xs);resize:vertical">${esc(res.sql || '')}</textarea>
        <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" id="dr-rerun">Run this query</button></div>
      </div>`;

    answer.querySelector('#dr-xlsx')?.addEventListener('click', () => {
      exportToXLSX(lastResult.rows, 'jcf_data_room', lastResult.columns, lastResult.title);
      showToast(`${lastResult.rows.length.toLocaleString('en-IN')} rows downloaded as Excel`, 'success');
    });
    answer.querySelector('#dr-csv')?.addEventListener('click', () => {
      exportToCSV(lastResult.rows, 'jcf_data_room', lastResult.columns);
    });
    answer.querySelector('#dr-rerun')?.addEventListener('click', () => {
      const sql = answer.querySelector('#dr-sql').value.trim();
      if (sql) submit({ sql }, 'Running your query…');
    });
  }

  askBtn.addEventListener('click', () => {
    const question = q.value.trim();
    if (!question) { showToast('Type a question first', 'info'); return; }
    submit({ question }, 'Thinking…');
  });
  q.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') askBtn.click();
  });

  // What it can be asked about, straight from the database so this list
  // cannot go stale the way a hand-written one would.
  callFunction({ mode: 'catalog' }).then((res) => {
    if (!res?.ok || !res.catalog) return;
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginTop = 'var(--s4)';
    box.innerHTML = `<details><summary style="font:var(--t-body-strong);cursor:pointer">What it can see (${res.catalog.length} datasets)</summary>
      <p style="font:var(--t-xs);color:var(--ink-3);margin:8px 0">If what you need is not in here, it will tell you rather than improvise. That is when to ask an administrator.</p>
      ${res.catalog.map((v) => `<div style="margin-bottom:10px">
        <strong style="font:var(--t-xs)">${esc(v.view.replace('dataroom.', ''))}</strong>
        ${v.purpose ? `<p style="font:var(--t-xs);color:var(--ink-2);margin:2px 0">${esc(v.purpose)}</p>` : ''}
        <p style="font:var(--t-mono-xs);color:var(--ink-3);margin:2px 0">${esc((v.columns || []).join(', '))}</p>
      </div>`).join('')}</details>`;
    host.appendChild(box);
  }).catch(() => { /* the catalog panel is a nicety, not a requirement */ });
}

// ============================================================
// Shared files: put a spreadsheet in the Data room instead of mailing it
// around. The bytes go to the `data-room` storage bucket; this table is the
// catalogue, and `contains_pii` is a required answer rather than a default,
// because the person uploading is the only one who knows.
// ============================================================
export function renderFilesTab(host) {
  const sb = getSupabase();
  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--s4)">
      <strong style="font:var(--t-body-strong)">Add a file to the Data room</strong>
      <p style="font:var(--t-xs);color:var(--ink-2);margin:4px 0 12px">
        A spreadsheet, a report, a resource list. Everyone with Data room access can download it, which is the point,
        so say honestly whether it carries personal data.</p>
      <div style="display:grid;gap:var(--s3);max-width:560px">
        <input class="form-input" id="drf-title" placeholder="What is it? e.g. West Bengal financial resources, Sept 2026" />
        <input class="form-input" id="drf-desc" placeholder="One line on what is inside and who it is for (optional)" />
        <label style="display:flex;align-items:center;gap:8px;font:var(--t-xs);color:var(--ink-2)">
          <input type="checkbox" id="drf-pii" /> This file contains names, phone numbers or anything else identifying
        </label>
        <input type="file" id="drf-file" class="form-input" />
        <div><button class="btn btn-primary" id="drf-up">${icon('upload')}Upload</button></div>
      </div>
    </div>
    <div id="drf-list"><div class="spinner"></div></div>`;

  const list = host.querySelector('#drf-list');

  async function refresh() {
    const { data, error } = await sb.from('data_room_files')
      .select('*').is('archived_at', null).order('created_at', { ascending: false });
    if (error) { list.innerHTML = `<p style="font:var(--t-xs);color:var(--ink-3)">Could not list the files: ${esc(error.message)}</p>`; return; }
    if (!data.length) { list.innerHTML = '<p style="font:var(--t-xs);color:var(--ink-3)">No files yet. The first one goes above.</p>'; return; }
    list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:var(--s4)">
      ${data.map((f) => `<div class="card" style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
          <strong style="font:var(--t-body-strong);min-width:0">${esc(f.title)}</strong>
          <span class="badge ${f.contains_pii ? 'badge-warn' : 'badge-ok'}" style="flex:none">${f.contains_pii ? 'Personal data' : 'De-identified'}</span>
        </div>
        ${f.description ? `<p style="font:var(--t-xs);color:var(--ink-2);margin:0;flex:1">${esc(f.description)}</p>` : '<div style="flex:1"></div>'}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span style="font:var(--t-xs);color:var(--ink-3)">${new Date(f.created_at).toLocaleDateString('en-IN')} · ${f.size_bytes ? (f.size_bytes / 1024 / 1024).toFixed(1) + ' MB' : ''}</span>
          <button class="btn btn-ghost btn-sm" data-path="${esc(f.storage_path)}">${icon('download')}Download</button>
        </div>
      </div>`).join('')}</div>`;

    list.querySelectorAll('[data-path]').forEach((b) => b.addEventListener('click', async () => {
      const { data: signed, error: sErr } = await sb.storage.from('data-room')
        .createSignedUrl(b.dataset.path, 60);
      if (sErr) { showToast('Could not open that file: ' + sErr.message, 'error'); return; }
      window.open(signed.signedUrl, '_blank');
    }));
  }

  host.querySelector('#drf-up').addEventListener('click', async () => {
    const title = host.querySelector('#drf-title').value.trim();
    const file = host.querySelector('#drf-file').files[0];
    if (!title || !file) { showToast('A title and a file, both', 'info'); return; }
    const btn = host.querySelector('#drf-up');
    btn.disabled = true;
    try {
      const { data: u } = await sb.auth.getUser();
      const key = `${Date.now()}_${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      const { error: upErr } = await sb.storage.from('data-room').upload(key, file, { upsert: false });
      if (upErr) throw upErr;
      const { error: insErr } = await sb.from('data_room_files').insert({
        storage_path: key, title,
        description: host.querySelector('#drf-desc').value.trim() || null,
        size_bytes: file.size, mime_type: file.type || null,
        contains_pii: host.querySelector('#drf-pii').checked,
        uploaded_by: u?.user?.id ?? null,
      });
      if (insErr) throw insErr;
      showToast('Uploaded. Everyone with Data room access can see it now', 'success');
      host.querySelector('#drf-title').value = '';
      host.querySelector('#drf-desc').value = '';
      host.querySelector('#drf-file').value = '';
      refresh();
    } catch (e) {
      showToast('Upload failed: ' + e.message, 'error');
    } finally { btn.disabled = false; }
  });

  refresh();
}
