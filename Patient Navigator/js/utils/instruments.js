// ============================================================
// Patient Navigator: clinical instrument reference + tooltips
// Turns every mention of "PHQ-4", "MUST", "Zarit-4" etc. into a
// hover/tap popover that shows the ACTUAL questions we ask, the
// scoring bands, and what a high score triggers, so a doctor
// reading the analytics understands the tool, not just a label.
//
// One source of truth: the questionnaire items already live in
// utils/catalog.js (INSTRUMENTS / MEASURES). This module adds the
// validation lineage (citation, scale, what it screens) and the
// popover UI. Pure presentation: no data writes.
// ============================================================

import { INSTRUMENTS, MEASURES, BEREAVEMENT_MEASURES } from './catalog.js';

const ALL_MEASURES = [...MEASURES, ...BEREAVEMENT_MEASURES];
const measureDef = (k) => ALL_MEASURES.find(m => m.key === k);

// Validation lineage: the "this is a real, published tool" layer.
// name: how a clinician refers to it · source: the citation ·
// screens: one line on what it measures · bands: [label, hint, tone].
export const INSTRUMENT_REFERENCE = {
  phq4_patient: {
    name: 'PHQ-4', full: 'Patient Health Questionnaire-4',
    source: 'Kroenke, Spitzer, Williams & Löwe (2009), Psychosomatics',
    screens: 'Ultra-brief screen for anxiety (items 1-2, GAD-2) and depression (items 3-4, PHQ-2) over the last 2 weeks.',
    scale: '4 items · 0-3 each · total 0-12 · higher = more distress',
    bands: [
      ['0-2', 'None', 'ok'], ['3-5', 'Mild', 'info'],
      ['6-8', 'Moderate', 'warn'], ['9-12', 'Severe', 'danger'],
    ],
    triggers: 'A score of 6+ auto-raises a concern to the supervisor and prompts a well-being session.',
  },
  phq4_caregiver: {
    name: 'PHQ-4 (caregiver)', full: 'Patient Health Questionnaire-4: asked of the caregiver',
    source: 'Kroenke et al. (2009), Psychosomatics',
    screens: 'The same 4-item anxiety/depression screen, turned on the family caregiver, who routinely under-reports their own strain.',
    scale: '4 items · 0-3 each · total 0-12 · higher = more distress',
    bands: [
      ['0-2', 'None', 'ok'], ['3-5', 'Mild', 'info'],
      ['6-8', 'Moderate', 'warn'], ['9-12', 'Severe', 'danger'],
    ],
    triggers: 'A score of 6+ flags the caregiver for their own support session.',
  },
  zarit_burden: {
    name: 'Zarit-4', full: 'Zarit Burden Interview (4-item screen)',
    source: 'Bédard et al. (2001), The Gerontologist: short form of Zarit (1980)',
    screens: 'Caregiver burden: how much caring is costing the family member their own time, health and equilibrium.',
    scale: '4 items · 0-4 each · total 0-16 · higher = heavier burden',
    bands: [['0-7', 'Lighter burden', 'ok'], ['8-16', 'High burden', 'danger']],
    triggers: 'A score of 8+ flags for respite guidance and a caregiver support session.',
  },
  financial_toxicity: {
    name: 'Financial toxicity', full: 'Financial toxicity screen (COST-adapted)',
    source: 'Adapted from the COST / FACIT-COST measure (de Souza et al., 2017, Cancer)',
    screens: 'How badly treatment costs are damaging the household: savings spent, loans, cutting back on food, daily money stress.',
    scale: '5 items · 0-2 each · total 0-10 · higher = more harm',
    bands: [
      ['0-3', 'Minimal', 'ok'], ['4-6', 'Moderate', 'warn'], ['7-10', 'High toxicity', 'danger'],
    ],
    triggers: 'A score of 7+ flags for financial-aid navigation.',
  },
  must_malnutrition: {
    name: 'MUST', full: 'Malnutrition Universal Screening Tool',
    source: 'BAPEN Malnutrition Advisory Group (2003)',
    screens: 'Malnutrition risk from three quick inputs: BMI, unplanned weight loss, and acute illness with no intake.',
    scale: '3 components · summed · 0 low / 1 medium / 2+ high risk',
    bands: [['0', 'Low risk', 'ok'], ['1', 'Medium (watch)', 'warn'], ['2+', 'High risk', 'danger']],
    triggers: 'A score of 2+ flags the nutrition team to see the patient this week.',
  },
  grief_screen: {
    name: 'BGQ', full: 'Brief Grief Questionnaire',
    source: 'Shear et al. / Prigerson: brief screen for complicated grief',
    screens: 'Administered ~3 months after a loss: difficulty accepting the death, intrusive thoughts, avoidance, disconnection.',
    scale: '5 items · 0-2 each · total 0-10 · higher = more grief difficulty',
    bands: [['0-4', 'Uncomplicated', 'ok'], ['5-10', 'Possible complicated grief', 'danger']],
    triggers: 'A score of 5+ prompts a counselling referral.',
  },
  qol_physical: {
    name: 'QoL (physical)', full: 'Quality of life: physical (single-item)',
    source: 'Single-item linear analogue self-assessment (LASA), validated in oncology',
    screens: 'The patient rates their physical health and comfort right now on a 0-10 ladder.',
    scale: '0-10 · higher = better',
    bands: [['0-3', 'Struggling', 'danger'], ['4-6', 'Middle', 'warn'], ['7-10', 'Doing well', 'ok']],
  },
  qol_emotional: {
    name: 'QoL (emotional)', full: 'Quality of life: emotional (single-item)',
    source: 'Single-item linear analogue self-assessment (LASA), validated in oncology',
    screens: 'The patient rates their emotional and mental wellbeing right now on a 0-10 ladder.',
    scale: '0-10 · higher = better',
    bands: [['0-3', 'Struggling', 'danger'], ['4-6', 'Middle', 'warn'], ['7-10', 'Doing well', 'ok']],
  },
  activation: {
    name: 'Patient activation', full: 'Patient activation (self-efficacy, PAM-informed)',
    source: 'Informed by the Patient Activation Measure (Hibbard et al., 2004)',
    screens: '"If something goes wrong, do you know what to do?" (how equipped the patient feels to manage their own care).',
    scale: '1-5 · higher = more activated',
    bands: [['1-2', 'Low (at risk)', 'danger'], ['3', 'Building', 'warn'], ['4-5', 'Activated', 'ok']],
  },
  caregiver_confidence: {
    name: 'Caregiver confidence', full: 'Caregiver confidence (self-rated)',
    source: 'Single-item caregiver self-efficacy, recorded at baseline and follow-up',
    screens: 'How confident the caregiver feels managing their relative’s care, tracked before vs. after our support.',
    scale: '1-5 · higher = more confident',
    bands: [['1-2', 'Low', 'danger'], ['3', 'Building', 'warn'], ['4-5', 'Confident', 'ok']],
  },
  caregiver_support_6m: {
    name: 'Caregiver support (6 mo)', full: 'Caregiver support at 6 months (bereavement)',
    source: 'Single-item bereavement follow-up',
    screens: 'Six months after a loss: how supported the caregiver feels, by family, friends, and us.',
    scale: '1-5 · higher = more supported',
    bands: [['1-2', 'Isolated', 'danger'], ['3', 'Some support', 'warn'], ['4-5', 'Well supported', 'ok']],
  },
};

