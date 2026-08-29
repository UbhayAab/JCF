// ============================================================
// Patient Navigator: Team Leaderboard (managers + admins)
// A live, dynamically-refreshing scoreboard of caregiver-mentor
// performance: MVP ranking, a podium, award badges per metric, team
// KPIs, and a sortable table. Data from get_leaderboard(days) (sql/42).
// ============================================================

import { getSupabase } from '../supabase.js';
import { icon } from '../components/icons.js';
import { navigate } from '../router.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { showModal, closeModal } from '../components/modal.js';
import { withMvp } from '../utils/performance.js';
import { AVATAR_COLORS, avatarColor, initials } from '../utils/avatar.js';

const num = (v, d = 0) => (v == null ? 0 : Number(v)).toFixed(d);

// ---- module state (survives re-render, reset on mount) ----
let DAYS = 30;
let SORT = { key: 'mvp', dir: -1 };
let refreshTimer = null;
let lastRows = [];
let lastLoaded = null;

// Award definitions: each finds its leader among qualifying mentors.
const AWARDS = [
  { key: 'calls',        emoji: '🔥', label: 'Volume Leader',    tip: 'Most calls made',            min: 1 },
  { key: 'connect_rate', emoji: '🎯', label: 'Best Connector',   tip: 'Highest connect rate',        min: 10 },
  { key: 'depth_score',  emoji: '🧠', label: 'Deepest Prober',   tip: 'Richest notes & capture',     min: 10 },
  { key: 'assessments',  emoji: '📊', label: 'Top Recorder',     tip: 'Most well-being scores logged', min: 1 },
  { key: 'services',     emoji: '🤝', label: 'Support Champion', tip: 'Most support actions delivered', min: 1 },
  { key: 'wa_joins',     emoji: '💬', label: 'WhatsApp Star',    tip: 'Most WhatsApp joins driven',  min: 1 },
  { key: 'calls_per_day',emoji: '⚡', label: 'Most Consistent',  tip: 'Most calls per active day',   min: 10 },
];

const COLS = [
  { key: 'mvp',           label: 'MVP',      w: 62 },
  { key: 'calls',         label: 'Calls',    w: 56 },
  { key: 'connect_rate',  label: 'Conn %',   w: 62 },
  { key: 'calls_per_day', label: '/day',     w: 52 },
  // Minutes on a connected call. get_leaderboard already computed this and
  // nothing ever showed it, so "who actually sits with a family" was invisible.
  { key: 'avg_duration',  label: 'Avg min',  w: 64 },
  { key: 'depth_score',   label: 'Depth',    w: 78 },
  { key: 'notes_rate',    label: 'Notes %',  w: 64 },
  { key: 'reqs_rate',     label: 'Asks %',   w: 60 },
  { key: 'assessments',   label: 'Scores',   w: 58 },
  { key: 'services',      label: 'Support',  w: 62 },
  { key: 'wa_joins',      label: 'WA',       w: 44 },
];

export async function renderLeaderboard(container) {
  DAYS = 30; SORT = { key: 'mvp', dir: -1 };
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Team Leaderboard</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Live caregiver-mentor performance: quality, not just volume. <span id="lb-updated" class="faint" style="color:var(--ink-3)"></span></p>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="seg" id="lb-window" style="display:inline-flex;border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden">
          ${[[7,'7d'],[30,'30d'],[90,'90d']].map(([d,l]) => `<button class="btn btn-ghost btn-sm lb-win ${d===30?'on':''}" data-days="${d}" style="border-radius:0;border:0">${l}</button>`).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" id="lb-refresh" title="Refresh now">${icon('refresh')}</button>
      </div>
    </div>
    <div id="lb-root">${Array(3).fill('<div class="skeleton skeleton-row" style="height:120px;margin-bottom:12px"></div>').join('')}</div>`;

  container.querySelectorAll('.lb-win').forEach(b => b.addEventListener('click', () => {
    DAYS = Number(b.dataset.days);
    container.querySelectorAll('.lb-win').forEach(x => x.classList.toggle('on', x === b));
    load(container);
  }));
  container.querySelector('#lb-refresh')?.addEventListener('click', () => load(container));

  await load(container);

  // Live refresh every 60s; self-cancels once the page is gone.
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.getElementById('lb-root')) { clearInterval(refreshTimer); refreshTimer = null; return; }
    load(container, true);
  }, 60000);
}

async function load(container, silent = false) {
  const root = container.querySelector('#lb-root');
  if (!root) return;
  try {
    const { data, error } = await getSupabase().rpc('get_leaderboard', { p_days: DAYS });
    if (error) throw error;
    lastRows = decorate(data || []);
    lastLoaded = new Date();
    paint(container);
  } catch (e) {
    if (!silent) root.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('alertCircle')}</div><h4>Couldn't load the leaderboard</h4><p>${e.message}</p></div>`;
  }
}

