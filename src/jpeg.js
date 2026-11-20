// JPEG: walk the marker segments and keep only what is needed to draw the picture.
// No re-encoding, so there is zero quality loss.

import { parseTiff } from './exif.js';
import { parseApp13 } from './iptc.js';
import { parseXmp } from './xmp.js';
import { EXIF_HEADER, concat, finding, minimalTiff, startsWith, u16be, utf8 } from './util.js';

const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_SIG = 'http://ns.adobe.com/xmp/extension/\0';

export function isJpeg(b) {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/**
 * @param {Uint8Array} b
 * @param {{keepOrientation?: boolean}} opts
 * @returns {{bytes: Uint8Array, findings: Array, orientation: number|null}}
 */
export function cleanJpegBytes(b, { keepOrientation = true } = {}) {
  if (!isJpeg(b)) throw new Error('not a jpeg');
  const findings = [];
  const out = [b.subarray(0, 2)];
  let jfif = null;
  let orientation = null;
  let pos = 2;
  let ended = false;

  while (pos < b.length) {
    if (b[pos] !== 0xff) {
      // Corrupt stream: keep the rest untouched rather than guessing.
      out.push(b.subarray(pos));
      pos = b.length;
      break;
    }
    // Skip fill bytes (0xFF 0xFF ...).
    let m = pos + 1;
    while (m < b.length && b[m] === 0xff) m++;
    if (m >= b.length) break;
    const marker = b[m];
    const segStart = m - 1;

    if (marker === 0xd9) {
      out.push(b.subarray(segStart, m + 1));
      pos = m + 1;
      ended = true;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(b.subarray(segStart, m + 1));
      pos = m + 1;
      continue;
    }
    if (m + 2 >= b.length) break;
    const len = u16be(b, m + 1);
    const segEnd = Math.min(m + 1 + len, b.length);
    const data = m + 3; // first payload byte

    if (marker === 0xda) {
      // Start of scan: copy the header and the entropy-coded data up to the next real marker.
      let i = segEnd;
      while (i < b.length - 1) {
        if (b[i] === 0xff) {
          const n = b[i + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      if (i >= b.length - 1) i = b.length;
      out.push(b.subarray(segStart, i));
      pos = i;
      continue;
    }

    const seg = b.subarray(segStart, segEnd);
    if (marker === 0xe0) {
      if (startsWith(b, data, 'JFIF\0') && !jfif) {
        // Keep JFIF (pixel density only), but without its optional thumbnail.
        jfif = new Uint8Array(18);
        jfif.set([0xff, 0xe0, 0, 16]);
        jfif.set(b.subarray(data, Math.min(data + 12, segEnd)), 4);
        jfif[16] = 0;
        jfif[17] = 0;
        if (segEnd - data > 14 && (b[data + 12] || b[data + 13])) findings.push(finding('Ενσωματωμένη μικρογραφία της εικόνας'));
      } else if (startsWith(b, data, 'JFXX')) {
        findings.push(finding('Ενσωματωμένη μικρογραφία της εικόνας'));
      }
    } else if (marker === 0xe1) {
      if (startsWith(b, data, 'Exif\0')) {
        const tiff = parseTiff(b, data + 6, segEnd);
        findings.push(...tiff.findings);
        if (tiff.orientation && !orientation) orientation = tiff.orientation;
      } else if (startsWith(b, data, XMP_SIG)) {
        findings.push(...parseXmp(utf8.decode(b.subarray(data + XMP_SIG.length, segEnd))));
      } else if (startsWith(b, data, XMP_EXT_SIG)) {
        findings.push(finding('Επιπλέον μεταδεδομένα XMP'));
      } else {
        findings.push(finding('Άλλα κρυφά δεδομένα'));
      }
    } else if (marker === 0xe2) {
      if (startsWith(b, data, 'ICC_PROFILE\0')) {
        out.push(seg); // colour profile: needed for correct colours, holds nothing personal
      } else if (startsWith(b, data, 'MPF\0')) {
        findings.push(finding('Επιπλέον κρυφές εικόνες (π.χ. HDR ή βάθος)'));
      } else {
        findings.push(finding('Άλλα κρυφά δεδομένα'));
      }
    } else if (marker === 0xed) {
      findings.push(...parseApp13(b, data, segEnd));
    } else if (marker === 0xee) {
      if (startsWith(b, data, 'Adobe')) out.push(seg); // colour transform flag, needed to decode CMYK
    } else if (marker === 0xeb) {
      findings.push(finding(startsWith(b, data, 'JP') ? 'Ψηφιακά διαπιστευτήρια περιεχομένου (C2PA)' : 'Άλλα κρυφά δεδομένα'));
    } else if (marker === 0xfe) {
      const text = utf8.decode(b.subarray(data, segEnd)).replace(/\0/g, '').trim();
      if (text) findings.push(finding('Σχόλιο', text));
    } else if (marker >= 0xe3 && marker <= 0xef) {
      findings.push(finding('Άλλα κρυφά δεδομένα'));
    } else {
      // DQT, DHT, SOFn, DRI, ... : image data, keep.
      out.push(seg);
    }
    pos = segEnd;
  }

  if (ended && pos < b.length) {
    const rest = b.subarray(pos);
    if (rest.some((x) => x !== 0)) findings.push(finding('Κρυφά δεδομένα στο τέλος του αρχείου'));
  }

  const head = [out[0]];
  if (jfif) head.push(jfif);
  if (keepOrientation && orientation >= 2 && orientation <= 8) {
    const tiff = minimalTiff(orientation);
    const app1 = new Uint8Array(4 + EXIF_HEADER.length + tiff.length);
    const l = app1.length - 2;
    app1.set([0xff, 0xe1, l >> 8, l & 0xff]);
    app1.set(EXIF_HEADER, 4);
    app1.set(tiff, 4 + EXIF_HEADER.length);
    head.push(app1);
  }
  return { bytes: concat([...head, ...out.slice(1)]), findings, orientation };
}
