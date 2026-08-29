// ============================================================
// Patient Navigator: shared data vocabulary (WHO → ACTION → IMPACT)
// One source of truth for patient fields, support levers and
// wellbeing measures. Used by patients, calling, calls, dashboard,
// analytics. Keys match DB columns / CHECK constraints in sql/14.
// ============================================================

export const PATIENT_STATUSES = [
  { key: 'new_lead', label: 'New lead',  badge: 'badge-info' },
  { key: 'active',   label: 'Active',    badge: 'badge-ok' },
  { key: 'inactive', label: 'Inactive',  badge: 'badge-neutral' },
  { key: 'deceased', label: 'Deceased',  badge: 'badge-violet' },
];
export const statusBadge = (key) => {
  const s = PATIENT_STATUSES.find(x => x.key === key) || PATIENT_STATUSES[0];
  return `<span class="badge badge-dot ${s.badge}">${s.label}</span>`;
};

export const GI_SUBTYPES = [
  { key: 'oesophageal',     label: 'Oesophageal' },
  { key: 'gastric',         label: 'Gastric (stomach)' },
  { key: 'colorectal',      label: 'Colorectal' },
  { key: 'pancreatic',      label: 'Pancreatic' },
  { key: 'liver_hcc',       label: 'Liver (HCC)' },
  { key: 'gallbladder',     label: 'Gallbladder' },
  { key: 'bile_duct',       label: 'Bile duct' },
  { key: 'small_intestine', label: 'Small intestine' },
  { key: 'gist',            label: 'GIST' },
  { key: 'anal',            label: 'Anal' },
  { key: 'other_gi',        label: 'Other GI' },
];
export const giLabel = (key) => GI_SUBTYPES.find(x => x.key === key)?.label || null;

export const TRAJECTORIES = [
  { key: 'curative',     label: 'Curative intent' },
  { key: 'palliative',   label: 'Palliative only' },
  { key: 'surveillance', label: 'Surveillance' },
  { key: 'unknown',      label: 'Unknown' },
];
export const STOMA_TYPES = [
  { key: 'none',         label: 'None' },
  { key: 'colostomy',    label: 'Colostomy' },
  { key: 'ileostomy',    label: 'Ileostomy' },
  { key: 'urostomy',     label: 'Urostomy' },
  { key: 'feeding_tube', label: 'Feeding tube' },
];
export const HEALTH_LITERACY = [
  { key: 'basic',    label: 'Basic' },
  { key: 'moderate', label: 'Moderate' },
  { key: 'high',     label: 'High' },
];
export const ECOG = [
  { key: 0, label: '0 (Fully active)' },
  { key: 1, label: '1 (Light work only)' },
  { key: 2, label: '2 (Up >50% of day)' },
  { key: 3, label: '3 (In bed >50%)' },
  { key: 4, label: '4 (Bedbound)' },
];
export const SCHOOL_RETENTION = [
  { key: 'same_school',    label: 'Same school' },
  { key: 'other_school',   label: 'Other school' },
  { key: 'not_enrolled',   label: 'Not enrolled' },
  { key: 'not_applicable', label: 'No school-age children' },
];

// ---- ACTION: support levers (patient_services.lever keys) ----
// field: extra structured input shown when the lever is on.
export const LEVER_GROUPS = [
  {
    group: 'Financial & practical',
    levers: [
      { key: 'financial_resources_sent', label: 'Financial resources sent' },
      { key: 'financial_aid_availed',    label: 'Financial aid availed', field: 'amount', fieldLabel: 'Amount (₹)' },
      { key: 'accommodation_sent',       label: 'Accommodation details sent' },
      { key: 'accommodation_availed',    label: 'Accommodation availed' },
      { key: 'documents_help',           label: 'Helped with documents / paperwork' },
    ],
  },
  {
    group: 'Nutrition & wellbeing',
    levers: [
      { key: 'nutritionist_assigned',  label: 'Nutritionist assigned' },
      { key: 'nutrition_plan_given',   label: 'One-on-one nutrition plan given' },
      { key: 'nutrition_followup',     label: 'Nutrition follow-up sessions', field: 'sessions', fieldLabel: 'Sessions held' },
      { key: 'emotional_support',      label: 'Emotional support provided' },
      { key: 'wellbeing_sessions',     label: 'Therapy / well-being sessions', field: 'sessions', fieldLabel: 'Sessions attended' },
    ],
  },
  {
    group: 'Clinical navigation',
    levers: [
      { key: 'second_opinion_requested', label: 'Second opinion requested by patient' },
      { key: 'second_opinion_connected', label: 'Connected to board doctor', field: 'detail', fieldLabel: 'Outcome of second opinion' },
      { key: 'trial_match_report',       label: 'Clinical-trial matching report sent (Trial Bot)' },
      { key: 'trial_enrolment',          label: 'Clinical-trial enrolment', field: 'outcome',
        options: [ { key: 'enrolled', label: 'Enrolled' }, { key: 'considering', label: 'Considering' }, { key: 'not_eligible', label: 'Not eligible' } ] },
    ],
  },
  {
    group: 'Information & engagement',
    levers: [
      { key: 'acp_workbook',             label: 'Advance-care-planning workbook given' },
      { key: 'videos_sent',              label: 'Educational videos sent' },
      { key: 'whatsapp_resources_sent',  label: 'Resources sent over WhatsApp' },
    ],
  },
];
export const ALL_LEVERS = LEVER_GROUPS.flatMap(g => g.levers);
export const leverLabel = (key) => ALL_LEVERS.find(l => l.key === key)?.label
  || OUTCOME_FLAGS.find(l => l.key === key)?.label || key;

