import {getCurrentProfile,getCurrentUser,isImpersonating,updateProfile,changePassword} from '../auth.js';
import {validatePassword,sanitize} from '../utils/validators.js';

export async function renderMedicalProfile(container) {
  const profile=getCurrentProfile(),owner=getCurrentUser()?.id;
  const current=()=>container.isConnected&&getCurrentUser()?.id===owner&&getCurrentProfile()?.id===owner
    &&getCurrentProfile()?.role==='medical_navigator'&&getCurrentProfile()?.is_active===true
    &&getCurrentProfile()?.must_change_password!==true&&!isImpersonating();
  if(!current()){container.textContent='Open your own account to edit your profile.';return;}
  container.innerHTML=`<div class="page-header"><h1>My profile</h1></div>
    <section class="card" style="max-width:650px;padding:20px"><p>Medical navigator</p>
    <form data-medical-profile><div class="form-group"><label class="form-label" for="medical-name">Full name</label>
    <input class="form-input" id="medical-name" name="full_name" maxlength="200" required value="${sanitize(profile.full_name||'')}"></div>
    <div class="form-group"><label class="form-label" for="medical-phone">Contact number</label>
    <input class="form-input" id="medical-phone" name="phone" type="tel" maxlength="50" value="${sanitize(profile.phone||'')}"></div>
    <button class="btn btn-primary">Save changes</button></form>
    <form data-medical-password style="margin-top:24px"><h2>Change password</h2>
    <div class="form-group"><label class="form-label" for="medical-password">New password</label>
    <input class="form-input" id="medical-password" name="password" type="password" autocomplete="new-password" required></div>
    <div class="form-group"><label class="form-label" for="medical-password-confirm">Repeat password</label>
    <input class="form-input" id="medical-password-confirm" name="confirm" type="password" autocomplete="new-password" required></div>
    <button class="btn btn-secondary">Update password</button></form><p data-medical-profile-status role="status" aria-live="polite"></p></section>`;
  const status=text=>{if(current())container.querySelector('[data-medical-profile-status]').textContent=text;};
  const save=container.querySelector('[data-medical-profile]');
  save.onsubmit=async event=>{
    event.preventDefault();if(!current())return;const button=save.querySelector('button');button.disabled=true;
    try{await updateProfile({full_name:save.elements.full_name.value,phone:save.elements.phone.value});status('Profile saved.');}
    catch(error){status(error.message);}finally{if(button.isConnected)button.disabled=false;}
  };
  const password=container.querySelector('[data-medical-password]');
  password.onsubmit=async event=>{
    event.preventDefault();if(!current())return;
    const value=password.elements.password.value;
    const problem=validatePassword(value);if(problem){status(problem);return;}
    if(value!==password.elements.confirm.value){status('Passwords do not match.');return;}
    const button=password.querySelector('button');button.disabled=true;
    try{await changePassword(value);if(current()){password.reset();status('Password updated.');}}
    catch(error){status(error.message);}finally{if(button.isConnected)button.disabled=false;}
  };
}
