// Analytics > HopeBot analytics > Saturday weekly message (Fixboard 292).
// Aggregate counts only, from public.hopebot_weekly_checkin_analytics(date,date) (sql/258).
// No names, numbers or per-person rows ever reach this view.
import { createReportView234 } from './reportHistory234.js';
import { sanitize } from '../utils/validators.js';

const count = (x) => Number.isSafeInteger(x) && x >= 0;
const instant = (x) => typeof x === 'string' && x.length <= 64 && Number.isFinite(Date.parse(x));
const day = (x) => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x) && instant(x) && new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x;
const exact = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const num = (x) => Number(x).toLocaleString('en-IN');
const rate = (n, d) => (d ? Math.round((n / d) * 100) : null);
const pct = (n, d) => (d ? rate(n, d) + '%' : '-');
const ofText = (n, d) => (d ? `${num(n)} of ${num(d)} (${pct(n, d)})` : '-');
const stamp = (x) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(x)) + ' IST';
const LONG = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', dateStyle: 'medium' });
const SHORT = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });
// A Saturday (YYYY-MM-DD, already an IST date) as text.
const saturday = (x, style = 'medium') => (style === 'short' ? SHORT : LONG).format(new Date(x + 'T00:00:00Z'));
const dateIST = (x) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }).format(new Date(x));

const TOP = ['version', 'actor_id', 'from', 'to', 'timezone', 'from_at', 'until_at', 'as_of', 'audience', 'weeks'];
const AUDIENCE = ['signed_up', 'weekly_on', 'ever_messaged', 'messaged_two_plus_weeks', 'first_sent_at'];
const WEEK = ['week_of', 'first_sent_at', 'complete', 'days_measured', 'families', 'messages', 'delivered', 'read', 'failed',
  'no_file_before', 'replied', 'sent_file', 'files', 'activated', 'others'];
const OTHERS = ['families', 'replied', 'sent_file', 'files'];

export function validateWeekly(d, actor, from, to) {
  if (!exact(d, TOP) || d.version !== 1 || d.actor_id !== actor || d.from !== from || d.to !== to || d.timezone !== 'Asia/Kolkata'
    || !day(from) || !day(to) || !instant(d.as_of)
    || Date.parse(d.from_at) !== Date.parse(from + 'T00:00:00+05:30') || Date.parse(d.until_at) !== Date.parse(to + 'T00:00:00+05:30') + 86400000) throw Error('contract');
  const a = d.audience;
  if (!exact(a, AUDIENCE) || !AUDIENCE.slice(0, 4).every((k) => count(a[k])) || (a.first_sent_at !== null && !instant(a.first_sent_at))
    || a.weekly_on > a.signed_up || a.messaged_two_plus_weeks > a.ever_messaged) throw Error('audience');
  if (!Array.isArray(d.weeks) || d.weeks.length > 60) throw Error('weeks');
  d.weeks.forEach((w, i) => {
    if (!exact(w, WEEK) || !day(w.week_of) || new Date(w.week_of + 'T00:00:00Z').getUTCDay() !== 6 || w.week_of > to
      || (i && w.week_of <= d.weeks[i - 1].week_of) || !instant(w.first_sent_at) || typeof w.complete !== 'boolean'
      || !Number.isInteger(w.days_measured) || w.days_measured < 0 || w.days_measured > 7 || (w.complete && w.days_measured !== 7)
      || !WEEK.slice(4, 14).every((k) => count(w[k]))) throw Error('week');
    if (w.read > w.delivered || w.delivered > w.families || w.messages < w.families || w.replied > w.families
      || w.sent_file > w.families || w.files < w.sent_file || w.no_file_before > w.families || w.activated > w.no_file_before
      || w.activated > w.sent_file || (w.families === 0 && w.failed === 0)) throw Error('week counts');
    const o = w.others;
    if (!exact(o, OTHERS) || !OTHERS.every((k) => count(o[k])) || o.replied > o.families || o.sent_file > o.families || o.files < o.sent_file) throw Error('others');
  });
  return d;
}

