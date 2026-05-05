// ============================================================
// Patient Navigator — Formatters
// ============================================================

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '—';
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
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return 'XXXX';
  return 'XXXXX-X' + digits.slice(-4);
}

export function capitalize(str) {
  if (!str) return '';
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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

export function getRoleBadge(role) {
  const map = {
    admin: 'badge-danger', manager: 'badge-info', caller: 'badge-neutral',
    caregiver_mentor: 'badge-success', therapist: 'badge-primary',
    nutritionist: 'badge-warning', content: 'badge-neutral'
  };
  return `<span class="badge ${map[role] || 'badge-neutral'}">${capitalize(role)}</span>`;
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
export function exportToCSV(data, filename, columns) {
  if (!data || data.length === 0) return;

  // Build header
  const headers = columns.map(c => c.label);
  const rows = data.map(row =>
    columns.map(c => {
      let val = c.accessor ? c.accessor(row) : row[c.key] || '';
      // Escape CSV values
      val = String(val).replace(/"/g, '""');
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = `"${val}"`;
      }
      return val;
    }).join(',')
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
