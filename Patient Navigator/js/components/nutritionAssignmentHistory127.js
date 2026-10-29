// Read the existing ownership audit. No assignment, scheduling or patient-detail reads.
import {getSupabase} from '../supabase.js';
import {getCurrentProfile,getCurrentUser,isManagerOrAdmin,isImpersonating} from '../auth.js';
import {showModal} from './modal.js';
import {sanitize} from '../utils/validators.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const validDate=s=>typeof s==='string'&&DATE.test(s)&&Number.isFinite(Date.parse(s));
const PAGE=25;
export function canViewNutritionAssignments127(){
 const p=getCurrentProfile(),u=getCurrentUser();
 return !!u?.id&&p?.id===u.id&&p.is_active===true&&p.must_change_password!==true&&isManagerOrAdmin()&&!isImpersonating();
}
export function nutritionAssignmentQuery127(sb,cursor=null){
 let q=sb.from('patient_assignment_history').select('id,to_user,changed_at,assignee:profiles!pah_to_user_fkey(full_name)')
  .eq('team','nutrition').not('to_user','is',null).neq('reason','nutrition_backfill')
  .order('changed_at',{ascending:false}).order('id',{ascending:false}).limit(PAGE+1);
 if(cursor){if(!UUID.test(cursor.id)||!validDate(cursor.changed_at))throw Error('Invalid assignment history cursor');
  q=q.or(`changed_at.lt.${cursor.changed_at},and(changed_at.eq.${cursor.changed_at},id.lt.${cursor.id})`);}
 return q;
}
const when=s=>new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Kolkata'}).format(new Date(s));
export function openNutritionAssignmentHistory127(container){
 if(!canViewNutritionAssignments127()||!container?.isConnected)return null;
 const account=getCurrentUser().id,route=location.hash;
 let disposed=false,busy=false,token=0,cursor=null,loaded=0,subscription,observer;
 const end=()=>{if(disposed)return;disposed=true;token++;subscription?.unsubscribe?.();observer?.disconnect();window.removeEventListener('hashchange',changed);list.replaceChildren();modal.closeOwnedModal();};
 const modal=showModal({title:'Nutrition assignment history',size:'lg',content:'<p>Recent recorded assignments to nutrition interns, newest first. Use this as a reference for your team\'s cycle; it does not choose the next intern or change ownership.</p><p class="nw-muted">India time (Asia/Kolkata). Earlier imported ownership and handbacks are excluded because they are not new assignments.</p><div data-assignment-history-list aria-live="polite"></div><p data-assignment-history-state role="status"></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn btn-secondary" data-assignment-history-refresh>Refresh history</button><button type="button" class="btn btn-secondary" data-assignment-history-older hidden>Older assignments</button></div>',onClose:end});
 const list=modal.querySelector('[data-assignment-history-list]'),state=modal.querySelector('[data-assignment-history-state]'),older=modal.querySelector('[data-assignment-history-older]'),refresh=modal.querySelector('[data-assignment-history-refresh]');
 const sheet=modal.querySelector('.modal');sheet.style.overflowAnchor='none';
 modal.querySelector('.modal-header').style.cssText='position:sticky;top:0;z-index:4;background:var(--surface)';
 const showOlder=show=>{older.hidden=!show;older.style.display=show?'':'none';};showOlder(false);
 const current=()=>!disposed&&container.isConnected&&modal.isCurrentModal()&&route===location.hash&&getCurrentUser()?.id===account&&canViewNutritionAssignments127();
 function changed(){if(!current())end();}
 async function load(reset=false){
  if(!current()){end();return;}if(busy)return;busy=true;const request=++token;refresh.disabled=older.disabled=true;state.textContent='Loading assignment history...';
  if(reset){cursor=null;loaded=0;list.replaceChildren();showOlder(false);}
  let timeout;
  try{
   const result=await Promise.race([nutritionAssignmentQuery127(getSupabase(),cursor),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('History read timed out')),8000);})]);
   if(!current()||request!==token)return;
   if(result?.error||!Array.isArray(result?.data))throw Error('Assignment history unavailable');
   const rows=result.data;if(rows.length>PAGE+1||rows.some(r=>!UUID.test(r.id)||!UUID.test(r.to_user)||!validDate(r.changed_at)))throw Error('Invalid assignment history response');
   const page=rows.slice(0,PAGE);for(const r of page){
    const item=document.createElement('div');item.className='card';item.style.cssText='padding:12px;margin:0 0 8px;overflow-wrap:anywhere';
    const name=r.assignee?.full_name||'Team member name unavailable';
    item.innerHTML=`<strong>${sanitize(name)}</strong><br><time datetime="${sanitize(r.changed_at)}" title="${sanitize(r.changed_at)}">${sanitize(when(r.changed_at))}</time>`;list.append(item);
   }
   loaded+=page.length;if(page.length)cursor={id:page.at(-1).id,changed_at:page.at(-1).changed_at};
   showOlder(rows.length>PAGE);state.textContent=loaded?`${loaded} recorded assignment${loaded===1?'':'s'} shown.${older.hidden?' No older assignments found.':''}`:'No recorded nutrition assignments yet. Imported ownership is not listed.';
   if(reset)sheet.scrollTop=0;
  }catch{if(current()&&request===token){state.textContent='Assignment history could not be loaded. Try again; the current patient assignments have not changed.';showOlder(!!cursor);refresh.textContent=loaded?'Refresh history':'Retry history';}}
  finally{clearTimeout(timeout);if(request===token){busy=false;refresh.disabled=older.disabled=false;}changed();}
 }
 refresh.addEventListener('click',()=>{refresh.textContent='Refresh history';void load(true);});older.addEventListener('click',()=>void load());
 const sb=getSupabase();subscription=sb.auth?.onAuthStateChange?.((event,session)=>{if(event==='SIGNED_OUT'||session?.user?.id&&session.user.id!==account)end();else changed();})?.data?.subscription;
 if(disposed){subscription?.unsubscribe?.();return modal;}
 window.addEventListener('hashchange',changed);observer=new MutationObserver(changed);observer.observe(document.body,{childList:true,subtree:true});void load(true);return modal;
}
