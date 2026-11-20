import { cleanFile, SUPPORTED_SUMMARY } from './src/clean.js';
import { needJSZip } from './src/deps.js';

const ICONS = {
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4V8z"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  other: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  tag: '<path d="M12 2H2v10l9.3 9.3a1 1 0 0 0 1.4 0l8.6-8.6a1 1 0 0 0 0-1.4Z"/><circle cx="7" cy="7" r="1.5"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.tag}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel) => document.querySelector(sel);
const sizeFmt = new Intl.NumberFormat('el-GR', { maximumFractionDigits: 1 });
const formatSize = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${sizeFmt.format(n / 1024)} KB` : n < 1073741824 ? `${sizeFmt.format(n / 1048576)} MB` : `${sizeFmt.format(n / 1073741824)} GB`;
const PREVIEWABLE = /^image\/(jpeg|png|webp|gif|avif)$/;

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  },
};

const state = { items: [], renameMode: store.get('metazero.rename', 'auto') };
let queue = Promise.resolve();

// ---------- adding files ----------

function addFiles(list) {
  const files = [...(list || [])].filter((f) => f instanceof Blob);
  if (!files.length) return;
  document.body.classList.add('has-results');
  $('#results').hidden = false;
  $('.pick-label').textContent = 'Πρόσθεσε κι άλλα';
  for (const file of files) {
    const item = { id: Math.random().toString(36).slice(2), file, status: 'processing', originalName: file.name, originalSize: file.size };
    state.items.unshift(item);
    const li = document.createElement('li');
    li.className = 'card';
    li.id = 'card-' + item.id;
    $('#cards').prepend(li);
    render(item);
    queue = queue.then(() => processItem(item));
  }
  updateBulk();
}

async function processItem(item) {
  await new Promise((r) => setTimeout(r, 30)); // let the "cleaning…" state paint
  try {
    Object.assign(item, await cleanFile(item.file, { renameMode: state.renameMode }));
  } catch (e) {
    console.error(e);
    Object.assign(item, { status: 'error', message: 'Κάτι πήγε στραβά με αυτό το αρχείο. Δεν έγινε καμία αλλαγή.' });
  }
  if (item.blob && PREVIEWABLE.test(item.blob.type)) item.preview = URL.createObjectURL(item.blob);
  render(item);
  updateBulk();
  announce(item);
}

// ---------- rendering ----------

function findingIcon(label) {
  if (/Τοποθεσία|GPS|Πόλη|Περιοχή|Νομός|Χώρα/.test(label)) return 'pin';
  if (/Δημιουργός|Ιδιοκτήτης|Ονόματα|συντάκτη|Καλλιτέχνης|Εταιρεία|αλλαγή από|Εκτυπώθηκε|Προϊστάμενος|Ερμηνευτής/.test(label)) return 'user';
  if (/Διαδρομή/.test(label)) return 'folder';
  if (/Συσκευή|Σειριακός|Κατασκευαστής|Μοντέλο|Φακός|Android|υπολογιστή/.test(label)) return 'phone';
  if (/Ημερομηνία|εκτύπωση|χρόνος/.test(label)) return 'calendar';
  return 'tag';
}

function findingRow(f) {
  return `<li class="finding ${f.level === 'high' ? 'high' : ''}">${icon(findingIcon(f.label))}
    <div><span class="f-label">${esc(f.label)}</span>${f.value ? `<span class="f-value"><s>${esc(f.value)}</s></span>` : ''}</div></li>`;
}

function statusBadge(item) {
  switch (item.status) {
    case 'processing':
      return '<span class="badge badge-busy"><span class="spinner"></span>Καθαρισμός…</span>';
    case 'cleaned':
    case 'clean':
      return `<span class="badge badge-ok">${icon('check')}Καθαρό</span>`;
    case 'unsupported':
      return `<span class="badge badge-warn">${icon('alert')}Δεν υποστηρίζεται</span>`;
    default:
      return `<span class="badge badge-danger">${icon('x')}Δεν καθαρίστηκε</span>`;
  }
}

function render(item) {
  const li = document.getElementById('card-' + item.id);
  if (!li) return;
  const category = item.info?.category || 'other';
  const name = item.name || item.originalName;
  const metaParts = [item.info?.label, formatSize(item.blob?.size ?? item.originalSize)].filter(Boolean);
  const thumb = item.preview ? `<img src="${item.preview}" alt="">` : icon(category);
  let body = '';

  if (item.status === 'cleaned' || item.status === 'clean') {
    const n = item.findings.length;
    const high = item.findings.filter((f) => f.level === 'high');
    if (n) {
      const headline = n === 1 ? 'Αφαιρέθηκε 1 κρυφό στοιχείο' : `Αφαιρέθηκαν ${n} κρυφά στοιχεία`;
      const sub = high.length ? 'Ανάμεσά τους προσωπικά στοιχεία:' : 'Τίποτα από αυτά δεν θα φτάσει στον παραλήπτη.';
      const first = (high.length ? high : item.findings).slice(0, 4);
      const rest = item.findings.filter((f) => !first.includes(f));
      body += `<p class="summary">${headline}<small>${sub}</small></p><ul class="findings">${first.map(findingRow).join('')}</ul>`;
      if (rest.length) {
        body += `<details class="more"><summary><span class="when-closed">Δες και τα υπόλοιπα ${rest.length}</span><span class="when-open">Λιγότερα</span></summary>
          <ul class="findings">${rest.map(findingRow).join('')}</ul></details>`;
      }
    } else {
      body += `<p class="summary">Δεν βρέθηκαν κρυφά στοιχεία<small>${esc(item.note || 'Το αρχείο ήταν ήδη καθαρό.')}</small></p>`;
    }
    if (item.warnings?.length) {
      body += `<ul class="warnings">${item.warnings.map((w) => `<li>${icon('alert')}<span>${esc(w)}</span></li>`).join('')}</ul>`;
    }
    if (item.verified) body += `<p class="verified">${icon('shield')}Ελέγχθηκε ξανά: δεν έμεινε τίποτα</p>`;
    const shareable = canShare([item.blob]);
    body += `<div class="actions">
      ${shareable ? `<button class="btn btn-primary" data-action="share" data-id="${item.id}" type="button">${icon('share')}Κοινοποίηση</button>` : ''}
      <button class="btn ${shareable ? 'btn-secondary' : 'btn-primary'}" data-action="save" data-id="${item.id}" type="button">${icon('download')}Αποθήκευση</button>
    </div>`;
  } else if (item.status === 'unsupported' || item.status === 'error') {
    body += `<p class="message">${esc(item.message)}</p>`;
  }

  li.innerHTML = `
    <div class="card-head">
      <div class="thumb">${thumb}</div>
      <div class="card-title">
        <p class="name">${esc(name)}</p>
        <p class="meta">${esc(metaParts.join(' · '))}${item.renamed ? `<br>Πριν: <s>${esc(item.originalName)}</s>` : ''}</p>
      </div>
      ${statusBadge(item)}
    </div>${body}`;
}

function readyItems() {
  return state.items.filter((i) => (i.status === 'cleaned' || i.status === 'clean') && i.blob);
}

function updateBulk() {
  const ready = readyItems();
  const show = ready.length >= 2;
  $('#bulk').hidden = !show;
  document.body.classList.toggle('has-bulk', show);
  $('#share-all').hidden = !(show && canShare(ready.map((i) => i.blob)));
  $('#share-all span').textContent = `Κοινοποίηση (${ready.length})`;
  const busy = state.items.filter((i) => i.status === 'processing').length;
  $('#results-title').textContent = busy ? `Καθαρισμός… (${busy})` : state.items.length === 1 ? 'Το αρχείο σου' : 'Τα αρχεία σου';
}

function announce(item) {
  const text =
    item.status === 'cleaned' ? `${item.name}: αφαιρέθηκαν ${item.findings.length} στοιχεία.` :
    item.status === 'clean' ? `${item.name}: δεν βρέθηκαν κρυφά στοιχεία.` :
    `${item.originalName}: ${item.message || 'δεν καθαρίστηκε.'}`;
  $('#live').textContent = text;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- share / save ----------

function canShare(files) {
  try {
    return !!(navigator.canShare && files.length && navigator.canShare({ files }));
  } catch {
    return false;
  }
}

async function share(files) {
  try {
    await navigator.share({ files });
  } catch (e) {
    if (e?.name !== 'AbortError') toast('Η κοινοποίηση δεν έγινε. Δοκίμασε «Αποθήκευση».');
  }
}

function save(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function saveAll() {
  const ready = readyItems();
  if (ready.length === 1) return save(ready[0].blob);
  const btn = $('#save-all');
  btn.disabled = true;
  try {
    const JSZip = await needJSZip();
    const zip = new JSZip();
    const used = new Map();
    const date = new Date(Date.UTC(1980, 0, 1));
    for (const item of ready.slice().reverse()) {
      let n = item.blob.name;
      const count = used.get(n) || 0;
      used.set(n, count + 1);
      if (count) n = n.replace(/(\.[^.]*)?$/, ` (${count})$1`);
      zip.file(n, item.blob, { date });
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', platform: 'DOS' });
    save(new File([blob], 'files.zip', { type: 'application/zip' }));
  } catch (e) {
    console.error(e);
    toast('Δεν μπόρεσα να φτιάξω το ZIP. Αποθήκευσε τα αρχεία ένα-ένα.');
  } finally {
    btn.disabled = false;
  }
}

// ---------- events ----------

$('#pick').addEventListener('click', () => $('#picker').click());
$('#picker').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

$('#cards').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const item = state.items.find((i) => i.id === btn.dataset.id);
  if (!item?.blob) return;
  if (btn.dataset.action === 'share') share([item.blob]);
  else save(item.blob);
});

$('#share-all').addEventListener('click', () => share(readyItems().map((i) => i.blob)));
$('#save-all').addEventListener('click', saveAll);
$('#clear').addEventListener('click', () => {
  for (const i of state.items) if (i.preview) URL.revokeObjectURL(i.preview);
  state.items = [];
  $('#cards').innerHTML = '';
  $('#results').hidden = true;
  document.body.classList.remove('has-results');
  $('.pick-label').textContent = 'Διάλεξε αρχεία';
  updateBulk();
});

for (const r of document.querySelectorAll('input[name="rename"]')) {
  r.checked = r.value === state.renameMode;
  r.addEventListener('change', () => {
    state.renameMode = r.value;
    store.set('metazero.rename', r.value);
  });
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  addFiles(e.dataTransfer?.files);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

const formats = $('#formats');
formats.innerHTML = SUPPORTED_SUMMARY.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

const offline = () => ($('#offline-pill').hidden = navigator.onLine);
window.addEventListener('online', offline);
window.addEventListener('offline', offline);
offline();

// ---------- install & share target ----------

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;

if (!standalone) {
  if (ios) {
    $('#install').hidden = false;
    $('#install-text').textContent = 'Στο Safari πάτα το κουμπί Κοινοποίησης και μετά «Προσθήκη στην οικ. οθόνη». Θα δουλεύει και χωρίς internet.';
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#install').hidden = false;
    $('#install-btn').hidden = false;
    if (/android/i.test(navigator.userAgent)) {
      $('#install-text').textContent = 'Μετά την εγκατάσταση θα εμφανίζεται στο μενού «Κοινοποίηση»: στέλνεις ένα αρχείο στο MetaZero και το παίρνεις πίσω καθαρό.';
    }
  });
}
$('#install-btn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('#install').hidden = true;
});
window.addEventListener('appinstalled', () => ($('#install').hidden = true));

async function takeSharedFiles() {
  const params = new URLSearchParams(location.search);
  if (!params.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('metazero-shared');
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-file-name') || 'file');
      files.push(new File([blob], name, { type: blob.type }));
      await cache.delete(req);
    }
    addFiles(files);
  } catch (e) {
    console.error(e);
    toast('Δεν μπόρεσα να διαβάσω τα αρχεία που κοινοποίησες.');
  }
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
}
takeSharedFiles();
