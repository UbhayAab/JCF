// The embedded patient is the current authorized relationship. A raw call
// subject ID is not authority to open a patient record after reassignment.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid=x=>typeof x==='string'&&x.length===36&&UUID.test(x);
const text=(x,max)=>typeof x==='string'?x.trim().slice(0,max):'';
const unavailable=()=>({id:null,name:'Patient record unavailable',code:'',hasCurrentRecord:false,
 detail:'The call is saved. Current patient details are not available for this account.'});
export function callPatientIdentity150(call){
 if(!call||typeof call!=='object'||Array.isArray(call))return unavailable();
 const p=call.patients;
 if(!p||typeof p!=='object'||Array.isArray(p)||!uuid(call.patient_id)||!uuid(p.id)||p.id.toLowerCase()!==call.patient_id.toLowerCase())return unavailable();
 const code=text(p.patient_code,80),name=text(p.full_name,160);
 return{id:p.id,name:name||code||'Patient name not recorded',code,hasCurrentRecord:true,
  detail:name||code?'':'This patient record has no name or code in this result.'};
}