// IMPACT flags that live in patient_services but render with wellbeing.
export const OUTCOME_FLAGS = [
  { key: 'main_request_resolved',  label: 'Main request resolved' },
  { key: 'treatment_interruption', label: 'Unplanned treatment interruption', field: 'detail', fieldLabel: 'Reason' },
  { key: 'nutrition_adherence',    label: 'Nutritional adherence', field: 'outcome',
    options: [ { key: 'full', label: 'Full' }, { key: 'partial', label: 'Partial' }, { key: 'none', label: 'None' } ] },
];

// ---- IMPACT: scored measures (patient_assessments.measure keys) ----
// dir: +1 = higher is better, -1 = lower is better.
export const MEASURES = [
  { key: 'qol_physical',        label: 'Quality of life (physical)',  min: 0, max: 10, dir: +1, hint: '0 worst → 10 best',
    prompt: 'On a scale of 0 to 10, how would you rate your physical health and comfort right now?',
    hindi: 'Abhi aapki physical health/sehat/aaram kaisa hai?',
    probe: 'Dard, kamzori, ya neend ki problem hai kya?',
    lowAnchor: 'worst', highAnchor: 'best' },
  { key: 'qol_emotional',       label: 'Quality of life (emotional)', min: 0, max: 10, dir: +1, hint: '0 worst → 10 best',
    prompt: 'On a scale of 0 to 10, how would you rate your emotional and mental wellbeing right now?',
    hindi: 'Abhi aap mentally/emotionally kaisa feel kar rahe hain?',
    probe: 'Kya zyada tension ya udaasi rehti hai?',
    lowAnchor: 'worst', highAnchor: 'best' },
  { key: 'financial_toxicity',  label: 'Financial toxicity',          min: 0, max: 10, dir: -1, hint: '0 none → 10 severe' },
  { key: 'must_malnutrition',   label: 'MUST malnutrition risk',      min: 0, max: 6,  dir: -1, hint: '0 low → 6 high risk' },
  { key: 'phq4_patient',        label: 'PHQ-4 (patient)',             min: 0, max: 12, dir: -1, hint: 'anxiety / depression screen' },
  { key: 'phq4_caregiver',      label: 'PHQ-4 (caregiver)',           min: 0, max: 12, dir: -1, hint: 'anxiety / depression screen' },
  { key: 'zarit_burden',        label: 'Caregiver burden (Zarit-4)',  min: 0, max: 16, dir: -1, hint: '0 light → 16 heavy' },
  { key: 'activation',          label: 'Patient activation',          min: 1, max: 5,  dir: +1, hint: '“I know what to do if…”',
    prompt: 'How confident do you feel managing your own care, or handling a medical emergency at home?',
    hindi: 'Aap samajh paa rahe hain apni bimari? Aap manage kar paa rahe hain khud ka khayal rakhna aur baaki cheezein?',
    probe: 'Agar abhi koi problem ho jaaye, aapko pata hai kya karna hai?',
    levels: ['Unaware', 'Aware but lacking confidence', 'Learning', 'Active and independent', 'Resilient and proactive'],
    lowAnchor: 'disagree strongly', highAnchor: 'agree strongly' },
  { key: 'caregiver_confidence',label: 'Caregiver confidence',        min: 1, max: 5,  dir: +1, hint: 'self-rated, before vs after',
    prompt: 'How confident do you feel managing your relative’s care?',
    hindi: 'Inki dekhbhal karne mein aap kitna confident feel karte hain?',
    probe: 'Ask once at baseline and again after a few weeks to show change, record both.',
    lowAnchor: 'disagree strongly', highAnchor: 'agree strongly' },
];
export const BEREAVEMENT_MEASURES = [
  { key: 'grief_screen',         label: 'Grief screening (BGQ, ~3 months)', min: 0, max: 10, dir: -1, hint: '≥5 suggests support needed' },
  { key: 'caregiver_support_6m', label: 'Caregiver support at 6 months',    min: 1, max: 5,  dir: +1, hint: 'how supported they feel',
    prompt: 'Six months on, how supported does the caregiver feel right now, by family, by friends, and by us?',
    lowAnchor: 'not at all', highAnchor: 'very supported' },
];
export const measureLabel = (key) =>
  [...MEASURES, ...BEREAVEMENT_MEASURES].find(m => m.key === key)?.label || key;

