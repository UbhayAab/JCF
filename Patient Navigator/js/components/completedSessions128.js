// Saved session records beside call history. Never insert a pretend phone call.
import{getSupabase}from'../supabase.js';
import{getCurrentUser,getCurrentProfile,getRealProfile,isManagerOrAdmin,isImpersonating}from'../auth.js';
import{sanitize}from'../utils/validators.js';
const mounts=new WeakMap(),UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const validDate=s=>typeof s==='string'&&DATE.test(s)&&Number.isFinite(Date.parse(s));
const identity=()=>{const u=getCurrentUser(),p=getCurrentProfile(),r=getRealProfile(),day=new Date(Date.now()+19800000).toISOString().slice(0,10);return u?.id&&r?.id===u.id&&r.is_active===true&&p?.is_active===true&&(!r.ends_on||r.ends_on>=day)&&(!p.ends_on||p.ends_on>=day)?JSON.stringify([u.id,p.id,p.role,isImpersonating()]):null;};
const KIND={nutrition:'Nutrition',wellbeing:'Well-being / therapy',caregiver:'Caregiver support'};
export function completedSessionQuery128(sb,{patientId=null,cursor=null}={}){
 const p=getCurrentProfile();if(!identity()||!UUID.test(p.id)||patientId&&!UUID.test(patientId))throw Error('Session history unavailable');
 let q=sb.from('care_sessions').select('id,patient_id,kind,status,held_at,duration_mins,session_notes,assignee:profiles!care_sessions_assigned_to_fkey(full_name)'+(patientId?'':',patient:patients(full_name,patient_code)'))
  .eq('status','held').order('held_at',{ascending:false,nullsFirst:false}).order('id',{ascending:false}).limit(26);
 if(patientId)q=q.eq('patient_id',patientId);
 // Open as retains manager Auth. Never use that broad read as the target's scope.
 const scope=isImpersonating()||!patientId&&!isManagerOrAdmin()?`assigned_to.eq.${p.id},invited_by.eq.${p.id}`:null;let dateFilter=null;
 if(cursor){if(!UUID.test(cursor.id)||cursor.held_at!==null&&!validDate(cursor.held_at))throw Error('Invalid session cursor');
  if(cursor.held_at===null)q=q.is('held_at',null).lt('id',cursor.id);else dateFilter=`held_at.lt.${cursor.held_at},held_at.is.null,and(held_at.eq.${cursor.held_at},id.lt.${cursor.id})`;}
 // One logical filter keeps cursor OR and preview-scope OR explicitly ANDed.
 if(scope&&dateFilter)q=q.or(`and(or(${scope}),or(${dateFilter}))`);else if(scope||dateFilter)q=q.or(scope||dateFilter);
 return q;
}
const when=s=>new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}).format(new Date(s));
export function mountCompletedSessions128(container,{patientId=null}={}){
 mounts.get(container)?.dispose();const owner=identity(),route=location.hash;let ended=false,generation=0,cursor=null,busy=false,loaded=0,subscription,observer;
 const card=document.createElement('section');card.className='card';card.style.cssText='padding:16px;margin-top:16px;min-width:0';card.dataset.completedSessions128='';card.innerHTML='<h3>Completed 1:1 sessions</h3><p class="due-meta">Original saved session notes, shown automatically here without creating another phone-call log. Call filters above apply to phone calls. Newest first; times in India time (Asia/Kolkata).</p><div data-session-rows></div><p data-session-state role="status" aria-live="polite"></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-secondary btn-sm" data-session-refresh>Refresh sessions</button><button type="button" class="btn btn-secondary btn-sm" data-session-older style="display:none">Older sessions</button></div>';container.append(card);
 const list=card.querySelector('[data-session-rows]'),state=card.querySelector('[data-session-state]'),older=card.querySelector('[data-session-older]'),refresh=card.querySelector('[data-session-refresh]');
 const current=()=>!ended&&container.isConnected&&mounts.get(container)===control&&owner&&owner===identity()&&route===location.hash;
 function dispose(){if(ended)return;ended=true;generation++;subscription?.unsubscribe?.();observer?.disconnect();window.removeEventListener('hashchange',changed);list.replaceChildren();card.remove();if(mounts.get(container)===control)mounts.delete(container);}
 function changed(){if(!current())dispose();}
 const control={dispose};mounts.set(container,control);
 async function load(reset=false){
  if(!current()){dispose();return;}if(busy)return;busy=true;const request=++generation;let timeout;refresh.disabled=older.disabled=true;
  if(reset){cursor=null;loaded=0;list.replaceChildren();older.style.display='none';}state.textContent='Loading saved sessions...';
  try{
   const r=await Promise.race([completedSessionQuery128(getSupabase(),{patientId,cursor}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Session read timed out')),8000);})]);if(!current()||request!==generation)return;
   if(r?.error||!Array.isArray(r?.data)||r.data.length>26||r.data.some(x=>!UUID.test(x.id)||!UUID.test(x.patient_id)||x.status!=='held'||x.held_at!==null&&!validDate(x.held_at)||patientId&&x.patient_id!==patientId))throw Error('Saved sessions unavailable');
   const page=r.data.slice(0,25);for(const s of page){
    const item=document.createElement('article');item.style.cssText='border-top:1px solid var(--line);padding:12px 0;overflow-wrap:anywhere';item.dataset.completedSession=s.id;
    const patient=s.patient?.full_name||s.patient?.patient_code;
    item.innerHTML=`${!patientId?`<p style="margin:0 0 4px">${patient?`<a href="#patients/${s.patient_id}">${sanitize(patient)}</a>`:'Patient record restricted'}</p>`:''}<div style="display:flex;gap:8px;flex-wrap:wrap"><strong>${sanitize(KIND[s.kind]||'1:1 session')}</strong><span class="badge badge-ok">Session held</span></div><p class="due-meta">${s.held_at?`<time datetime="${sanitize(s.held_at)}">${sanitize(when(s.held_at))}</time>`:'Completion date unavailable'} · ${sanitize(s.assignee?.full_name||'Specialist name unavailable')}${Number.isFinite(s.duration_mins)&&s.duration_mins>=0?` · ${s.duration_mins} min`:''}</p><div style="white-space:pre-wrap">${sanitize(s.session_notes||'No session notes saved.')}</div><a class="btn btn-ghost btn-sm" href="#sessions?session=${s.id}">Open session</a>`;list.append(item);
   }
   loaded+=page.length;if(page.length)cursor={id:page.at(-1).id,held_at:page.at(-1).held_at};older.style.display=r.data.length>25?'':'none';state.textContent=loaded?`${loaded} completed session${loaded===1?'':'s'} shown.`:'No completed sessions available to your account.';refresh.textContent='Refresh sessions';
  }catch{if(current()&&request===generation){state.textContent='Saved sessions could not be loaded. This is not an empty history. Try again.';refresh.textContent=loaded?'Refresh sessions':'Retry sessions';}}
  finally{clearTimeout(timeout);if(request===generation){busy=false;refresh.disabled=older.disabled=false;}changed();}
 }
 refresh.addEventListener('click',()=>void load(true));older.addEventListener('click',()=>void load());
 if(!owner){dispose();return control;}subscription=getSupabase().auth?.onAuthStateChange?.((event,session)=>{if(event==='SIGNED_OUT'||session?.user?.id&&session.user.id!==getCurrentUser()?.id)dispose();else changed();})?.data?.subscription;
 if(ended){subscription?.unsubscribe?.();return control;}window.addEventListener('hashchange',changed);observer=new MutationObserver(changed);observer.observe(document.body,{childList:true,subtree:true});void load(true);return control;
}
