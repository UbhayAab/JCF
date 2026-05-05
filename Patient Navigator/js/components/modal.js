// ============================================================
// Patient Navigator — Modal Component
// ============================================================

let activeModal = null;

export function showModal({ title, content, size = '', footer = '', onClose = null }) {
  closeModal(); // Close any existing modal

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${size ? 'modal-' + size : ''}">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="btn btn-ghost btn-icon btn-sm modal-close-btn" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">${typeof content === 'string' ? content : ''}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>
  `;

  // If content is a DOM element, append it
  if (typeof content !== 'string' && content instanceof HTMLElement) {
    overlay.querySelector('.modal-body').innerHTML = '';
    overlay.querySelector('.modal-body').appendChild(content);
  }

  document.body.appendChild(overlay);
  activeModal = overlay;

  // Animate in
  requestAnimationFrame(() => overlay.classList.add('active'));

  // Close handlers
  overlay.querySelector('.modal-close-btn').addEventListener('click', () => closeModal(onClose));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(onClose);
  });

  // Escape key
  const escHandler = (e) => {
    if (e.key === 'Escape') { closeModal(onClose); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);

  return overlay;
}

export function closeModal(onClose = null) {
  if (!activeModal) return;
  activeModal.classList.remove('active');
  const m = activeModal;
  activeModal = null;
  setTimeout(() => m.remove(), 250);
  if (onClose) onClose();
}

export function confirmModal(message, onConfirm) {
  return showModal({
    title: 'Confirm Action',
    content: `<p style="margin:0">${message}</p>`,
    footer: `
      <button class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
      <button class="btn btn-danger" id="modal-confirm-btn">Confirm</button>
    `,
    onClose: null,
  });
}

// Attach confirm/cancel handlers after DOM is ready
document.addEventListener('click', (e) => {
  if (e.target.id === 'modal-cancel-btn') closeModal();
  if (e.target.id === 'modal-confirm-btn') {
    // The confirm action should be set by the caller
    const event = new CustomEvent('modal-confirmed');
    document.dispatchEvent(event);
    closeModal();
  }
});