// ---- call vocabulary shared by the portal and the log-call modal ----
export const REQUIREMENTS = [
  { key: 'Financial aid', icon: 'shieldCheck' },   { key: 'Nutrition / diet', icon: 'leaf' },
  { key: 'Emotional support', icon: 'heart' },     { key: 'Treatment info', icon: 'fileText' },
  { key: 'Second opinion', icon: 'stethoscope' },  { key: 'Clinical-trial info', icon: 'fileText' },
  { key: 'Caregiver support', icon: 'users' },     { key: 'Medicines / equipment', icon: 'plus' },
  { key: 'Documents help', icon: 'fileText' },     { key: 'Accommodation', icon: 'home' },
];
export const CONDITIONS = [
  { key: 'improving', label: 'Improving', tone: 'ok' },   { key: 'stable', label: 'Stable', tone: 'info' },
  { key: 'declining', label: 'Declining', tone: 'warn' }, { key: 'critical', label: 'Critical', tone: 'danger' },
  { key: 'unknown', label: 'Not sure', tone: 'neutral' },
];
export const DIAL_STATUSES = [
  { key: 'connected',          label: 'Connected',    icon: 'phoneCall', tone: 'ok' },
  { key: 'no_answer',          label: 'No answer',    icon: 'phone',     tone: 'warn' },
  { key: 'busy',               label: 'Busy',         icon: 'phone',     tone: 'warn' },
  { key: 'callback_requested', label: 'Callback',     icon: 'clock',     tone: 'info' },
  { key: 'voicemail',          label: 'Voicemail',    icon: 'message',   tone: 'neutral' },
  { key: 'wrong_number',       label: 'Wrong number', icon: 'x',         tone: 'danger' },
];
// Follow-up cadence: interested → a week, otherwise → two weeks, "don't call
// me" → ~three weeks. Hard floor of 3 days on explicit dates. A marked call
// never resurfaces the next day. Kept in sync with the auto_followup_date
// trigger (sql/49), which also clamps custom dates to the 3-day floor.
export const RECEPTIVENESS = [
  { key: 'highly_receptive', label: 'Highly receptive', days: 7,  hint: 'Warm, engaged, open to help' },
  { key: 'neutral',          label: 'Neutral',          days: 14, hint: 'Polite, listening, undecided' },
  { key: 'skeptical',        label: 'Skeptical',        days: 14, hint: 'Guarded or unsure of us' },
  { key: 'agitated',         label: 'Agitated',         days: 20, hint: 'Frustrated: tread gently' },
  { key: 'overwhelmed',      label: 'Overwhelmed',      days: 17, hint: 'Exhausted: give them space' },
];

// ---- Concerns (clinical escalation): keys mirror sql/43 CHECKs ----
export const CONCERN_REASONS = [
  { key: 'self_harm',               label: 'Talk of self-harm',            hint: 'Anything about ending it, or being a burden' },
  { key: 'severe_distress',         label: 'Severe emotional distress',    hint: 'Crying, despair, hopelessness' },
  { key: 'severe_pain',             label: 'Severe untreated pain',        hint: 'Pain the treating team may not know about' },
  { key: 'treatment_stopped_money', label: 'Treatment stopped (money)',    hint: 'Paused or dropped treatment over costs' },
  { key: 'financial_hardship',      label: 'Severe financial hardship',    hint: 'Loans, selling assets, cutting back on food' },
  { key: 'caregiver_burnout',       label: 'Caregiver burning out',        hint: 'Exhausted, unwell, carrying it alone' },
  { key: 'malnutrition_risk',       label: 'Malnutrition risk',            hint: 'Weight loss, barely eating' },
  { key: 'condition_critical',      label: 'Condition critical',           hint: 'Sudden decline: emergency-adjacent' },
  { key: 'grief_risk',              label: 'Complicated grief',            hint: 'Family struggling after a loss' },
  { key: 'family_conflict',         label: 'Family conflict / disclosure', hint: 'Diagnosis hidden, tension at home' },
  { key: 'other',                   label: 'Something else',               hint: 'Trust your judgment, flag it anyway' },
];
export const CONCERN_SEVERITIES = [
  { key: 'urgent', label: 'Urgent: today',        tone: 'danger' },
  { key: 'high',   label: 'High: this week',      tone: 'warn' },
  { key: 'watch',  label: 'Watch: keep an eye',   tone: 'info' },
];
export const concernReason   = (k) => CONCERN_REASONS.find(r => r.key === k)    || { key: k, label: k, hint: '' };
export const concernSeverity = (k) => CONCERN_SEVERITIES.find(s => s.key === k) || CONCERN_SEVERITIES[1];

