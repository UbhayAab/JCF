// ============================================================
// Patient Navigator: Profile Page
// ============================================================

import { getCurrentProfile, updateProfile, changePassword, getUserRole } from '../auth.js';
import { getSupabase } from '../supabase.js';
import { showToast } from '../components/toast.js';
import { formatDate, capitalize } from '../utils/formatters.js';
import { validatePassword } from '../utils/validators.js';

export async function renderProfile(container) {
  const profile = getCurrentProfile();
  container.innerHTML = `
    <div class="page-header"><h1>My Profile</h1></div>
    <div class="content-grid">
      <div class="col-span-6">
        <div class="card">
          <h4 class="mb-4">Personal Information</h4>
          <form id="profile-form">
            <div class="form-group">
              <label class="form-label">Full Name</label>
              <input class="form-input" id="prof-name" value="${profile?.full_name || ''}" />
            </div>
            <div class="form-group">
              <label class="form-label">Phone</label>
              <input class="form-input" id="prof-phone" value="${profile?.phone || ''}" placeholder="Optional" />
            </div>
            <div class="form-group">
              <label class="form-label">Role</label>
              <input class="form-input" value="${capitalize(getUserRole())}" disabled />
              <span class="form-hint">Contact an admin to change your role.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Member Since</label>
              <input class="form-input" value="${formatDate(profile?.created_at)}" disabled />
            </div>
            <div class="form-actions" style="border:none;margin-top:var(--space-4)">
              <button type="submit" class="btn btn-primary">Save Changes</button>
            </div>
          </form>
        </div>
      </div>
      <div class="col-span-6">
        <div class="card">
          <h4 class="mb-4">Change Password</h4>
          <form id="password-form">
            <div class="form-group">
              <label class="form-label">New Password</label>
              <input class="form-input" id="prof-password" type="password" placeholder="Min 8 characters" />
            </div>
            <div class="form-group">
              <label class="form-label">Confirm Password</label>
              <input class="form-input" id="prof-password-confirm" type="password" placeholder="Repeat password" />
            </div>
            <div class="form-actions" style="border:none;margin-top:var(--space-4)">
              <button type="submit" class="btn btn-secondary">Update Password</button>
            </div>
          </form>
        </div>

        <!-- "I can't save anything on my laptop" is impossible to act on
             without knowing WHICH of session, account or permission failed.
             This runs the four checks and prints the answer, so the report
             that reaches us is a cause instead of a symptom. -->
        <div class="card" style="margin-top:var(--space-5)">
          <h4 class="mb-4">Can't save anything?</h4>
          <p style="font-size:var(--font-xs);color:var(--color-text-muted);margin:0 0 var(--space-4)">
            Run this on the device that is failing and send the result. It says exactly which step is broken.
          </p>
          <button class="btn btn-secondary" id="diag-run">Check my access</button>
          <div id="diag-out" style="margin-top:var(--space-4);font-size:13px;line-height:1.7"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('diag-run')?.addEventListener('click', async () => {
    const btn = document.getElementById('diag-run');
    const out = document.getElementById('diag-out');
    btn.disabled = true; out.innerHTML = 'Checking…';
    const line = (ok, label, detail) =>
      `<div><span style="color:${ok ? 'var(--ok,#2E7D55)' : 'var(--danger,#B0433A)'};font-weight:700">${ok ? '✓' : '✗'}</span>
        ${label}${detail ? ` <span style="color:var(--color-text-muted)">(${detail})</span>` : ''}</div>`;
    const rows = [];
    try {
      const sb = getSupabase();
      const { data: sess } = await sb.auth.getSession();
      const s = sess?.session;
      rows.push(line(!!s, 'Signed in', s ? `token valid to ${new Date(s.expires_at * 1000).toLocaleString('en-IN')}` : 'no session on this device: sign out and sign in again'));

      if (s) {
        const { data: prof, error: pe } = await sb.from('profiles')
          .select('id, full_name, role, is_active').eq('id', s.user.id).maybeSingle();
        rows.push(line(!pe && !!prof, 'Account found', pe ? pe.message : (prof ? `${prof.role}` : 'no profile row. An admin must recreate it')));
        if (prof) rows.push(line(!!prof.is_active, 'Account is active', prof.is_active ? '' : 'switched off: ask an admin to turn it back on'));

        // A real write, on a row every user is allowed to touch.
        const { data: w, error: we } = await sb.from('profiles')
          .update({ updated_at: new Date().toISOString() }).eq('id', s.user.id).select('id');
        rows.push(line(!we && !!w?.length, 'Saving works', we ? we.message : (w?.length ? '' : 'the write was refused with no error, usually a stale login; sign out and back in')));
      }
    } catch (e) {
      rows.push(line(false, 'Could not reach the server', e.message));
    }
    out.innerHTML = rows.join('');
    btn.disabled = false;
  });

  document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await updateProfile({
        full_name: document.getElementById('prof-name').value.trim(),
        phone: document.getElementById('prof-phone').value.trim() || null,
      });
      showToast('Profile updated', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('prof-password').value;
    const confirm = document.getElementById('prof-password-confirm').value;
    if (pw !== confirm) { showToast('Passwords do not match', 'warning'); return; }
    const err = validatePassword(pw);
    if (err) { showToast(err, 'warning'); return; }
    try {
      await changePassword(pw);
      showToast('Password updated', 'success');
      document.getElementById('password-form').reset();
    } catch (err) { showToast(err.message, 'error'); }
  });
}
