import {getSupabase} from '../supabase.js';
import {getCurrentUser,getCurrentProfile,getRealProfile,isImpersonating} from '../auth.js';
import {sanitize} from '../utils/validators.js';

const mounted=new WeakMap();
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const methods=new Set(['NGS','WES','WGS','FISH','PCR','Sanger']);
const count=x=>Number.isSafeInteger(x)&&x>=0;
const instant=x=>typeof x==='string'&&x.length<=64&&Number.isFinite(Date.parse(x));
const TYPES={discharge_summary:'Discharge summary',prescription:'Prescription',histopathology:'Histopathology',opd_note:'Clinic note',imaging_report:'Imaging report',treatment_protocol:'Treatment protocol',drug_calculation:'Drug calculation',nursing_record:'Nursing record',registration_form:'Registration paper',id_card:'Identity paper',file_cover:'File cover',cost_certificate:'Cost certificate',laboratory_report:'Laboratory report',radiology_report:'Radiology report',pathology_addendum:'Pathology addendum',endoscopy_report:'Endoscopy report',device_record:'Device record',consent_form:'Consent paper',referral_letter:'Referral letter',scheme_card:'Scheme paper',income_certificate:'Income certificate',disability_certificate:'Disability certificate',ration_card:'Ration paper',insurance_document:'Insurance paper',ngo_sanction_letter:'Support sanction',transfusion_record:'Transfusion record',bill_receipt:'Bill or receipt',unknown:'Type not recorded',other:'Other paper',pdf_original:'Received PDF',image_original:'Received image',file_original:'Received file'};
export const reportType234=x=>TYPES[x]||'Other recorded paper';
const identity=()=>JSON.stringify([getCurrentUser()?.id,getCurrentProfile()?.id,getRealProfile()?.id,getRealProfile()?.role,getRealProfile()?.is_active,getRealProfile()?.ends_on,getRealProfile()?.must_change_password,getRealProfile()?.on_probation,isImpersonating()]);
const dayNow=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(p=>['year','month','day'].includes(p.type)).sort((a,b)=>['year','month','day'].indexOf(a.type)-['year','month','day'].indexOf(b.type)).map(p=>p.value).join('-');
function allowed(manager){const u=getCurrentUser(),p=getRealProfile();return !!u?.id&&p?.id===u.id&&getCurrentProfile()?.id===u.id&&!isImpersonating()&&p.is_active===true&&p.must_change_password!==true&&(!p.ends_on||p.ends_on>=dayNow())&&(manager?['admin','manager'].includes(p.role)&&p.on_probation!==true:['admin','manager','caller','caregiver_mentor','nutritionist','therapist','ground_poc'].includes(p.role));}
export function createReportView234(host,{manager=false,isCurrent=()=>true}={}){
 mounted.get(host)?.dispose();const key=identity(),route=location.hash,actor=getCurrentUser()?.id,root=document.createElement('section');
 let disposed=false,generation=0,pending,observer,subscription;
 const current=()=>!disposed&&mounted.get(host)===view&&host.isConnected&&root.parentNode===host&&root.isConnected&&identity()===key&&location.hash===route&&allowed(manager)&&isCurrent();
 function dispose(reason=''){if(disposed)return;disposed=true;generation++;pending?.abort();observer?.disconnect();subscription?.unsubscribe();window.removeEventListener('hashchange',check);if(mounted.get(host)===view){mounted.delete(host);root.replaceChildren();if(reason&&root.isConnected){const p=document.createElement('p');p.setAttribute('role','status');p.textContent=reason;root.append(p);}else root.remove();}}
 function check(){if(!current())dispose('Access changed. Reopen this view from your own account.');}
 function invalidate(){generation++;pending?.abort();}
 async function read(name,args){if(!current())throw Object.assign(new Error('stale'),{stale:true});invalidate();const token=generation,abort=new AbortController();pending=abort;let timer;
  try{let request=getSupabase().rpc(name,args);if(typeof request.abortSignal==='function')request=request.abortSignal(abort.signal);
   const result=await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('timeout'));},16000);})]);
   if(!current()||token!==generation)throw Object.assign(new Error('stale'),{stale:true});if(result?.error||!result?.data)throw new Error('unavailable');return result.data;
  }catch(e){if(!current()||token!==generation)throw Object.assign(new Error('stale'),{stale:true});throw e;}
  finally{clearTimeout(timer);if(pending===abort)pending=null;}
 }
 const view={root,actor,current,read,invalidate,dispose};mounted.set(host,view);host.replaceChildren(root);
 if(!allowed(manager)||!host.isConnected){dispose('Use your own active authorised account to view report data.');return view;}
 observer=new MutationObserver(check);observer.observe(document.body,{childList:true,subtree:true});window.addEventListener('hashchange',check);
 subscription=getSupabase().auth?.onAuthStateChange?.(check)?.data?.subscription;return view;
}
const stamp=x=>x?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}).format(new Date(x))+' IST':'Not recorded';
const printed=x=>x?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium'}).format(new Date(x+'T00:00:00+05:30')):'Not recorded';
function response(d,actor,patient,kind){
 if(!d||d.version!==1||d.actor_id!==actor||d.patient_id!==patient||d.kind!==kind||!instant(d.as_of)||!d.totals||!['reports','originals','molecular_evidence_reports','report_date_unknown'].every(k=>count(d.totals[k]))||!Array.isArray(d.rows)||d.rows.length>25||typeof d.has_more!=='boolean')throw Error('contract');
 const keys=['id','at','report_date','uploaded_at','received_at','type','pages','issuer','channel','state','molecular_methods','genetics_status'];
 if(new Set(d.rows.map(r=>r.id)).size!==d.rows.length||d.rows.some(r=>!uuid(r.id)||!instant(r.at)||Object.keys(r).some(k=>!keys.includes(k))||typeof r.type!=='string'||r.type.length>80||r.report_date!==null&&(!/^\d{4}-\d\d-\d\d$/.test(r.report_date)||!instant(r.report_date))||['uploaded_at','received_at'].some(k=>r[k]!==null&&!instant(r[k]))||r.pages!==null&&!count(r.pages)||r.issuer!==null&&(typeof r.issuer!=='string'||r.issuer.length>240)||!['whatsapp_filed','navigator_upload','whatsapp_received'].includes(r.channel)||typeof r.state!=='string'||r.state.length>80||!Array.isArray(r.molecular_methods)||r.molecular_methods.length>6||r.molecular_methods.some(m=>!methods.has(m))||r.genetics_status!==(r.molecular_methods.length?'molecular_method_linked':'not_recorded')))throw Error('rows');
 if(d.totals.molecular_evidence_reports>d.totals.reports||d.totals.report_date_unknown>d.totals.reports)throw Error('totals');
 if(d.has_more&&(!d.next||!instant(d.next.at)||!uuid(d.next.id)||Object.keys(d.next).length!==2||!d.rows.length||d.next.id!==d.rows.at(-1).id||d.next.at!==d.rows.at(-1).at)||!d.has_more&&d.next!==null)throw Error('cursor');
 return d;
}
export function mountReportHistory234(host,patientId,{isCurrent=()=>true}={}){
 const scope=createReportView234(host,{isCurrent}),root=scope.root;let kind='reports',rows=[],next=null,busy=false;
 if(!scope.current())return scope;if(!uuid(patientId)){root.textContent='Report history is unavailable. Reopen the patient record.';return scope;}
 root.className='report-history234';root.innerHTML=`<style>.report-history234{min-width:0;overflow-wrap:anywhere}.report-history234 article{padding:16px;border:1px solid var(--line,var(--border-color));border-radius:12px;margin:12px 0}.report-history234 .rh-actions{display:flex;gap:8px;flex-wrap:wrap}.report-history234 dt{font-weight:600;margin-top:8px}.report-history234 dd{margin-left:0}.report-history234 [hidden]{display:none!important}</style>
 <h2>Report history</h2><p>Saved report metadata for this patient's current care and document-consent scope.</p>
 <p data-rh-totals role="status"></p><div class="rh-actions" role="group" aria-label="Report history source"><button class="btn btn-secondary" data-rh-kind="reports" aria-pressed="true">Reports and papers</button><button class="btn btn-ghost" data-rh-kind="originals" aria-pressed="false">WhatsApp originals</button><button class="btn btn-ghost" data-rh-refresh>Refresh history</button></div>
 <p data-rh-message role="status" aria-live="polite"></p><div data-rh-rows></div><button class="btn btn-secondary" data-rh-more hidden>Load earlier</button>
 <p class="due-meta" style="white-space:normal">A filed report is a logical page group. A WhatsApp original is a received file; these counts must not be added. Printed report dates and upload/receipt dates are labelled separately. A linked molecular-test method is recorded evidence, not a diagnosis or confirmation of a genetics report. No universal genetics-report classification is stored; missing classification means Not recorded.</p>`;
 const list=root.querySelector('[data-rh-rows]'),message=root.querySelector('[data-rh-message]'),more=root.querySelector('[data-rh-more]'),totals=root.querySelector('[data-rh-totals]');
 function controls(){root.querySelectorAll('button').forEach(b=>b.disabled=busy);root.querySelectorAll('[data-rh-kind]').forEach(b=>{const on=b.dataset.rhKind===kind;b.setAttribute('aria-pressed',String(on));b.className='btn '+(on?'btn-secondary':'btn-ghost');});more.hidden=!next;more.style.display=next?'':'none';}
 function paint(){list.innerHTML=rows.length?rows.map(r=>`<article data-report234="${r.id}"><h3>${sanitize(reportType234(r.type))}</h3><dl>${kind==='reports'?`<dt>Report date</dt><dd>${sanitize(printed(r.report_date))}${r.report_date?'':' - placed by upload date'}</dd><dt>Uploaded</dt><dd>${sanitize(stamp(r.uploaded_at))}</dd>${r.issuer?`<dt>Recorded issuer</dt><dd>${sanitize(r.issuer)}</dd>`:''}<dt>Genetics and molecular evidence</dt><dd>${r.molecular_methods.length?'Recorded molecular test linked: '+r.molecular_methods.map(sanitize).join(', '):'Genetics report classification not recorded'}</dd>${r.pages!==null?`<dt>Pages in this group</dt><dd>${r.pages}</dd>`:''}`:`<dt>Received through HopeBot</dt><dd>${sanitize(stamp(r.received_at))}</dd><dt>Filing state</dt><dd>${sanitize(r.state==='read'?'Sent to the reader':r.state==='waiting'?'Waiting for filing':r.state.replaceAll('_',' '))}</dd><dt>Genetics classification</dt><dd>Not recorded for this original file</dd>`}</dl></article>`).join(''):`<p>No retained ${kind==='reports'?'filed reports or papers':'WhatsApp originals'} are available in this current scope.</p>`;}
 async function load(earlier=false){if(!scope.current()||busy)return;busy=true;if(!earlier){scope.invalidate();rows=[];next=null;list.replaceChildren();totals.textContent='';}message.textContent='Checking current report access...';controls();
  try{const d=response(await scope.read('patient_reports234',{p_patient:patientId,p_kind:kind,p_before:earlier?next:null,p_limit:25}),scope.actor,patientId,kind);if(!scope.current())return;
   const seen=new Set(rows.map(r=>r.id));rows.push(...d.rows.filter(r=>!seen.has(r.id)));next=d.next;paint();totals.textContent=`${d.totals.reports} filed reports/papers; ${d.totals.originals} received originals. ${d.totals.molecular_evidence_reports} filed groups have linked molecular-method evidence. ${d.totals.report_date_unknown} have no valid recorded report date.`;message.textContent='Updated '+stamp(d.as_of)+'.';
  }catch(e){if(e.stale||!scope.current())return;rows=[];next=null;list.replaceChildren();totals.textContent='';message.textContent='Report history could not be confirmed. Current care permission and document consent are required. Refresh to retry.';}
  finally{busy=false;if(scope.current())controls();}
 }
 root.querySelectorAll('[data-rh-kind]').forEach(b=>b.onclick=()=>{if(busy||!scope.current())return;kind=b.dataset.rhKind;load();});root.querySelector('[data-rh-refresh]').onclick=()=>load();more.onclick=()=>load(true);load();return {...scope,refresh:()=>load()};
}
