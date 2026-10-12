// ============================================================
// Patient Navigator: Document collection (Fixboard #32, sql/183)
//
// Families who agreed to share their papers ("Ready to share documents" on
// the record or the call), and who follows up: call, collect, tap what
// happened. A caller sees what is theirs and what they marked; a manager sees
// everyone, assigns, and reads each family's history.
// ============================================================
import { icon } from '../components/icons.js';
import { isManagerOrAdmin } from '../auth.js';
import { mountCollectionList } from '../components/docCollection.js';

let scope = 'all';

export async function renderDocCollection(container) {
  const mgr = isManagerOrAdmin();
  if (!mgr) scope = 'mine';
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Document collection</h1>
        <p class="header-subtitle" style="margin:4px 0 0">${mgr
          ? 'Families who agreed to share their papers, who follows up, and how far each one has got. The aim: papers in within 2 or 3 calls.'
          : 'Families who agreed to share their papers and are yours to follow up. Call, collect the papers, tap what happened.'}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${mgr ? `<div class="chip-row" id="dc-scope">
          <button type="button" class="fchip ${scope === 'all' ? 'on' : ''}" data-scope="all">Everyone</button>
          <button type="button" class="fchip ${scope === 'mine' ? 'on' : ''}" data-scope="mine">Mine</button></div>` : ''}
        <button class="btn btn-secondary btn-sm" id="dc-refresh">${icon('refresh')}Refresh</button>
      </div>
    </div>
    <div class="due-meta wraps" style="margin:-4px 0 12px">To add a family: open their record (or the call) and tap <strong>Ready to share documents (consent given)</strong>.
      When papers arrive, by upload or on WhatsApp, the family moves to Done by itself.</div>
    <div id="dc-list"><div class="card" style="padding:28px;text-align:center;color:var(--ink-3)">Loading…</div></div>`;
  const list = () => mountCollectionList(container.querySelector('#dc-list'), { scope });
  container.querySelector('#dc-refresh')?.addEventListener('click', list);
  container.querySelectorAll('#dc-scope [data-scope]').forEach((b) => b.addEventListener('click', () => {
    scope = b.dataset.scope;
    container.querySelectorAll('#dc-scope [data-scope]').forEach((x) => x.classList.toggle('on', x === b));
    list();
  }));
  await list();
}
