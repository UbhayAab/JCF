import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';
import { DIAL_STATUSES, RECEPTIVENESS, REQUIREMENTS, CONDITIONS } from '../utils/catalog.js';
import { PRIVACY_LINE } from './callRecording.js';

export const CARE_CONSENT_WORDING_VERSION136 = 'pn-care-call136-v1';

// One questionnaire for every intake channel. Persistence remains typed.
export function renderCareCallForm136(p, { pitches = {}, callNum = 1, services = [], leverHTML = '', contactMode = false, historyIncomplete = false } = {}) {
  const showDeeper = callNum >= 2;   // services, WhatsApp, consent, details
  return `
    <div class="card card-flush logform">
      <div class="lf-head" style="flex-wrap:wrap;gap:10px"><h3>How did it go?</h3>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;max-width:100%">
          <span class="faint" style="font-size:13px;color:var(--ink-3);min-width:0;max-width:100%;overflow-wrap:anywhere">${sanitize((p.full_name || '').split(' ')[0])}</span>
          <!-- Relabelled 2026-09-10. The RPC behind this modal has been live
               since sql/113 and had been used ZERO times (321 concerns, 0 with
               reassign_requested). Prachi's report on 01/09 asks for an
               "Escalate/Flag Patient or Request Reassignment option"; the
               button said "Raise a concern", which nobody looking for a way
               out of a call reads as that. Text only, same handler. -->
${!contactMode ? `          <button type="button" class="btn btn-ghost btn-sm" id="f-concern" title="Flag something a supervisor must see, including how this call is going for you, and ask to be taken off this patient" style="color:var(--danger);gap:6px">${icon('alertTriangle')}Flag / hand over</button>
          <!-- 2026-09-10: mark_patient_disinterest shipped in sql/125 and had
               been used ZERO times, because the only way to reach it was the
               patient record. The intern learns a family is not taking part
               DURING the call, on this screen, and was not going to navigate
               away mid-call to say so. Same modal, reachable where the fact
               is learned. -->
          <button type="button" class="btn btn-ghost btn-sm" id="f-disinterest" title="They do not want to take part. Stops them being passed round the team while that is true." style="color:var(--warn);gap:6px">${icon('skip')}Not taking part</button>
          <button type="button" class="btn btn-ghost btn-sm" id="f-block" title="Severe cases only: block for everyone until a manager reviews. Needs a reason." style="color:var(--danger);gap:6px">${icon('x')}Block</button>` : `<button type="button" class="btn btn-secondary btn-sm" data-family-register136>Confirm patient record</button>`}
        </div>
      </div>
      <div class="lf-body">${contactMode ? `<div class="followup" data-family-intake136><strong>Care intake</strong><p class="due-meta">Start with the same care questions below. Confirm the patient's identity and permission before linking a record. Recording, well-being scores and changes to a patient's record become available after that confirmation.</p></div>` : ''}
        ${p.consent_given ? `
        <div class="followup" style="background:var(--ok-soft);border-color:var(--ok);padding:10px 12px">
          <div class="fu-head" style="color:var(--ok)">${icon('shieldCheck')}<span>Consent on file</span></div>
          <p style="font:var(--t-xs);color:var(--ink-2);margin:6px 0 0">They have already agreed. Anything they tell you today can be saved.</p>
        </div>` : `
        <div class="followup" id="consent-block" style="background:var(--gold-soft);border-color:var(--gold)">
          <div class="fu-head" style="color:var(--gold-deep)">${icon('shieldCheck')}<span>Consent first</span></div>
          <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 10px">${callNum >= 2
            ? '“May I note down a few details about the diagnosis? It stays private and helps our team guide you better.”'
            : '“Is it alright if we stay in touch and keep a few notes about your care? It stays private, and you can ask us to stop any time.”'}</p>
          <p style="font:var(--t-xs);color:var(--ink-2);margin:0 0 10px">“${PRIVACY_LINE}”</p>
          <p style="font:var(--t-xs);color:var(--ink-3);margin:0 0 10px">Until they say yes, nothing about them can be saved. Ask this before anything else.</p>
          <div class="yesno" data-yn="consent"><button type="button" class="yn" data-v="yes">They consented</button><button type="button" class="yn" data-v="no">Not today</button></div>
          <div class="due-meta" id="consent-saved" style="display:none;margin-top:8px;color:var(--ok)"></div>
        </div>`}
        <!-- sql/166, Fixboard #22: the recording, its transcript and suggested answers. -->
        ${contactMode ? '<div id="rec-mount"><p class="due-meta">Confirm the patient record before asking for a call recording.</p></div>' : '<div id="rec-mount"></div>'}
        <div class="field"><label>Call outcome <span class="req">*</span></label>
          <div class="seg seg-wrap" id="seg-outcome">
            ${DIAL_STATUSES.map(o => `<button type="button" class="seg-btn" data-status="${o.key}" data-tone="${o.tone}">${icon(o.icon)}<span>${o.label}</span></button>`).join('')}
          </div>
        </div>
        <div class="reveal" id="reveal-connected"><div class="reveal-inner">
          <div class="field"><label>How were they doing? <span class="req">*</span></label>
            <div class="recep" id="recep">${RECEPTIVENESS.map(r => `<button type="button" class="recep-btn" data-recep="${r.key}"><div class="recep-label">${r.label}</div><div class="recep-hint">${r.hint}</div></button>`).join('')}</div>
          </div>
          <div class="field"><label>How is the patient doing?</label>
            <div class="seg" style="grid-template-columns:repeat(auto-fit,minmax(96px,1fr))" id="seg-condition">
              ${CONDITIONS.map(c => `<button type="button" class="seg-btn" data-cond="${c.key}" data-tone="${c.tone}"><span>${c.label}</span></button>`).join('')}
            </div>
          </div>
          <div class="field"><label>What did they ask for?</label>
            <div class="chips" id="reqs" style="display:flex;flex-wrap:wrap;gap:8px">
              ${REQUIREMENTS.map(r => `<button type="button" class="chip seg-btn" data-req="${r.key}" data-tone="primary" style="padding:8px 12px">${icon(r.icon)}<span>${r.key}</span></button>`).join('')}
            </div>
            <input class="input" id="f-customreq" placeholder="Anything else they asked for…" style="margin-top:8px" />
          </div>
          ${showDeeper ? '<div id="invite-moment"></div>' : ''}
          ${showDeeper ? `
          <button type="button" class="btn btn-secondary" id="f-details-btn">${icon('stethoscope')}Add clinical details they shared</button>
          <div class="field"><label>Services offered today</label>
            <div class="services" id="services">
              ${services.map(s => { const already = !!pitches[s.column];
                return `<label class="svc${already ? ' on locked' : ''}" data-svc="${s.key}"><input type="checkbox" ${already ? 'checked disabled' : ''} />${icon(s.icon)}<span class="svc-label">${s.label}</span>${already ? '<span class="svc-note">offered earlier</span>' : ''}</label>`; }).join('')}
            </div>
          </div>
          <div class="row gap5 wrap" style="display:flex;gap:20px;flex-wrap:wrap">
            <div class="field grow" style="flex:1;min-width:140px"><label>WhatsApp link sent?</label>
              <div class="yesno" data-yn="waLink"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
            <div class="field grow" style="flex:1;min-width:140px"><label>Joined the WhatsApp group?</label>
              <div class="yesno" data-yn="whatsapp"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
            <div class="field grow" style="flex:1;min-width:140px"><label>Following our channels?</label>
              <div class="yesno" data-yn="social"><button type="button" class="yn" data-v="yes">Yes</button><button type="button" class="yn" data-v="no">No</button></div></div>
          </div>` : `
          <p style="font:var(--t-xs);color:var(--ink-3);margin:0;padding:10px 12px;background:var(--surface-3);border-radius:var(--r-sm)">
            ${icon('info')} ${historyIncomplete ? 'Earlier care-call history could not be fully confirmed. Ask about previous conversations and follow the family\'s lead; the available history may be incomplete.' : 'First call. Focus on trust and consent. The HopeBot introduction is available today in its own panel after consent; the longer service and medical questions appear from the second call.'}
          </p>`}
          <button type="button" class="btn btn-ghost btn-sm" id="f-wellbeing-btn" ${contactMode ? 'disabled title="Confirm the patient record to record well-being scores"' : ''} style="align-self:flex-start">${icon('activity')}Record well-being scores (PHQ-4, QoL…)</button>
          <div class="row gap5 wrap" style="display:flex;gap:20px;flex-wrap:wrap">
            <div class="field grow" style="flex:1;min-width:170px"><label>Feedback from patient</label>
              <input class="input" id="f-fb-patient" placeholder="In their words…" /></div>
            <div class="field grow" style="flex:1;min-width:170px"><label>Feedback from caregiver</label>
              <input class="input" id="f-fb-caregiver" placeholder="In their words…" /></div>
          </div>
        </div></div>
        <div class="field"><label>General notes</label>
          <textarea class="textarea" id="f-notes" placeholder="Anything worth remembering about this conversation…"></textarea></div>
        <div class="followup">
          <div class="fu-head">${icon('calendar')}<span>Next care call</span><span class="fu-auto" id="fu-auto" style="display:none">suggested for you</span></div>
          <div class="field"><label>Date</label><input class="input" type="date" id="f-followup" /><div class="muted" style="font-size:12px">Doctor appointments and treatment dates belong in General notes.</div></div>
          <div class="field" style="margin-top:12px"><label>A note to hand the next caregiver mentor</label>
            <textarea class="textarea" id="f-strategy" placeholder="What helped, what to lead with, the best time to reach them…"></textarea></div>
        </div>
        ${contactMode ? '' : leverHTML}
      </div>
      <!-- #f-why: a greyed Submit always says what it is waiting for, same
           rule as "Save call" in components/callForm.js (field report 25/09). -->
      <div class="lf-actions" style="flex-wrap:wrap">
        <div id="f-why" role="status" aria-live="polite" style="flex:1 1 100%;font-size:12.5px;line-height:1.35;color:var(--ink-3)"></div>
        <button class="btn btn-ghost" id="f-skip">${icon('skip')}Skip for now</button>
        <button class="btn btn-primary grow" id="f-submit" style="flex:1" disabled>${icon('check')}Submit &amp; next call</button>
      </div>
    </div>`;
}