// Compute MVP score + rank + awards across the cohort.
function decorate(rows) {
  // The MVP blend now lives in utils/performance.js, because Team & Queue
  // sorts its roster by the same number and the two must not drift.
  rows = withMvp(rows).map(r => ({ ...r, awards: [] }));
  // Award each badge to its qualifying leader.
  AWARDS.forEach(a => {
    const pool = rows.filter(r => r.calls >= a.min || a.key === 'calls');
    const eligible = a.key === 'connect_rate' || a.key === 'calls_per_day' || a.key === 'depth_score'
      ? rows.filter(r => r.calls >= a.min) : rows.filter(r => (r[a.key] || 0) > 0);
    if (!eligible.length) return;
    const best = eligible.reduce((p, c) => (c[a.key] || 0) > (p[a.key] || 0) ? c : p);
    if ((best[a.key] || 0) > 0) best.awards.push(a);
  });
  rows.sort((a, b) => b.mvp - a.mvp);
  rows.forEach((r, i) => r.rank = i + 1);
  return rows;
}

function paint(container) {
  const root = container.querySelector('#lb-root');
  if (!root) return;
  const rows = lastRows;
  const upd = container.querySelector('#lb-updated');
  if (upd && lastLoaded) upd.innerHTML = `· <span class="lb-live-dot"></span>updated ${formatRelativeTime(lastLoaded.toISOString())}`;

  if (!rows.length) { root.innerHTML = `<div class="empty"><div class="ico-wrap">${icon('users')}</div><h4>No caregiver mentors yet</h4></div>`; return; }

  const active = rows.filter(r => r.calls > 0);
  const team = {
    mentors: active.length,
    calls: rows.reduce((s, r) => s + r.calls, 0),
    connected: rows.reduce((s, r) => s + r.connected, 0),
    assess: rows.reduce((s, r) => s + r.assessments, 0),
    services: rows.reduce((s, r) => s + r.services, 0),
    depth: active.length ? Math.round(active.reduce((s, r) => s + r.depth_score, 0) / active.length) : 0,
  };
  const connRate = team.calls ? Math.round(team.connected / team.calls * 100) : 0;

  root.innerHTML = `
    ${kpiStrip(team, connRate)}
    ${podium(rows.slice(0, 3))}
    ${awardsRow(rows)}
    ${table(rows)}
    <p class="faint" style="font-size:12px;color:var(--ink-3);margin:14px 2px 0">MVP blends reach (calls), connect rate, probing depth (notes + capture) and impact (scores + support). Depth = 35% notes written · 25% note length · 20% asks captured · 20% condition captured. Window: last ${DAYS} days · refreshes live.</p>`;

  wireTable(container);
}

