// Entry point: figure out what a file really is (from its bytes, not its name), clean it, then
// run the cleaner a second time on the result to prove nothing was left behind.

import { cleanGifBytes, isGif } from './gif.js';
import { cleanIsobmff, isIsobmff } from './isobmff.js';
import { cleanJpegBytes, isJpeg } from './jpeg.js';
import { cleanMp3, isMp3 } from './mp3.js';
import { outputName, splitExt } from './names.js';
import { cleanZipDocument } from './office.js';
import { cleanPdf, isPdf } from './pdf.js';
import { cleanPngBytes, isPng } from './png.js';
import { UserError, dedupeFindings, readBytes, startsWith } from './util.js';
import { cleanWebpBytes, isWebp } from './webp.js';

const TEXT_EXT = /^(txt|csv|tsv|md|log|json|srt|vtt)$/i;
const OFFICE_LABELS = {
  docx: 'Έγγραφο Word', docm: 'Έγγραφο Word', dotx: 'Πρότυπο Word',
  xlsx: 'Υπολογιστικό φύλλο Excel', xlsm: 'Υπολογιστικό φύλλο Excel', xltx: 'Πρότυπο Excel',
  pptx: 'Παρουσίαση PowerPoint', pptm: 'Παρουσίαση PowerPoint', ppsx: 'Παρουσίαση PowerPoint', potx: 'Πρότυπο PowerPoint',
  odt: 'Έγγραφο LibreOffice', ods: 'Υπολογιστικό φύλλο LibreOffice', odp: 'Παρουσίαση LibreOffice', odg: 'Σχέδιο LibreOffice',
};

export const SUPPORTED_SUMMARY = [
  ['Φωτογραφίες', 'JPEG, PNG, WebP, GIF, HEIC (iPhone), AVIF'],
  ['Βίντεο', 'MP4, MOV (κινητά, iPhone, Android)'],
  ['Ήχος', 'MP3, M4A (φωνητικά μηνύματα, ηχογραφήσεις)'],
  ['Έγγραφα', 'PDF, Word, Excel, PowerPoint, LibreOffice'],
];

export async function detect(file) {
  const name = file.name || '';
  const [, extRaw] = splitExt(name);
  const ext = extRaw.toLowerCase();
  const head = await readBytes(file, 0, Math.min(file.size, 4096));

  if (isJpeg(head)) return { type: 'jpeg', category: 'image', label: 'Φωτογραφία JPEG', ext: 'jpg', mime: 'image/jpeg' };
  if (isPng(head)) return { type: 'png', category: 'image', label: 'Εικόνα PNG', ext: 'png', mime: 'image/png' };
  if (isWebp(head)) return { type: 'webp', category: 'image', label: 'Εικόνα WebP', ext: 'webp', mime: 'image/webp' };
  if (isGif(head)) return { type: 'gif', category: 'image', label: 'Εικόνα GIF', ext: 'gif', mime: 'image/gif' };
  if (isIsobmff(head)) {
    const brand = startsWith(head, 4, 'ftyp') ? String.fromCharCode(...head.subarray(8, 12)) : '';
    if (/^(heic|heix|heim|heis|hevc|hevx|mif1|mif2|msf1)$/.test(brand)) return { type: 'isobmff', category: 'image', label: 'Φωτογραφία HEIC', ext: 'heic', mime: 'image/heic' };
    if (/^(avif|avis)$/.test(brand)) return { type: 'isobmff', category: 'image', label: 'Εικόνα AVIF', ext: 'avif', mime: 'image/avif' };
    if (/^M4[ABP] $/.test(brand) || /^(m4a|m4b|aac)$/.test(ext)) return { type: 'isobmff', category: 'audio', label: 'Ήχος M4A', ext: 'm4a', mime: 'audio/mp4' };
    const mov = brand === 'qt  ' || ext === 'mov';
    return { type: 'isobmff', category: 'video', label: mov ? 'Βίντεο MOV' : 'Βίντεο MP4', ext: mov ? 'mov' : 'mp4', mime: mov ? 'video/quicktime' : 'video/mp4' };
  }
  if (isPdf(head)) return { type: 'pdf', category: 'document', label: 'Έγγραφο PDF', ext: 'pdf', mime: 'application/pdf' };
  if (startsWith(head, 0, 'PK\x03\x04')) {
    return { type: 'zip', category: 'document', label: OFFICE_LABELS[ext] || 'Έγγραφο', ext: ext || 'zip', mime: file.type || 'application/octet-stream' };
  }
  if (isMp3(head, name)) return { type: 'mp3', category: 'audio', label: 'Ήχος MP3', ext: 'mp3', mime: 'audio/mpeg' };
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return { type: 'ole', category: 'document', label: 'Παλιό έγγραφο Office', ext };
  if (TEXT_EXT.test(ext) && !head.includes(0)) return { type: 'text', category: 'document', label: 'Αρχείο κειμένου', ext, mime: file.type || 'text/plain' };
  return { type: 'unknown', category: 'other', label: ext ? `Αρχείο .${ext}` : 'Άγνωστο αρχείο', ext };
}

