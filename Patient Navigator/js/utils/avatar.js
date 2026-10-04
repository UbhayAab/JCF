// ============================================================
// Patient Navigator: ONE avatar palette
//
// The same six-colour array was pasted into eight files (sidebar,
// admin, calling, dashboard, leaderboard, nutrition, patients, team),
// so a colour change meant eight edits and any missed file drifted.
// Three copies had survived the first clean-up (admin.js, team.js and the
// patient record in patients.js); v11 points them here too.
//
// It also carried the only contrast failure left in the whole product
// after the theme rebuild: white initials on #B0702A measured 4.04:1,
// which is under the 4.5:1 floor, and it failed identically in all
// three themes because the hex never came from a token.
//
// v11 (Oct 2026): the redesign's avatars are pastel discs with cocoa
// initials ("JW", "SJ" in the mockups). The entries are CSS variables, not
// hexes, so the disc follows the theme and its label (--av-ink, set on
// .avatar in components.css) follows with it: each pair is solved in
// css/variables.css for all three themes. They still only ever land in a
// style="background:..." attribute, where var() works.
// ============================================================

export const AVATAR_COLORS = [
  'var(--av-1)', // rose
  'var(--av-2)', // beige
  'var(--av-3)', // lavender pink
  'var(--av-4)', // blue
  'var(--av-5)', // mint
  'var(--av-6)', // amber
];

// Stable per name: the same person is always the same colour, on every
// screen, across reloads. Hash first, then index; never random.
export function avatarColor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initials(name) {
  return name
    ? String(name).trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : '?';
}
