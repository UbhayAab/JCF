// ============================================================
// Patient Navigator: Learning Hub
// The training ground for the team: psychology interns learn to
// run warm, clinically sound calls; nutritionists find their
// playbook; everyone learns the instruments they administer.
// Static content: deliberately readable, not a database.
// ============================================================

import { icon } from '../components/icons.js';
import { STAGE_GUIDES, INSTRUMENTS, RECEPTIVENESS, MEASURES, BEREAVEMENT_MEASURES } from '../utils/catalog.js';
import { getCurrentProfile } from '../auth.js';

const MINDSET_GUIDE = [
  { key: 'Hopeful', cue: 'Forward-looking words, asks about options', respond: 'Feed the hope with concrete next steps, hope plus a plan.' },
  { key: 'Anxious', cue: 'Rapid speech, many what-ifs, circular questions', respond: 'Slow your own pace. Name it: “It makes sense to feel worried.” One thing at a time.' },
  { key: 'Resistant', cue: 'Short answers, “we’re fine”, wants to hang up', respond: 'Don’t push. Leave one warm door open and a promise to check in later.' },
  { key: 'Distressed', cue: 'Crying, despair, talk of giving up', respond: 'Stay on the line. Listen first, fix nothing yet. Escalate to your supervisor the same day.' },
  { key: 'Informed', cue: 'Knows the protocol names, asks precise questions', respond: 'Match their level. Offer second-opinion and trial-matching support.' },
  { key: 'Grateful', cue: 'Thanks you repeatedly', respond: 'Receive it, then gently deepen: gratitude moments are when people accept more help.' },
];

const RED_FLAGS = [
  ['Talk of self-harm, “ending it”, or feeling like a burden', 'Stay calm and on the call. Tell your supervisor IMMEDIATELY after (same hour). Never carry this alone.'],
  ['Severe untreated pain mentioned', 'Note it, encourage contacting the treating team today, flag to supervisor.'],
  ['Patient stopped treatment because of money', 'Mark “financial aid” requirement + raise it the same day. This is our core rescue case.'],
  ['Caregiver sounding burnt out or unwell', 'Offer a caregiver well-being session; record a PHQ-4 (caregiver) when natural.'],
  ['Family hiding the diagnosis from the patient', 'Respect it on-call; discuss in supervision. Never force disclosure.'],
];

function section(id, title, iconName, bodyHTML, subtitle = '') {
  return `
    <div class="card" id="learn-${id}" style="margin-bottom:var(--s5)">
      <div class="fsec" style="margin-top:0"><span class="fsec-ico">${icon(iconName)}</span>
        <div><h4>${title}</h4>${subtitle ? `<div class="fsec-sub">${subtitle}</div>` : ''}</div></div>
      ${bodyHTML}
    </div>`;
}