// ---- 1:1 care sessions: keys mirror sql/43 CHECKs ----
export const SESSION_KINDS = [
  { key: 'wellbeing', label: 'Well-being / therapy', icon: 'heart',
    who:  'held by the counselling team',
    desc: 'A one-to-one with the counselling team for the patient: stress, anxiety, low mood, grief. PHQ-4 before and after a few sessions makes the change visible.' },
  { key: 'nutrition', label: 'Nutrition', icon: 'leaf',
    who:  'held by the nutrition team',
    desc: 'A one-to-one with the nutrition team: eating during treatment, weight loss, side-effects. Starts with a MUST screen and ends with a simple plan the family can follow.' },
  { key: 'caregiver', label: 'Caregiver support', icon: 'users',
    who:  'held by the counselling team',
    desc: 'A one-to-one for the family member giving care: burnout, practical guidance, and space to talk about what they are carrying.' },
];
export const SESSION_STATUSES = [
  { key: 'invited',   label: 'Invited',   tone: 'info',    live: true },
  { key: 'agreed',    label: 'Said yes',  tone: 'gold',    live: true },
  { key: 'scheduled', label: 'Scheduled', tone: 'primary', live: true },
  { key: 'held',      label: 'Held',      tone: 'ok',      live: false },
  { key: 'declined',  label: 'Declined',  tone: 'neutral', live: false },
  { key: 'no_show',   label: 'No-show',   tone: 'warn',    live: false },
  { key: 'cancelled', label: 'Cancelled', tone: 'neutral', live: false },
];
export const sessionKind   = (k) => SESSION_KINDS.find(s => s.key === k)    || SESSION_KINDS[0];
export const sessionStatus = (k) => SESSION_STATUSES.find(s => s.key === k) || SESSION_STATUSES[0];

// ---- Resource library categories: keys mirror sql/43 CHECKs ----
// The shelf families actually need, not just the one we started with.
// Keys match the `category` column and the public directory at
// directory.html, so anything filed here is shareable straight away.
export const RESOURCE_CATEGORIES = [
  { key: 'accommodation', label: 'Stay near treatment', icon: 'home' },
  { key: 'financial_aid', label: 'Financial aid',       icon: 'shieldCheck' },
  { key: 'clinical',      label: 'Doctors & hospitals', icon: 'stethoscope' },
  { key: 'trials',        label: 'Clinical trials',     icon: 'fileText' },
  { key: 'travel',        label: 'Travel help',         icon: 'arrowRight' },
  { key: 'food',          label: 'Food & meals',        icon: 'leaf' },
  { key: 'medicines',     label: 'Medicines',           icon: 'plus' },
  { key: 'nutrition',     label: 'Nutrition guidance',  icon: 'leaf' },
  { key: 'counselling',   label: 'Emotional support',   icon: 'heart' },
  { key: 'caregiver',     label: 'Caregiver support',   icon: 'users' },
  { key: 'community',     label: 'Community groups',    icon: 'users' },
  { key: 'palliative',    label: 'Palliative & home care', icon: 'handHeart' },
  { key: 'other',         label: 'Other help',          icon: 'star' },
];
export const resourceCategory = (k) =>
  RESOURCE_CATEGORIES.find(c => c.key === k) || RESOURCE_CATEGORIES[RESOURCE_CATEGORIES.length - 1];

// vulnerability score (0-10) → badge
export function vulnerabilityBadge(score) {
  if (score == null) return '<span class="badge badge-neutral">N/A</span>';
  const cls = score >= 5 ? 'badge-danger' : score >= 3 ? 'badge-warn' : 'badge-ok';
  return `<span class="badge ${cls}" title="Household vulnerability (dependents + income + insurance + distance)">V${score}</span>`;
}

// ============================================================
// GUIDED INSTRUMENTS: the actual questionnaire items, so a
// psychology intern administers the real tool, item by item,
// and the score sums itself. `options` are [label, points] and
// apply to every item. An item may instead be an object
// { q, options } carrying its OWN option set, used by MUST,
// where BMI / weight-loss / acute-illness each score differently.
// The wizard sums points across all items and shows the running
// total against the measure's max.
// ============================================================
// Bilingual option labels: English · Hindi (transliterated, for callers in India).
const PHQ4_OPTIONS = [['Not at all · bilkul nahi', 0], ['Several days · kabhi-kabhi', 1], ['More than half the days · aadhe se zyada din', 2], ['Nearly every day · roz jaisa', 3]];
const ZARIT_OPTIONS = [['Never · kabhi nahi', 0], ['Rarely · kabhi-kabhaar', 1], ['Sometimes · kabhi kabhi', 2], ['Quite often · aksar', 3], ['Nearly always · hamesha jaisa', 4]];
const BGQ_OPTIONS = [['Not at all · bilkul nahi', 0], ['Somewhat · thoda', 1], ['A lot · bahut', 2]];

