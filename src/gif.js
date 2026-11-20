// GIF: remove comment blocks and application blocks other than looping / colour profile.

import { ascii, concat, finding, startsWith, utf8 } from './util.js';

const KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

export function isGif(b) {
  return startsWith(b, 0, 'GIF87a') || startsWith(b, 0, 'GIF89a');
}

function skipSubBlocks(b, p) {
  while (p < b.length) {
    const n = b[p];
    p += 1 + n;
    if (n === 0) break;
  }
  return Math.min(p, b.length);
}

export function cleanGifBytes(b) {
  if (!isGif(b)) throw new Error('not a gif');
  const findings = [];
  const out = [];
  let p = 13;
  const flags = b[10];
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  out.push(b.subarray(0, p));

  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) {
      out.push(b.subarray(p, p + 1));
      p++;
      break;
    }
    if (t === 0x2c) {
      let q = p + 10;
      const lf = b[p + 9];
      if (lf & 0x80) q += 3 * (1 << ((lf & 7) + 1));
      q = skipSubBlocks(b, q + 1); // LZW min code size, then data
      out.push(b.subarray(p, q));
      p = q;
      continue;
    }
    if (t === 0x21) {
      const label = b[p + 1];
      const end = skipSubBlocks(b, p + 2);
      if (label === 0xfe) {
        const parts = [];
        for (let q = p + 2; q < end && b[q]; q += 1 + b[q]) parts.push(b.subarray(q + 1, q + 1 + b[q]));
        const text = utf8.decode(concat(parts)).trim();
        findings.push(finding('Σχόλιο', text || null));
      } else if (label === 0xff) {
        const app = b[p + 2] === 11 ? ascii(b, p + 3, 11) : '';
        if (KEEP_APPS.has(app)) out.push(b.subarray(p, end));
        else findings.push(finding(app === 'XMP DataXMP' ? 'Μεταδεδομένα XMP' : 'Άλλα κρυφά δεδομένα', app === 'XMP DataXMP' ? null : app.trim()));
      } else {
        out.push(b.subarray(p, end)); // graphic control / plain text
      }
      p = end;
      continue;
    }
    // Unknown byte: stop here, keep nothing after (it cannot be part of a valid image).
    break;
  }
  if (p < b.length && b.subarray(p).some((x) => x !== 0)) findings.push(finding('Κρυφά δεδομένα στο τέλος του αρχείου'));
  const bytes = concat(out);
  if (bytes[bytes.length - 1] !== 0x3b) return { bytes: concat([bytes, new Uint8Array([0x3b])]), findings };
  return { bytes, findings };
}
