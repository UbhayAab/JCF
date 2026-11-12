// Text-only, on-demand saved conversation. Every page is authorized natively;
// no message content, cursor or session is written to browser storage.
import { getSupabase } from '../supabase.js';
import { getCurrentUser, getCurrentProfile, isImpersonating } from '../auth.js';
import { showModal } from './modal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUT = { queued:'Queued - not sent yet', sending:'Sending', accepted:'Sent to WhatsApp', delivered:'Delivered', read:'Read', failed:'Send failed', unknown:'Send outcome unknown', suppressed:'Held - not sent', cancelled:'Cancelled - not sent' };
const IN = { received:'Received', processed:'Received', superseded:'Combined with another message', ignored:'Ignored', failed:'Processing failed' };
const actorKey = () => {
  const u=getCurrentUser(),p=getCurrentProfile();
  return JSON.stringify([u?.id,p?.id,p?.role,p?.is_active,p?.ends_on,p?.must_change_password,p?.on_probation,isImpersonating()]);
};
const validTime = value => typeof value==='string' && Number.isFinite(Date.parse(value));
const when = value => new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'})+' IST';

function validMessage(m) {
  return m && UUID.test(m.id) && ['in','out'].includes(m.direction) && validTime(m.at)
    && (m.direction==='in' ? m.speaker==='family' && Object.prototype.hasOwnProperty.call(IN,m.status) : ['hopebot','staff','automatic','saved_outgoing'].includes(m.speaker) && Object.prototype.hasOwnProperty.call(OUT,m.status))
    && (m.direction==='in' || m.sent_at===null || validTime(m.sent_at))
    && typeof m.kind==='string' && m.kind.length<=64
    && (m.text===null || typeof m.text==='string' && m.text.length<=8192)
    && ['saved_message','saved_preview'].includes(m.text_source) && typeof m.truncated==='boolean'
    && (m.redaction===null || ['safety','privacy','not_reviewed'].includes(m.redaction))
    && (!m.redaction || m.text===null)
    && Array.isArray(m.options) && m.options.length<=10 && m.options.every(x=>typeof x==='string' && x.length<=160)
    && (!m.redaction || m.options.length===0);
}
function validCursor(cursor,messages) {
  const first=messages[0];
  return cursor && validTime(cursor.at) && UUID.test(cursor.id) && [0,1].includes(cursor.side)
    && first && cursor.id===first.id && cursor.at===first.at && cursor.side===(first.direction==='in'?0:1);
}

