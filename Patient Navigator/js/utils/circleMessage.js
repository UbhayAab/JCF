export const CIRCLE_FIELDS = {
  first_name: 'First name', session_title: 'Session title', session_date: 'Session date',
  session_time: 'Session time', joining_link: 'Joining link',
};
export const DEFAULT_CIRCLE_BODY = `Hello 🙏

You're invited to our {session_title} for relatives of cancer patients.

📅 {session_date}
⏰ {session_time}
🔗 {joining_link}

This is a space to share your experiences and listen to others who are going through a similar journey. Sometimes speaking and being heard makes all the difference. We hope to see you there. 🌿

Reply STOP to stop these messages.`;
export const CIRCLE_EXAMPLES = {
  first_name: 'Asha', session_title: 'Caregiver Therapy Session',
  session_date: 'Saturday, 17 October', session_time: '11:30 AM', joining_link: 'https://meet.google.com/tdh-mhqn-ehh',
};

// datetime-local is a wall clock, not the device timezone. PN schedules use IST.
export function indiaISO(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const d = new Date(value + ':00+05:30');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function indiaInput(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0,16);
}
export const circlePreview = (body, examples) => String(body).replace(/\{([a-z_]+)\}/g,(m,k) => examples[k] || m);