export const INSTRUMENTS = {
  phq4_patient: {
    intro: 'Ask gently: “Over the last 2 weeks, how often have you been bothered by…”. Read the English line, then the Hindi, then offer the four choices.',
    options: PHQ4_OPTIONS,
    items: [
      { q: 'Feeling nervous, anxious, or on edge',
        hindi: 'Aapka tension ya gabraya hua mehsus hota hai phichle kuch samay se?',
        probe: 'If unsure: “Kya aapka dil dhadakta hai ya haath kaampte hain jab tension hoti hai?”' },
      { q: 'Not being able to stop or control worrying',
        hindi: 'Aapko lagta hai ki aap apni worry/chinta ko rokna chahte hain par rok nahi paate?',
        probe: '“Kya raat ko sone se pehle bhi yeh khayal aate rehte hain?”' },
      { q: 'Feeling down, depressed, or hopeless',
        hindi: 'Kya aapko udaas ya hopeless (kuch theek nahi hoga aisa) feel hota hai?',
        probe: 'Gently: “Kya kabhi rone ka mann karta hai ya kuch karne ka mann nahi karta?” Watch for hopelessness, escalate if severe.' },
      { q: 'Little interest or pleasure in doing things',
        hindi: 'Jo kaam pehle aapko pasand the (jaise TV dekhna, baat karna), unmein ab interest kam hua hai?',
        probe: '“Kya aap pehle jitna logon se baat karte the, ab bhi karte hain?”' },
    ],
    interpret: '0-2 none · 3-5 mild · 6-8 moderate · 9-12 severe. 6+ → flag to your supervisor; anxiety items are Q1-2, depression Q3-4.',
  },
  phq4_caregiver: {
    intro: 'Same four questions, asked OF THE CAREGIVER about themselves. Caregivers minimise their own distress, open first with: “And how have YOU been holding up?” / “Aap inki dekhbhal karte karte khud kaisa feel kar rahe hain?”',
    options: PHQ4_OPTIONS,
    items: [
      { q: 'Feeling nervous, anxious, or on edge',
        hindi: 'Aapko tense ya ghabraye hua feel hota hai abhi yeh sab ke dauraan?',
        probe: '“Kya aapko lagta hai ki sab kuch sambhal nahi paa rahe?”' },
      { q: 'Not being able to stop or control worrying',
        hindi: 'Kya aap chahte hain ki tension band ho par ruk nahi paati?' },
      { q: 'Feeling down, depressed, or hopeless',
        hindi: 'Kya aapko khud udaas ya thaka hua (hopeless) feel hota hai?',
        probe: '“Koi hai jo aapki bhi sun sake, jab aap thak jaate hain?”' },
      { q: 'Little interest or pleasure in doing things',
        hindi: 'Apne liye jo time pehle nikalte the, woh ab mil paata hai?' },
    ],
    interpret: '0-2 none · 3-5 mild · 6-8 moderate · 9-12 severe. 6+ → offer a well-being session and tell your supervisor.',
  },
  zarit_burden: {
    intro: 'Screen for caregiver strain (Zarit-4). Ask the caregiver: “Do you ever feel…”',
    extraProbes: [
      'Have you felt more irritated or angry than usual?',
      'Do you feel emotionally numb or checked out?',
      'Any physical signs of stress: headaches, body pain, feeling unwell?',
      'Do you feel like you are losing yourself in caregiving?',
    ],
    options: ZARIT_OPTIONS,
    items: [
      { q: '…that because of the time you spend with your relative, you don’t have enough time for yourself?',
        hindi: 'Kya aapko lagta hai ki inki dekhbhal karte karte aapke paas apne liye time hi nahi bachta?',
        probe: '“Aap khud ke liye, jaise khana khane ya rest karne ka time nikal paate hain?”' },
      { q: '…stressed between caring for your relative and meeting other family or work responsibilities?',
        hindi: 'Kya inki dekhbhal aur ghar ke/kaam ke doosre kaamon ko sambhalna aapke liye stressful hai?',
        probe: '“Kaam ya ghar ke doosre log iski wajah se affect ho rahe hain?”' },
      { q: '…angry or strained when you are around your relative?',
        hindi: 'Kya kabhi unke saath rehte hue gussa ya irritation feel hota hai?',
        probe: 'Reassure: “Yeh feel hona normal hai, hum sirf samajhna chahte hain.”' },
      { q: '…uncertain about what to do about your relative?',
        hindi: 'Kya aapko lagta hai ki aage kya karna hai, yeh samajh nahi aata?',
        probe: '“Kisi specific situation mein confusion hota hai, jaise emergency mein?”' },
    ],
    interpret: '0-7 lighter burden · 8+ high burden → suggest caregiver support + respite ideas.',
  },
  grief_screen: {
    intro: 'Brief Grief Questionnaire: only at ~3 months after the loss, on a call the family welcomed. Soft tone, no rush.',
    options: BGQ_OPTIONS,
    items: [
      { q: 'How much are you having trouble accepting the death?',
        hindi: 'Aapko unke jaane ko accept karne mein kitni mushkil ho rahi hai?',
        probe: '“Kya kabhi lagta hai jaise woh abhi bhi yahin hain?”' },
      { q: 'How much does grief interfere with your daily life?',
        hindi: 'Kya yeh dukh aapke roz ke kaam (khana, sona, kaam par jaana) mein rukawat daal raha hai?',
        probe: '“Kya neend ya bhookh par bhi farak pada hai?”' },
      { q: 'How much are you having troubling images or thoughts about the death?',
        hindi: 'Kya unke jaane se related koi pareshaan karne wale khayal ya tasveerein mann mein aati hain?',
        probe: 'Gently, don’t push for graphic detail; confirm presence/frequency only.' },
      { q: 'How much are you avoiding things connected to the loss (places, people, activities)?',
        hindi: 'Kya aap unse judi jagah, log, ya kaamon se bachne ki koshish karte hain?',
        probe: '“Koi jagah ya cheez hai jo aap ab avoid karte hain?”' },
      { q: 'How much do you feel cut off or distant from people?',
        hindi: 'Kya aap logon se door ya kata hua feel karte hain?',
        probe: '“Kya pehle jaisa logon se milna-julna ab bhi hota hai?”' },
    ],
    interpret: '5+ → likely complicated grief; offer counselling referral and inform your supervisor.',
  },
  financial_toxicity: {
    intro: 'Money is sensitive, ask only once there’s trust. Open warmly: “May I ask how the cost of treatment is affecting the family?” / “Treatment ka kharcha aapke ghar ki financial situation ko kitna nuksan pohcha raha hai?”',
    options: [['Not at all · bilkul nahi', 0], ['Somewhat · thoda', 1], ['Very much · bahut', 2]],
    items: [
      { q: 'Do you worry about the money problems the illness and treatment may cause?',
        hindi: 'Kya aapko bimari aur ilaaj ke kharche ki chinta rehti hai?' },
      { q: 'Has paying for care used up savings, or meant loans or borrowing?',
        hindi: 'Kya ilaaj ke liye jama-poonji kharch ho gayi, ya udhaar/loan lena pada?',
        probe: '“Kya iske liye paise udhaar lene pade ya kuch bechna pada?”' },
      { q: 'Have you had to cut back on food, travel, or other basics to afford treatment?',
        hindi: 'Kya ilaaj ke liye khaane, aane-jaane ya zaroori cheezon mein kami karni padi?' },
      { q: 'Is it hard to meet the monthly household and medical bills?',
        hindi: 'Kya har mahine ghar ke aur ilaaj ke kharche pure karna mushkil hota hai?' },
      { q: 'Do money worries cause stress or tension at home?',
        hindi: 'Kya paise ki chinta se ghar mein tension rehti hai?' },
    ],
    interpret: '0-3 minimal · 4-6 moderate financial stress · 7+ high financial toxicity → flag for financial-aid guidance.',
  },
  must_malnutrition: {
    intro: 'MUST nutrition screen: three quick scores that add up. Use the patient’s BMI (or recent weight & height), any unplanned weight loss, and whether they’ve been acutely unwell with little to eat.',
    note: 'If you are unsure how to score this, ask the assigned nutritionist before finalizing, please do not guess this one.',
    items: [
      { q: 'Body-mass index: BMI (weight in kg ÷ height in m²)',
        hindi: 'Wazan aur sehat kaisi hai, bahut patle to nahi?',
        options: [['Over 20 (healthy)', 0], ['18.5-20 (low)', 1], ['Under 18.5 (very low)', 2]] },
      { q: 'Unplanned weight loss over the last 3-6 months',
        hindi: 'Pichle kuch mahino mein wazan kam hua hai?',
        options: [['Under 5%', 0], ['5-10%', 1], ['Over 10%', 2]] },
      { q: 'Is the patient acutely unwell AND has had little or no food for more than 5 days?',
        hindi: 'Khana khane mein dikkat hoti hai (kam khaana, nigalne mein problem)? 5 din se zyada se kam khaaya?',
        options: [['No', 0], ['Yes', 2]] },
    ],
    interpret: '0 low risk · 1 medium risk (watch & repeat) · 2+ high risk → refer to the dietitian and start nutrition support.',
  },
};

