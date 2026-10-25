// Short, static help for tabs opened during training. No data or action access.
export const TAB_GUIDES = Object.freeze([
  { route: 'patients', label: 'Patients', what: 'Read the family record before a call and keep agreed details current.', steps: [
    'Search the families available to you. During training, your manager assigns the families you can open.',
    'Open a record to review its notes, call history and care needs before changing anything.',
    'Record only what the family confirmed. A tab opening does not give access to other families.',
  ] },
  { route: 'calls', label: 'Call Logs', what: 'Review the calls you saved and the context for the next conversation.', steps: [
    'Find the saved call by date or family, then read its outcome and notes.',
    'An unanswered attempt is still a call log. Training progress counts answered conversations only.',
    'Open the linked family record when you need the wider history.',
  ] },
  { route: 'resources', label: 'Resources', what: 'Find practical support to discuss with a family: services, places and schemes.', steps: [
    'Choose the kind of help and the relevant location, then read the resource details.',
    'Check the contact, eligibility and current availability before recommending a service.',
    'Discuss suitable options with the family; a listing does not guarantee support.',
  ] },
  { route: 'brief', label: 'This morning', what: 'See the work and follow-ups that need your attention today.', steps: [
    'Read the brief, then open the relevant family or task for its full context.',
    'Use the Calling Portal to log a conversation; reading the brief does not complete a task.',
  ] },
  { route: 'sessions', label: '1:1 Sessions', what: 'Review care sessions and the next steps agreed with the family.', steps: [
    'Open the session you are supporting and check its date, owner and current state.',
    'Record the actual outcome after the session. A scheduled session is not proof that it happened.',
    'Only the sessions and families your care access permits are available.',
  ] },
  { route: 'concerns', label: 'Flags & concerns', what: 'Raise a concern for the team and follow its review.', steps: [
    'Read the family context and describe what was heard, without guessing a diagnosis.',
    'Choose the appropriate concern and follow its review state here.',
    'For urgent concerns, contact your supervisor directly as well as recording the flag.',
  ] },
  { route: 'leads', label: 'WhatsApp leads', what: 'Follow up the help requests that families made through HopeBot.', steps: [
    'Read the request, assigned caller and due time before contacting the family.',
    'Log the real call outcome. Reached, no answer and callback have different effects on the request.',
    'Respect contact restrictions and safety holds; opening the tab does not send a message.',
  ] },
  { route: 'referrals', label: 'Form referrals', what: 'Review incoming referral forms and their first-contact needs.', steps: [
    'Read the submitted answers and check the linked family record before following up.',
    'Log the actual call through the Calling Portal. Reading a form does not mark a family reached.',
  ] },
  { route: 'doccollect', label: 'Document collection', what: 'Follow up families who are ready to share their papers.', steps: [
    'Check the assigned caller, due time and collection history.',
    'Record the call outcome and agreed next step; no answer is different from papers received.',
    'Use the family document workflow and its permission checks for any invitation or upload.',
  ] },
]);

const byRoute = new Map(TAB_GUIDES.map(guide => [guide.route, guide]));
export const tabGuide = route => byRoute.get(route) || null;
export const guideHref = route => tabGuide(route) ? `#learn?tab=${route}` : null;

export function guideFromHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#learn?')) return null;
  const query = new URLSearchParams(hash.slice('#learn?'.length));
  if (query.getAll('tab').length !== 1 || [...query.keys()].some(key => key !== 'tab')) return null;
  return tabGuide(query.get('tab'));
}
