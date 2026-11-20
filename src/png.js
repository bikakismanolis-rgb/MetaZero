// PNG: keep the chunks that describe pixels and colour, drop text/EXIF/time and unknown chunks.

import { parseTiff } from './exif.js';
import { parseXmp } from './xmp.js';
import { ascii, concat, crc32, finding, inflate, judgeIcc, minimalTiff, startsWith, u32be, utf8, writeU32be } from './util.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB',
  'cICP', 'mDCV', 'cLLI', 'mDCv', 'cLLi', 'bKGD', 'hIST', 'pHYs', 'sPLT',
  'acTL', 'fcTL', 'fdAT',
]);

export function isPng(b) {
  return SIGNATURE.every((v, i) => b[i] === v);
}

const TEXT_LABELS = {
  author: ['Δημιουργός', 'high'],
  software: ['Λογισμικό', 'normal'],
  'creation time': ['Ημερομηνία δημιουργίας', 'normal'],
  comment: ['Σχόλιο', 'normal'],
  description: ['Περιγραφή', 'normal'],
  title: ['Τίτλος', 'normal'],
  copyright: ['Πνευματικά δικαιώματα', 'normal'],
  source: ['Συσκευή / πηγή', 'normal'],
  disclaimer: ['Σημείωση', 'normal'],
  parameters: ['Οδηγίες δημιουργίας AI (prompt)', 'high'],
  prompt: ['Οδηγίες δημιουργίας AI (prompt)', 'high'],
  workflow: ['Ρυθμίσεις δημιουργίας AI', 'normal'],
};

export async function cleanPngBytes(b) {
  if (!isPng(b)) throw new Error('not a png');
  const findings = [];
  const kept = [b.subarray(0, 8)];
  const dropped = new Set();
  let orientation = null;
  let pos = 8;
  let ended = false;
  let insertAt = -1;

  while (pos + 12 <= b.length) {
    const len = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    const end = pos + 12 + len;
    if (end > b.length) {
      kept.push(b.subarray(pos));
      pos = b.length;
      break;
    }
    const data = b.subarray(pos + 8, pos + 8 + len);
    let iccVerdict = null;
    if (type === 'iCCP') {
      const nul = data.indexOf(0);
      const profile = nul > 0 ? await inflate(data.subarray(nul + 2)) : null;
      iccVerdict = profile ? judgeIcc(profile) : null;
    }

    if (iccVerdict) {
      findings.push(iccVerdict);
    } else if (KEEP.has(type)) {
      kept.push(b.subarray(pos, end));
      if (type === 'IHDR') insertAt = kept.length;
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      findings.push(...(await readText(type, data)));
    } else if (type === 'eXIf') {
      const t = parseTiff(data, startsWith(data, 0, 'Exif\0\0') ? 6 : 0);
      findings.push(...t.findings);
      orientation = t.orientation;
    } else if (type === 'tIME' && len === 7) {
      const y = (data[0] << 8) | data[1];
      findings.push(finding('Ημερομηνία αλλαγής', `${String(data[3]).padStart(2, '0')}/${String(data[2]).padStart(2, '0')}/${y}`));
    } else if (type === 'caBX') {
      findings.push(finding('Ψηφιακά διαπιστευτήρια περιεχομένου (C2PA)'));
    } else {
      dropped.add(type);
    }
    pos = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }

  if (dropped.size) findings.push(finding('Άλλα κρυφά δεδομένα', [...dropped].join(', ')));
  if (ended && pos < b.length && b.subarray(pos).some((x) => x !== 0)) {
    findings.push(finding('Κρυφά δεδομένα στο τέλος του αρχείου'));
  }

  if (orientation >= 2 && orientation <= 8 && insertAt > 0) {
    const tiff = minimalTiff(orientation);
    const chunk = new Uint8Array(12 + tiff.length);
    writeU32be(chunk, 0, tiff.length);
    chunk.set([0x65, 0x58, 0x49, 0x66], 4); // eXIf
    chunk.set(tiff, 8);
    writeU32be(chunk, 8 + tiff.length, crc32(chunk, 4, 8 + tiff.length));
    kept.splice(insertAt, 0, chunk);
  }
  return { bytes: concat(kept), findings };
}

async function readText(type, data) {
  const nul = data.indexOf(0);
  if (nul < 0) return [finding('Κρυμμένο κείμενο')];
  const keyword = ascii(data, 0, nul);
  let text = null;
  if (type === 'tEXt') {
    text = new TextDecoder('latin1').decode(data.subarray(nul + 1));
  } else if (type === 'zTXt') {
    const raw = await inflate(data.subarray(nul + 2));
    text = raw ? new TextDecoder('latin1').decode(raw) : null;
  } else {
    const compressed = data[nul + 1] === 1;
    let p = nul + 3;
    const langEnd = data.indexOf(0, p);
    if (langEnd < 0) return [finding(`Κρυμμένο κείμενο «${keyword}»`)];
    const transEnd = data.indexOf(0, langEnd + 1);
    if (transEnd < 0) return [finding(`Κρυμμένο κείμενο «${keyword}»`)];
    const body = data.subarray(transEnd + 1);
    const raw = compressed ? await inflate(body) : body;
    text = raw ? utf8.decode(raw) : null;
  }

  const key = keyword.toLowerCase();
  if (key === 'xml:com.adobe.xmp') return parseXmp(text || '');
  if (key.startsWith('raw profile type exif') || key.startsWith('raw profile type app1')) {
    return [finding('Μεταδεδομένα EXIF')];
  }
  if (key.startsWith('raw profile type iptc') || key.startsWith('raw profile type 8bim')) {
    return [finding('Μεταδεδομένα IPTC')];
  }
  if (key.startsWith('raw profile type xmp')) return [finding('Μεταδεδομένα XMP')];
  const [label, level] = TEXT_LABELS[key] || [`Κρυμμένο κείμενο «${keyword}»`, 'normal'];
  return [finding(label, text, level)];
}
