// MP3 / AAC: remove ID3v2 (start), ID3v1, APE and appended ID3v2 tags (end).

import { ascii, finding, prettyDate, readBytes, startsWith, u32le } from './util.js';

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

const FRAMES = {
  TIT2: ['Τίτλος'],
  TPE1: ['Καλλιτέχνης', 'high'],
  TPE2: ['Καλλιτέχνης άλμπουμ'],
  TALB: ['Άλμπουμ'],
  TCOM: ['Συνθέτης'],
  TYER: ['Έτος'],
  TDRC: ['Ημερομηνία ηχογράφησης', 'normal', true],
  TENC: ['Λογισμικό κωδικοποίησης'],
  TSSE: ['Ρυθμίσεις κωδικοποίησης'],
  TCOP: ['Πνευματικά δικαιώματα'],
  COMM: ['Σχόλιο'],
  APIC: ['Εξώφυλλο (εικόνα)'],
  PRIV: ['Ιδιωτικά δεδομένα προγράμματος'],
  GEOB: ['Ενσωματωμένο αρχείο'],
  TXXX: ['Προσαρμοσμένο πεδίο'],
  USLT: ['Στίχοι'],
};

export function isMp3(head, name) {
  if (startsWith(head, 0, 'ID3')) return true;
  return head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && /\.(mp3|mp2|aac)$/i.test(name);
}

function decodeTextFrame(b, s, e) {
  const enc = b[s];
  const body = b.subarray(s + 1, e);
  let text;
  if (enc === 1 || enc === 2) text = new TextDecoder(enc === 2 || (body[0] === 0xfe && body[1] === 0xff) ? 'utf-16be' : 'utf-16le').decode(body);
  else if (enc === 3) text = new TextDecoder('utf-8').decode(body);
  else text = new TextDecoder('latin1').decode(body);
  return text.replace(/^﻿/, '').replace(/\0+/g, ' ').trim();
}

function parseId3v2(b) {
  const f = [];
  const ver = b[3];
  const flags = b[5];
  let p = 10;
  if (flags & 0x40 && ver >= 3) p += ver === 4 ? syncsafe(b, 10) : 4 + ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]);
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (p + hdrLen <= b.length) {
    const id = ascii(b, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) >>> 0) + ((b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]);
    const s = p + hdrLen;
    const e = Math.min(s + size, b.length);
    const spec = FRAMES[id];
    if (spec) {
      const [label, level = 'normal', isDate] = spec;
      let value = null;
      if (id[0] === 'T' && id !== 'TXXX') value = decodeTextFrame(b, s, e);
      if (id === 'COMM' || id === 'USLT') value = decodeTextFrame(b, s, e).slice(3).trim();
      if (id === 'TXXX') value = decodeTextFrame(b, s, e).replace(/\s+/, ': ');
      f.push(finding(label, isDate ? prettyDate(value) : value, level));
    }
    p = e;
  }
  if (!f.length) f.push(finding('Μεταδεδομένα ID3'));
  return f;
}

export async function cleanMp3(file) {
  const findings = [];
  let start = 0;
  for (;;) {
    const h = await readBytes(file, start, Math.min(file.size, start + 10));
    if (h.length < 10 || !startsWith(h, 0, 'ID3')) break;
    const len = 10 + syncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0);
    findings.push(...parseId3v2(await readBytes(file, start, Math.min(file.size, start + len))));
    start += len;
  }
  let end = file.size;
  if (end - start >= 128) {
    const t = await readBytes(file, end - 128, end);
    if (startsWith(t, 0, 'TAG')) {
      const title = new TextDecoder('latin1').decode(t.subarray(3, 33)).replace(/\0/g, '').trim();
      const artist = new TextDecoder('latin1').decode(t.subarray(33, 63)).replace(/\0/g, '').trim();
      if (title) findings.push(finding('Τίτλος', title));
      if (artist) findings.push(finding('Καλλιτέχνης', artist, 'high'));
      if (!title && !artist) findings.push(finding('Μεταδεδομένα ID3'));
      end -= 128;
    }
  }
  if (end - start >= 32) {
    const t = await readBytes(file, end - 32, end);
    if (startsWith(t, 0, 'APETAGEX')) {
      const size = u32le(t, 12);
      const hasHeader = t[23] & 0x80;
      end -= size + (hasHeader ? 32 : 0);
      findings.push(finding('Μεταδεδομένα APE'));
    }
  }
  if (end - start >= 10) {
    const t = await readBytes(file, end - 10, end);
    if (startsWith(t, 0, '3DI')) {
      end -= syncsafe(t, 6) + 20;
      findings.push(finding('Μεταδεδομένα ID3'));
    }
  }
  return { blob: file.slice(start, Math.max(start, end), file.type || 'audio/mpeg'), findings };
}