function kpiStrip(t, connRate) {
  const cell = (v, l, tone) => `<div style="flex:1;min-width:110px;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2)">
      <div style="font:var(--t-h2);font-weight:750;color:var(--${tone||'ink-1'})">${v}</div>
      <div class="faint" style="font-size:12px;color:var(--ink-3)">${l}</div></div>`;
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
    ${cell(t.mentors, 'Active mentors')}
    ${cell(t.calls.toLocaleString(), 'Calls')}
    ${cell(connRate + '%', 'Connect rate', connRate>=60?'ok':'clay')}
    ${cell(t.depth, 'Avg depth', t.depth>=67?'ok':'clay')}
    ${cell(t.assess.toLocaleString(), 'Scores logged')}
    ${cell(t.services.toLocaleString(), 'Support actions')}
  </div>`;
}

function podium(top) {
  if (top.length < 3) return '';
  const order = [top[1], top[0], top[2]];     // silver, gold, bronze
  const meta = [
    { medal: '🥈', h: 96,  ring: '#B8C2CC' },
    { medal: '🥇', h: 124, ring: '#E8C24A' },
    { medal: '🥉', h: 78,  ring: '#CD8B4E' },
  ];
  return `<div style="display:flex;align-items:flex-end;justify-content:center;gap:14px;margin:6px 0 20px;padding:18px 8px 8px;background:linear-gradient(180deg,var(--surface-2),transparent);border-radius:var(--r-lg)">
    ${order.map((r, i) => {
      const m = meta[i];
      return `<div data-open="${r.caller_id}" style="cursor:pointer;flex:1;max-width:170px;text-align:center">
        <div style="font-size:22px;line-height:1">${m.medal}</div>
        <span class="avatar avatar-lg" style="background:${avatarColor(r.full_name)};box-shadow:0 0 0 3px ${m.ring};margin:6px auto 8px">${initials(r.full_name)}</span>
        <div style="font:var(--t-body-strong);font-weight:650;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.full_name}</div>
        <div style="font:var(--t-h2);font-weight:800;color:var(--primary);line-height:1.1">${r.mvp}</div>
        <div class="faint" style="font-size:11px;color:var(--ink-3);margin-bottom:8px">MVP</div>
        <div style="height:${m.h}px;border-radius:10px 10px 0 0;background:linear-gradient(180deg,var(--primary-bright),var(--primary));display:flex;align-items:flex-start;justify-content:center;padding-top:8px;color:#fff;font-weight:800;font-size:20px">${r.rank}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function awardsRow(rows) {
  const chips = [];
  rows.forEach(r => r.awards.forEach(a => chips.push({ a, r })));
  if (!chips.length) return '';
  const orderKey = k => AWARDS.findIndex(a => a.key === k);
  chips.sort((x, y) => orderKey(x.a.key) - orderKey(y.a.key));
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
    ${chips.map(({ a, r }) => `
      <div data-open="${r.caller_id}" title="${a.tip}" style="cursor:pointer;display:flex;align-items:center;gap:9px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:var(--surface-2)">
        <span style="font-size:16px">${a.emoji}</span>
        <div style="line-height:1.15">
          <div style="font-size:11px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em">${a.label}</div>
          <div style="font-size:13px;font-weight:650">${r.full_name.split(' ')[0]} <span class="faint" style="color:var(--ink-3);font-weight:400">· ${awardValue(a.key, r)}</span></div>
        </div>
      </div>`).join('')}
  </div>`;
}
function awardValue(k, r) {
  if (k === 'connect_rate') return num(r.connect_rate) + '%';
  if (k === 'calls_per_day') return num(r.calls_per_day, 1) + '/day';
  if (k === 'depth_score') return 'depth ' + num(r.depth_score);
  return num(r[k]);
}

function table(rows) {
  const sorted = [...rows].sort((a, b) => {
    const av = a[SORT.key] ?? -1, bv = b[SORT.key] ?? -1;
    return (av < bv ? -1 : av > bv ? 1 : 0) * SORT.dir || a.rank - b.rank;
  });
  const head = `<th style="text-align:left;padding:9px 10px;position:sticky;left:0;background:var(--surface)">#</th>
    <th style="text-align:left;padding:9px 10px;position:sticky;left:0;background:var(--surface)">Mentor</th>
    ${COLS.map(c => `<th class="lb-th" data-sort="${c.key}" style="padding:9px 8px;text-align:center;cursor:pointer;white-space:nowrap;min-width:${c.w}px">${c.label}${SORT.key===c.key?`<span style="color:var(--primary)"> ${SORT.dir<0?'▼':'▲'}</span>`:''}</th>`).join('')}
    <th style="padding:9px 10px;text-align:right;white-space:nowrap">Last active</th>`;
  return `<div class="card" style="padding:0;overflow-x:auto">
    <table class="lb-table" style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="border-bottom:1px solid var(--line);color:var(--ink-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em">${head}</thead>
      <tbody>${sorted.map(rowHTML).join('')}</tbody>
    </table></div>`;
}

function rowHTML(r) {
  const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `<span class="faint" style="color:var(--ink-3)">${r.rank}</span>`;
  const zero = r.calls === 0;
  const depthTone = r.depth_score >= 75 ? 'ok' : r.depth_score >= 55 ? 'primary' : 'clay';
  const connTone = r.connect_rate >= 60 ? 'ok' : r.connect_rate >= 45 ? 'clay' : 'danger';
  const cellNum = (v, tone) => `<td style="padding:8px;text-align:center;${tone?`color:var(--${tone});font-weight:650`:''}">${v}</td>`;
  return `<tr data-open="${r.caller_id}" style="border-bottom:1px solid var(--line-2);cursor:pointer;${zero?'opacity:.5':''}">
    <td style="padding:8px 10px;font-size:15px;position:sticky;left:0;background:var(--surface)">${medal}</td>
    <td style="padding:8px 10px;position:sticky;left:0;background:var(--surface)">
      <div style="display:flex;align-items:center;gap:9px;min-width:150px">
        <span class="avatar" style="background:${avatarColor(r.full_name)};width:30px;height:30px;font-size:12px">${initials(r.full_name)}</span>
        <div style="min-width:0"><div style="font-weight:600;white-space:nowrap">${r.full_name}</div>
          <div style="display:flex;gap:3px">${r.awards.slice(0,3).map(a => `<span title="${a.label}">${a.emoji}</span>`).join('')}</div></div>
      </div>
    </td>
    <td style="padding:8px;text-align:center"><span style="display:inline-block;min-width:34px;padding:3px 8px;border-radius:8px;background:var(--primary);color:var(--on-primary);font-weight:750">${r.mvp}</span></td>
    ${cellNum(r.calls)}
    ${cellNum(num(r.connect_rate) + '%', connTone)}
    ${cellNum(num(r.calls_per_day, 1))}
    ${cellNum(r.avg_duration == null ? '<span style="color:var(--ink-3)">N/A</span>' : num(r.avg_duration, 1))}
    <td style="padding:8px 10px;min-width:80px">
      <div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1;height:6px;border-radius:999px;background:var(--surface-3);overflow:hidden"><div style="height:100%;width:${Math.min(r.depth_score,100)}%;background:var(--${depthTone})"></div></div>
        <span style="font-size:12px;font-weight:650;color:var(--${depthTone})">${num(r.depth_score)}</span>
      </div>
    </td>
    ${cellNum(num(r.notes_rate) + '%')}
    ${cellNum(num(r.reqs_rate) + '%')}
    ${cellNum(r.assessments)}
    ${cellNum(r.services)}
    ${cellNum(r.wa_joins)}
    <td style="padding:8px 10px;text-align:right;white-space:nowrap;color:var(--ink-3);font-size:12px">${r.last_call ? formatRelativeTime(r.last_call) : 'N/A'}</td>
  </tr>`;
}

function wireTable(container) {
  container.querySelectorAll('.lb-th').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (SORT.key === k) SORT.dir *= -1; else SORT = { key: k, dir: -1 };
    paint(container);
  }));
  container.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => openMentorModal(el.dataset.open)));
}