// ============================================================
// CALL-STAGE PLAYBOOK: relationship first, never a sales script.
// stage = which call this is for the patient (1st, 2nd, 3rd+).
// ============================================================
export const STAGE_GUIDES = [
  {
    stage: 1,
    title: 'First call: just build the relationship',
    tone: 'clay',
    what: 'No pitching today. Introduce yourself and Jarurat Care (free, no selling: we exist to help), listen to their story, let them feel heard.',
    openers: [
      '“Namaste, am I speaking with ___? I’m calling from Jarurat Care. We support families going through cancer treatment, completely free. Is this a good time to talk for a few minutes?”',
      '“How are you, and how is the treatment journey going so far?”',
      '“Who is with you in this journey at home?”',
    ],
    avoid: 'Don’t open with services, WhatsApp links, or a list of questions. If they ask what we offer, answer warmly and briefly, then return to them.',
    capture: 'Just the outcome, how they were doing, anything they asked for, and your notes.',
  },
  {
    stage: 2,
    title: 'Second call: understand, consent, details',
    tone: 'info',
    what: 'They know you now. If the last call felt good, ask permission to understand their medical situation properly so our doctors and nutritionists can actually help.',
    openers: [
      '“Last time we spoke you mentioned ___. How has that been since?”',
      '“If it’s okay with you, may I note down a few details about the diagnosis and treatment? It stays private and helps our team guide you better.” (this is the consent moment)',
      '“If you have a discharge summary or report handy, you could share it on WhatsApp whenever convenient, no hurry.”',
    ],
    avoid: 'If they hesitate about details, drop it instantly and stay with the relationship. Consent must feel optional, because it is.',
    capture: 'Consent (if given), clinical details (subtype, stage, hospital, treatment), what they asked for, the WhatsApp invitation if the moment is right.',
  },
  {
    stage: 3,
    title: 'Third call onwards: deepen the support',
    tone: 'ok',
    what: 'Now we help concretely: match what they NEED to what we HAVE (financial-aid guidance, nutrition plans, second opinions, well-being sessions), and start tracking how they are really doing.',
    openers: [
      '“You mentioned the costs were worrying you. I looked into it, and here’s what we can do…”',
      '“Our nutrition circle meets Saturday in the WhatsApp group. Shall I make sure you get the link?”',
      '“May I ask a few short questions about how you’ve been feeling? It helps us see if our support is actually working.” (PHQ-4 moment)',
    ],
    avoid: 'Don’t turn it into a checklist march. One or two meaningful steps per call.',
    capture: 'Services offered, well-being scores when natural, condition, the next check-in promise, and keep every promise.',
  },
];
export const stageGuide = (callNumber) =>
  STAGE_GUIDES[Math.min(Math.max(callNumber, 1), 3) - 1];

