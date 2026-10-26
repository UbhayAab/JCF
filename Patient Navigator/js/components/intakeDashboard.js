// Intake metrics count the uploader's patients, not their caller assignments.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, getUserRole } from '../auth.js';
import { sanitize } from '../utils/validators.js';

const counts = ['uploaded','attempted','reached','not_attempted','attempted_not_reached','attempted_24h','attempted_48h','reached_48h','untouched_over_48h','followups_due'];
const summaryCounts = ['total_uploaded','attempted','reached','not_attempted','attempted_not_reached','uploaded_today','attempted_today','reached_today','untouched_over_48h','followups_due'];
const note = 'white-space:normal;overflow:visible;text-overflow:clip';
const dateOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
const countOK = value => Number.isSafeInteger(value) && value >= 0;
export function validateIntakeStats(value, expectedDays) {
  const bad = () => { throw Error('The statistics response was incomplete. Try again.'); };
  if (!value || value.version !== 1 || value.timezone !== 'Asia/Kolkata' || !dateOK(value.from) || !dateOK(value.through) || !Number.isFinite(Date.parse(value.as_of)) || !Array.isArray(value.days) || value.days.length !== expectedDays || !value.summary) bad();
  for (const key of summaryCounts) if (!countOK(value.summary[key])) bad();
  if (value.summary.total_uploaded !== value.summary.reached + value.summary.attempted_not_reached + value.summary.not_attempted || value.summary.attempted !== value.summary.reached + value.summary.attempted_not_reached || value.summary.reached_today > value.summary.attempted_today) bad();
  const from = Date.parse(value.from+'T12:00:00Z');
  for (let i=0;i<value.days.length;i++) {
    const row=value.days[i],expected=new Date(from+i*864e5).toISOString().slice(0,10);
    if (row.day !== expected || !dateOK(row.day)) bad();
    for (const key of counts) if (!countOK(row[key])) bad();
    if (row.uploaded !== row.reached + row.attempted_not_reached + row.not_attempted || row.attempted !== row.reached + row.attempted_not_reached || row.attempted_24h > row.attempted_48h || row.attempted_48h > row.attempted || row.reached_48h > row.reached || row.untouched_over_48h > row.not_attempted || row.followups_due > row.uploaded) bad();
  }
  if (value.days.at(-1)?.day !== value.through) bad();
  return value;
}
const dayLabel = date => new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'}).format(new Date(date+'T12:00:00Z'));
const tile = (number,label,hint) => `<div class="card stat-card"><div class="stat-value tnum">${number}</div><div class="stat-label">${label}</div><p class="due-meta" style="${note};margin-top:6px">${hint}</p></div>`;
export function intakeStatsHTML(data) {
  const s=data.summary;
  return `<p class="due-meta" style="${note}">Today: <strong>${dayLabel(data.through)}</strong> · India time (IST). Updated ${sanitize(new Date(data.as_of).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}))}.</p>
    <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin:14px 0">
      ${tile(s.uploaded_today,'Uploaded today','New patient records created by you today. Older backlog is not included.')}
      ${tile(s.attempted_today,'Contact attempted today','Your uploaded patients with at least one call logged by the team today.')}
      ${tile(s.reached_today,'Reached today','Your uploaded patients with a connected call today; each patient counts once.')}
      ${tile(s.followups_due,'Follow-ups due now','Distinct contactable patients with an outstanding, due follow-up queue record.')}
    </div>
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin:0 0 10px">All your uploaded records</h3>
      <p style="line-height:1.6;margin:0"><strong>${s.total_uploaded}</strong> uploaded overall · <strong>${s.reached}</strong> reached · <strong>${s.attempted_not_reached}</strong> called, not reached · <strong>${s.not_attempted}</strong> never called.</p>
      <p class="due-meta" style="${note};margin:8px 0 0"><strong>${s.untouched_over_48h}</strong> active, contactable patients have waited over 48 hours without a call. These are older records, not uploads today. Archived, blocked and resting patients are excluded from that waiting count.</p>
    </div>
    <div class="card" style="min-width:0">
      <h3 style="margin:0 0 8px">Progress by upload day</h3>
      <p class="due-meta" style="${note}">${dayLabel(data.from)} to ${dayLabel(data.through)}, IST. Each row follows the patients uploaded on that date. Contact totals grow as later calls are logged. Zero-upload days stay at zero.</p>
      <p class="form-hint">On a phone, swipe the table sideways to compare all the columns.</p>
      <div style="overflow-x:auto;max-width:100%" tabindex="0" aria-label="Daily lead statistics; scroll horizontally for all columns">
        <table class="data-table" style="min-width:940px;width:100%;font-size:13px">
          <thead><tr>${['Upload date','Uploaded','Attempted so far','Reached so far','Never called','Called, not reached','First call ≤24h','First call ≤48h','Reached ≤48h','Uncalled >48h','Follow-ups due'].map(x=>`<th scope="col" style="white-space:normal">${x}</th>`).join('')}</tr></thead>
          <tbody>${data.days.slice().reverse().map(r=>`<tr><th scope="row" style="white-space:nowrap">${dayLabel(r.day)}</th>${counts.map(k=>`<td class="tnum">${r[k]}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      <details style="margin-top:14px"><summary style="cursor:pointer">What these numbers mean</summary><ul style="line-height:1.7;padding-left:20px">
        <li>Uploaded means a patient record was created by you on that IST date. Updating an existing record is not another upload.</li>
        <li>Attempted means a call was logged, even if unanswered. Reached means at least one connected call. Multiple calls still count as one patient.</li>
        <li>First call within 24 or 48 hours uses the first logged call after that record was uploaded. Reached within 48 hours uses the first connected call after upload. Imported history before upload does not create a positive timing result.</li>
        <li>Uncalled over 48 hours counts only records old enough for the full window and currently eligible for contact. A fresh record is not overdue.</li>
        <li>Follow-ups due means an outstanding follow-up or callback queue record scheduled by now, excluding completed, future, engagement holds, blocked or do-not-call work. The calling list separately applies its daily plan and call cooldowns, so this is not a caller's quota.</li>
        <li>All-time totals include your full upload history, including archived records. Waiting-over-48h and due follow-ups include only currently contactable patients.</li>
      </ul></details>
    </div>`;
}

export async function renderIntakeDashboard(container,{sb=getSupabase(),mountNotices=()=>Promise.resolve()}={}) {
  const owner=getCurrentUser()?.id,profile=getCurrentProfile()?.id;
  if (!container?.isConnected || !owner || !profile || !['ground_poc','uploader'].includes(getUserRole())) return;
  let sequence=0;
  container.innerHTML=`<div class="dash"><div class="greet"><div><h1>Your intake dashboard</h1><p>Your uploads and the team's contact progress, with daily totals in India time.</p></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0">
      <a class="btn btn-primary" href="#upload">Upload leads</a><a class="btn btn-secondary" href="#upload?mode=existing">Update existing patient</a><a class="btn btn-secondary" href="#intake">Full intake report</a><a class="btn btn-ghost" href="#profile">Profile</a>
    </div><div id="care-notifications"></div><div id="saturday-card"></div><div id="resource-replies"></div><div id="docs-waiting-card"></div>
    <section aria-label="Your daily intake statistics"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <label for="intake-stats-days">Daily history</label><select class="form-select" id="intake-stats-days" style="width:auto"><option value="7">Last 7 days</option><option value="14" selected>Last 14 days</option><option value="30">Last 30 days</option></select>
      <button class="btn btn-secondary btn-sm" type="button" data-intake-refresh>Refresh statistics</button>
    </div><div data-intake-stats aria-live="polite"></div></section></div>`;
  const host=container.querySelector('[data-intake-stats]'),select=container.querySelector('#intake-stats-days');
  const active=()=>container.isConnected&&container.querySelector('[data-intake-stats]')===host&&getCurrentUser()?.id===owner&&getCurrentProfile()?.id===profile&&['ground_poc','uploader'].includes(getUserRole());
  const load=async()=>{
    if (!active()) return;
    const mine=++sequence,days=Number(select.value),current=()=>active()&&sequence===mine&&Number(select.value)===days;
    if (![7,14,30].includes(days)) return;
    host.setAttribute('aria-busy','true');host.innerHTML='<p role="status">Loading your intake statistics...</p>';
    try {
      const {data,error}=await sb.rpc('get_intake_daily_stats',{p_uploader:profile,p_days:days});
      if (!current()) return;
      if (error) throw error;
      host.innerHTML=intakeStatsHTML(validateIntakeStats(data,days));
    } catch {
      if (!current()) return;
      host.innerHTML='<div class="card" role="alert"><h3>Statistics could not load</h3><p>Your work is not marked finished and no counts have been guessed. Check your connection and try again.</p><button type="button" class="btn btn-secondary" data-intake-retry>Try again</button></div>';
      host.querySelector('[data-intake-retry]')?.addEventListener('click',load,{once:true});
    } finally {if(current())host.setAttribute('aria-busy','false');}
  };
  select.addEventListener('change',load);container.querySelector('[data-intake-refresh]').addEventListener('click',load);
  await Promise.all([load(),Promise.resolve().then(()=>active()?mountNotices():undefined)]);
}
