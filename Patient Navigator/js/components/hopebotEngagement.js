// Analytics > HopeBot analytics > Repeat use and uploads.
// Aggregate counts only, from public.hopebot_engagement_analytics(date,date) (sql/257).
// No names, numbers or per-person rows ever reach this view.
import { createReportView234 } from './reportHistory234.js';
import { sanitize } from '../utils/validators.js';

const KINDS = {
  docs_invite: ['Send HopeBot invitation', 'From the Send HopeBot button in Navigator. Asks the family to send photos or PDFs of hospital papers in the chat.'],
  intro: ['HopeBot introduction after a call', 'Sent when a caller introduces HopeBot from the Calling Portal. Tells the family they can share hospital reports in the chat.'],
  reports_reminder: ['Reports reminder', 'Sent by HopeBot about a day after it asked for reports, when none came.'],
  weekly_no_reports: ['Saturday reminder, no reports yet', 'HopeBot\'s Saturday check-in for families who have not sent any reports.'],
  weekly_checkin: ['Saturday check-in', 'HopeBot\'s Saturday check-in asking for any new report this week, for families who already sent reports.'],
  passport_empty: ['Empty Cancer Passport reminder', 'Asks for reports to fill an empty Cancer Passport.'],
};
const ORDER = Object.keys(KINDS);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const median = (x) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0);
const instant = (x) => typeof x === 'string' && x.length <= 64 && Number.isFinite(Date.parse(x));
const day = (x) => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x) && instant(x) && new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x;
const sum = (...xs) => xs.reduce((a, b) => a + b, 0);
const exact = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const num = (x) => Number(x).toLocaleString('en-IN');
const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : 'Not yet measurable');
const plural = (x, one, many) => (x === null ? 'Not yet measurable' : `${dec(x)} ${x === 1 ? one : many}`);
const dec = (x) => (x === null ? 'Not yet measurable' : Number(x).toLocaleString('en-IN', { maximumFractionDigits: 1 }));
const stamp = (x) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(x)) + ' IST';
const dateOnly = (x) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }).format(new Date(x));
function waited(hours) {
  if (hours === null) return 'Not yet measurable';
  if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' minutes';
  if (hours < 48) return dec(hours) + ' hours';
  return dec(hours / 24) + ' days';
}