export function openLeadConversation223(lead,{isCurrent=()=>true}={}) {
  const user=getCurrentUser(),profile=getCurrentProfile(),identity=actorKey();
  if(!UUID.test(lead?.id) || !user?.id || profile?.id!==user.id || isImpersonating() || !isCurrent())return null;
  const leadId=lead.id;
  const el=document.createElement('section');
  el.dataset.leadConversation223=leadId;
  el.innerHTML=`<p data-conversation-name style="font-weight:700;overflow-wrap:anywhere"></p>
    <p class="due-meta wraps">Saved family messages and support replies, including staff replies. Proactive messages and file contents are not included. A queued or held reply has not been delivered.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0"><button type="button" class="btn btn-secondary btn-sm" data-conversation-refresh>Refresh conversation</button><button type="button" class="btn btn-secondary btn-sm" data-conversation-earlier hidden style="display:none">Load earlier messages</button></div>
    <p class="due-meta wraps" data-conversation-status role="status" aria-live="polite"></p>
    <div data-conversation-messages role="log" aria-label="Saved conversation" aria-live="off" style="max-height:58vh;overflow:auto;overflow-wrap:anywhere;min-width:0"></div>`;
  el.querySelector('[data-conversation-name]').textContent=lead.name || 'WhatsApp lead';
  const list=el.querySelector('[data-conversation-messages]'),status=el.querySelector('[data-conversation-status]');
  const refresh=el.querySelector('[data-conversation-refresh]'),earlier=el.querySelector('[data-conversation-earlier]');
  let overlay,observer,request=null,disposed=false,generation=0,messages=[],cursor=null,more=false,busy=false;
  const current=()=>!disposed && el.isConnected && overlay?.isCurrentModal?.() && user===getCurrentUser()
    && profile===getCurrentProfile() && actorKey()===identity && isCurrent();
  function dispose() {
    if(disposed)return;
    disposed=true;++generation;request?.abort();observer?.disconnect();
    window.removeEventListener('hashchange',check);
    window.removeEventListener('pn:probation-access224',check);
    messages=[];cursor=null;list.replaceChildren();
  }
  function check() {
    if(current())return;
    const close=overlay?.isCurrentModal?.();dispose();
    if(close)overlay.closeOwnedModal?.();
  }
  function paint() {
    const fragment=document.createDocumentFragment();
    for(const message of messages) {
      const card=document.createElement('article');card.className='card';card.dataset.messageId=message.id;
      card.dataset.direction=message.direction;card.style.cssText='padding:12px;margin:8px 0;min-width:0;overflow-wrap:anywhere';
      const author=document.createElement('strong');
      author.textContent=message.speaker==='family'?'Family':message.speaker==='staff'?'Staff reply':message.speaker==='hopebot'?'HopeBot reply':message.speaker==='automatic'?'Automatic reply':'Saved outgoing message';card.append(author);
      const meta=document.createElement('p');meta.className='due-meta wraps';meta.style.margin='4px 0';
      meta.textContent=(message.direction==='in'?'Received ':'Saved ')+when(message.at)+' - '+(message.direction==='in'?IN[message.status]:OUT[message.status]);
      if(message.direction==='out' && message.sent_at)meta.textContent+='; sent '+when(message.sent_at);card.append(meta);
      const body=document.createElement('p');body.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0';
      body.textContent=message.redaction==='safety'?'Safety message contents are withheld.'
        :message.redaction==='privacy'?'Privacy-request contents are withheld.'
        :message.redaction==='not_reviewed'?'Message text is not available for this care view yet.'
        :message.text || (['audio','voice'].includes(message.kind)?'Voice message; no saved text is available.'
          :['document','image','video'].includes(message.kind)?'Attachment message; no saved text or caption is available.'
            :'No saved message text is available.');card.append(body);
      if(message.options.length) {
        const label=document.createElement('p');label.className='due-meta';label.textContent='Choices offered:';card.append(label);
        const choices=document.createElement('ul');choices.style.paddingLeft='20px';
        for(const text of message.options){const item=document.createElement('li');item.textContent=text;choices.append(item);}card.append(choices);
      }
      if(!message.redaction && (message.text_source==='saved_preview' || message.truncated)) {
        const note=document.createElement('p');note.className='due-meta wraps';
        note.textContent=message.truncated?'Showing the first 4,096 characters.':'This is the retained preview of the reply.';card.append(note);
      }
      fragment.append(card);
    }
    list.replaceChildren(fragment);earlier.hidden=!more;earlier.style.display=more?'':'none';
  }
  async function load(loadEarlier=false) {
    if(!current() || busy){check();return;}
    const sequence=++generation;busy=true;refresh.disabled=true;earlier.disabled=true;
    if(!loadEarlier){messages=[];cursor=null;more=false;list.replaceChildren();earlier.hidden=true;earlier.style.display='none';}
    status.textContent=loadEarlier?'Loading earlier saved messages…':'Loading saved conversation…';
    const controller=new AbortController();request=controller;let deadline;
    try {
      const query=getSupabase().rpc('hopebot_lead_conversation223',{p_lead:leadId,p_before:loadEarlier?cursor:null,p_limit:10});
      const operation=typeof query.abortSignal==='function'?query.abortSignal(controller.signal):query;
      const {data,error,status:httpStatus}=await Promise.race([operation,new Promise((_,reject)=>{
        deadline=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},8000);
      })]);
      if(!current() || sequence!==generation)return;
      if(error){const failed=new Error('unavailable');failed.denied=error.code==='42501'||String(error.code||'').startsWith('PGRST3')||[401,403].includes(httpStatus)||[401,403].includes(error.status);throw failed;}
      if(!data || data.actor_id!==user.id || data.lead_id!==leadId || !validTime(data.checked_at)
        || !['available','unavailable','withheld'].includes(data.state) || !Array.isArray(data.messages)
        || data.messages.length>10 || !data.messages.every(validMessage) || typeof data.has_more!=='boolean'
        || data.has_more && !validCursor(data.next_before,data.messages)
        || data.state!=='available' && (data.messages.length || data.has_more)) {
        const failed=new Error('invalid');failed.denied=true;throw failed;
      }
      if(data.state!=='available') {
        messages=[];more=false;cursor=null;paint();
        status.textContent=data.state==='withheld'?'This conversation is unavailable while a deletion request is pending.'
          :'A matching retained conversation is not available for this lead. This does not mean that the family has never used HopeBot.';
        return;
      }
      const combined=loadEarlier?[...data.messages,...messages]:data.messages;
      const seen=new Set();messages=combined.filter(m=>{const key=m.direction+':'+m.id;if(seen.has(key))return false;seen.add(key);return true;});
      more=data.has_more;cursor=data.next_before||null;paint();
      status.textContent=messages.length?'Showing '+messages.length+' saved messages in time order. Checked '+when(data.checked_at)+'.'+(more?' Earlier saved messages are available.':'')
        :'No saved messages are available in this matched conversation. This does not confirm that no messages were exchanged.';
      list.scrollTop=loadEarlier?0:list.scrollHeight;
    }catch(error) {
      if(!current() || sequence!==generation)return;
      if(error.denied || !loadEarlier){messages=[];more=false;cursor=null;paint();}
      status.textContent=error.denied?'This conversation could not be verified for your current account. Return to your own account and refresh.'
        :loadEarlier?'Earlier messages could not be loaded. Choose Load earlier messages to retry.'
          :'The conversation could not be loaded. Choose Refresh conversation to retry.';
    }finally{
      clearTimeout(deadline);if(request===controller)request=null;
      if(current() && sequence===generation){busy=false;refresh.disabled=false;earlier.disabled=false;}
    }
  }
  overlay=showModal({title:'HopeBot conversation',content:el,size:'lg',onClose:dispose});
  observer=new MutationObserver(()=>{if(!current())check();});observer.observe(document.body,{childList:true});
  window.addEventListener('hashchange',check);window.addEventListener('pn:probation-access224',check);
  refresh.addEventListener('click',()=>load());earlier.addEventListener('click',()=>load(true));
  void load();return {dispose,refresh:()=>load(),overlay};
}