export const hasInstrumentInfo = (key) => !!INSTRUMENT_REFERENCE[key];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The item (question) list: from the guided INSTRUMENTS if present,
// otherwise the single prompt for a scale measure.
function itemsHTML(key) {
  const inst = INSTRUMENTS[key];
  const m = measureDef(key);
  if (inst?.items?.length) {
    const rows = inst.items.map((it, i) => {
      const q = (it && typeof it === 'object') ? it.q : it;
      return `<li><span class="ii-num">${i + 1}</span>${esc(q)}</li>`;
    }).join('');
    const lead = inst.items.length > 1
      ? `<div class="ii-lead">${esc(inst.intro?.split('.')[0] || 'The items we read out:')}</div>`
      : '';
    return `${lead}<ol class="ii-items">${rows}</ol>`;
  }
  if (m?.prompt) {
    return `<div class="ii-lead">The question we ask:</div>
      <ol class="ii-items"><li><span class="ii-num">·</span>${esc(m.prompt)}</li></ol>`;
  }
  return '';
}

function bandsHTML(ref) {
  if (!ref.bands?.length) return '';
  return `<div class="ii-bands">${ref.bands.map(([range, label, tone]) =>
    `<span class="ii-band ii-${tone}"><b>${esc(range)}</b> ${esc(label)}</span>`).join('')}</div>`;
}

