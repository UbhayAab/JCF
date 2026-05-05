// ============================================================
// Patient Navigator — Validators
// ============================================================

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password) {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  return null;
}

export function validateRequired(value, fieldName) {
  if (!value || (typeof value === 'string' && !value.trim())) {
    return `${fieldName} is required`;
  }
  return null;
}

export function validateAge(age) {
  const n = parseInt(age);
  if (isNaN(n) || n < 0 || n > 150) return 'Please enter a valid age (0-150)';
  return null;
}

export function validatePinCode(pin) {
  if (!pin) return null; // optional
  if (!/^\d{6}$/.test(pin)) return 'PIN code must be exactly 6 digits';
  return null;
}

export function validatePhone(phone) {
  if (!phone) return null; // optional
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 12) return 'Please enter a valid phone number';
  return null;
}

// Sanitize input to prevent XSS
export function sanitize(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