// Change in percentage points against the week before, only when both weeks are complete.
function change(weeks, i, key) {
  const w = weeks[i], p = weeks[i - 1];
  if (!p || !w.complete || !p.complete || !w.families || !p.families) return null;
  return rate(w[key], w.families) - rate(p[key], p.families);
}
const points = (x) => (x === null ? '-' : x === 0 ? 'same' : `${x > 0 ? '+' : ''}${x} ${Math.abs(x) === 1 ? 'point' : 'points'}`);

const STYLE = `<style>
.hbw{min-width:0;overflow-wrap:anywhere}
.hbw h2{margin:0 0 6px;font-size:clamp(20px,5vw,24px);line-height:1.25}.hbw h3{margin:0 0 6px;font-size:15px}
.hbw .hbw-section{padding:20px;margin:14px 0}
.hbw .hbw-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:12px}
.hbw .hbw-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:12px}
.hbw .hbw-stat{padding:16px;min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.hbw .hbw-stat h4{font-size:13px;margin:0 0 8px;color:var(--ink-2);font-weight:600}
.hbw .hbw-stat strong{display:block;font-size:28px;line-height:1.15;color:var(--ink)}
.hbw .hbw-stat p,.hbw .hbw-note{font-size:13px;line-height:1.6;color:var(--ink-3);margin:6px 0 0}
.hbw .hbw-warning{padding:12px 14px;border-left:4px solid var(--warn);background:var(--warn-soft);color:var(--ink);border-radius:6px;margin:10px 0;font-size:14px;line-height:1.55}
.hbw .hbw-chart{min-width:0}
.hbw .hbw-cols{display:flex;align-items:stretch;gap:6px;height:190px;padding:0 2px;border-bottom:1px solid var(--line-2)}
.hbw .hbw-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;padding-top:20px}
.hbw .hbw-val{position:absolute;left:50%;transform:translateX(-50%);font-size:12px;font-weight:600;color:var(--ink);white-space:nowrap;line-height:16px}
.hbw .hbw-plot{position:relative;flex:1;width:100%;max-width:44px}
.hbw .hbw-bar{position:absolute;left:0;right:0;bottom:0;border-radius:4px 4px 0 0;background:var(--primary);min-height:2px}
.hbw .hbw-bar.hbw-partial{background:repeating-linear-gradient(135deg,var(--primary) 0 4px,var(--primary-soft) 4px 8px)}
.hbw .hbw-mark{position:absolute;left:-3px;right:-3px;height:0;border-top:2px solid var(--ink);box-shadow:0 0 0 1px var(--surface)}
.hbw .hbw-xs{display:flex;gap:6px;padding:4px 2px 0}
.hbw .hbw-xs span{flex:1 1 0;min-width:0;text-align:center;font-size:11px;color:var(--ink-2);white-space:nowrap;overflow:hidden}
.hbw .hbw-dense .hbw-val{visibility:hidden}
.hbw .hbw-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:10px 0 0;padding:0;list-style:none;font-size:13px;color:var(--ink-2)}
.hbw .hbw-legend li{display:flex;align-items:center;gap:6px}
.hbw .hbw-key{display:inline-block;width:14px;height:10px;border-radius:3px;background:var(--primary)}
.hbw .hbw-key.hbw-key-mark{height:0;border-top:2px solid var(--ink);border-radius:0;background:none}
.hbw .hbw-key.hbw-partial{background:repeating-linear-gradient(135deg,var(--primary) 0 3px,var(--primary-soft) 3px 6px)}
.hbw .hbw-table{overflow-x:auto;margin-top:12px}
.hbw table{width:100%;border-collapse:collapse;font-size:14px}
.hbw th,.hbw td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line-2);vertical-align:top;color:var(--ink)}
.hbw th{font-size:12px;color:var(--ink-2);font-weight:600}
.hbw td small{display:block;font-size:12px;color:var(--ink-3)}
.hbw .hbw-cards{display:none}
.hbw .hbw-card{padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);margin-top:12px}
.hbw .hbw-card dl{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:8px 12px;margin:8px 0 0;font-size:14px;line-height:1.45}
.hbw .hbw-card dt{color:var(--ink-2)}.hbw .hbw-card dd{margin:0;color:var(--ink);font-weight:600}
.hbw details summary{cursor:pointer;font-weight:600}
.hbw details p,.hbw details li{font-size:14px;line-height:1.6;color:var(--ink-2)}
@media(max-width:900px){.hbw .hbw-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.hbw .hbw-two{grid-template-columns:1fr}.hbw .hbw-section{padding:16px}.hbw .hbw-stat strong{font-size:26px}
.hbw .hbw-table{display:none}.hbw .hbw-cards{display:block}.hbw .hbw-cols{gap:3px;height:160px}.hbw .hbw-xs{gap:3px}.hbw .hbw-val{font-size:11px}}
</style>`;