export async function renderLearn(container) {
  const me = getCurrentProfile();
  const first = me?.full_name?.split(' ')[0] || 'there';

  const stagesHTML = STAGE_GUIDES.map(g => `
    <div class="lever-row" style="display:block;border-left:3px solid var(--${g.tone === 'clay' ? 'clay' : g.tone === 'info' ? 'info' : 'ok'});padding:14px 16px">
      <div style="font:var(--t-body-strong);margin-bottom:4px">${g.title}</div>
      <p style="font:var(--t-sm);color:var(--ink-2);margin:0 0 10px">${g.what}</p>
      <div class="lever-group-title">Things you can actually say</div>
      ${g.openers.map(o => `<p style="font:var(--t-sm);color:var(--ink-2);margin:4px 0;padding-left:12px;border-left:2px solid var(--line-2);font-style:italic">${o}</p>`).join('')}
      <p style="font:var(--t-xs);color:var(--clay);margin:10px 0 0"><strong>Avoid:</strong> ${g.avoid}</p>
    </div>`).join('');

  const recepHTML = `
    <div class="kv">${RECEPTIVENESS.map(r => `
      <div><div class="k">${r.label}</div><div class="v" style="font-weight:500;font-size:13.5px">${r.hint}.<br><span style="color:var(--ink-3);font-size:12px">Next check-in ≈ ${r.days} days</span></div></div>`).join('')}
    </div>
    <p style="font:var(--t-xs);color:var(--ink-3);margin-top:10px">Your receptiveness read sets the follow-up rhythm automatically. Read honestly, not optimistically.</p>`;

  const mindsetHTML = `
    <div class="table-wrap"><table class="data"><thead><tr><th>Mindset</th><th>You will hear</th><th>How to respond</th></tr></thead>
      <tbody>${MINDSET_GUIDE.map(m => `<tr><td><strong>${m.key}</strong></td><td style="color:var(--ink-2)">${m.cue}</td><td style="color:var(--ink-2)">${m.respond}</td></tr>`).join('')}</tbody>
    </table></div>`;

  const instrumentsHTML = Object.entries(INSTRUMENTS).map(([key, ins]) => {
    const meta = [...MEASURES, ...BEREAVEMENT_MEASURES].find(m => m.key === key);
    return `
    <div class="lever-row" style="display:block;padding:14px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <div style="font:var(--t-body-strong)">${meta?.label || key}</div>
        <span class="badge badge-primary">${meta ? `${meta.min}-${meta.max}` : ''} ${meta?.dir === 1 ? '· higher is better' : '· lower is better'}</span>
      </div>
      <p style="font:var(--t-sm);color:var(--ink-2);margin:6px 0 8px">${ins.intro}</p>
      <ol style="margin:0 0 8px 18px;font:var(--t-sm);color:var(--ink-2);display:flex;flex-direction:column;gap:8px">
        ${ins.items.map(item => {
          if (typeof item === 'string') return `<li>${item}</li>`;
          return `<li>
            <div>${item.q}</div>
            ${item.hindi ? `<div style="color:var(--ink-3);font-style:italic;margin-top:2px">${item.hindi}</div>` : ''}
            ${item.probe ? `<div style="font:var(--t-xs);color:var(--ink-3);margin-top:2px">${item.probe}</div>` : ''}
            ${item.options ? `<div style="font:var(--t-xs);color:var(--ink-3);margin-top:2px">${item.options.map(o => `${o[0]} = ${o[1]}`).join(' · ')}</div>` : ''}
          </li>`;
        }).join('')}
      </ol>
      ${ins.options ? `<p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 6px"><strong>Choices for every item:</strong> ${ins.options.map(o => `${o[0]} = ${o[1]}`).join(' · ')}</p>` : ''}
      <p style="font:var(--t-xs);color:var(--ink-3);margin:0"><strong>Scoring:</strong> ${ins.interpret}</p>
    </div>`;
  }).join('') + `
    <div class="lever-row" style="display:block;padding:14px 16px">
      <div style="font:var(--t-body-strong)">Single-score measures</div>
      <p style="font:var(--t-sm);color:var(--ink-2);margin:6px 0 0">
        Quality of life (physical / emotional, 0-10), financial toxicity (0-10, “how much is the cost of care hurting your family?”),
        MUST malnutrition risk (0-6: weight loss + eating ability; ask the nutritionist if unsure), patient activation and caregiver
        confidence (1-5 self-ratings). Record the first entry as the <strong>baseline</strong>; every later entry shows the change we made.
      </p>
    </div>`;

  const redflagHTML = `
    <div class="table-wrap"><table class="data"><thead><tr><th>If you hear…</th><th>Do this</th></tr></thead>
      <tbody>${RED_FLAGS.map(([a, b]) => `<tr><td style="color:var(--ink-2)">${a}</td><td style="color:var(--ink-2)">${b}</td></tr>`).join('')}</tbody></table></div>
    <p style="font:var(--t-xs);color:var(--danger);margin-top:10px"><strong>The rule:</strong> you are never expected to handle a crisis alone. Hearing it and escalating it IS doing your job perfectly.</p>`;

  const saturdayHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2);margin-bottom:10px">
      Every Saturday we run a group session in the patient WhatsApp groups: <strong>nutrition one week, emotional
      well-being the next</strong>, alternating. They are detailed, prepared sessions, not casual chats.</p>
    <div class="kv">
      <div><div class="k">Nutrition Saturdays</div><div class="v" style="font-weight:500;font-size:13.5px">Treatment-phase diets, managing side effects (nausea, mouth sores), affordable protein, stoma & feeding-tube nutrition. Led by the nutrition team.</div></div>
      <div><div class="k">Well-being Saturdays</div><div class="v" style="font-weight:500;font-size:13.5px">Anxiety tools, sleep, caregiver self-care, grief literacy, gentle Q&A. Led by the psychology team.</div></div>
      <div><div class="k">Before the session</div><div class="v" style="font-weight:500;font-size:13.5px">Invite your patients on calls during the week (“this Saturday in the group…”). Personal invitations triple attendance.</div></div>
      <div><div class="k">After the session</div><div class="v" style="font-weight:500;font-size:13.5px">Log it in Team → Saturday sessions (topic, attendance, notes) so impact shows in analytics.</div></div>
    </div>`;

  const ethosHTML = `
    <p style="font:var(--t-sm);color:var(--ink-2)">
      Jarurat Care is a <strong>free service</strong>. Nobody is ever sold anything, which means no call you make is a
      “sales call”, and no question you ask is for a pipeline. We call because families navigating cancer in India are
      overwhelmed, under-informed and often financially cornered. Your voice may be the only one that week that asked how
      they actually are.</p>
    <div class="kv" style="margin-top:10px">
      <div><div class="k">Your double mission</div><div class="v" style="font-weight:500;font-size:13.5px">Help this family, and become a better clinician with every call. Each conversation is supervised practice in rapport, assessment and psycho-oncology.</div></div>
      <div><div class="k">The data is care</div><div class="v" style="font-weight:500;font-size:13.5px">Everything you record (receptiveness, scores, requirements) decides what help reaches them next. Honest notes = better help.</div></div>
      <div><div class="k">Privacy (DPDPA)</div><div class="v" style="font-weight:500;font-size:13.5px">Consent before details. Never share patient information outside the platform. What they tell you stays here.</div></div>
    </div>`;

  const toc = [
    ['ethos', 'Why we call'], ['stages', 'The 3-call playbook'], ['reading', 'Reading the person'],
    ['instruments', 'The instruments'], ['redflags', 'Red flags'], ['saturday', 'Saturday circles'],
  ];

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Learning Hub</h1>
        <p class="header-subtitle" style="margin:4px 0 0">Hi ${first}, everything you need to run calls that genuinely help, and grow as a clinician doing it.</p>
      </div>
    </div>
    <div class="chip-row" style="margin-bottom:var(--s5)">
      ${toc.map(([id, label]) => `<button class="fchip" data-jump="${id}">${label}</button>`).join('')}
    </div>
    ${section('ethos', 'Why we call: the Jarurat Care way', 'handHeart', ethosHTML, 'Free service. Relationship first. Data because it routes the help.')}
    ${section('stages', 'The 3-call playbook', 'phoneCall', stagesHTML, 'The portal shows you the right focus automatically. This is the thinking behind it')}
    ${section('reading', 'Reading the person', 'heart', `${recepHTML}<div style="height:var(--s5)"></div>${mindsetHTML}`, 'Receptiveness sets the rhythm; mindset sets your tone')}
    ${section('instruments', 'The instruments you administer', 'activity', instrumentsHTML, 'Real, validated tools. The app walks you through them item by item')}
    ${section('redflags', 'Red flags & escalation', 'alertTriangle', redflagHTML, 'When to stop being a caller and start being a colleague')}
    ${section('saturday', 'Saturday circles (WhatsApp groups)', 'users', saturdayHTML, 'Nutrition one week, well-being the next')}
  `;

  container.querySelectorAll('[data-jump]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('learn-' + chip.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}