// ---- Drill-down: one mentor's full scorecard, ranks, and read ----
const METRICS = [
  { key: 'calls',         label: 'Calls',            fmt: v => Math.round(v) },
  { key: 'connect_rate',  label: 'Connect rate',     fmt: v => num(v) + '%' },
  { key: 'calls_per_day', label: 'Calls / day',      fmt: v => num(v, 1) },
  { key: 'avg_duration',  label: 'Avg min / call',   fmt: v => num(v, 1) },
  { key: 'depth_score',   label: 'Depth score',      fmt: v => num(v) },
  { key: 'notes_rate',    label: 'Notes written',    fmt: v => num(v) + '%' },
  { key: 'reqs_rate',     label: 'Asks captured',    fmt: v => num(v) + '%' },
  { key: 'cond_rate',     label: 'Condition noted',  fmt: v => num(v) + '%' },
  { key: 'assessments',   label: 'Well-being scores',fmt: v => Math.round(v) },
  { key: 'services',      label: 'Support actions',  fmt: v => Math.round(v) },
  { key: 'wa_joins',      label: 'WhatsApp joins',   fmt: v => Math.round(v) },
];

function openMentorModal(id) {
  const rows = lastRows;
  const r = rows.find(x => x.caller_id === id);
  if (!r) return;
  const N = rows.length;
  const active = rows.filter(x => x.calls > 0);
  const avg = k => active.length ? active.reduce((s, x) => s + (+x[k] || 0), 0) / active.length : 0;
  const rankOf = k => [...rows].sort((a, b) => (+b[k] || 0) - (+a[k] || 0)).findIndex(x => x.caller_id === id) + 1;

  // strongest / weakest metric by % distance from the team average
  let best = null, worst = null;
  METRICS.forEach(m => {
    const a = avg(m.key); if (!a) return;
    const d = ((+r[m.key] || 0) - a) / a;
    if (!best || d > best.d) best = { m, d };
    if (!worst || d < worst.d) worst = { m, d };
  });

  const cards = METRICS.map(m => {
    const v = +r[m.key] || 0, a = avg(m.key), rk = rankOf(m.key);
    const above = v >= a;
    const pct = a ? Math.round((v - a) / a * 100) : 0;
    return `<div style="border:1px solid var(--line);border-radius:var(--r-md);padding:10px 12px;background:var(--surface-2)">
      <div class="faint" style="font-size:11.5px;color:var(--ink-3)">${m.label}</div>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin:2px 0">
        <span style="font-size:19px;font-weight:750">${m.fmt(v)}</span>
        <span style="font-size:11px;font-weight:800;padding:1px 7px;border-radius:999px;background:var(--${rk <= 3 ? 'ok-soft' : 'surface-3'});color:var(--${rk <= 3 ? 'ok' : 'ink-3'})">#${rk}/${N}</span>
      </div>
      <div style="font-size:11px;color:var(--${above ? 'ok' : 'clay'})">${above ? '▲' : '▼'} ${Math.abs(pct)}% vs team avg ${m.fmt(a)}</div>
    </div>`;
  }).join('');

  const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '';
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
      <span class="avatar avatar-lg" style="background:${avatarColor(r.full_name)}">${initials(r.full_name)}</span>
      <div style="flex:1;min-width:0">
        <div style="font:var(--t-h2);font-weight:750">${r.full_name}</div>
        <div class="faint" style="color:var(--ink-3);font-size:13px">Caregiver mentor · last active ${r.last_call ? formatRelativeTime(r.last_call) : 'N/A'}</div>
      </div>
      <div style="text-align:center;flex:none">
        <div style="font-size:22px;line-height:1">${medal}</div>
        <div style="font-size:30px;font-weight:800;color:var(--primary);line-height:1.1">${r.mvp}</div>
        <div class="faint" style="font-size:11px;color:var(--ink-3)">MVP · rank #${r.rank} of ${N}</div>
      </div>
    </div>
    ${r.awards.length ? `<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">${r.awards.map(a => `<span class="badge badge-gold" style="font-size:11.5px">${a.emoji} ${a.label}</span>`).join('')}</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px;margin-bottom:14px">${cards}</div>
    <div style="padding:12px 14px;border-radius:var(--r-md);background:var(--surface-3)">
      <div style="font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:6px">${icon('activity')}The read</div>
      <p style="margin:0;font-size:13.5px;color:var(--ink-2)">
        ${best ? `Strongest at <strong>${best.m.label.toLowerCase()}</strong> (${best.d >= 0 ? '+' : ''}${Math.round(best.d * 100)}% vs team).` : ''}
        ${worst && worst.d < -0.05 ? ` Biggest gap: <strong>${worst.m.label.toLowerCase()}</strong> (${Math.round(worst.d * 100)}% vs team), worth a nudge.` : ' Solidly around the team average elsewhere.'}
      </p>
    </div>`;
  showModal({
    title: 'Mentor scorecard', content: el, size: 'lg',
    footer: `<button class="btn btn-secondary" id="lb-close">Close</button>
             <button class="btn btn-primary" id="lb-caseload">${icon('users')}View caseload</button>`,
  });
  document.getElementById('lb-close')?.addEventListener('click', () => closeModal());
  document.getElementById('lb-caseload')?.addEventListener('click', () => { closeModal(); navigate('team'); });
}