export function validateEngagement(d, actor, from, to) {
  const top = ['version', 'actor_id', 'from', 'to', 'timezone', 'from_at', 'until_at', 'as_of', 'records_from', 'usage', 'repeat', 'uploads', 'reminders'];
  if (!exact(d, top) || d.version !== 1 || d.actor_id !== actor || d.from !== from || d.to !== to || d.timezone !== 'Asia/Kolkata'
    || !day(from) || !day(to) || !instant(d.as_of) || (d.records_from !== null && !instant(d.records_from))
    || Date.parse(d.from_at) !== Date.parse(from + 'T00:00:00+05:30') || Date.parse(d.until_at) !== Date.parse(to + 'T00:00:00+05:30') + 86400000) throw Error('contract');
  const u = d.usage, r = d.repeat, up = d.uploads;
  const uKeys = ['people', 'new_people', 'returning_people', 'messages', 'active_7d', 'active_30d', 'ever_people'];
  const rKeys = ['one_day', 'two_plus_days', 'days_1', 'days_2', 'days_3_5', 'days_6_plus', 'median_days', 'median_messages', 'ever_people', 'ever_two_plus_days'];
  const upKeys = ['uploaders', 'two_plus_days', 'files', 'days_1', 'days_2', 'days_3_5', 'days_6_plus', 'files_1', 'files_2_5', 'files_6_10', 'files_11_plus', 'median_days', 'median_files', 'ever_uploaders', 'ever_two_plus_days'];
  const medians = ['median_days', 'median_messages', 'median_files'];
  for (const [o, keys] of [[u, uKeys], [r, rKeys], [up, upKeys]]) {
    if (!exact(o, keys) || !keys.every((k) => (medians.includes(k) ? median(o[k]) : count(o[k])))) throw Error('counts');
  }
  if (u.new_people + u.returning_people !== u.people || r.one_day + r.two_plus_days !== u.people
    || sum(r.days_1, r.days_2, r.days_3_5, r.days_6_plus) !== u.people || r.days_1 !== r.one_day
    || u.active_7d > u.active_30d || u.active_30d > u.ever_people || u.people > u.ever_people || r.ever_people !== u.ever_people
    || r.ever_two_plus_days > r.ever_people || r.two_plus_days > r.ever_two_plus_days || u.messages < u.people) throw Error('usage');
  if (up.uploaders > u.people || sum(up.days_1, up.days_2, up.days_3_5, up.days_6_plus) !== up.uploaders
    || sum(up.files_1, up.files_2_5, up.files_6_10, up.files_11_plus) !== up.uploaders
    || up.two_plus_days !== sum(up.days_2, up.days_3_5, up.days_6_plus) || up.files < up.uploaders
    || up.uploaders > up.ever_uploaders || up.ever_uploaders > u.ever_people || up.ever_two_plus_days > up.ever_uploaders
    || up.two_plus_days > up.ever_two_plus_days) throw Error('uploads');
  if (!Array.isArray(d.reminders) || d.reminders.length !== ORDER.length) throw Error('reminders');
  d.reminders.forEach((k, i) => {
    const keys = ['kind', 'source', 'sends', 'delivered', 'people', 'people_with_file_before', 'windows', 'median_hours_to_file'];
    if (!exact(k, keys) || k.kind !== ORDER[i] || !['navigator', 'hopebot'].includes(k.source)
      || !['sends', 'delivered', 'people', 'people_with_file_before'].every((x) => count(k[x])) || !median(k.median_hours_to_file)
      || k.delivered > k.sends || k.people > k.sends || k.people_with_file_before > k.people
      || !Array.isArray(k.windows) || k.windows.length !== 3) throw Error('reminder');
    k.windows.forEach((w, j) => {
      const wKeys = ['days', 'sends_measurable', 'sends_followed', 'people_measurable', 'people_uploaded'];
      if (!exact(w, wKeys) || w.days !== [1, 3, 7][j] || !wKeys.every((x) => count(w[x]))
        || w.people_uploaded > w.people_measurable || w.people_measurable > k.people
        || w.sends_followed > w.sends_measurable || w.sends_measurable > k.sends) throw Error('window');
      // A longer window can only measure the same messages or fewer.
      if (j && (w.sends_measurable > k.windows[j - 1].sends_measurable || w.people_measurable > k.windows[j - 1].people_measurable)) throw Error('window order');
    });
  });
  return d;
}

