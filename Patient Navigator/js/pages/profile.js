// ============================================================
// Patient Navigator — Profile Page
// ============================================================

import { getCurrentProfile, updateProfile, changePassword, getUserRole } from '../auth.js';
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
      </div>
    </div>
  `;

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
