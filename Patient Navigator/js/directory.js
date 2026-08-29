// ============================================================
// Patient Navigator - public help directory (no login)
//
// v2. The page no longer reads a table. Everything goes through two
// RPCs (sql/75_directory_hardening.sql):
//
//   search_directory()      12 rows a page, max 20 pages, and NO contact
//                           details in the list at all.
//   get_directory_contact() one listing's phone/WhatsApp/address, logged
//                           and throttled per session token.
//
// Why: with direct table access, one unauthenticated request returned all
// 617 listings and 559 phone numbers. The 60-row cap that used to live on
// line 17 of this file was client-side and protected nothing.
//
// It also changes what a family sees. Before, the page loaded every card
// before anyone had said a word - the "oh, so many things" wall. Now
// nothing appears until you have said what kind of help you need, and a
// card opens up only when you ask it to. Fewer things, in the right
// order, is the whole design.
//
// Every filter still lives in the query string, so any view is a
// shareable link:
//   directory.html?c=accommodation&state=Maharashtra&track=A
// ============================================================

import { CONFIG } from './config.js';

// Public-facing wording. Patients never see "Track A" or "financial_aid".
const CATEGORIES = [
  { key: 'accommodation', label: 'A place to stay',   hint: 'near the hospital', icon: 'home' },
  { key: 'financial_aid', label: 'Help with money',   hint: 'schemes and grants', icon: 'shield' },
  { key: 'clinical',      label: 'Doctors & hospitals', hint: 'cancer specialists', icon: 'stethoscope' },
  { key: 'food',          label: 'Food & meals',      hint: 'free kitchens', icon: 'leaf' },
  { key: 'travel',        label: 'Getting there',     hint: 'travel help', icon: 'route' },
  { key: 'medicines',     label: 'Medicines',         hint: 'free or subsidised', icon: 'pill' },
  { key: 'counselling',   label: 'Someone to talk to', hint: 'free counselling', icon: 'heart' },
  { key: 'nutrition',     label: 'Diet guidance',     hint: 'eating through treatment', icon: 'leaf' },
  { key: 'caregiver',     label: 'For the caregiver', hint: 'support for you', icon: 'users' },
  { key: 'community',     label: 'Others like you',   hint: 'patient groups', icon: 'users' },
  { key: 'palliative',    label: 'Comfort care',      hint: 'pain and home care', icon: 'heart' },
  { key: 'trials',        label: 'Clinical trials',   hint: 'newer treatments', icon: 'flask' },
  { key: 'other',         label: 'Other help',        hint: '', icon: 'star' },
];

// The three tracks, said the way a family would say them.
const TRACKS = [
  { key: 'A', title: 'We need free or very low-cost help',
    body: 'Little or no insurance, and travelling a long way for treatment. We will show free stays, government schemes and NGOs first.' },
  { key: 'B', title: 'We can manage some of it',
    body: 'Part insurance or some savings, or family close by. A mix of free help and affordable options.' },
  { key: 'C', title: 'We mainly need the right people',
    body: 'Cost is not the main worry. Straight to specialists, hospitals and support groups.' },
];