const STYLE = `<style>
.hbe{min-width:0;overflow-wrap:anywhere}
.hbe h2{margin:0 0 6px;font-size:clamp(20px,5vw,24px);line-height:1.25}.hbe h3{margin:0 0 8px;font-size:15px}
.hbe .hbe-section{padding:20px;margin:14px 0}
.hbe .hbe-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.hbe .hbe-two{grid-template-columns:repeat(2,minmax(0,1fr))}
.hbe .hbe-stat{padding:16px;min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.hbe .hbe-stat h4{font-size:13px;margin:0 0 8px;color:var(--ink-2);font-weight:600}
.hbe .hbe-stat strong{display:block;font-size:28px;line-height:1.15;color:var(--ink)}
.hbe .hbe-stat p,.hbe .hbe-note{font-size:13px;line-height:1.6;color:var(--ink-3);margin:6px 0 0}
.hbe .hbe-hero strong{font-size:34px}
.hbe .hbe-bars{display:grid;gap:10px;margin:12px 0 0;padding:0;list-style:none}
.hbe .hbe-bar{display:grid;grid-template-columns:minmax(72px,110px) minmax(0,1fr) minmax(76px,auto);gap:10px;align-items:center;font-size:13px;color:var(--ink-2)}
.hbe .hbe-track{height:10px;border-radius:4px;background:var(--primary-soft);overflow:hidden}
.hbe .hbe-fill{display:block;height:100%;border-radius:4px;background:var(--primary);min-width:0}
.hbe .hbe-bar b{color:var(--ink);font-weight:600;text-align:right;white-space:nowrap}
.hbe .hbe-warning{padding:12px 14px;border-left:4px solid var(--warn);background:var(--warn-soft);color:var(--ink);border-radius:6px;margin:10px 0;font-size:14px;line-height:1.55}
.hbe .hbe-reminders{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
.hbe .hbe-reminder{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);min-width:0}
.hbe .hbe-reminder dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;margin:10px 0 0;font-size:14px}
.hbe .hbe-reminder dt{color:var(--ink-2)}.hbe .hbe-reminder dd{margin:0;text-align:right;color:var(--ink);font-weight:600}

.hbe details summary{cursor:pointer;font-weight:600}
.hbe details p{font-size:14px;line-height:1.6;color:var(--ink-2)}
@media(max-width:650px){.hbe .hbe-grid,.hbe .hbe-two,.hbe .hbe-reminders{grid-template-columns:1fr}.hbe .hbe-section{padding:16px}
.hbe .hbe-bar{grid-template-columns:minmax(64px,84px) minmax(0,1fr) auto;gap:8px}.hbe .hbe-stat strong{font-size:26px}.hbe .hbe-hero strong{font-size:30px}}
</style>`;

const stat = (title, value, note, hero = false) =>
  `<article class="hbe-stat${hero ? ' hbe-hero' : ''}"><h4>${sanitize(title)}</h4><strong>${sanitize(value)}</strong>${note ? `<p>${sanitize(note)}</p>` : ''}</article>`;

function bars(label, rows, total) {
  return `<ul class="hbe-bars" aria-label="${sanitize(label)}">${rows.map(([name, n]) => {
    const share = total ? Math.round((n / total) * 100) : 0;
    return `<li class="hbe-bar" aria-label="${sanitize(`${name}: ${num(n)} people, ${share}%`)}"><span>${sanitize(name)}</span><span class="hbe-track" aria-hidden="true"><span class="hbe-fill" style="width:${share}%"></span></span><b>${num(n)} (${share}%)</b></li>`;
  }).join('')}</ul>`;
}

function reminderCard(k) {
  const [title, about] = KINDS[k.kind];
  if (!k.sends) {
    return `<article class="hbe-reminder"><h3>${sanitize(title)}</h3><p class="hbe-note">${sanitize(about)}</p><p class="hbe-note"><strong>None sent in these dates.</strong></p></article>`;
  }
  const rows = k.windows.map((w) => [
    `Sent a file within ${w.days === 1 ? '1 day' : w.days + ' days'}`,
    w.people_measurable ? `${num(w.people_uploaded)} of ${num(w.people_measurable)} (${pct(w.people_uploaded, w.people_measurable)})` : 'Too soon to tell',
  ]);
  return `<article class="hbe-reminder"><h3>${sanitize(title)}</h3><p class="hbe-note">${sanitize(about)}</p><dl>
    <dt>Messages sent</dt><dd>${num(k.sends)}</dd>
    <dt>Delivered or read</dt><dd>${num(k.delivered)}</dd>
    <dt>People reached</dt><dd>${num(k.people)}</dd>
    <dt>Had already sent a file before</dt><dd>${num(k.people_with_file_before)}</dd>
    ${rows.map(([t, v]) => `<dt>${sanitize(t)}</dt><dd>${sanitize(v)}</dd>`).join('')}
    <dt>Typical time to the first file</dt><dd>${sanitize(waited(k.median_hours_to_file))}</dd>
  </dl></article>`;
}

