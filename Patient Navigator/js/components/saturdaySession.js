// Public schedule only. No patient data, notifications or message sends.
const GATEWAY = 'https://jcf-voice.pages.dev';
const mounted = new WeakMap();
const dateFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata',
});
const timeFormat = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
});

export function formatSessionWindow(session) {
  return `${dateFormat.format(session.startsAt)}, ${timeFormat.format(session.startsAt)} to ${timeFormat.format(session.endsAt)} IST`;
}

function validSession(session) {
  return session && [session.startsAt, session.endsAt].every(Number.isFinite)
    && session.endsAt > session.startsAt && ['weekly', 'extra'].includes(session.kind)
    && typeof session.label === 'string' && session.label.trim().length > 0;
}

export function sessionCardState(state) {
  if (!validSession(state) || !Number.isFinite(state.now)
      || !['before', 'open', 'after'].includes(state.state)) throw new Error('Invalid schedule');
  // Joining is a server-clock window, not a claim that a host has started a call.
  const open = state.state === 'open' && state.now >= state.startsAt && state.now < state.endsAt;
  if (state.endsAt <= state.now) throw new Error('Expired schedule');
  const otherSessions = (Array.isArray(state.sessions) ? state.sessions : [])
    .filter(session => validSession(session) && session.endsAt > state.now
      && !(session.id && state.id ? session.id === state.id
        : session.startsAt === state.startsAt && session.kind === state.kind))
    .sort((a, b) => a.startsAt - b.startsAt);
  return {
    label: state.label,
    when: formatSessionWindow(state),
    open,
    detail: open
      ? `Joining is open until ${timeFormat.format(state.endsAt)} IST. The host must sign in first.`
      : `Joining opens at ${timeFormat.format(state.startsAt)} IST on ${dateFormat.format(state.startsAt)}.`,
    reminder: !open && state.startsAt - state.now <= 24 * 60 * 60_000,
    otherSessions: otherSessions.slice(0, 3).map(session => `${session.label}: ${formatSessionWindow(session)}`),
    moreSessions: otherSessions.length > 3,
  };
}

export function mountSaturdaySession(mount) {
  if (!mount?.isConnected) return () => {};
  mounted.get(mount)?.();
  let disposed = false;
  let pending;
  const card = document.createElement('section');
  card.className = 'card saturday-session-card';
  card.setAttribute('aria-label', 'Saturday wellbeing session');
  Object.assign(card.style, { padding: '16px', display: 'grid', gap: '10px', minWidth: '0', overflowWrap: 'anywhere' });
  const title = document.createElement('strong');
  title.textContent = 'Saturday wellbeing';
  const label = document.createElement('div');
  label.className = 'badge badge-neutral';
  Object.assign(label.style, { justifySelf: 'start', display: 'none', whiteSpace: 'normal', maxWidth: '100%' });
  const when = document.createElement('div');
  const detail = document.createElement('p');
  detail.setAttribute('role', 'status');
  detail.style.margin = '0';
  const reminder = document.createElement('p');
  reminder.style.margin = '0';
  reminder.hidden = true;
  reminder.textContent = 'Staff reminder: the host signs in first. Check sound with a colleague before families join.';
  const others = document.createElement('div');
  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' });
  function anchor(text, path, className) {
    const link = document.createElement('a');
    link.textContent = text;
    link.href = `${GATEWAY}${path}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (className) link.className = className;
    return link;
  }
  const link = anchor('Open session page', '', 'btn btn-primary');
  actions.append(link, anchor('Moderator guide', '/moderator.html'), anchor('Manage extra sessions', '/team.html'));
  const note = document.createElement('small');
  note.textContent = 'Weekly session: Saturday, 11 AM to 12 PM IST. Camera starts off. Please do not record. Patient reminders are off.';
  card.append(title, label, when, detail, reminder, others, actions, note);
  mount.replaceChildren(card);

  function fallback() {
    label.style.display = 'none';
    when.textContent = 'Every Saturday, 11 AM to 12 PM IST';
    detail.textContent = 'The session status could not load. Open the session page to check the next session and any extra sessions.';
    reminder.hidden = true;
    others.replaceChildren();
    link.textContent = 'Open session page';
    link.href = GATEWAY;
  }
  fallback();
  detail.textContent = 'Checking the next session and any extra sessions...';

  function alive() {
    if (disposed) return false;
    if (!mount.isConnected || !card.isConnected) { dispose(); return false; }
    return true;
  }
  async function refresh() {
    if (!alive() || document.visibilityState === 'hidden') return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${GATEWAY}/api/state`, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('Schedule unavailable');
      const view = sessionCardState(await response.json());
      if (!alive() || pending !== controller) return;
      label.textContent = view.label;
      label.style.display = 'inline-flex';
      when.textContent = view.when;
      detail.textContent = view.detail;
      reminder.hidden = !view.reminder;
      others.replaceChildren();
      if (view.otherSessions.length) {
        const heading = document.createElement('small');
        heading.textContent = 'Also scheduled';
        const list = document.createElement('ul');
        Object.assign(list.style, { margin: '4px 0 0', paddingLeft: '20px' });
        for (const text of view.otherSessions) {
          const item = document.createElement('li');
          item.textContent = text;
          list.append(item);
        }
        others.append(heading, list);
        if (view.moreSessions) others.append(anchor('Check session page', ''));
      }
      link.textContent = view.open ? 'Join session' : 'Open session page';
      link.href = `${GATEWAY}${view.open ? '/join' : ''}`;
    } catch {
      if (alive() && pending === controller) fallback();
    } finally {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
    }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
  const interval = setInterval(refresh, 60_000);
  const observer = new MutationObserver(alive);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('hashchange', dispose);
  mounted.set(mount, dispose);
  refresh();
  function dispose() {
    if (disposed) return;
    disposed = true;
    pending?.abort();
    clearInterval(interval);
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('hashchange', dispose);
    if (mounted.get(mount) === dispose) mounted.delete(mount);
  }
  return dispose;
}