const ICONS = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5Z"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3Z"/><polyline points="9 12 11 14 15 10"/>',
  stethoscope: '<path d="M6 3v5a4 4 0 0 0 8 0V3"/><path d="M10 12v3a5 5 0 0 0 10 0v-1"/><circle cx="20" cy="10" r="2"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 4 13c0-6 8-9 16-9 0 8-3 16-9 16Z"/><path d="M4 20c3-4 6-6 10-8"/>',
  route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h1"/>',
  pill: '<rect x="2" y="8" width="20" height="8" rx="4"/><line x1="12" y1="8" x2="12" y2="16"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6L5 19a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-10V3"/>',
  star: '<polygon points="12 2 15 9 22 9.5 17 14 18.5 21 12 17.5 5.5 21 7 14 2 9.5 9 9"/>',
};
const svg = (n) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ICONS.star}</svg>`;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const digits = (p) => String(p || '').replace(/[^\d+]/g, '');
const $ = (id) => document.getElementById(id);

let sb = null;
let state = { c: '', state: '', city: '', track: '', q: '' };
let cities = [];
let page = 1;            // which page we have loaded up to
let loaded = [];         // rows accumulated across "show more"
let lastMeta = null;     // {total, has_more, capped, needs_filter}
let busy = false;

// A random id kept in this browser. Not an identity and not trusted - it
// is what makes harvesting every number cost 559 logged calls instead of
// one, and it is what the throttle counts.
function sessionToken() {
  try {
    let t = localStorage.getItem('dir_tok');
    if (!t) {
      t = (crypto.randomUUID && crypto.randomUUID()) ||
          String(Math.random()).slice(2) + String(Math.random()).slice(2);
      localStorage.setItem('dir_tok', t);
    }
    return t;
  } catch { return 'no-storage'; }
}

const hasFilter = () => Boolean(state.c || state.state || state.city || state.q);

// ---- the URL is the state, so every view is a link worth sending ----
function readUrl() {
  const p = new URLSearchParams(location.search);
  state = {
    c: p.get('c') || '',
    state: p.get('state') || '',
    city: p.get('city') || '',
    track: (p.get('track') || '').toUpperCase(),
    q: p.get('q') || '',
  };
  if (!['A', 'B', 'C'].includes(state.track)) state.track = '';
}
function writeUrl() {
  const p = new URLSearchParams();
  Object.entries(state).forEach(([k, v]) => { if (v) p.set(k, v); });
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 2600);
}

// ---- render the choosers ----
function renderCats(counts) {
  $('cats').innerHTML = CATEGORIES
    .filter(c => counts[c.key] || state.c === c.key)
    .map(c => `
      <button type="button" class="dir-cat${state.c === c.key ? ' on' : ''}" data-cat="${c.key}">
        <span class="dir-cat-ico">${svg(c.icon)}</span>
        <span class="dir-cat-tx"><b>${esc(c.label)}</b>
        <span class="dir-cat-n">${counts[c.key] || 0} listed${c.hint ? ' &middot; ' + esc(c.hint) : ''}</span></span>
      </button>`).join('');
  $('cats').querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    state.c = state.c === b.dataset.cat ? '' : b.dataset.cat;
    apply();
  }));
}

function renderTracks() {
  $('tracks').innerHTML = TRACKS.map(t => `
    <button type="button" class="dir-track${state.track === t.key ? ' on' : ''}" data-track="${t.key}">
      <b>${esc(t.title)}</b><span>${esc(t.body)}</span>
    </button>`).join('');
  $('tracks').querySelectorAll('[data-track]').forEach(b => b.addEventListener('click', () => {
    state.track = state.track === b.dataset.track ? '' : b.dataset.track;
    apply();
  }));
}

function renderCityOptions() {
  const list = cities.filter(c => !state.state || c.state === state.state);
  $('f-city').innerHTML = '<option value="">Any city</option>' +
    list.map(c => `<option value="${esc(c.key)}"${state.city === c.key ? ' selected' : ''}>${esc(c.key)} (${c.n})</option>`).join('');
  if (state.city && !list.some(c => c.key === state.city)) $('f-city').value = '';
}

// ---- cards ----
const COST_LABEL = { free: 'Free', subsidised: 'Subsidised', paid: 'Paid', unknown: '' };

// How fresh is this listing? A family cannot tell a checked-last-month
// entry from a three-year-old one, and schemes close. verified_on was
// stored and never shown; now it is on the card.
function freshness(r) {
  if (!r.verified_on) return '<span class="dir-fresh unk">Not checked recently</span>';
  const days = Math.floor((Date.now() - new Date(r.verified_on).getTime()) / 86400000);
  if (days <= 120) return '<span class="dir-fresh ok">Checked recently</span>';
  if (days <= 400) return '<span class="dir-fresh mid">Checked this year</span>';
  return '<span class="dir-fresh old">Not checked in a while</span>';
}

function card(r) {
  const place = [r.city, r.state].filter(Boolean).join(', ');
  const price = r.cost === 'paid' && r.price_from ? `from &#8377;${Number(r.price_from).toLocaleString('en-IN')}` : '';
  const tag = COST_LABEL[r.cost] ? `<span class="dir-tag ${r.cost}">${COST_LABEL[r.cost]}${price ? ' &middot; ' + price : ''}</span>` : '';
  const meta = [r.languages, r.hours].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
  return `
    <article class="dir-card" data-id="${esc(r.id)}">
      <div class="dir-card-top"><h3>${esc(r.title)}</h3>${tag}</div>
      ${place ? `<div class="dir-where">${esc(place)}${r.area ? ' &middot; ' + esc(r.area) : ''}</div>` : ''}
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
      <div class="dir-card-meta">${freshness(r)}${meta}</div>
      <div class="dir-more" hidden></div>
      <div class="dir-actions">
        <button type="button" class="dir-act open" data-open="${esc(r.id)}">
          ${r.has_contact ? 'See details &amp; phone number' : 'See details'}
        </button>
        ${r.link ? `<a class="dir-act" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">Website</a>` : ''}
      </div>
    </article>`;
}

// Opening one card is the second step of the journey: the steps to apply
// and the phone number arrive only when a family asks for this one.
async function openCard(id, btn) {
  const art = document.querySelector(`.dir-card[data-id="${CSS.escape(id)}"]`);
  if (!art) return;
  const box = art.querySelector('.dir-more');
  if (!box.hidden) { box.hidden = true; btn.textContent = 'See details'; return; }

  const r = loaded.find(x => String(x.id) === String(id));
  btn.disabled = true; btn.textContent = 'Opening…';

  let contact = {};
  if (r && r.has_contact) {
    const { data, error } = await sb.rpc('get_directory_contact', { p_id: id, p_token: sessionToken() });
    if (error) {
      btn.disabled = false; btn.textContent = 'See details & phone number';
      toast(/short time|little while/i.test(error.message || '')
        ? 'You have opened a lot of listings quickly. Please wait a few minutes.'
        : 'Could not load the contact details. Please try again.');
      return;
    }
    contact = data || {};
  }

  const phone = digits(contact.contact_phone);
  const wa = digits(contact.whatsapp || '');
  const maps = contact.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(contact.address)}` : '';
  const blocks = [
    r.eligibility      && ['Who can get this', r.eligibility],
    r.how_to_apply     && ['How to apply', r.how_to_apply],
    r.documents_needed && ['Papers to carry', r.documents_needed],
    r.who_to_ask       && ['Ask for', r.who_to_ask],
    contact.address    && ['Address', contact.address],
  ].filter(Boolean);

  box.innerHTML = `
    ${blocks.map(([h, b]) => `<div class="dir-block"><div class="dir-block-h">${esc(h)}</div><p>${esc(b)}</p></div>`).join('')}
    ${blocks.length ? '' : '<div class="dir-block"><p>We do not have the application steps for this one yet. Please call and ask.</p></div>'}
    <div class="dir-actions">
      ${phone ? `<a class="dir-act call" href="tel:${esc(phone)}">Call ${esc(contact.contact_phone)}</a>` : ''}
      ${wa ? `<a class="dir-act wa" href="https://wa.me/${esc(wa.replace(/^\+/, ''))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      ${contact.email ? `<a class="dir-act" href="mailto:${esc(contact.email)}">Email</a>` : ''}
      ${maps ? `<a class="dir-act" href="${esc(maps)}" target="_blank" rel="noopener noreferrer">Directions</a>` : ''}
    </div>`;
  box.hidden = false;
  btn.disabled = false; btn.textContent = 'Hide details';
}

// ---- the "that did not work, try the next thing" panel ----
// A family who has read everything we have should never hit a dead end
// with nothing to do next.
function exhausted() {
  const next = [];
  if (state.city)  next.push(`<button type="button" class="dir-next" data-drop="city">Look across all of ${esc(state.state || 'the state')} instead</button>`);
  if (state.state) next.push('<button type="button" class="dir-next" data-drop="state">Look anywhere in India</button>');
  if (state.track) next.push('<button type="button" class="dir-next" data-drop="track">Show every price, not just my budget</button>');
  if (state.q)     next.push('<button type="button" class="dir-next" data-drop="q">Clear the search words</button>');
  if (state.c)     next.push('<button type="button" class="dir-next" data-drop="c">Try a different kind of help</button>');
  return `
    <div class="dir-endcap">
      <b>That is everything we have for this.</b>
      <p>If none of it worked, widen the search - most families find something two or three tries in.</p>
      ${next.length ? `<div class="dir-nexts">${next.join('')}</div>` : ''}
      <p class="dir-fine">Still stuck? Tell the person who sent you this link. We add to this list every week.</p>
    </div>`;
}

function wireResults() {
  $('results').querySelectorAll('[data-open]').forEach(b =>
    b.addEventListener('click', () => openCard(b.dataset.open, b)));
  $('results').querySelectorAll('[data-drop]').forEach(b =>
    b.addEventListener('click', () => { state[b.dataset.drop] = ''; apply(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  const more = $('more-btn');
  if (more) more.addEventListener('click', () => { page += 1; load(true); });
}

// ---- query ----
async function load(append) {
  if (busy) return;
  busy = true;
  if (!append) { loaded = []; page = 1; $('results').innerHTML = Array(4).fill('<div class="dir-sk"></div>').join(''); }

  const { data, error } = await sb.rpc('search_directory', {
    p_category: state.c || null,
    p_state: state.state || null,
    p_city: state.city || null,
    p_track: state.track || null,
    p_q: state.q || null,
    p_page: page,
  });
  busy = false;

  if (error) {
    $('results').innerHTML = `<div class="dir-empty"><b>We could not load the list just now</b>
      Please check your internet and refresh. If it keeps happening, call the person who sent you this link.</div>`;
    $('count').textContent = '';
    return;
  }

  lastMeta = data || {};
  const rows = lastMeta.rows || [];
  loaded = append ? loaded.concat(rows) : rows;
  render();
}

function render() {
  const m = lastMeta || {};

  // Step one of the journey: nothing at all until they have chosen.
  if (m.needs_filter) {
    $('count').textContent = '';
    $('results').innerHTML = `
      <div class="dir-invite">
        <b>Start with what you need most right now.</b>
        <p>Pick one above - a place to stay, help with money, someone to talk to. We will only show you that, and only the ones near you.</p>
        <p class="dir-fine">Nothing to fill in, no sign-up, and we never ask for your phone number.</p>
      </div>`;
    $('clear-btn').hidden = true;
    return;
  }

  const total = m.total || 0;
  $('count').innerHTML = total
    ? `<b>${total}</b> ${total === 1 ? 'place' : 'places'} can help &middot; showing ${loaded.length}`
    : 'Nothing matches those filters yet';

  if (!total) {
    $('results').innerHTML = `<div class="dir-empty"><b>Nothing here matches yet</b>
      Try removing the city, or choose a different kind of help.</div>` + exhausted();
    wireResults();
    return;
  }

  const more = m.has_more
    ? `<button type="button" class="dir-more-btn" id="more-btn">Show 12 more</button>`
    : exhausted();
  const capNote = m.capped && !m.has_more
    ? `<p class="dir-fine">This is a long list. Narrow it by city to see the rest.</p>` : '';

  $('results').innerHTML = loaded.map(card).join('') + more + capNote;
  wireResults();
}

async function apply() {
  writeUrl();
  renderTracks();
  $('f-state').value = state.state;
  renderCityOptions();
  if ($('f-q').value !== state.q) $('f-q').value = state.q;
  $('clear-btn').hidden = !Object.values(state).some(Boolean);
  document.body.classList.toggle('dir-picked', hasFilter());
  page = 1;
  await load(false);
}

function clearAll() { state = { c: '', state: '', city: '', track: '', q: '' }; renderCatsFromCache(); apply(); }

let facetCache = { categories: {} };
function renderCatsFromCache() { renderCats(facetCache.categories); }

async function init() {
  if (!window.supabase?.createClient) {
    $('results').innerHTML = `<div class="dir-empty"><b>This page could not start</b>
      Please refresh. If you are on a slow connection, give it a moment first.</div>`;
    return;
  }
  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  readUrl();

  const { data: facets } = await sb.rpc('get_directory_facets');
  const f = facets || {};
  facetCache.categories = Object.fromEntries((f.categories || []).map(c => [c.k, c.n]));
  cities = (f.cities || []).map(c => ({ key: c.k, state: c.st, n: c.n }));
  $('f-state').innerHTML = '<option value="">Anywhere in India</option>' +
    (f.states || []).map(s => `<option value="${esc(s.k)}"${state.state === s.k ? ' selected' : ''}>${esc(s.k)} (${s.n})</option>`).join('');

  renderCatsFromCache();
  renderTracks();

  $('f-state').addEventListener('change', (e) => { state.state = e.target.value; state.city = ''; apply(); });
  $('f-city').addEventListener('change', (e) => { state.city = e.target.value; apply(); });
  let t; $('f-q').addEventListener('input', (e) => {
    clearTimeout(t); const v = e.target.value;
    t = setTimeout(() => { state.q = v.trim(); apply(); }, 320);
  });
  $('clear-btn').addEventListener('click', clearAll);
  $('share-btn').addEventListener('click', async () => {
    const url = location.href;
    const share = { title: 'Help near you - Jarurat Care', text: 'Free and low-cost help for families facing cancer.', url };
    try {
      if (navigator.share) { await navigator.share(share); return; }
      await navigator.clipboard.writeText(url);
      toast('Link copied - paste it into WhatsApp');
    } catch { toast('Copy the link from your browser address bar'); }
  });

  await apply();

  // Opened from a shared link: someone already chose the filters for this
  // family, so put them on the results rather than making them scroll past
  // three questions they have effectively already answered.
  if (Object.values(state).some(Boolean)) {
    document.body.classList.add('dir-shared');
    $('bar').scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', init);
else init();
