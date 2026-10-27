import { getSupabase } from '../supabase.js';
import * as auth from '../auth.js';
import { showModal, closeModal } from './modal.js';
import { sanitize } from '../utils/validators.js';

const OUTCOMES = { connected: 'Connected', no_answer: 'No answer', busy: 'Busy', wrong_number: 'Wrong number', not_needed: 'Not needed' };
const drafts = new Map();
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const identity = () => JSON.stringify([auth.getCurrentUser?.()?.id,auth.getCurrentProfile?.()?.id,auth.getRealProfile?.()?.id,auth.isImpersonating?.()]);
function writable(lead) {
  const u=auth.getCurrentUser?.(),p=auth.getRealProfile?.(),shown=auth.getCurrentProfile?.();
  return !!u?.id && p?.id===u.id && shown?.id===u.id && auth.isImpersonating?.()===false
    && p.is_active===true && p.on_probation===false && ['admin','manager','caller','caregiver_mentor'].includes(p.role)
    && !lead?.patient_id && lead?.is_team===false && (['admin','manager'].includes(p.role)||lead?.assigned_to===u.id);
}
function historyResult(data,lead) {
  if(data?.lead_id!==lead || !Array.isArray(data.items) || data.items.length>20) throw new Error('Could not confirm the follow-up history. Refresh and try again.');
  const seen=new Set();
  return data.items.map(r=>{
    if(!uuid(r?.id)||seen.has(r.id)||!Object.hasOwn(OUTCOMES,r.outcome)||typeof r.note!=='string'||r.note.length>2000||!Number.isFinite(Date.parse(r.recorded_at))||(r.author_name!=null&&typeof r.author_name!=='string'))throw new Error('Could not confirm the follow-up history.');
    seen.add(r.id);return r;
  });
}
export function openLeadFollowup(lead,{isCurrent=()=>true,onSaved=()=>{}}={}) {
  if(!uuid(lead?.id)) throw new Error('Refresh the lead before logging a follow-up.');
  const actor=auth.getCurrentUser?.()?.id,account=identity(),route=window.location.hash,key=actor+':'+lead.id;
  let disposed=false,saving=false,saved=false,generation=0,observer;
  const el=document.createElement('section');
  const own=()=>!disposed&&el.isConnected;
  const current=()=>own()&&identity()===account&&window.location.hash===route&&isCurrent();
  const canSave=()=>current()&&writable(lead)&&!saved;
  const draft=drafts.get(key)||{nonce:crypto.randomUUID(),outcome:'connected',note:'',attempt:null};
  drafts.set(key,draft);
  const message=(s,error=false)=>{if(!current())return;const host=el.querySelector('[data-lf-message]');host.textContent=s;host.style.color=error?'var(--danger, #b42318)':'';};
  function dispose(){if(disposed)return;disposed=true;generation++;observer?.disconnect();window.removeEventListener('hashchange',changed);document.removeEventListener('change',changed,true);if(identity()!==account){drafts.clear();el.replaceChildren();}if(el.isConnected){closeModal();}}
  function changed(){if(!current()||(!saved&&!writable(lead)))dispose();}
  function controls(){const frozen=!!draft.attempt||saved;el.querySelector('[data-lf-outcome]').disabled=frozen||!canSave();el.querySelector('[data-lf-note]').readOnly=frozen||!canSave();el.querySelector('[data-lf-save]').disabled=saving||!canSave();el.querySelector('[data-lf-save]').textContent=draft.attempt?'Retry this follow-up':'Save follow-up';}
  el.innerHTML=`<p><strong>${sanitize(lead.name||'Assigned WhatsApp lead')}</strong></p>
    <p class="due-meta" style="white-space:normal">Save what happened in your completed follow-up with this assigned WhatsApp lead.</p>
    <form data-lf-form>
      <label class="form-label" for="lf-outcome">What happened?</label>
      <select id="lf-outcome" class="form-select" data-lf-outcome>${Object.entries(OUTCOMES).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select>
      <label class="form-label" for="lf-note" style="margin-top:14px">Follow-up note</label>
      <textarea id="lf-note" class="form-input" data-lf-note rows="4" maxlength="2000" placeholder="What did they tell you, and what follow-up is needed?" style="width:100%;box-sizing:border-box"></textarea>
      <p class="due-meta" style="white-space:normal">Use Log the call on an open HopeBot request so that its callback is properly updated.</p>
      <p data-lf-message role="status" aria-live="polite"></p>
      <button type="submit" class="btn btn-primary" data-lf-save>Save follow-up</button>
    </form>
    <h4 style="margin-top:20px">Recent follow-ups</h4><div data-lf-history role="status">Loading history...</div>`;
  showModal({title:'Log follow-up',content:el,size:'sm'});
  el.querySelector('[data-lf-outcome]').value=draft.outcome;el.querySelector('[data-lf-note]').value=draft.note;
  el.querySelector('[data-lf-outcome]').onchange=e=>{if(canSave()&&!draft.attempt)draft.outcome=e.target.value;};
  el.querySelector('[data-lf-note]').oninput=e=>{if(canSave()&&!draft.attempt)draft.note=e.target.value;};
  controls();if(!writable(lead))message('Return to your own eligible calling account to log this assigned lead. Open as is read-only.',true);
  async function history(){const n=++generation;try{const{data,error}=await getSupabase().rpc('hopebot_lead_followup_history',{p_lead:lead.id});if(!current()||n!==generation)return;if(error)throw error;const entries=historyResult(data,lead.id);el.querySelector('[data-lf-history]').innerHTML=entries.length?entries.map(r=>`<article style="border-top:1px solid var(--line);padding:12px 0;overflow-wrap:anywhere"><strong>${OUTCOMES[r.outcome]}</strong><div class="due-meta">${sanitize(new Date(r.recorded_at).toLocaleString())} · ${sanitize(r.author_name||'Team member')}</div><p style="white-space:pre-wrap">${sanitize(r.note)||'No note recorded.'}</p></article>`).join(''):'No follow-ups recorded for this lead.';}catch(e){if(current()&&n===generation)el.querySelector('[data-lf-history]').textContent=e.message||'History unavailable. Refresh before retrying.';}}
  el.querySelector('[data-lf-form]').onsubmit=async e=>{
    e.preventDefault();if(!canSave()||saving)return;
    if(!Object.hasOwn(OUTCOMES,draft.outcome)||draft.note.length>2000){message('Choose an outcome and keep the note within 2000 characters.',true);return;}
    draft.attempt ||= {p_lead:lead.id,p_outcome:draft.outcome,p_note:draft.note,p_nonce:draft.nonce};
    saving=true;controls();message('Saving follow-up...');
    try{
      const{data,error}=await getSupabase().rpc('hopebot_lead_followup_save',draft.attempt);
      if(!current()||!writable(lead))return;if(error)throw error;
      if(!uuid(data?.id)||data.lead_id!==lead.id||data.outcome!==draft.attempt.p_outcome||data.note!==draft.attempt.p_note.trim()||!Number.isFinite(Date.parse(data.recorded_at))||typeof data.duplicate!=='boolean')throw new Error('The saved result could not be confirmed. Retry this same follow-up.');
      saved=true;drafts.delete(key);el.querySelector('[data-lf-save]').hidden=true;el.querySelector('[data-lf-save]').style.display='none';message('Follow-up saved. Your team can read it in Recent follow-ups.');
      await history();if(current())await onSaved(data);
    }catch(e){if(current())message((e.message||'Could not confirm the save.')+' Your draft is kept. Retry sends the same follow-up, so it cannot create a duplicate.',true);}
    finally{saving=false;if(current())controls();}
  };
  window.addEventListener('hashchange',changed);document.addEventListener('change',changed,true);
  observer=new MutationObserver(()=>{if(!el.isConnected)dispose();else if(identity()!==account)dispose();});observer.observe(document.body,{childList:true,subtree:true});
  history();return{dispose};
}