function paint(d) {
  const u = d.usage, r = d.repeat, up = d.uploads;
  const since = d.records_from ? dateOnly(d.records_from) : null;
  return `
  <section class="card hbe-section" aria-labelledby="hbe-repeat-title">
    <h2 id="hbe-repeat-title">Came back or one time only</h2>
    <p class="hbe-note">People who wrote to HopeBot in these dates, by how many separate days they wrote on.</p>
    <div class="hbe-grid hbe-two" style="margin-top:12px">
      ${stat('Came back on 2 or more days', num(r.two_plus_days), `${pct(r.two_plus_days, u.people)} of ${num(u.people)} people`, true)}
      ${stat('One day only', num(r.one_day), `${pct(r.one_day, u.people)} of ${num(u.people)} people`, true)}
    </div>
    ${bars('Days each person wrote on', [['1 day', r.days_1], ['2 days', r.days_2], ['3 to 5 days', r.days_3_5], ['6 or more', r.days_6_plus]], u.people)}
    <div class="hbe-grid" style="margin-top:14px">
      ${stat('Typical days per person', dec(r.median_days), 'Median separate days with a message.')}
      ${stat('Typical messages per person', dec(r.median_messages), 'Median messages and button taps.')}
      ${stat('All time, came back', num(r.ever_two_plus_days), `${pct(r.ever_two_plus_days, r.ever_people)} of ${num(r.ever_people)} people${since ? ' since ' + since : ''} wrote on 2 or more days.`)}
    </div>
    <p class="hbe-note">Counted inside the selected dates. People who first wrote near the end of the dates have had less time to come back.</p>
  </section>
  <section class="card hbe-section" aria-labelledby="hbe-usage-title">
    <h2 id="hbe-usage-title">People using HopeBot</h2>
    <div class="hbe-grid" style="margin-top:12px">
      ${stat('People who messaged HopeBot', num(u.people), `${num(u.new_people)} new, ${num(u.returning_people)} had written before these dates.`)}
      ${stat('Messages and taps', num(u.messages), 'Texts, button taps, voice notes, photos and files sent to HopeBot.')}
      ${stat('Active recently', `${num(u.active_7d)} / ${num(u.active_30d)}`, 'Wrote in the last 7 days / last 30 days, counted up to today whatever dates are chosen.')}
    </div>
  </section>
  <section class="card hbe-section" aria-labelledby="hbe-upload-title">
    <h2 id="hbe-upload-title">Building their record: reports sent</h2>
    <p class="hbe-note">Photos and documents families sent to HopeBot in these dates.</p>
    <div class="hbe-grid" style="margin-top:12px">
      ${stat('People who sent a file', num(up.uploaders), `${pct(up.uploaders, u.people)} of people who messaged.`, true)}
      ${stat('Sent files on 2 or more days', num(up.two_plus_days), `${pct(up.two_plus_days, up.uploaders)} of people who sent a file.`, true)}
      ${stat('Files received', num(up.files), 'Each photo or document counts once.')}
    </div>
    <div class="hbe-grid hbe-two" style="margin-top:14px">
      <div><h3>Days with a file, per person</h3>${bars('Days with a file per person', [['1 day', up.days_1], ['2 days', up.days_2], ['3 to 5 days', up.days_3_5], ['6 or more', up.days_6_plus]], up.uploaders)}
        <p class="hbe-note">Typical: ${sanitize(plural(up.median_days, 'day', 'days'))} per person who sent a file.</p></div>
      <div><h3>Files per person</h3>${bars('Files per person', [['1 file', up.files_1], ['2 to 5', up.files_2_5], ['6 to 10', up.files_6_10], ['11 or more', up.files_11_plus]], up.uploaders)}
        <p class="hbe-note">Typical: ${sanitize(plural(up.median_files, 'file', 'files'))} per person who sent a file.</p></div>
    </div>
    <p class="hbe-note">All time${since ? ' since ' + sanitize(since) : ''}: ${num(up.ever_uploaders)} people have sent a file, ${num(up.ever_two_plus_days)} of them on 2 or more separate days.</p>
  </section>
  <section class="card hbe-section" aria-labelledby="hbe-reminder-title">
    <h2 id="hbe-reminder-title">After a "please send your reports" message</h2>
    <div class="hbe-warning" role="note">A file sent after a message shows timing only. It does not prove the message caused it: some families would have sent it anyway.</div>
    <p class="hbe-note">Messages sent in these dates. Each "within" line counts only messages sent at least that many days ago, so a later line can show fewer people than the one above it.</p>
    <div class="hbe-reminders">${d.reminders.map(reminderCard).join('')}</div>
  </section>
  <details class="card hbe-section"><summary>How these numbers are measured</summary>
    <p>People are WhatsApp numbers that wrote to HopeBot. Team numbers, team tests, test resets, numbers that sent STOP and numbers with an open deletion request are left out, the same rules as the HopeBot console's Usage and retention.</p>
    <p>A message is a text, button tap, voice note, photo, document or video sent to HopeBot. A day is an India Standard Time calendar day.</p>
    <p>A file is a photo or a document (such as a PDF) sent in the chat. HopeBot cannot tell a report photo from any other photo, so every photo and document counts. This is different from Report sharing, which counts only files filed into a registered patient's record.</p>
    <p>Sent means WhatsApp accepted the message; a message reported as failed is not counted. "Sent a file within 1 day" means the person's first photo or document after that message came within 24 hours. Typical time is the median wait, for messages at least 7 days old that were followed by a file within 7 days.</p>
    <p>Send HopeBot invitations come from Navigator's own invitation log. Everything else comes from HopeBot's records in the same database.${since ? ' HopeBot records start ' + sanitize(since) + '.' : ''} Updated ${sanitize(stamp(d.as_of))}.</p>
  </details>`;
}