const stat = (title, value, note) =>
  `<article class="hbw-stat"><h4>${sanitize(title)}</h4><strong>${sanitize(value)}</strong>${note ? `<p>${sanitize(note)}</p>` : ''}</article>`;

function chart(title, weeks, key, otherKey) {
  const dense = weeks.length > 10, step = Math.ceil(weeks.length / 8);
  const cols = weeks.map((w) => {
    // The value sits just above its bar, or above the others line when that line is close above it.
    const r = rate(w[key], w.families), o = rate(w.others[otherKey], w.others.families);
    const label = `${saturday(w.week_of)}: ${w.families ? `${num(w[key])} of ${num(w.families)} messaged (${r}%)` : 'none delivered'}`
      + `${w.complete ? '' : `, so far (${w.days_measured} of 7 days)`}. Others not messaged: ${o === null ? 'none' : `${num(w.others[otherKey])} of ${num(w.others.families)} (${o}%)`}.`;
    return `<div class="hbw-col" title="${sanitize(label)}" aria-label="${sanitize(label)}" role="listitem">
      <span class="hbw-plot" aria-hidden="true">${r === null ? '' : `<span class="hbw-bar${w.complete ? '' : ' hbw-partial'}" style="height:${r}%"></span>`}${o === null ? '' : `<span class="hbw-mark" style="bottom:${o}%"></span>`}${r === null ? '' : `<span class="hbw-val" style="bottom:calc(${o !== null && o >= r && o - r <= 10 ? o : r}% + 4px)">${r}%</span>`}</span>
    </div>`;
  }).join('');
  const xs = weeks.map((w, i) => `<span>${dense && i % step ? '' : sanitize(saturday(w.week_of, 'short'))}</span>`).join('');
  return `<div class="hbw-chart${dense ? ' hbw-dense' : ''}"><h3>${sanitize(title)}</h3><div class="hbw-cols" role="list" aria-label="${sanitize(title)}, by Saturday">${cols}</div><div class="hbw-xs" aria-hidden="true">${xs}</div></div>`;
}

function weekCells(w, weeks, i) {
  const partial = w.complete ? '' : ` (so far, ${w.days_measured} of 7 days)`;
  return {
    saturday: saturday(w.week_of) + (w.complete ? '' : ' - still counting'),
    messaged: num(w.families) + (w.failed ? ` (+${num(w.failed)} not delivered)` : ''),
    delivered: w.families ? `${num(w.delivered)} / ${num(w.read)}` : '-',
    replied: ofText(w.replied, w.families) + partial,
    files: ofText(w.sent_file, w.families) + (w.families ? `, ${num(w.files)} ${w.files === 1 ? 'file' : 'files'}` : '') + partial,
    activated: w.no_file_before ? `${num(w.activated)} of ${num(w.no_file_before)} (${pct(w.activated, w.no_file_before)})` : (w.families ? '0 (all had sent before)' : '-'),
    change: !w.complete ? 'Still counting' : change(weeks, i, 'replied') === null ? 'No full week before'
      : `Replies ${points(change(weeks, i, 'replied'))}, reports ${points(change(weeks, i, 'sent_file'))}`,
    others: w.others.families ? `Replied ${pct(w.others.replied, w.others.families)}, reports ${pct(w.others.sent_file, w.others.families)} (of ${num(w.others.families)})` : '-',
  };
}

const COLUMNS = [
  ['saturday', 'Saturday'], ['messaged', 'Families messaged'], ['delivered', 'Delivered / read'], ['replied', 'Replied in 7 days'],
  ['files', 'Sent reports in 7 days'], ['activated', 'Activated'], ['change', 'Change vs week before'], ['others', 'Others, not messaged'],
];

