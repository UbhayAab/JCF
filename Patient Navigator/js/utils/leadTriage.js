// Classification is native evidence or self-report, never an inferred clinical identity.
export function leadKind(row) {
  if(typeof row?.is_team!=='boolean')return 'unavailable';
  if(row.is_team)return 'team';
  if(row.patient_id)return 'registered';
  return row.role==='patient'?'patient':row.role==='caregiver'?'caregiver':'review';
}
export const LEAD_LABELS={team:'Team test',registered:'Registered family',patient:'Patient - self-reported',caregiver:'Caregiver - self-reported',review:'Identity needs review'};
const time=value=>{const n=Date.parse(value);return Number.isFinite(n)?n:0;};
export function newestLeads(rows) {
  return [...rows].sort((a,b)=>(time(b.created_at)||time(b.first_seen_at))-(time(a.created_at)||time(a.first_seen_at))||String(b.id||'').localeCompare(String(a.id||'')));
}
export function callbackTriage(rows,flags) {
  let unavailable=false;
  const items=rows.filter(row=>{
    // Safety, privacy requests and linked families keep their original authorized route.
    if(row.safety||row.team==='all'||row.team==='admin'||row.reason==='deletion_request'||row.family?.patient_id)return true;
    const flag=flags.get(row.family?.lead_id||row.lead_id);
    if(typeof flag!=='boolean'){unavailable=true;return false;}
    return flag===false;
  });
  return {items,unavailable};
}
