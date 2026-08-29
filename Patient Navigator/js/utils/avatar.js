// ============================================================
// Patient Navigator: ONE avatar palette
//
// The same six-colour array was pasted into eight files (sidebar,
// admin, calling, dashboard, leaderboard, nutrition, patients, team),
// so a colour change meant eight edits and any missed file drifted.
//
// It also carried the only contrast failure left in the whole product
// after the theme rebuild: white initials on #B0702A measured 4.04:1,
// which is under the 4.5:1 floor, and it failed identically in all
// three themes because the hex never came from a token.
//
// These are rung 10 of the rebuilt chromatic ramps, the same rung the
// accents use. White initials clear 6.4:1 on every one of them, and the
// hues match the palette rather than sitting beside it.
// ============================================================

export const AVATAR_COLORS = [
  '#006469', // teal, the primary
  '#7A4C00', // amber
  '#5B4892', // violet
  '#295B86', // blue
  '#106841', // green
  '#953028', // red
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