export function mountHopebotEngagement(host, { from, to, isCurrent = () => true } = {}) {
  const scope = createReportView234(host, { manager: true, isCurrent }), root = scope.root;
  let first = from, last = to, generation = 0;
  if (!scope.current()) return scope;
  root.className = 'hbe';
  root.innerHTML = `${STYLE}<h2 class="sr-only">Repeat use and uploads</h2><p data-hbe-message role="status" aria-live="polite"></p><div data-hbe-results></div>`;
  const box = root.querySelector('[data-hbe-results]'), message = root.querySelector('[data-hbe-message]');
  function invalidate() {
    generation++; scope.invalidate(); box.replaceChildren();
    message.textContent = 'Apply dates to load repeat use and uploads.';
  }
  async function load(newFrom = first, newTo = last) {
    if (!scope.current()) return;
    invalidate(); first = newFrom; last = newTo;
    if (!day(first) || !day(last) || last < first || (Date.parse(last) - Date.parse(first)) / 86400000 > 365) {
      message.textContent = 'Choose a valid period of at most 366 days.'; return;
    }
    const token = generation;
    message.textContent = 'Loading repeat use and uploads...';
    try {
      const d = validateEngagement(await scope.read('hopebot_engagement_analytics', { p_from: first, p_to: last }), scope.actor, first, last);
      if (!scope.current() || token !== generation) return;
      box.innerHTML = paint(d);
      message.textContent = `Results for ${first} to ${last} (IST). Updated ${stamp(d.as_of)}.`;
    } catch (e) {
      if (e.stale || !scope.current() || token !== generation) return;
      box.replaceChildren();
      message.textContent = 'Repeat use and uploads could not be confirmed. Use your active manager account, exit Open as, and refresh. No zero-usage conclusion was drawn.';
    }
  }
  load();
  return { ...scope, load, invalidate };
}
