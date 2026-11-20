// WebP is a RIFF container. Drop the EXIF/XMP chunks (and unknown ones), fix the header flags.

import { parseTiff } from './exif.js';
import { parseXmp } from './xmp.js';
import { ascii, concat, finding, minimalTiff, startsWith, u32le, utf8, writeU32le } from './util.js';

const KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

export function isWebp(b) {
  return startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP');
}

export function cleanWebpBytes(b) {
  if (!isWebp(b)) throw new Error('not a webp');
  const findings = [];
  const chunks = [];
  const dropped = new Set();
  let orientation = null;
  const riffEnd = Math.min(8 + u32le(b, 4), b.length);
  let pos = 12;

  while (pos + 8 <= riffEnd) {
    const type = ascii(b, pos, 4);
    const size = u32le(b, pos + 4);
    const end = Math.min(pos + 8 + size + (size & 1), riffEnd);
    const data = b.subarray(pos + 8, Math.min(pos + 8 + size, riffEnd));
    if (KEEP.has(type)) {
      chunks.push({ type, bytes: b.slice(pos, end) });
    } else if (type === 'EXIF') {
      const t = parseTiff(data, startsWith(data, 0, 'Exif\0\0') ? 6 : 0);
      findings.push(...t.findings);
      orientation = t.orientation;
    } else if (type === 'XMP ') {
      findings.push(...parseXmp(utf8.decode(data)));
    } else {
      dropped.add(type.trim());
    }
    pos = end;
  }
  if (dropped.size) findings.push(finding('Άλλα κρυφά δεδομένα', [...dropped].join(', ')));
  if (riffEnd < b.length && b.subarray(riffEnd).some((x) => x !== 0)) {
    findings.push(finding('Κρυφά δεδομένα στο τέλος του αρχείου'));
  }

  const vp8x = chunks.find((c) => c.type === 'VP8X');
  const keepOrientation = vp8x && orientation >= 2 && orientation <= 8;
  if (vp8x) {
    vp8x.bytes[8] &= ~(0x08 | 0x04); // clear EXIF and XMP flags
    if (keepOrientation) vp8x.bytes[8] |= 0x08;
  }
  if (keepOrientation) {
    const tiff = minimalTiff(orientation);
    const c = new Uint8Array(8 + tiff.length + (tiff.length & 1));
    c.set([0x45, 0x58, 0x49, 0x46]); // EXIF
    writeU32le(c, 4, tiff.length);
    c.set(tiff, 8);
    chunks.push({ type: 'EXIF', bytes: c });
  }

  const body = concat(chunks.map((c) => c.bytes));
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  writeU32le(head, 4, body.length + 4);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return { bytes: concat([head, body]), findings };
}
