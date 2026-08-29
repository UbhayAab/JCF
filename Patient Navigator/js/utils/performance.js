// ============================================================
// Patient Navigator: ONE definition of caregiver-mentor performance
//
// The Leaderboard scored mentors with a blend of reach, connect rate,
// probing depth and impact. Team & Queue listed the same people in
// whatever order the RPC happened to return them. Two pages, two answers
// to "who is doing well", and only one of them was defensible.
//
// The formula lives here so both pages import it. If it is ever tuned,
// it is tuned once, and the Leaderboard cannot quietly disagree with the
// team roster the way the queue counters once disagreed with the queue.
//
// Normalised against the cohort being scored, deliberately: this answers
// "who is carrying the work THIS window", not "who cleared an absolute
// bar". A mentor is compared with the peers on screen beside her.
// ============================================================

export const MVP_WEIGHTS = [
  ['calls',        0.25, 'reach: how many families were dialled'],
  ['connect_rate', 0.15, 'how often a dial became a real conversation'],
  ['depth_score',  0.30, 'probing depth: notes written, asks and condition captured'],
  ['assessments',  0.15, 'wellbeing scores actually recorded'],
  ['services',     0.15, 'support levers actually delivered'],
];

const num = (v) => (v == null ? 0 : +v || 0);

// Returns a NEW array; never mutates the caller's rows.
// Each row gains `mvp` (0 to 100, rounded).
export function withMvp(rows) {
  const list = (rows || []).map(r => ({
    ...r,
    calls: num(r.calls),
    connected: num(r.connected),
    connect_rate: num(r.connect_rate),
    calls_per_day: num(r.calls_per_day),
    depth_score: num(r.depth_score),
    notes_rate: num(r.notes_rate),
    reqs_rate: num(r.reqs_rate),
    cond_rate: num(r.cond_rate),
    assessments: num(r.assessments),
    services: num(r.services),
    wa_joins: num(r.wa_joins),
    avg_duration: r.avg_duration == null ? null : +r.avg_duration,
  }));
  // Max of 1 as the floor, so a cohort where nobody logged anything scores
  // zero instead of dividing by zero and rendering NaN.
  const max = (k) => Math.max(1, ...list.map(r => r[k] || 0));
  const mx = Object.fromEntries(MVP_WEIGHTS.map(([k]) => [k, max(k)]));
  list.forEach(r => {
    r.mvp = Math.round(100 * MVP_WEIGHTS.reduce((s, [k, w]) => s + w * (r[k] / mx[k]), 0));
  });
  return list;
}

// A short, honest label for a score, so a card can say something a manager
// can act on rather than only showing a number out of context.
export function mvpBand(mvp, cohortMedian) {
  if (mvp >= Math.max(70, cohortMedian * 1.25)) return { label: 'Leading', tone: 'ok' };
  if (mvp >= cohortMedian) return { label: 'On pace', tone: 'info' };
  if (mvp > 0) return { label: 'Below pace', tone: 'warn' };
  return { label: 'Nothing logged', tone: 'danger' };
}

export function median(values) {
  const v = (values || []).filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}