async function runCleaner(file, info) {
  switch (info.type) {
    case 'jpeg': {
      const r = cleanJpegBytes(await readBytes(file));
      return { blob: new Blob([r.bytes], { type: info.mime }), findings: r.findings, warnings: [] };
    }
    case 'png': {
      const r = await cleanPngBytes(await readBytes(file));
      return { blob: new Blob([r.bytes], { type: info.mime }), findings: r.findings, warnings: [] };
    }
    case 'webp': {
      const r = cleanWebpBytes(await readBytes(file));
      return { blob: new Blob([r.bytes], { type: info.mime }), findings: r.findings, warnings: [] };
    }
    case 'gif': {
      const r = cleanGifBytes(await readBytes(file));
      return { blob: new Blob([r.bytes], { type: info.mime }), findings: r.findings, warnings: [] };
    }
    case 'isobmff': {
      const r = await cleanIsobmff(file, file.name || '');
      return { blob: new Blob([r.blob], { type: info.mime }), findings: r.findings, warnings: r.warnings };
    }
    case 'mp3': {
      const r = await cleanMp3(file);
      return { blob: new Blob([r.blob], { type: info.mime }), findings: r.findings, warnings: [] };
    }
    case 'pdf':
      return cleanPdf(file);
    case 'zip':
      return cleanZipDocument(file);
    default:
      return null;
  }
}

function asFile(blob, name) {
  if (typeof File !== 'undefined') return new File([blob], name, { type: blob.type });
  blob.name = name;
  return blob;
}

/**
 * @param {File} file
 * @param {{renameMode?: 'auto'|'keep'|'random'}} options
 */
export async function cleanFile(file, { renameMode = 'auto' } = {}) {
  const info = await detect(file);
  const base = { originalName: file.name, originalSize: file.size, info };

  if (info.type === 'ole') {
    return { ...base, status: 'unsupported', message: 'Παλιά μορφή Office (.doc, .xls, .ppt). Άνοιξέ το, αποθήκευσέ το ως .docx / .xlsx / .pptx και καθάρισέ το ξανά εδώ.' };
  }
  if (info.type === 'unknown') {
    return { ...base, status: 'unsupported', message: 'Αυτός ο τύπος αρχείου δεν υποστηρίζεται ακόμα. Δεν έγινε καμία αλλαγή.' };
  }

  const name = outputName(file.name, info.category, info.ext, renameMode);
  if (info.type === 'text') {
    return {
      ...base, status: 'clean', name, blob: asFile(file, name), findings: [], warnings: [],
      note: 'Τα απλά αρχεία κειμένου δεν έχουν κρυφά μεταδεδομένα.', renamed: name !== file.name,
    };
  }

  let result;
  try {
    result = await runCleaner(file, info);
    if (!result) {
      return { ...base, status: 'unsupported', message: 'Αυτό το συμπιεσμένο αρχείο δεν είναι έγγραφο Office. Τα αρχεία ZIP δεν υποστηρίζονται ακόμα.' };
    }
  } catch (e) {
    return {
      ...base, status: 'error',
      message: e instanceof UserError ? e.message : 'Κάτι πήγε στραβά με αυτό το αρχείο. Δεν έγινε καμία αλλαγή.',
      detail: String(e?.stack || e),
    };
  }

  const warnings = [...(result.warnings || [])];
  let verified = false;
  try {
    const again = await runCleaner(asFile(result.blob, file.name), info);
    const left = again ? again.findings : [];
    verified = left.length === 0;
    if (!verified) warnings.push('Ο δεύτερος έλεγχος βρήκε ότι ίσως έμειναν: ' + [...new Set(left.map((f) => f.label))].join(', '));
  } catch {
    warnings.push('Δεν μπόρεσα να επιβεβαιώσω το αποτέλεσμα με δεύτερο έλεγχο.');
  }

  const findings = dedupeFindings(result.findings);
  return {
    ...base,
    status: findings.length ? 'cleaned' : 'clean',
    name,
    blob: asFile(result.blob, name),
    findings,
    warnings,
    verified,
    renamed: name !== file.name,
  };
}
