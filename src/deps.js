// pdf-lib and JSZip are large, so the browser loads them only when a PDF or Office file shows up.
// In Node tests they are put on globalThis before the cleaners run.

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Αποτυχία φόρτωσης ' + url));
    document.head.appendChild(s);
  });
}

export async function needPdfLib() {
  if (!globalThis.PDFLib) await loadScript(new URL('../vendor/pdf-lib.min.js', import.meta.url).href);
  return globalThis.PDFLib;
}

export async function needJSZip() {
  if (!globalThis.JSZip) await loadScript(new URL('../vendor/jszip.min.js', import.meta.url).href);
  return globalThis.JSZip;
}