// The popover body for one instrument.
export function instrumentPopoverHTML(key) {
  const ref = INSTRUMENT_REFERENCE[key];
  if (!ref) return '';
  return `
    <div class="ii-pop-head">
      <div class="ii-pop-name">${esc(ref.name)}</div>
      <div class="ii-pop-full">${esc(ref.full)}</div>
    </div>
    <div class="ii-pop-screens">${esc(ref.screens)}</div>
    ${itemsHTML(key)}
    <div class="ii-pop-scale"><span class="ii-k">Scoring</span>${esc(ref.scale)}</div>
    ${bandsHTML(ref)}
    ${ref.triggers ? `<div class="ii-pop-trig">${esc(ref.triggers)}</div>` : ''}
    <div class="ii-pop-src"><span class="ii-k">Instrument</span>${esc(ref.source)}</div>`;
}

// A chip that shows the instrument name and opens the popover.
// Use in HTML strings: instrumentChip('phq4_patient', 'PHQ-4')
export function instrumentChip(key, label = null) {
  const ref = INSTRUMENT_REFERENCE[key];
  if (!ref) return esc(label || key);
  return `<button type="button" class="ii-chip" data-metric="${esc(key)}"
    aria-label="${esc(ref.name)} · show the questions and scoring">${esc(label || ref.name)}<svg class="ii-chip-i" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></button>`;
}

