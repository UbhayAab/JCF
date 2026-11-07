const FORMATS = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};

// The medical endpoint deliberately uses application/octet-stream, and a
// document-page row need not have MIME metadata. Never trust a filename to
// decide what may be rendered.
export async function medicalDocumentFormat(blob, declaredMime) {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const starts = (signature, offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte);
  const text = (signature, offset) => starts(Array.from(signature, char => char.charCodeAt(0)), offset);
  let extension;
  if (text('%PDF-')) extension = 'pdf';
  else if (starts([0xff, 0xd8, 0xff])) extension = 'jpg';
  else if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) extension = 'png';
  else if (text('RIFF') && text('WEBP', 8)) extension = 'webp';
  // Keep the existing text download suffix without previewing unknown bytes.
  return { extension: extension || (declaredMime === 'text/plain' ? 'txt' : 'bin'),
    type: FORMATS[extension] || 'application/octet-stream' };
}

export function mountMedicalDocument(button, blob, format) {
  const panel = document.createElement('section');
  panel.dataset.documentPreview = '';
  panel.setAttribute('aria-label', 'Document preview');
  panel.style.cssText = 'display:grid;gap:12px;margin-top:12px';
  panel.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-secondary" type="button">Close preview</button><a class="btn btn-secondary">Download document</a></div><p role="status"></p>';
  const status = panel.querySelector('[role=status]');
  const link = panel.querySelector('a');
  const url = URL.createObjectURL(blob.slice(0, blob.size, format.type));
  link.href = url;
  link.download = 'medical-document.' + format.extension;
  let closed = false, task, rendering;
  function close() {
    if (closed) return;
    closed = true;
    panel.remove();
    URL.revokeObjectURL(url);
    rendering?.cancel();
    if (task) void task.destroy().catch(() => {});
  }
  const dismiss = panel.querySelector('button');
  dismiss.onclick = () => { close(); button.focus(); };
  button.after(panel);
  dismiss.focus();

  if (format.type.startsWith('image/')) {
    const image = document.createElement('img');
    image.alt = 'Uploaded document page';
    image.style.cssText = 'max-width:100%;height:auto';
    image.onerror = () => { status.textContent = 'This image could not be displayed. You can download the file.'; };
    image.src = url;
    panel.append(image);
  } else if (format.extension === 'pdf') {
    void openPdf();
  } else {
    status.textContent = 'Preview is unavailable for this file type. You can download the original.';
  }

  async function openPdf() {
    status.textContent = 'Loading PDF pages...';
    try {
      const { loadPdfLib } = await import('../pages/docBatch.js');
      const pdfjs = await loadPdfLib();
      if (closed) return;
      const data = new Uint8Array(await blob.arrayBuffer());
      if (closed) return;
      task = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false, maxImageSize: 16_000_000 });
      const pdf = await task.promise;
      if (closed) return;
      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
      controls.innerHTML = '<button class="btn btn-secondary" type="button">Previous page</button><button class="btn btn-secondary" type="button">Next page</button>';
      const [previous, next] = controls.querySelectorAll('button');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'max-width:100%;height:auto';
      canvas.setAttribute('role', 'img');
      panel.append(controls, canvas);
      let number = 1;
      async function showPage(pageNumber) {
        previous.disabled = next.disabled = true;
        canvas.hidden = true;
        const page = await pdf.getPage(pageNumber);
        if (closed) return;
        const full = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1400 / Math.max(full.width, full.height)) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        rendering = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        await rendering.promise;
        rendering = null;
        if (closed) return;
        number = pageNumber;
        status.textContent = 'Page ' + number + ' of ' + pdf.numPages;
        canvas.setAttribute('aria-label', status.textContent);
        canvas.hidden = false;
        previous.disabled = number === 1;
        next.disabled = number === pdf.numPages;
      }
      const show = page => showPage(page).catch(() => {
        if (!closed) status.textContent = 'This page could not be displayed. You can download the PDF.';
      });
      previous.onclick = () => void show(number - 1);
      next.onclick = () => void show(number + 1);
      await show(1);
    } catch {
      if (!closed) status.textContent = 'The PDF preview could not be loaded. You can download the PDF.';
    }
  }
  return close;
}
