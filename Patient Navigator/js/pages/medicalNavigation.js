// PN130 - dedicated assigned-only workflow. Server APIs remain authoritative.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, isImpersonating } from '../auth.js';

const ROLES = ['admin','manager','caller','caregiver_mentor','medical_navigator'];
const HISTORY = ['calls','sessions','assessments','services','assignments','notes','medical','events','documents'];
const TITLES = { calls:'Call history',sessions:'Sessions',assessments:'Assessments',services:'Support services',assignments:'Care assignments',notes:'Patient notes',medical:'Medical calls and notes',events:'Medical assignment history',documents:'Documents' };
const PATIENT_SECTIONS = {
  "Patient and contact": [
    ["patient_code","Patient ID"],
    ["full_name","Patient name"],
    ["age","Age"],
    ["gender","Gender"],
    ["phone_masked","Patient phone (masked)"],
    ["phone_full","Patient phone"],
    ["email","Email"],
    ["primary_language","Preferred language"],
    ["message_language","Message language"],
    ["health_literacy","Health literacy"],
    ["state","State"],
    ["city","City"],
    ["pin_code","PIN code"],
    ["home_state","Home state"],
    ["date_of_birth","Date of birth"],
    ["occupation","Occupation"],
    ["home_district","Home district"]
  ],
  "Caregiver and family": [
    ["caregiver_name","Caregiver name"],
    ["caregiver_relationship","Relationship"],
    ["caregiver_gender","Caregiver gender"],
    ["caregiver_phone_masked","Caregiver phone (masked)"],
    ["caregiver_phone_full","Caregiver phone"],
    ["family_support","Family support"],
    ["marital_status","Marital status"],
    ["nominee_name","Nominee"],
    ["nominee_relationship","Nominee relationship"],
    ["dependents_count","Dependents"]
  ],
  "Diagnosis and treatment": [
    ["cancer_type","Cancer type"],
    ["cancer_stage","Cancer stage"],
    ["diagnosis_date","Diagnosis date"],
    ["gi_subtype","GI subtype"],
    ["primary_site","Primary site"],
    ["histology","Histology"],
    ["metastatic_sites","Metastatic sites"],
    ["biomarkers","Biomarkers"],
    ["tnm_stage","TNM stage"],
    ["ecog_status","ECOG status"],
    ["trajectory","Treatment trajectory"],
    ["comorbidities","Comorbidities"],
    ["allergies","Allergies"],
    ["stoma_type","Stoma / device"],
    ["treating_hospital","Treating hospital"],
    ["treating_doctor","Treating doctor"],
    ["current_treatment","Current treatment"],
    ["referring_doctor","Referring doctor"],
    ["clinical_trial_aware","Clinical trial awareness"],
    ["treatment_city","Treatment city"],
    ["distance_to_treatment_km","Distance to treatment (km)"]
  ],
  "Hospital registration": [
    ["hospital_case_no","Hospital case number"],
    ["registration_category","Registration category"],
    ["hospital_registered_on","Hospital registration date"],
    ["hospital_unit","Hospital unit"],
    ["hospital_opd_days","OPD days"],
    ["abha_present","ABHA present"],
    ["resident_of_treatment_city","Resident of treatment city"],
    ["referred_by","Referred by"],
    ["referred_for","Referred for"]
  ],
  "Practical support": [
    ["insurance_status","Insurance"],
    ["economic_status","Economic status"],
    ["payment_method","Payment method"],
    ["employment_at_diagnosis","Employment at diagnosis"],
    ["family_income_annual_inr","Annual family income (INR)"],
    ["family_income_basis","Income source"],
    ["aid_amount_needed_inr","Aid needed (INR)"],
    ["aid_need_note","Aid need note"],
    ["railway_concession_from","Rail concession from"],
    ["railway_concession_to","Rail concession to"],
    ["documents_held","Documents held"],
    ["documents_missing","Documents missing"],
    ["documents_asked_on","Documents requested on"],
    ["vulnerability_score","Vulnerability score"]
  ],
  "Care and follow-up": [
    ["legacy_notes","Earlier patient notes"],
    ["assigned_caller_name","Recorded caller name"],
    ["first_contact_at","First contact"],
    ["call_stage","Call stage"],
    ["pitched_therapy_at","Therapy discussed"],
    ["pitched_nutrition_at","Nutrition discussed"],
    ["pitched_caregiver_at","Caregiver support discussed"],
    ["pitched_clinical_trial_at","Clinical trial discussed"],
    ["pitched_financial_aid_at","Financial aid discussed"],
    ["follow_up_date","Follow-up date"],
    ["follow_up_instruction","Follow-up instruction"],
    ["patient_status","Patient status"],
    ["status_changed_at","Status changed"],
    ["date_of_death","Date of death"],
    ["bereavement_support_offered","Bereavement support offered"],
    ["bereavement_support_type","Bereavement support"],
    ["funeral_debt","Funeral debt"],
    ["child_school_6m","Child schooling at 6 months"],
    ["child_school_12m","Child schooling at 12 months"],
    ["caregiver_contact","Current caregiver mentor"],
    ["original_caregiver_contact","Original caregiver mentor"],
    ["nutrition_contact","Nutrition contact"],
    ["nutrition_owner_at","Nutrition assigned at"],
    ["nutrition_owner_source","Nutrition assignment source"],
    ["nutrition_released_at","Nutrition released at"]
  ],
  "Contact permissions and source": [
    ["is_active","Active patient record"],
    ["do_not_call","Do not call"],
    ["do_not_call_reason","Do-not-call reason"],
    ["disinterest_level","Engagement status"],
    ["disinterest_marked_at","Engagement status recorded"],
    ["engagement_hold_until","Engagement hold until"],
    ["is_blacklisted","Blacklisted"],
    ["blacklist_reason","Blacklist reason"],
    ["blacklisted_at","Blacklisted on"],
    ["blacklist_reviewed","Blacklist reviewed"],
    ["blacklist_review_note","Blacklist review note"],
    ["blacklist_set_dnc","Blacklist set do not call"],
    ["whatsapp_do_not_message","Do not message"],
    ["whatsapp_opted_out_at","Messaging opt-out recorded"],
    ["consent_given","Patient consent"],
    ["consent_date","Patient consent date"],
    ["consent_method","Consent method"],
    ["consent_purpose","Consent purpose"],
    ["data_retention_until","Retention until"],
    ["is_demo","Fictional / demo record"],
    ["created_at","Record created"],
    ["updated_at","Record updated"]
  ]
};
const HISTORY_FIELDS = {
  "calls": [
    ["call_date","Call time"],
    ["author_name","Recorded by"],
    ["call_team","Care team"],
    ["lead_source","Lead source"],
    ["dial_status","Dial status"],
    ["call_duration_mins","Duration (minutes)"],
    ["patient_mindset","Patient mindset"],
    ["value_pitch_executed","Support explained"],
    ["whatsapp_group_joined","WhatsApp group joined"],
    ["social_media_follow","Social media follow"],
    ["resource_shared","Resource shared"],
    ["conversion_score","Conversion score"],
    ["follow_up_date","Follow-up date"],
    ["follow_up_priority","Follow-up priority"],
    ["caller_notes","Call notes"],
    ["resistance_reason","Resistance reason"],
    ["key_concerns","Key concerns"],
    ["qa_reviewed","QA reviewed"],
    ["qa_review_date","QA review date"],
    ["qa_score","QA score"],
    ["qa_notes","QA notes"],
    ["contacted_by_name","Spoke with"],
    ["requirements_noted","Requirements"],
    ["social_media_response","Social media response"],
    ["receptiveness_bucket","Receptiveness"],
    ["next_followup_date","Next follow-up"],
    ["followup_strategy_notes","Follow-up plan"],
    ["patient_condition","Patient condition"],
    ["whatsapp_link_sent","WhatsApp link sent"],
    ["feedback_patient","Patient feedback"],
    ["feedback_caregiver","Caregiver feedback"],
    ["main_request_resolved","Main request resolved"],
    ["unplanned_interruption","Unplanned interruption"],
    ["unplanned_interruption_reason","Interruption reason"],
    ["nutrition_followup_mode","Nutrition follow-up source"],
    ["nutrition_followup_due_on","Nutrition follow-up due"],
    ["created_at","Logged at"],
    ["has_additional_structured_source","Additional structured source exists"]
  ],
  "sessions": [
    ["kind","Session kind"],
    ["status","Session status"],
    ["author_name","Invited by"],
    ["invited_at","Invited at"],
    ["agreed_at","Agreed at"],
    ["scheduled_at","Scheduled at"],
    ["held_at","Held at"],
    ["duration_mins","Duration (minutes)"],
    ["session_notes","Session notes"],
    ["created_at","Logged at"],
    ["updated_at","Updated at"]
  ],
  "assessments": [
    ["measure","Measure"],
    ["score","Score"],
    ["notes","Assessment notes"],
    ["author_name","Recorded by"],
    ["recorded_at","Recorded at"],
    ["has_additional_assessment_detail","Additional assessment source exists"]
  ],
  "services": [
    ["lever","Support service"],
    ["done","Completed"],
    ["detail","Service details"],
    ["amount","Amount"],
    ["sessions","Sessions"],
    ["outcome","Outcome"],
    ["author_name","Recorded by"],
    ["recorded_at","Recorded at"],
    ["updated_at","Updated at"],
    ["entry_source","Entry source"]
  ],
  "assignments": [
    ["from_name","Previous caregiver"],
    ["to_name","New caregiver"],
    ["author_name","Changed by"],
    ["reason","Assignment reason"],
    ["changed_at","Changed at"],
    ["team","Care team"]
  ],
  "notes": [
    ["author_name","Written by"],
    ["author_role","Author role"],
    ["kind","Note kind"],
    ["body","Patient note"],
    ["pinned","Pinned"],
    ["acknowledged_at","Acknowledged at"],
    ["created_at","Written at"],
    ["updated_at","Updated at"]
  ],
  "medical": [
    ["author_name","Written by"],
    ["kind","Medical entry kind"],
    ["body","Medical note"],
    ["call_at","Call time"],
    ["dial_status","Dial status"],
    ["duration_mins","Duration (minutes)"],
    ["follow_up_on","Follow-up date"],
    ["created_at","Written at"]
  ],
  "events": [
    ["author_name","Changed by"],
    ["action","Medical assignment action"],
    ["from_name","Previous medical navigator"],
    ["to_name","New medical navigator"],
    ["created_at","Changed at"]
  ],
  "documents": [
    ["source","Document source"],
    ["doc_type","Document type"],
    ["mime_type","File type"],
    ["document_date","Document date"],
    ["page_no","Page number"],
    ["page_count","Page count"],
    ["issuing_body","Issuing body"],
    ["typed_text","Intake notes"],
    ["source_name","Source filename"],
    ["doc_class","Document class"],
    ["legible","Legibility"],
    ["caption","Received caption"]
  ]
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let releaseView = null;
function clinicalFields(record,allowed) {
  return allowed.filter(([key])=>record?.[key]!==null && record?.[key]!==undefined && record?.[key]!=='')
    .map(([key,title])=>{const value=record[key];
      // Only admitted scalar/typed scalar-array values; no recursive unknown
      // objects, mechanically prettified keys, raw IDs or diagnostic dumps.
      if(typeof value==='object' && (!Array.isArray(value)||value.some(v=>v!==null&&typeof v==='object')))return '';
      const text=Array.isArray(value)?value.join(', '):typeof value==='boolean'?(value?'Yes':'No'):String(value);
      return '<div style="min-width:0;overflow-wrap:anywhere"><dt class="text-muted">'+esc(title)+'</dt><dd style="margin:0;white-space:pre-wrap">'+esc(text)+'</dd></div>';
    }).join('');
}
function patientSections(patient){
  return Object.entries(PATIENT_SECTIONS).map(([title,fields])=>{
    const facts=clinicalFields(patient,fields);
    return facts?'<section><h3>'+esc(title)+'</h3><dl style="display:grid;gap:12px">'+facts+'</dl></section>':'';
  }).join('');
}

function recordedDetails(record,kind) {
  if(kind==='calls')return clinicalFields(record.structured,[['requirements','Requirements'],['custom_requirement','Other requirement'],
    ['condition','Recorded condition'],['whatsapp_link_sent','WhatsApp link sent'],['whatsapp','WhatsApp group joined'],['consent_taken','Consent recorded']]);
  if(kind==='assessments'){
    const detail=record.details;
    if(!detail||typeof detail!=='object'||Array.isArray(detail))return '';
    const items=Array.isArray(detail.items)?detail.items.filter(item=>item&&typeof item.q==='string'&&typeof item.points==='number'):[];
    return clinicalFields(detail,[['instrument','Assessment instrument'],['total','Recorded total']])+items.map(item=>
      '<div><dt>'+esc(item.q)+'</dt><dd>Recorded score: '+esc(item.points)+'</dd></div>').join('');
  }
  return '';
}

export async function renderMedicalNavigation(container) {
  releaseView?.();
  const sb = getSupabase();
  const actor = getCurrentUser()?.id;
  const initialRole = getCurrentProfile()?.role;
  let disposed = false, epoch = 0, queueOffset = 0, selected = null, context = null;
  let observer = null, subscription = null, refreshTimer = null, pmPanel151 = null;
  let busy = false, submitting = false, submission = null, historyEpoch = 0;
  let historyRows = [], historyOffset = 0, historyKind = 'medical', assignees = [];
  const urls = new Set();
  const timers = new Set();
  const current = () => !disposed && container.isConnected && getCurrentUser()?.id===actor
    && getCurrentProfile()?.id===actor && getCurrentProfile()?.role===initialRole
    && getCurrentProfile()?.is_active===true && getCurrentProfile()?.must_change_password!==true && !isImpersonating();
  function clearFiles() { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
  function message(text) { const el=container.querySelector('[data-message]'); if(el) el.textContent=text; }
  function clearContext(text) {
    epoch++; historyEpoch++; selected=null; context=null; historyRows=[]; submission=null; clearFiles();
    container.querySelector('[data-context]')?.replaceChildren();
    if(text) message(text);
  }
  function dispose(text) {
    if(disposed) return;
    clearContext(); disposed=true; clearFiles(); for(const timer of timers) clearTimeout(timer); timers.clear();
    clearInterval(refreshTimer); pmPanel151?.dispose(); pmPanel151 = null; window.removeEventListener('hashchange',onRoute); window.removeEventListener('focus',onFocus);
    document.removeEventListener('visibilitychange',onVisibility); observer?.disconnect(); subscription?.unsubscribe();
    container.replaceChildren(); if(text) container.textContent=text;
    if(releaseView===dispose) releaseView=null;
  }
  async function rpc(name,args={},token=epoch) {
    if(!current()) throw new Error('Account changed. Reopen Medical navigation in your own account.');
    let timer;
    try {
      const answer=await Promise.race([sb.rpc(name,args),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Request timed out. Refresh before continuing.')),12000);timers.add(timer);})]);
      if(!current() || token!==epoch) throw new Error('Stale medical response ignored');
      if(answer.error) throw new Error(answer.error.message || 'Medical request failed');
      return answer.data;
    } finally {clearTimeout(timer);timers.delete(timer);}
  }
  function failure(error) {
    if(disposed || error?.message === 'Stale medical response ignored')return;
    if(!current()){dispose('Account changed. Reopen Medical navigation.');return;}
    // On any failed verification, discard clinical context and drafts. The
    // server has already refused stale assignment writes; do not keep its data.
    clearContext(); message(error?.message || 'Access could not be verified. Refresh to try again.');
  }
  async function act(button,fn) {
    if(busy || !current()) return;
    busy=true; if(button) button.disabled=true;
    try {await fn();} catch(error) {failure(error);} finally {busy=false;if(button?.isConnected)button.disabled=false;}
  }
  function queueShell() {
    container.innerHTML='<section class="page-content" data-mednav style="max-width:1100px;margin:auto;overflow-wrap:anywhere">'+
      '<h1>Medical navigation</h1><p>'+(initialRole==='medical_navigator'?'Only patients currently assigned to you appear here.':'Raise a request for a patient you support. Managers assign requests to medical navigators.')+'</p>'+
      '<p role="status" aria-live="polite" data-message></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-secondary" data-refresh>Refresh work</button></div>'+
      (initialRole==='medical_navigator'?'':'<form data-request-form class="card" style="padding:16px;margin-top:16px"><h2>Request medical support</h2><label>Find your patient<input class="form-control" name="search" maxlength="120" autocomplete="off"></label><button class="btn btn-secondary" type="button" data-search>Find patients</button><div data-patients></div><button type="button" data-more-patients hidden>More patients</button><label>Reason<textarea class="form-control" name="reason" maxlength="4000" required></textarea></label><button class="btn btn-primary" type="submit">Raise request</button></form>')+
      '<div data-medical-pm151></div><div data-queue style="margin-top:16px"></div><div style="display:flex;gap:8px"><button class="btn btn-secondary" data-prev hidden>Previous</button><button class="btn btn-secondary" data-next hidden>More requests</button></div><div data-context></div></section>';
    container.querySelector('[data-refresh]').onclick=e=>act(e.target,()=>loadQueue(true));
    container.querySelector('[data-prev]').onclick=e=>act(e.target,async()=>{queueOffset=Math.max(0,queueOffset-50);await loadQueue();});
    container.querySelector('[data-next]').onclick=e=>act(e.target,async()=>{queueOffset+=50;await loadQueue();});
    const form=container.querySelector('[data-request-form]');
    if(form) {
      let patientOffset=0, results=[], chosenPatient='';
      async function search(reset) {
        if(reset){patientOffset=0;results=[];chosenPatient='';}
        const found=await rpc('medical_navigation_patients',{p_search:form.elements.search.value.trim(),p_offset:patientOffset});
        results.push(...found.rows); patientOffset=found.next_offset;
        form.querySelector('[data-patients]').innerHTML=results.length?'<label>Patient<select class="form-control" name="patient" required><option value="">Choose patient</option>'+results.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.full_name)+' - '+esc(p.patient_code)+'</option>').join('')+'</select></label>':'<p>No eligible patients found.</p>';
        const select=form.querySelector('[name=patient]');if(select){select.value=chosenPatient;select.onchange=()=>{chosenPatient=select.value;};}
        form.querySelector('[data-more-patients]').hidden=!found.has_more;
      }
      form.querySelector('[data-search]').onclick=e=>act(e.target,()=>search(true));
      form.querySelector('[data-more-patients]').onclick=e=>act(e.target,()=>search(false));
      form.onsubmit=e=>{e.preventDefault();act(form.querySelector('[type=submit]'),async()=>{
        if(!chosenPatient) throw new Error('Choose a patient from your search results');
        const result=await rpc('medical_navigation_raise',{p_patient:chosenPatient,p_reason:form.elements.reason.value});
        message(result.message);if(result.created)form.elements.reason.value='';await loadQueue();
      });};
    }
  }
  async function loadQueue(reset=false) {
    clearContext(); if(reset)queueOffset=0;
    const result=await rpc('medical_navigation_queue',{p_offset:queueOffset});
    const list=container.querySelector('[data-queue]');
    list.innerHTML=result.rows.length?result.rows.map(q=>'<article class="card" style="padding:16px;margin-bottom:12px"><h2>'+esc(q.full_name)+'</h2><p>'+esc(q.patient_code)+' - '+esc(q.status)+' - '+esc(q.assignee_name || 'Awaiting manager assignment')+'</p><p style="white-space:pre-wrap">'+esc(q.reason)+'</p><button class="btn btn-primary" data-open="'+esc(q.id)+'">Open medical work</button></article>').join(''):'<p>No medical requests are available to this account.</p>';
    container.querySelector('[data-prev]').hidden=queueOffset===0;container.querySelector('[data-next]').hidden=!result.has_more;
    list.querySelectorAll('[data-open]').forEach(button=>{button.onclick=()=>act(button,()=>openRequest(button.dataset.open));});
  }
  async function openRequest(id) {
    clearContext();selected=id;const token=epoch;
    const result=await rpc('medical_navigation_context',{p_request:id},token);
    context=result; historyKind='medical'; historyRows=[];historyOffset=0;renderContext();await loadHistory(true);
  }
  function renderContext() {
    if(!context || !current())return;
    const {patient:p,request:q}=context;
    const manager=['admin','manager'].includes(initialRole);
    const writable=context.can_write===true && initialRole==='medical_navigator';
    const holder=container.querySelector('[data-context]');
    holder.innerHTML='<section class="card" style="padding:16px;margin-top:16px"><h2>'+esc(p.full_name)+'</h2><p>Medical request - '+esc(q.status)+'</p>'+
      '<button class="btn btn-secondary" data-recheck>Recheck access</button><details><summary>Patient record</summary>'+patientSections(p)+'</details>'+
      (manager && q.status==='open'?'<form data-assignment><label>Medical navigator<select name="assignee" class="form-control"><option value="">Unassigned</option>'+assignees.map(a=>'<option value="'+esc(a.id)+'" '+(a.id===q.assigned_to?'selected':'')+'>'+esc(a.full_name)+'</option>').join('')+'</select></label><button class="btn btn-primary">Save assignment</button></form>':'')+
      '<h3>Patient history</h3><label>History section<select class="form-control" data-history-kind>'+HISTORY.map(k=>'<option value="'+k+'" '+(k===historyKind?'selected':'')+' '+(k==='documents'&&!context.documents_allowed?'disabled':'')+'>'+TITLES[k]+'</option>').join('')+'</select></label>'+
      (!context.documents_allowed?'<p>Medical document consent is missing or withdrawn. Documents cannot be opened.</p>':'')+
      '<div data-history></div><button class="btn btn-secondary" data-history-more hidden>Load older history</button>'+
      (writable?'<form data-entry style="margin-top:20px"><h3>Add medical call or note</h3><label>Entry type<select class="form-control" name="kind"><option value="note">Note</option><option value="call">Call log</option></select></label><div data-call-fields hidden><label>Call date and time<input class="form-control" name="call_at" type="datetime-local"></label><label>Dial status<select class="form-control" name="dial_status"><option>connected</option><option>no_answer</option><option>busy</option><option>wrong_number</option><option>callback_requested</option><option>voicemail</option></select></label><label>Duration (minutes)<input class="form-control" name="duration" type="number" min="0" max="1440" step="0.1" value="0"></label><label>Follow-up date<input class="form-control" name="follow_up" type="date"></label></div><label>Notes<textarea class="form-control" name="body" maxlength="4000" required></textarea></label><p>Enter your own observations. Saving does not send messages or create calling jobs.</p><button class="btn btn-primary" type="submit">Save medical entry</button></form>':'')+
      ((writable || manager)&&q.status==='open'?'<button class="btn btn-danger" data-close style="margin-top:16px">Close medical request</button>':'')+
      (writable?(p.do_not_call||p.is_blacklisted?'<p>Calling is blocked for this patient. You may add a note.</p>':phoneLinks(p)):'')+'</section>';
    holder.querySelector('[data-recheck]').onclick=e=>act(e.target,()=>openRequest(selected));
    holder.querySelector('[data-history-kind]').onchange=e=>act(e.target,async()=>{historyKind=e.target.value;await loadHistory(true);});
    holder.querySelector('[data-history-more]').onclick=e=>act(e.target,()=>loadHistory(false));
    const assignment=holder.querySelector('[data-assignment]');
    if(assignment)assignment.onsubmit=e=>{e.preventDefault();act(assignment.querySelector('button'),async()=>{
      await rpc('medical_navigation_assign',{p_request:q.id,p_assignee:assignment.elements.assignee.value||null,p_version:q.version});
      message('Assignment saved.');await loadQueue();
    });};
    const entry=holder.querySelector('[data-entry]');
    if(entry){
      submission=crypto.randomUUID();
      entry.elements.kind.onchange=()=>{const call=entry.elements.kind.value==='call';entry.querySelector('[data-call-fields]').hidden=!call;entry.elements.call_at.required=call;entry.elements.duration.required=call;};
      entry.onsubmit=async e=>{
        e.preventDefault();if(submitting || !current())return;
        submitting=true;const button=entry.querySelector('[type=submit]');button.disabled=true;
        const call=entry.elements.kind.value==='call';
        try {
          await rpc('medical_navigation_save',{p_request:q.id,p_version:q.version,p_submission:submission,p_kind:entry.elements.kind.value,p_body:entry.elements.body.value,
            p_call_at:call&&entry.elements.call_at.value?new Date(entry.elements.call_at.value).toISOString():null,
            p_dial_status:call?entry.elements.dial_status.value:null,p_duration:call?Number(entry.elements.duration.value):null,p_follow_up:call?(entry.elements.follow_up.value||null):null});
          if(!current())return;entry.elements.body.value='';submission=crypto.randomUUID();message('Medical entry saved.');await loadHistory(true);
        }catch(error){failure(error);}finally{submitting=false;if(button.isConnected)button.disabled=false;}
      };
    }
    holder.querySelector('[data-close]')?.addEventListener('click',e=>{if(!window.confirm('Close this medical request? The navigator will lose access.'))return;act(e.target,async()=>{await rpc('medical_navigation_close',{p_request:q.id,p_version:q.version});message('Medical request closed.');await loadQueue();});});
    holder.querySelectorAll('[data-dial]').forEach(button=>{button.onclick=()=>act(button,async()=>{
      const now=await rpc('medical_navigation_context',{p_request:q.id});
      if(!now.can_write || now.patient.do_not_call || now.patient.is_blacklisted)throw new Error('Calling is no longer permitted');
      const number=now.patient[button.dataset.dial];if(!/^[+0-9 ()-]{6,25}$/.test(number||''))throw new Error('No valid phone number');
      window.location.href='tel:'+number.replace(/[^+0-9]/g,'');
    });});
  }
  function phoneLinks(p) {
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">'+[['phone_full','Call patient'],['caregiver_phone_full','Call caregiver']].filter(([key])=>/^[+0-9 ()-]{6,25}$/.test(p[key]||'')).map(([key,title])=>'<button class="btn btn-secondary" data-dial="'+key+'">'+title+'</button>').join('')+'</div>';
  }
  async function loadHistory(reset) {
    if(!selected || !context)return;
    const turn=++historyEpoch,id=selected,kind=historyKind;
    if(reset){historyRows=[];historyOffset=0;clearFiles();}
    const result=await rpc('medical_navigation_history',{p_request:id,p_kind:kind,p_offset:historyOffset});
    if(turn!==historyEpoch || selected!==id || historyKind!==kind)return;
    historyRows.push(...result.rows);historyOffset=result.next_offset;
    const target=container.querySelector('[data-history]');
    target.innerHTML=historyRows.length?historyRows.map((row,index)=>'<article style="border-bottom:1px solid var(--border-color,#ddd);padding:12px 0"><h4>'+esc(TITLES[kind])+' - '+esc(row.at)+'</h4><dl style="display:grid;gap:8px">'+clinicalFields(row.record,HISTORY_FIELDS[kind])+recordedDetails(row.record,kind)+'</dl>'+((row.record.has_additional_structured_source||row.record.has_additional_assessment_detail)?'<p>Additional structured source content exists in the original record. This section shows the supported recorded clinical fields.</p>':'')+(kind==='documents'&&row.record.storage_path?'<button class="btn btn-secondary" data-document="'+index+'">Open document</button>':'')+'</article>').join(''):'<p>No entries in this section.</p>';
    container.querySelector('[data-history-more]').hidden=!result.has_more;
    target.querySelectorAll('[data-document]').forEach(button=>{button.onclick=()=>act(button,async()=>{
      const token=epoch,request=selected,record=historyRows[Number(button.dataset.document)]?.record,path=record?.storage_path;
      const checked=await rpc('medical_navigation_context',{p_request:request});
      if(!checked.documents_allowed || !current() || token!==epoch)throw new Error('Document access changed');
      // A non-cached server response checks current assignment both before and
      // after fetching bytes. Direct medical Storage access is disabled.
      const response=await sb.functions.invoke('medical-document',{body:{request_id:request,path}});
      if(response.error)throw new Error(response.error.message||'Document unavailable');
      if(!current() || token!==epoch || request!==selected)return;
      const verified=await rpc('medical_navigation_context',{p_request:request},token);
      if(!verified.documents_allowed)throw new Error('Document consent changed');
      const url=URL.createObjectURL(response.data);urls.add(url);
      const extension={'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp','text/plain':'txt'}[record?.mime_type]||'bin';
      const link=document.createElement('a');link.href=url;link.download='medical-document.'+extension;link.textContent='Download document';
      // Download attachment rather than embedding potentially active HTML/SVG.
      const downloadTimer=setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);timers.delete(downloadTimer);},60000);timers.add(downloadTimer);
      button.after(link);link.click();
    });});
  }
  async function revalidate() {
    if(!current()){dispose('Account changed. Reopen Medical navigation.');return;}
    if(!selected || busy || submitting)return;
    const id=selected,version=context?.request.version,token=epoch;
    try{const fresh=await rpc('medical_navigation_context',{p_request:id},token);if(selected===id && (fresh.request.version!==version || fresh.documents_allowed!==context?.documents_allowed))clearContext('Assignment or document access changed. Refresh your work.');}
    catch(error){if(token===epoch)failure(error);}
  }
  function onRoute(){if(!location.hash.replace(/^#/,'').startsWith('medical-navigation'))dispose();}
  function onFocus(){void revalidate();}
  function onVisibility(){if(document.hidden)clearFiles();else void revalidate();}
  observer=new MutationObserver(()=>{if(!container.isConnected)dispose();});observer.observe(document.body,{childList:true,subtree:true});
  subscription=sb.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT' || (session?.user && session.user.id!==actor))dispose('Account changed.');
  })?.data?.subscription;
  refreshTimer=setInterval(()=>void revalidate(),30000);
  window.addEventListener('hashchange',onRoute);window.addEventListener('focus',onFocus);document.addEventListener('visibilitychange',onVisibility);
  releaseView=dispose;
  if(!actor || !ROLES.includes(initialRole) || !current()){dispose('Use your own active authorised account to open Medical navigation.');return;}
  queueShell();
  // Optional new panel cannot prevent the existing clinical worklist loading.
  if(['admin','manager','medical_navigator'].includes(initialRole)) {
    import('../components/medicalPm151.js').then(({mountMedicalPm151})=>{
      if(current())pmPanel151=mountMedicalPm151(container.querySelector('[data-medical-pm151]'),
        {isCurrent:current,onAssigned:()=>loadQueue(true),onOpen:id=>openRequest(id)});
    }).catch(()=>{if(current())container.querySelector('[data-medical-pm151]').textContent='PM controls could not load. Refresh to retry. Your existing clinical worklist remains below.';});
  }
  try{
    if(['admin','manager'].includes(initialRole))assignees=await rpc('medical_navigation_assignees');
    await loadQueue();
  }catch(error){failure(error);}
  return dispose;
}