// ============================================================
// METRIC GLOSSARY: every chart, KPI and term on the analytics page
// gets a plain-language card so a doctor can hover any label and know
// exactly what it is, what we ask, how to read it, and why it matters.
//   what : one line, what the metric is
//   read : how to read THIS chart
//   why  : why it matters to the patient's care
//   formula (optional) : how it's computed
//   instrument (optional) : also show the real questions + bands from
//                           INSTRUMENT_REFERENCE
// ============================================================
export const METRIC_INFO = {
  // ---- REACH ----
  registry_growth: { name: 'Registry growth', what: 'New patients added to our care each day.', read: 'Each bar is that day\'s new registrations; hover shows the running total. Tall bars are bulk intake days from hospital lists.', why: 'Shows how fast the program is scaling and when the team takes on a wave of new families who each need a first call.' },
  gi_subtypes: { name: 'GI cancer subtypes', what: 'The mix of gastrointestinal cancers among our patients.', read: 'Each slice is a subtype\'s share of the registry. "Unclassified" = we don\'t yet know the exact type.', why: 'Different GI cancers need different navigation; unclassified patients are a diagnosis question for the next call.' },
  stage_first_contact: { name: 'Stage at first contact', what: 'What cancer stage patients were at when we first reached them.', read: 'Slices are stages I-IV (plus unknown). Stage III/IV = advanced.', why: 'Families who meet us late need palliative-side support (nutrition, finances, caregiver relief) as much as treatment navigation.' },
  vulnerability: { name: 'Household vulnerability', what: 'A 0-10 index of how much hardship a household faces.', read: 'Bars group households into Low / Moderate / High need. Higher = more vulnerable.', why: 'For a high-vulnerability family, one delivered support lever changes the week. This is who the program exists for.', formula: 'Built from low income + thin/no insurance + dependents at home + distance to the treatment centre.' },
  trajectory: { name: 'Disease trajectory', what: 'The goal of each patient\'s treatment.', read: 'Curative = treating to cure; Palliative = comfort and control; Surveillance = watching after treatment.', why: 'Cure-path families need treatment navigation; palliative families need comfort, nutrition and caregiver support: different conversations.' },
  insurance_status: { name: 'Financial / insurance situation', what: 'How families pay for treatment.', read: 'Uninsured / government scheme / insured / unknown.', why: 'Uninsured and scheme-dependent families are where financial-aid navigation earns its keep.' },
  geography: { name: 'Where patients are', what: 'The states our patients live in.', read: 'Longer bars = more patients in that state.', why: 'Distance to a treatment centre is part of vulnerability, and the resources directory is organised by state.' },
  age_bands: { name: 'Age at registration', what: 'The age distribution of patients.', read: 'Bars are age bands; darker = older. "Unknown" = age not recorded.', why: 'Working-age and young patients mean a diagnosis often takes the household income with it.' },
  gender_split: { name: 'Gender (patient & caregiver)', what: 'Gender of patients vs. their primary caregivers.', read: 'Two bars per category: the patient, and the family member giving care.', why: 'Caregiving usually falls to women (the daughter, wife, daughter-in-law); seeing that helps us support the caregiver too.' },
  languages: { name: 'Languages families speak', what: 'The languages our patients are most comfortable in.', read: 'Longer bars = more families. A family can speak more than one.', why: 'Matching a mentor to the family\'s language is what makes the warmth in the relationship possible.' },
  lifecycle: { name: 'Patient lifecycle', what: 'Where each person is in our care journey.', read: 'New lead (awaiting first call) → Active → Inactive → Deceased (families stay with us for bereavement support).', why: 'Tells us how many people are actively supported vs. waiting for a first conversation.' },
  subtype_stage: { name: 'Stage within each subtype', what: 'How advanced each GI cancer type is when we meet it.', read: 'Stacked bars per subtype, coloured by stage. Mostly red/amber = we meet that subtype late.', why: 'Where a subtype is caught late, early-detection messaging in that community is the long-term lever.' },
  data_completeness: { name: 'Data completeness', what: 'The share of active patients with each key field on file.', read: 'Longer/greener = better covered; red = big blind spots. Sorted worst-first.', why: 'Families share more as trust grows. The portal surfaces every missing question from call 2 onward.' },

  // ---- ACTION ----
  calls_over_time: { name: 'Calls over time', what: 'Total dials and connected conversations per day.', read: 'Two lines: every dial, and the ones that became real conversations. The gap is calls that didn\'t connect.', why: 'Unconnected dials roll forward automatically until we reach the family.' },
  dial_outcomes: { name: 'What happened to every dial', what: 'The outcome of each call attempt.', read: 'Connected / no answer / busy / callback requested / voicemail / wrong number.', why: '"Callback requested" is a soft yes, not a rejection; wrong numbers are what the linked-phones cleanup shrinks.' },
  best_time: { name: 'When families pick up', what: 'Connect rate by hour of day (IST).', read: 'Taller bar = families answer more at that hour. Connect rate = connected ÷ dials.', why: 'Stacking hard-to-reach families into the best hours is free connect rate.' },
  support_levers: { name: 'Support levers (delivered vs. declined)', what: 'Concrete units of help offered to patients, and whether each landed.', read: 'Per lever: green = delivered, grey = declined or not needed.', why: 'A "lever" is one real thing we do: financial resources, a nutrition plan, a second opinion, a well-being session. A decline still tells us which offers need better framing or timing.', formula: 'Levers are recorded on patient pages / calls as they\'re delivered (see the support-lever list).' },
  financial_sources: { name: 'Financial help (sources & conversion)', what: 'Where financial help comes from and how much converts to real aid.', read: 'Bars are the sources families availed. The badge is sent → availed conversion.', why: 'Shows not just that we send resources, but that families actually receive money, and through which schemes.', formula: 'Sent = "financial resources sent"; availed = "financial aid availed"; ₹ from the recorded aid amounts.' },
  support_equity: { name: 'Reaching the most vulnerable', what: 'Average support levers delivered per patient, by vulnerability band.', read: 'Taller bar for High-need than Low-need = help is flowing to where the need is greatest.', why: 'Answers the equity question directly: are the neediest families actually getting more of our help?' },
  requirements: { name: 'What patients ask for', what: 'The kinds of help families request on calls.', read: 'Longer bar = asked for more often.', why: 'The support-lever chart shows how many of these asks turn into delivered help.' },
  journey_funnel: { name: 'How far people travel with us', what: 'How the relationship deepens across conversations.', read: 'Reached once → twice → 3+ times → gave consent → joined WhatsApp. Each step is a smaller, more committed group.', why: 'Reaching someone 3+ times is the relationship, not a transaction. That\'s the model working.' },
  saturday_circles: { name: 'Saturday circles', what: 'Group sessions held on WhatsApp where families learn together.', read: 'Monthly bars split into nutrition vs. well-being circles.', why: 'A steady weekly rhythm is the goal. A shrinking bar is an early warning.' },
  session_pipeline: { name: '1:1 session pipeline', what: 'One-to-one sessions moving from invitation to held.', read: 'Invited → said yes → scheduled → held. The gap between "said yes" and "held" is where interest quietly dies.', why: 'Scheduling within the week is how a yes becomes a session that actually happens.' },
  mentor_performance: { name: 'Caregiver-mentor performance', what: 'Each mentor\'s calls, connections and distinct patients in the window.', read: 'Grouped bars per mentor; the tooltip shows average minutes per connected call.', why: 'Volume and depth are different gifts. Both matter, and the leaderboard scores both.' },

  // ---- SAFETY NET ----
  concern_reasons: { name: 'Why patients get flagged', what: 'The reasons patients are escalated as a concern.', read: 'Per reason: red = still open, green = handled.', why: 'Many flags are raised automatically when an assessment crosses a threshold. The system watches even when nobody flags.', formula: 'Auto-flag thresholds: PHQ-4 ≥6, Zarit ≥8, financial toxicity ≥7, MUST ≥2, grief ≥5.' },
  concern_backlog: { name: 'The open backlog', what: 'Concerns still waiting for a human, by urgency.', read: 'Urgent (today) / High (this week) / Watch. Each tile shows how old the flags are.', why: 'Every flag is a family that told us something serious. The oldest waiting is the one to act on first.' },

  // ---- NUTRITION ----
  nutrition_funnel: { name: 'Nutrition funnel (touched to fed)', what: 'How nutrition patients progress from first touch to follow-up.', read: 'Touched → nutritionist assigned → plan given → adherence check → follow-up. Each step is smaller.', why: 'The drop-off after the plan is where patients quietly slip. The adherence check is the catch.' },
  must: { name: 'MUST malnutrition risk', what: 'The mix of malnutrition risk across nutrition patients.', read: 'High (≥2) / Medium (1) / Low (0) / not screened yet.', why: 'Screening the unscreened is the fastest way to find who needs the nutrition team first.', instrument: 'must_malnutrition' },
  nutrition_team: { name: 'Nutrition team performance', what: 'Each nutritionist\'s check-ins, patients reached and 1:1s held.', read: 'Grouped bars per nutritionist over the window.', why: 'Shows who is carrying the nutrition work and who could use a nudge.' },

  // ---- IMPACT ----
  cohort_wellbeing: { name: 'Wellbeing by intake cohort', what: 'A 0-100 wellbeing index tracked separately for each month\'s intake of patients.', read: 'Each line follows only the patients who joined that month. Click a month to isolate it. Higher = better.', why: 'A rising line here is the SAME families getting better, not the average being dragged around as new (sicker-at-baseline) patients arrive.', formula: 'Average, across QoL physical/emotional, activation, PHQ-4 and financial toxicity, of each score normalised so 100 is always best.' },
  pooled_wellbeing: { name: 'Wellbeing over time (pooled)', what: 'The same 0-100 index, but averaged over ALL patients together.', read: 'Rising = better; flat can be good news in advanced cancer; falling is the one to act on.', why: 'This pools everyone, so it mixes cohorts. New arrivals with low baselines pull it around. Use the cohort chart above to read real change.' },
  improve_stable_decline: { name: 'Improved · stable · declined', what: 'For each measure, how many tracked patients got better, held, or worsened.', read: 'Green improved, teal stable, red declined. Needs ≥2 check-ins per patient.', why: 'In advanced cancer a STABLE score is a win. Quality of life not collapsing under treatment is the outcome.' },
  baseline_latest: { name: 'Baseline vs latest', what: 'The first score we ever recorded vs. where the patient stands now, per measure.', read: 'For distress measures (PHQ-4, financial toxicity, burden) a LOWER latest bar is the win; for QoL and activation, higher.', why: 'Bars that barely move on distress measures while treatment continues are quiet successes.' },
  fintox_by_income: { name: 'Financial toxicity by income band', what: 'Average financial-toxicity score across household income bands.', read: 'Taller bar = more financial harm. Watch whether the poorest bands score highest.', why: 'If the poorest score highest, treatment costs land exactly where there\'s least cushion. That\'s the queue for aid navigation.', instrument: 'financial_toxicity' },
  activation: { name: 'Patient activation', what: 'How equipped a patient feels to manage their own care and handle a crisis at home.', read: 'Bars count patients at each level 1-5. Left (1-2) = at risk; right (4-5) = activated.', why: 'A low-activation patient wouldn\'t know who to call in an emergency. Every navigation call that ends with "save this number" moves them right.', instrument: 'activation' },

  // ---- CORRELATE ----
  dose_response: { name: 'Support dose vs. well-being', what: 'Whether patients who receive more support show better wellbeing change.', read: 'Grouped by number of levers received (the "dose"); y = average wellbeing change. Positive = improving.', why: 'A positive slope is the correlation the program\'s case rests on. If flat, it may mean support flows to the sickest (confounding), not that support fails.' },
  warming_curve: { name: 'The warming curve', what: 'How receptive families are by the Nth conversation.', read: 'Each bar is a call number, split warm / neutral / guarded / overwhelmed.', why: 'Families warming up as calls grow is the repeat-call, relationship-first model doing its job: patience, not pitch.' },
  trust_curve: { name: 'The trust curve', what: 'How much we know about a family by the number of conversations.', read: '% of 8 key details known, grouped by conversations held. Rises with contact.', why: 'Families don\'t share everything at once, and don\'t have to. Every gentle call closes the gap.' },

  // ---- KPI tiles / hero numbers ----
  kpi_calls_made: { name: 'Calls made', what: 'Total dials in the selected window.', read: 'The number with its connect rate; the arrow compares to the previous window.', why: 'Raw reach: the top of everything the team does.' },
  kpi_families_reached: { name: 'Families reached', what: 'Distinct families we had a real conversation with.', read: 'With total minutes of conversation.', why: 'Conversations, not dials, are where support actually happens.' },
  kpi_talk_mins: { name: 'Talk time', what: 'Total minutes logged on connected calls in the window. Calls that never connected contribute nothing.', read: 'The big number is total minutes; underneath is the average length of one connected call. The arrow compares to the previous window of the same length.', why: 'Volume says how many families we dialled. Talk time says whether anyone actually sat with them. A rising call count with flat minutes means the calls are getting shallower.' },
  kpi_checkins: { name: 'Wellbeing check-ins', what: 'Scored assessments recorded in the window.', read: 'With support levers delivered alongside.', why: 'Check-ins are how we know whether our support is actually working.' },
  kpi_concerns_open: { name: 'Concerns open now', what: 'Escalated red flags not yet resolved.', read: 'With how many are urgent and how many were resolved in the window.', why: 'Every open concern is a family waiting on something serious.' },
  hero_aid: { name: 'Financial aid disbursed', what: 'Total money moved to families since the program began.', read: 'With how many families it reached.', why: 'The most concrete proof of help for the poorest patients.' },
  hero_improved: { name: 'Patients improved', what: 'Patients who improved on at least one wellbeing measure.', read: 'All-time count.', why: 'Direct evidence the support changes lives, not just numbers.' },
  hero_support: { name: 'Support actions delivered', what: 'Total support levers delivered since the start.', read: 'With well-being sessions alongside.', why: 'The volume of concrete help the program has provided.' },
  hero_checkins: { name: 'Wellbeing check-ins logged', what: 'All scored assessments recorded to date.', read: 'Across PHQ-4, QoL, MUST, Zarit and more: hover each to see its questions.', why: 'The measurement backbone that makes impact provable.' },
  connect_rate: { name: 'Connect rate', what: 'Share of dials that became a real conversation.', read: 'Connected ÷ total dials.', why: 'The efficiency of reaching families; higher means less effort per conversation.' },
  wellbeing_index: { name: 'Wellbeing index', what: 'A 0-100 score where 100 is always best.', read: 'Each measure is normalised and averaged so rising always means better.', why: 'One number that lets very different measures be compared and trended together.', formula: 'QoL, activation (higher=better) and PHQ-4, financial toxicity (lower=better) each rescaled to 0-100 then averaged.' },
};

