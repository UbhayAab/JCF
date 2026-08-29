// ============================================================
// Patient Navigator: Formatters
// ============================================================

export function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDate(dateStr);
}

export function maskPhone(phone) {
  if (!phone) return 'N/A';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return 'XXXX';
  return 'XXXXX-X' + digits.slice(-4);
}

export function capitalize(str) {
  if (!str) return '';
  return str
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bPoc\b/g, 'POC');
}

export function getDialStatusBadge(status) {
  const map = {
    connected: 'badge-success',
    no_answer: 'badge-warning',
    busy: 'badge-warning',
    wrong_number: 'badge-danger',
    callback_requested: 'badge-info',
    voicemail: 'badge-neutral',
  };
  return `<span class="badge badge-dot ${map[status] || 'badge-neutral'}">${capitalize(status)}</span>`;
}

export function getMindsetBadge(mindset) {
  const map = {
    hopeful: 'badge-success', informed: 'badge-success', grateful: 'badge-success',
    neutral: 'badge-neutral',
    anxious: 'badge-warning', resistant: 'badge-warning',
    distressed: 'badge-danger',
  };
  return `<span class="badge ${map[mindset] || 'badge-neutral'}">${capitalize(mindset)}</span>`;
}

// Pretty, user-facing role name. There is no "caller" any more. Anyone
// still carrying the legacy role value reads as a Caregiver Mentor.
export function roleLabel(role) {
  const labels = {
    caller: 'Caregiver Mentor',
    caregiver_mentor: 'Caregiver Mentor',
    ground_poc: 'Ground POC',
    uploader: 'Intake / Uploader',
  };
  return labels[role] || capitalize(role);
}

export function getRoleBadge(role) {
  const map = {
    admin: 'badge-danger', manager: 'badge-info', caller: 'badge-success',
    ground_poc: 'badge-primary', caregiver_mentor: 'badge-success', therapist: 'badge-primary',
    nutritionist: 'badge-warning', content: 'badge-neutral'
  };
  return `<span class="badge ${map[role] || 'badge-neutral'}">${roleLabel(role)}</span>`;
}

export function renderScoreBar(score, max = 10) {
  let html = '<div class="score-bar">';
  for (let i = 1; i <= max; i++) {
    const level = i <= 3 ? 'low' : i <= 6 ? 'mid' : 'high';
    html += `<div class="bar-segment ${i <= score ? 'filled ' + level : ''}"></div>`;
  }
  html += '</div>';
  return html;
}

export function renderSkeleton(rows = 5) {
  let html = '';
  for (let i = 0; i < rows; i++) {
    html += `<div class="skeleton skeleton-row"></div>`;
  }
  return html;
}

// ---- CSV Export ----

// A phone number is digits, so Excel opens it as a NUMBER: 6200552712 renders
// as 6.2E+09 in a default-width column, and any leading 0 or +91 is thrown
// away. The team read that as "the phone numbers are missing".
//
// Quoting alone does not help - Excel ignores quotes when it guesses a type.
// The one thing it honours is a leading tab inside a quoted field: the cell is
// forced to text, the tab itself is not displayed, and the digits survive
// exactly as stored. Other CSV readers see a leading tab, which is a cheap
// trade for the file actually being readable where it is actually opened.
const PHONEISH_LABEL = /phone|mobile|whatsapp|contact\s*(no|number)|aadhaar|account\s*(no|number)/i;

// Only long digit runs need rescuing. Ages, scores, amounts and counts are
// numbers the reader WANTS as numbers, so they are left alone.
function needsTextCell(value, column) {
  // An empty cell stays empty. Forcing text on a blank writes a lone tab,
  // which is not a value anybody asked for.
  if (!value) return false;
  if (column.text === false) return false;
  if (column.text === true) return true;
  if (!PHONEISH_LABEL.test(column.label || '')) return false;
  return /^[+\d][\d\s()+-]{5,}$/.test(value);
}

function csvCell(value, column) {
  let val = String(value).replace(/"/g, '""');
  if (needsTextCell(val, column)) return `"\t${val}"`;
  if (/[",\r\n]/.test(val)) return `"${val}"`;
  return val;
}

export function exportToCSV(data, filename, columns) {
  if (!data || data.length === 0) return;

  const headers = columns.map(c => csvCell(c.label, { label: '' }));
  const rows = data.map(row =>
    columns.map(c => {
      const raw = c.accessor ? c.accessor(row) : row[c.key] ?? '';
      return csvCell(raw === null || raw === undefined ? '' : raw, c);
    }).join(',')
  );

  // CRLF: Excel treats a bare LF row separator inconsistently once any cell
  // carries an embedded newline, which caller notes routinely do.
  const csv = [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
