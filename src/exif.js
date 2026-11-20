// Reads an EXIF/TIFF block and reports the sensitive parts in plain Greek.
// It never throws: broken metadata simply yields fewer findings.

import { ascii, finding, formatCoords, prettyDate, u16be, u32be, u16le, u32le, utf8 } from './util.js';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export function parseTiff(b, start = 0, end = b.length) {
  const result = { orientation: null, findings: [], meaningful: false };
  try {
    parse(b, start, end, result);
  } catch {
    result.meaningful = true; // malformed EXIF: say that something was there
  }
  if (result.findings.length === 0 && result.meaningful) {
    result.findings.push(finding('Μεταδεδομένα EXIF'));
  }
  return result;
}

function parse(b, start, end, result) {
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  const be = b[start] === 0x4d && b[start + 1] === 0x4d;
  if (!le && !be) return;
  const r16 = (o) => (le ? u16le(b, start + o) : u16be(b, start + o));
  const r32 = (o) => (le ? u32le(b, start + o) : u32be(b, start + o));
  const len = end - start;
  const inRange = (o, n) => o >= 0 && o + n <= len;

  function readIfd(off) {
    const tags = new Map();
    if (!inRange(off, 2)) return { tags, next: 0 };
    const count = r16(off);
    if (count > 1000 || !inRange(off + 2, count * 12)) return { tags, next: 0 };
    for (let i = 0; i < count; i++) {
      const e = off + 2 + i * 12;
      const tag = r16(e);
      const type = r16(e + 2);
      const n = r32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * n;
      const valueOff = size <= 4 ? e + 8 : r32(e + 8);
      tags.set(tag, { type, n, size, valueOff });
    }
    const nextPos = off + 2 + count * 12;
    return { tags, next: inRange(nextPos, 4) ? r32(nextPos) : 0 };
  }

  function str(t) {
    if (!t || !inRange(t.valueOff, t.size)) return null;
    const s = utf8.decode(b.subarray(start + t.valueOff, start + t.valueOff + t.size));
    return s.replace(/\0[\s\S]*$/, '').trim() || null;
  }
  function ucs2(t) {
    // Windows XP* tags are UTF-16LE regardless of byte order.
    if (!t || !inRange(t.valueOff, t.size)) return null;
    let s = '';
    for (let i = 0; i + 1 < t.size; i += 2) {
      const c = b[start + t.valueOff + i] | (b[start + t.valueOff + i + 1] << 8);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || null;
  }
  function userComment(t) {
    if (!t || t.size <= 8 || !inRange(t.valueOff, t.size)) return null;
    const code = ascii(b, start + t.valueOff, 8);
    const body = b.subarray(start + t.valueOff + 8, start + t.valueOff + t.size);
    if (code.startsWith('UNICODE')) {
      let s = '';
      for (let i = 0; i + 1 < body.length; i += 2) {
        const c = le ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1];
        if (c) s += String.fromCharCode(c);
      }
      return s.trim() || null;
    }
    return utf8.decode(body).replace(/\0/g, '').trim() || null;
  }
  function num(t) {
    if (!t || !inRange(t.valueOff, 2)) return null;
    return t.type === 3 ? r16(t.valueOff) : t.type === 4 ? r32(t.valueOff) : null;
  }
  function rationals(t) {
    if (!t || t.type !== 5 || !inRange(t.valueOff, t.n * 8)) return null;
    const out = [];
    for (let i = 0; i < t.n; i++) {
      const d = r32(t.valueOff + i * 8 + 4);
      out.push(d ? r32(t.valueOff + i * 8) / d : 0);
    }
    return out;
  }

  const f = result.findings;
  const ifd0 = readIfd(r32(4));
  const t0 = ifd0.tags;
  // Orientation, resolution and colour positioning say nothing about the person.
  const HARMLESS = new Set([0x0112, 0x011a, 0x011b, 0x0128, 0x0213]);
  result.meaningful = [...t0.keys()].some((t) => !HARMLESS.has(t)) || ifd0.next !== 0;

  const orientation = num(t0.get(0x0112));
  if (orientation) result.orientation = orientation;

  const make = str(t0.get(0x010f));
  const model = str(t0.get(0x0110));
  if (make || model) {
    const device = model && make && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' ');
    f.push(finding('Συσκευή', device));
  }
  const software = str(t0.get(0x0131));
  if (software) f.push(finding('Λογισμικό', software));
  const host = str(t0.get(0x013c));
  if (host) f.push(finding('Όνομα υπολογιστή', host, 'high'));
  const artist = str(t0.get(0x013b)) || ucs2(t0.get(0x9c9d));
  if (artist) f.push(finding('Δημιουργός', artist, 'high'));
  const copyright = str(t0.get(0x8298));
  if (copyright) f.push(finding('Πνευματικά δικαιώματα', copyright));
  const desc = str(t0.get(0x010e)) || ucs2(t0.get(0x9c9c)) || ucs2(t0.get(0x9c9b));
  if (desc) f.push(finding('Περιγραφή / σχόλιο', desc));
  const keywords = ucs2(t0.get(0x9c9e));
  if (keywords) f.push(finding('Λέξεις-κλειδιά', keywords));

  let dateFound = false;
  const exifPtr = t0.get(0x8769);
  if (exifPtr) {
    const ex = readIfd(r32(exifPtr.valueOff)).tags;
    const dto = str(ex.get(0x9003)) || str(ex.get(0x9004));
    if (dto) {
      f.push(finding('Ημερομηνία λήψης', prettyDate(dto)));
      dateFound = true;
    }
    const owner = str(ex.get(0xa430));
    if (owner) f.push(finding('Ιδιοκτήτης συσκευής', owner, 'high'));
    const serial = str(ex.get(0xa431));
    if (serial) f.push(finding('Σειριακός αριθμός συσκευής', serial, 'high'));
    const lens = str(ex.get(0xa434)) || str(ex.get(0xa433));
    if (lens) f.push(finding('Φακός', lens));
    const lensSerial = str(ex.get(0xa435));
    if (lensSerial) f.push(finding('Σειριακός αριθμός φακού', lensSerial, 'high'));
    const uid = str(ex.get(0xa420));
    if (uid) f.push(finding('Μοναδικός κωδικός φωτογραφίας', uid));
    const comment = userComment(ex.get(0x9286));
    if (comment) f.push(finding('Περιγραφή / σχόλιο', comment));
    if (ex.get(0x927c)) f.push(finding('Κρυφά δεδομένα κατασκευαστή (MakerNote)'));
  }
  if (!dateFound) {
    const dt = str(t0.get(0x0132));
    if (dt) f.push(finding('Ημερομηνία', prettyDate(dt)));
  }

  const gpsPtr = t0.get(0x8825);
  if (gpsPtr) {
    const g = readIfd(r32(gpsPtr.valueOff)).tags;
    const lat = rationals(g.get(0x0002));
    const lon = rationals(g.get(0x0004));
    const latRef = str(g.get(0x0001));
    const lonRef = str(g.get(0x0003));
    let shown = false;
    if (lat && lon && lat.length >= 1 && lon.length >= 1) {
      const dms = (a) => a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600;
      const la = dms(lat) * (latRef === 'S' ? -1 : 1);
      const lo = dms(lon) * (lonRef === 'W' ? -1 : 1);
      const coords = formatCoords(la, lo);
      if (coords) {
        f.push(finding('Τοποθεσία GPS', coords, 'high'));
        shown = true;
      }
    }
    if (!shown && g.size > 1) f.push(finding('Δεδομένα GPS', null, 'high'));
  }

  if (ifd0.next) {
    const ifd1 = readIfd(ifd0.next).tags;
    if (ifd1.size) f.push(finding('Ενσωματωμένη μικρογραφία της εικόνας'));
  }
}