export const hasMetricInfo = (key) => !!METRIC_INFO[key] || !!INSTRUMENT_REFERENCE[key];

// Popover body for a metric OR an instrument (metric first, then its
// instrument block if it names one; falls back to a pure instrument).
export function metricPopoverHTML(key) {
  const m = METRIC_INFO[key];
  if (!m) return instrumentPopoverHTML(key);   // headline chips pass instrument keys
  const row = (k, v) => v ? `<div class="ii-pop-scale"><span class="ii-k">${k}</span>${esc(v)}</div>` : '';
  let html = `
    <div class="ii-pop-head"><div class="ii-pop-name">${esc(m.name)}</div></div>
    <div class="ii-pop-screens">${esc(m.what)}</div>
    ${m.read ? `<div class="ii-metric-line"><span class="ii-k">How to read</span>${esc(m.read)}</div>` : ''}
    ${m.why ? `<div class="ii-metric-line"><span class="ii-k">Why it matters</span>${esc(m.why)}</div>` : ''}
    ${row('How it\'s built', m.formula)}`;
  if (m.instrument && INSTRUMENT_REFERENCE[m.instrument]) {
    html += `<div class="ii-pop-divider"></div>${instrumentPopoverHTML(m.instrument)}`;
  }
  return html;
}

// A chart-title target: the whole title becomes hoverable/tappable with a
// trailing ⓘ. Keyboard-reachable and announced to AT.
export function metricTitle(key, title) {
  if (!METRIC_INFO[key] && !INSTRUMENT_REFERENCE[key]) return esc(title);
  return `<span class="chart-title metric-label" data-metric="${esc(key)}" tabindex="0" role="button"
    aria-label="${esc(title)} · what this metric means">${esc(title)}<svg class="ml-i" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></span>`;
}