function paint(d) {
  const a = d.audience, weeks = d.weeks, newest = [...weeks].reverse();
  const last = [...weeks].reverse().find((w) => w.complete && w.families);
  const li = last ? weeks.indexOf(last) : -1;
  const counting = weeks.find((w) => !w.complete);
  const once = a.ever_messaged && a.messaged_two_plus_weeks * 10 < a.ever_messaged;
  const rows = newest.map((w) => weekCells(w, weeks, weeks.indexOf(w)));
  let html = `<section class="card hbw-section" aria-labelledby="hbw-who-title">
    <h2 id="hbw-who-title">Who gets the weekly message</h2>
    <p class="hbw-note">The weekly message is HopeBot's Saturday check-in at 8 pm. It goes only to families who finished HopeBot sign-up and have weekly messages on. Families who never signed up on HopeBot do not get it.</p>
    <div class="hbw-grid">
      ${stat('Signed up on HopeBot', num(a.signed_up), 'Families who finished HopeBot sign-up, counted today.')}
      ${stat('Weekly messages on', num(a.weekly_on), 'Of those, families who have not turned weekly messages off.')}
      ${stat('Ever got the Saturday message', num(a.ever_messaged), a.first_sent_at ? `Since ${dateIST(a.first_sent_at)}.` : 'None sent yet.')}
      ${stat('Got it on 2 or more Saturdays', num(a.messaged_two_plus_weeks), `${pct(a.messaged_two_plus_weeks, a.ever_messaged)} of families who ever got it.`)}
    </div>
    ${once ? `<div class="hbw-warning" role="note">So far most families have received the Saturday message only once, on the first Saturday after they signed up. It is not yet one message to every family every week. Each row below is mostly that week's newly signed-up families.</div>` : ''}
  </section>`;
  if (!weeks.length) {
    return html + `<section class="card hbw-section"><h2>Week by week</h2><p class="hbw-note">No Saturday message was sent in these dates. Try 90 days.</p></section>`;
  }
  html += `<section class="card hbw-section" aria-labelledby="hbw-last-title">
    <h2 id="hbw-last-title">${last ? `Last full week: Saturday ${sanitize(saturday(last.week_of))}` : 'No full week yet'}</h2>
    ${last ? `<div class="hbw-grid">
      ${stat('Families messaged', num(last.families), `${num(last.delivered)} delivered, ${num(last.read)} read.`)}
      ${stat('Replied within 7 days', pct(last.replied, last.families), `${num(last.replied)} of ${num(last.families)} families. ${li > 0 ? 'Change: ' + points(change(weeks, li, 'replied')) + '.' : ''}`)}
      ${stat('Sent reports within 7 days', pct(last.sent_file, last.families), `${num(last.sent_file)} families, ${num(last.files)} files. ${li > 0 ? 'Change: ' + points(change(weeks, li, 'sent_file')) + '.' : ''}`)}
      ${stat('Activated', num(last.activated), `of ${num(last.no_file_before)} families who had never sent a report before.`)}
    </div>` : '<p class="hbw-note">Every Saturday in these dates is less than 7 days old.</p>'}
    ${counting ? `<p class="hbw-note">Saturday ${sanitize(saturday(counting.week_of))} is still counting: ${counting.days_measured} of 7 days have passed, so its numbers can still go up.</p>` : ''}
  </section>
  <section class="card hbw-section" aria-labelledby="hbw-trend-title">
    <h2 id="hbw-trend-title">Trend by Saturday</h2>
    <div class="hbw-two">${chart('Replied within 7 days', weeks, 'replied', 'replied')}${chart('Sent reports within 7 days', weeks, 'sent_file', 'sent_file')}</div>
    <ul class="hbw-legend"><li><span class="hbw-key" aria-hidden="true"></span>Families messaged that Saturday</li><li><span class="hbw-key hbw-key-mark" aria-hidden="true"></span>Other signed-up families, not messaged that week</li>${counting ? '<li><span class="hbw-key hbw-partial" aria-hidden="true"></span>Still counting</li>' : ''}</ul>
  </section>
  <section class="card hbw-section" aria-labelledby="hbw-table-title">
    <h2 id="hbw-table-title">Week by week</h2>
    <p class="hbw-note">Newest Saturday first. "In 7 days" means within 7 days after that Saturday's message.</p>
    <div class="hbw-table"><table><thead><tr>${COLUMNS.map(([, h]) => `<th scope="col">${sanitize(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${COLUMNS.map(([k], j) => (j ? `<td>${sanitize(r[k])}</td>` : `<th scope="row">${sanitize(r[k])}</th>`)).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="hbw-cards">${rows.map((r) => `<article class="hbw-card"><h3>${sanitize(r.saturday)}</h3><dl>${COLUMNS.slice(1).map(([k, h]) => `<dt>${sanitize(h)}</dt><dd>${sanitize(r[k])}</dd>`).join('')}</dl></article>`).join('')}</div>
    <div class="hbw-warning" role="note">A reply or report after the message shows timing only. It does not prove the message caused it. "Others" signed up earlier, so they are usually less active anyway: read it as a rough comparison.</div>
  </section>
  <details class="card hbw-section"><summary>What each column means</summary><ul>
    <li><b>Families messaged</b>: families whose Saturday message WhatsApp accepted. "Not delivered" are messages WhatsApp could not deliver.</li>
    <li><b>Delivered / read</b>: delivered to the phone, and opened. Read only shows when the family has read receipts on.</li>
    <li><b>Replied in 7 days</b>: sent any message or tapped a button in the 7 days after the Saturday message. STOP does not count.</li>
    <li><b>Sent reports in 7 days</b>: sent at least one photo or document in those 7 days, and how many files in total. Every photo counts, because HopeBot cannot tell a report photo from any other photo.</li>
    <li><b>Activated</b>: a family that had never sent a photo or document before the message, and sent its first one within 7 days. Shown as activated of the families who had never sent one.</li>
    <li><b>Change vs week before</b>: the reply and report rates minus the Saturday before, in percentage points. Shown only when both weeks are complete.</li>
    <li><b>Others, not messaged</b>: families who had finished sign-up before that Saturday and did not get the message that week, over the same 7 days.</li>
  </ul><p>Team numbers, staff tests, test resets, numbers that sent STOP, numbers with an open deletion request and testing numbers are left out, the same rules as Repeat use and uploads. Updated ${sanitize(stamp(d.as_of))}.</p></details>`;
  return html;
}

export function mountHopebotWeekly(host, { from, to, isCurrent = () => true } = {}) {
  const scope = createReportView234(host, { manager: true, isCurrent }), root = scope.root;
  let first = from, last = to, generation = 0;
  if (!scope.current()) return scope;
  root.className = 'hbw';
  root.innerHTML = `${STYLE}<h2 class="sr-only">Saturday weekly message</h2><p data-hbw-message role="status" aria-live="polite"></p><div data-hbw-results></div>`;
  const box = root.querySelector('[data-hbw-results]'), message = root.querySelector('[data-hbw-message]');
  function invalidate() {
    generation++; scope.invalidate(); box.replaceChildren();
    message.textContent = 'Apply dates to load the Saturday weekly message.';
  }
  async function load(newFrom = first, newTo = last) {
    if (!scope.current()) return;
    invalidate(); first = newFrom; last = newTo;
    if (!day(first) || !day(last) || last < first || (Date.parse(last) - Date.parse(first)) / 86400000 > 365) {
      message.textContent = 'Choose a valid period of at most 366 days.'; return;
    }
    const token = generation;
    message.textContent = 'Loading the Saturday weekly message...';
    try {
      const d = validateWeekly(await scope.read('hopebot_weekly_checkin_analytics', { p_from: first, p_to: last }), scope.actor, first, last);
      if (!scope.current() || token !== generation) return;
      box.innerHTML = paint(d);
      message.textContent = `Saturdays from ${first} to ${last} (IST). Updated ${stamp(d.as_of)}.`;
    } catch (e) {
      if (e.stale || !scope.current() || token !== generation) return;
      box.replaceChildren();
      message.textContent = 'The Saturday weekly message could not be confirmed. Use your active manager account, exit Open as, and refresh. No zero-activity conclusion was drawn.';
    }
  }
  load();
  return { ...scope, load, invalidate };
}