// ============================================================
// DATA-GAP RADAR: what we don't know about a patient yet, with
// the natural way to ask it and the EARLIEST call it's okay to
// ask (deep clinical questions wait for trust, call 3+).
// Each gap carries an inline input spec so the caller can capture
// the answer right where the prompt is.
// ============================================================
const GAP_DEFS = [
  { key: 'caregiver_name', stage: 2, label: 'Caregiver', ask: '“Who looks after you at home?”',
    when: (p) => !p.caregiver_name,
    input: { kind: 'text', placeholder: 'Caregiver name' },
    patch: (v) => ({ caregiver_name: v }) },
  { key: 'caregiver_phone', stage: 2, label: 'Caregiver phone', ask: '“Could I note their number too, in case you’re resting?”',
    when: (p) => !!p.caregiver_name && !p.caregiver_phone_full,
    input: { kind: 'tel', placeholder: '98765 43210' },
    patch: (v) => ({ caregiver_phone_full: v, caregiver_phone_masked: 'XXXXX-X' + v.replace(/\D/g, '').slice(-4) }) },
  { key: 'caregiver_relationship', stage: 2, label: 'Caregiver relation', ask: '“And how are they related to the patient: son, daughter, spouse?”',
    when: (p) => !!p.caregiver_name && !p.caregiver_relationship,
    input: { kind: 'select', options: [
      { key: 'Spouse', label: 'Spouse' }, { key: 'Son', label: 'Son' }, { key: 'Daughter', label: 'Daughter' },
      { key: 'Parent', label: 'Parent' }, { key: 'Sibling', label: 'Sibling' },
      { key: 'Daughter-in-law', label: 'Daughter-in-law' }, { key: 'Son-in-law', label: 'Son-in-law' },
      { key: 'Other relative', label: 'Other relative' }, { key: 'Friend', label: 'Friend' }] },
    patch: (v) => ({ caregiver_relationship: v }) },
  { key: 'caregiver_gender', stage: 2, label: 'Caregiver gender', ask: 'Note quietly. Is the primary caregiver a man or a woman? (Often the daughter/wife carries it.)',
    when: (p) => !!p.caregiver_name && !p.caregiver_gender,
    input: { kind: 'select', options: [
      { key: 'female', label: 'Woman' }, { key: 'male', label: 'Man' }, { key: 'other', label: 'Other' }] },
    patch: (v) => ({ caregiver_gender: v }) },
  { key: 'treating_hospital', stage: 2, label: 'Treatment centre', ask: '“Where is the treatment happening?”',
    when: (p) => !p.treating_hospital,
    input: { kind: 'text', placeholder: 'Hospital name' },
    patch: (v) => ({ treating_hospital: v }) },
  { key: 'current_treatment', stage: 2, label: 'Current treatment', ask: '“What treatment is going on right now?”',
    when: (p) => !p.current_treatment,
    input: { kind: 'text', placeholder: 'e.g., chemo cycle 3' },
    patch: (v) => ({ current_treatment: v }) },
  { key: 'primary_language', stage: 2, label: 'Language', ask: '“Which language are you most comfortable in?”',
    when: (p) => !p.primary_language,
    input: { kind: 'text', placeholder: 'e.g., Hindi' },
    patch: (v) => ({ primary_language: v }) },
  { key: 'location', stage: 2, label: 'City', ask: '“Which city or town are you calling from?”',
    when: (p) => !p.city && !p.state,
    input: { kind: 'text', placeholder: 'City' },
    patch: (v) => ({ city: v }) },
  { key: 'age', stage: 2, label: 'Age', ask: '“May I ask the patient’s age?”',
    when: (p) => p.age == null,
    input: { kind: 'number', placeholder: 'Age', min: 0, max: 120 },
    patch: (v) => ({ age: Number(v) }) },
  { key: 'gi_subtype', stage: 3, label: 'Exact GI subtype', ask: '“The doctors said GI cancer. Do you know which type exactly? Liver, stomach, pancreas, colon…?”',
    when: (p) => !p.gi_subtype,
    input: { kind: 'select', options: GI_SUBTYPES },
    patch: (v) => ({ gi_subtype: v, cancer_type: giLabel(v) }) },
  { key: 'cancer_stage', stage: 3, label: 'Stage', ask: '“Did the doctors mention which stage it is?”',
    when: (p) => !p.cancer_stage || p.cancer_stage === 'unknown',
    input: { kind: 'select', options: [
      { key: 'stage_i', label: 'Stage I' }, { key: 'stage_ii', label: 'Stage II' },
      { key: 'stage_iii', label: 'Stage III' }, { key: 'stage_iv', label: 'Stage IV' },
      { key: 'not_applicable', label: 'Not applicable' }] },
    patch: (v) => ({ cancer_stage: v }) },
  { key: 'insurance', stage: 3, label: 'Insurance', ask: '“Do you have any insurance, or a scheme like Ayushman Bharat?”',
    when: (p) => !p.insurance_status || p.insurance_status === 'unknown',
    input: { kind: 'select', options: [
      { key: 'insured', label: 'Insured' }, { key: 'govt_scheme', label: 'Govt scheme' },
      { key: 'uninsured', label: 'No insurance' }] },
    patch: (v) => ({ insurance_status: v }) },
  { key: 'payment', stage: 3, label: 'How they pay', ask: '“How is the family managing the treatment costs?”',
    when: (p) => !p.payment_method,
    input: { kind: 'text', placeholder: 'e.g., savings, loan, scheme' },
    patch: (v) => ({ payment_method: v }) },
  { key: 'diagnosis_date', stage: 3, label: 'When diagnosed', ask: '“Around when was it first diagnosed?”',
    when: (p) => !p.diagnosis_date,
    input: { kind: 'month' },
    patch: (v) => ({ diagnosis_date: v + '-01' }) },
  { key: 'distance', stage: 3, label: 'Distance to care', ask: '“How far do you travel for treatment?”',
    when: (p) => p.distance_to_treatment_km == null,
    input: { kind: 'number', placeholder: 'km', min: 0 },
    patch: (v) => ({ distance_to_treatment_km: Number(v) }) },
  { key: 'dependents', stage: 3, label: 'Dependents', ask: '“How many people at home depend on the family income?”',
    when: (p) => p.dependents_count == null,
    input: { kind: 'number', placeholder: '#', min: 0, max: 20 },
    patch: (v) => ({ dependents_count: Number(v) }) },
  { key: 'ecog', stage: 4, label: 'Activity level (ECOG)', ask: '“How much of the day are they up and about, versus resting?”',
    when: (p) => p.ecog_status == null,
    input: { kind: 'select', options: ECOG.map(e => ({ key: String(e.key), label: e.label })) },
    patch: (v) => ({ ecog_status: Number(v) }) },
  { key: 'trajectory', stage: 4, label: 'Treatment goal', ask: '“Have the doctors talked about the goal: cure, or comfort and control?”',
    when: (p) => !p.trajectory,
    input: { kind: 'select', options: TRAJECTORIES.filter(t => t.key !== 'unknown') },
    patch: (v) => ({ trajectory: v }) },
];

// All gaps for a patient. Call 1 is relationship-only BY DESIGN; from call 2
// onward every question is available (stage now only orders them, gentler
// asks first. It no longer locks the deeper ones behind call 3/4).
export function dataGaps(patient, callNumber = 99) {
  return GAP_DEFS.filter(g => g.when(patient))
    .sort((a, b) => a.stage - b.stage)
    .map(g => ({ ...g, unlocked: callNumber >= 2 }));
}