// A short inline term chip (for the brief / KPI labels): term + ⓘ.
export function metricTerm(key, label) {
  if (!METRIC_INFO[key] && !INSTRUMENT_REFERENCE[key]) return esc(label);
  return `<span class="metric-term" data-metric="${esc(key)}" tabindex="0" role="button" aria-label="${esc(label)} · what this means">${esc(label)}<svg class="ml-i" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></span>`;
}

// ---- Singleton floating popover, shared by every chip on the page ----
let popEl = null;
let activeChip = null;

function ensurePop() {
  if (popEl) return popEl;
  popEl = document.createElement('div');
  popEl.className = 'ii-pop';
  popEl.setAttribute('role', 'dialog');
  popEl.setAttribute('aria-label', 'Instrument details');
  popEl.style.display = 'none';
  document.body.appendChild(popEl);
  // Keep it open while the pointer is inside it.
  popEl.addEventListener('mouseleave', () => { if (!pinned) hidePop(); });
  return popEl;
}

let pinned = false;   // tap/click pins it open until dismissed
let hideTimer = null;

function positionPop(chip) {
  const r = chip.getBoundingClientRect();
  const pop = ensurePop();
  pop.style.display = 'block';
  pop.style.visibility = 'hidden';
  // Measure, then place: prefer below, flip above if it would clip.
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const margin = 8;
  let left = r.left + window.scrollX;
  left = Math.min(left, window.scrollX + document.documentElement.clientWidth - pw - margin);
  left = Math.max(window.scrollX + margin, left);
  let top = r.bottom + window.scrollY + 6;
  if (r.bottom + ph + 12 > document.documentElement.clientHeight) {
    top = r.top + window.scrollY - ph - 6;   // flip above
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.visibility = 'visible';
}

function showPop(chip) {
  clearTimeout(hideTimer);
  const key = chip.dataset.metric || chip.dataset.instrument;
  const html = metricPopoverHTML(key);
  if (!html) return;
  const pop = ensurePop();
  pop.innerHTML = html;
  activeChip = chip;
  positionPop(chip);
}

function hidePop(force = false) {
  if (pinned && !force) return;
  if (!popEl) return;
  popEl.style.display = 'none';
  activeChip = null;
  pinned = false;
}

// Attach delegated hover/tap handlers ONCE per document. Idempotent:
// pages can call it after each render; the flag stops duplicate binding.
export function initInstrumentTooltips() {
  if (window.__iiBound) return;
  window.__iiBound = true;

  const isChip = (t) => t?.closest?.('[data-metric],[data-instrument]');

  document.addEventListener('mouseover', (e) => {
    const chip = isChip(e.target);
    if (!chip) return;
    clearTimeout(hideTimer);
    if (!pinned) showPop(chip);
  });
  document.addEventListener('mouseout', (e) => {
    const chip = isChip(e.target);
    if (!chip || pinned) return;
    // Grace period so the pointer can travel to the popover.
    hideTimer = setTimeout(() => {
      if (!popEl || popEl.matches(':hover')) return;
      hidePop();
    }, 160);
  });
  // Tap / click pins it (mobile + deliberate desktop click).
  document.addEventListener('click', (e) => {
    const chip = isChip(e.target);
    if (chip) {
      e.preventDefault();
      if (pinned && activeChip === chip) { hidePop(true); return; }
      pinned = false; showPop(chip); pinned = true;
      return;
    }
    if (pinned && popEl && !popEl.contains(e.target)) hidePop(true);
  });
  // Keyboard: focus reveals, Enter/Space pins, Esc closes, blur hides.
  document.addEventListener('focusin', (e) => {
    const chip = isChip(e.target);
    if (chip) { clearTimeout(hideTimer); if (!pinned) showPop(chip); }
  });
  document.addEventListener('focusout', (e) => {
    const chip = isChip(e.target);
    if (chip && !pinned) hideTimer = setTimeout(() => { if (!popEl || !popEl.matches(':hover')) hidePop(); }, 160);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hidePop(true); return; }
    const chip = isChip(e.target);
    if (chip && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (pinned && activeChip === chip) { hidePop(true); return; }
      pinned = false; showPop(chip); pinned = true;
    }
  });
  window.addEventListener('scroll', () => { if (activeChip) positionPop(activeChip); }, { passive: true });
  window.addEventListener('resize', () => hidePop(true));
}
