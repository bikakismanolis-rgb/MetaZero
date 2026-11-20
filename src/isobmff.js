// ISO base media files: MP4 / MOV / M4A video and audio, and HEIC / AVIF photos.
//
// Strategy: never move bytes around. Metadata boxes are renamed to "free" (which every player
// ignores) and their contents are overwritten with zeros, so all internal offsets stay valid.
// Only the boxes we change are read into memory; the rest of the file is passed through as slices,
// which keeps memory low even for multi-gigabyte videos.

import { parseTiff } from './exif.js';
import { isHdrOnlyXmp, MINIMAL_XMP_END, MINIMAL_XMP_START, parseXmp } from './xmp.js';
import {
  ascii, concat, encoder, finding, formatCoords, formatDate, minimalTiff, parseIso6709, prettyDate,
  readBytes, u16be, u32be, u64be, utf8,
} from './util.js';

const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
const TOP_KEEP = new Set(['ftyp', 'mdat', 'free', 'skip', 'wide', 'moof', 'mfra', 'sidx', 'ssix', 'styp', 'prft', 'emsg', 'pdin', 'meco']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
const TELEMETRY = { gpmd: 'GoPro', camm: 'κάμερα 360°', djmd: 'DJI' };
const FREE = new Uint8Array([0x66, 0x72, 0x65, 0x65]);

const ITEMS = {
  '©xyz': ['Τοποθεσία GPS', 'high', 'iso'],
  '©mak': ['Κατασκευαστής συσκευής'],
  '©mod': ['Μοντέλο συσκευής'],
  '©swr': ['Λογισμικό'],
  '©too': ['Λογισμικό'],
  '©enc': ['Λογισμικό'],
  '©day': ['Ημερομηνία', 'normal', 'date'],
  '©nam': ['Τίτλος'],
  '©ART': ['Καλλιτέχνης', 'high'],
  '©aut': ['Δημιουργός', 'high'],
  '©prf': ['Ερμηνευτής', 'high'],
  aART: ['Καλλιτέχνης άλμπουμ'],
  '©alb': ['Άλμπουμ'],
  '©cmt': ['Σχόλιο'],
  '©des': ['Περιγραφή'],
  desc: ['Περιγραφή'],
  '©inf': ['Πληροφορίες'],
  '©wrt': ['Συνθέτης'],
  '©cpy': ['Πνευματικά δικαιώματα'],
  cprt: ['Πνευματικά δικαιώματα'],
  covr: ['Εξώφυλλο (εικόνα)'],
  '©lyr': ['Στίχοι'],
  'com.apple.quicktime.location.ISO6709': ['Τοποθεσία GPS', 'high', 'iso'],
  'com.apple.quicktime.location.name': ['Τοποθεσία (όνομα)', 'high'],
  'com.apple.quicktime.make': ['Κατασκευαστής συσκευής'],
  'com.apple.quicktime.model': ['Μοντέλο συσκευής'],
  'com.apple.quicktime.software': ['Λογισμικό'],
  'com.apple.quicktime.creationdate': ['Ημερομηνία δημιουργίας', 'normal', 'date'],
  'com.apple.quicktime.author': ['Δημιουργός', 'high'],
  'com.apple.quicktime.artist': ['Δημιουργός', 'high'],
  'com.apple.quicktime.displayname': ['Τίτλος'],
  'com.apple.quicktime.title': ['Τίτλος'],
  'com.apple.quicktime.description': ['Περιγραφή'],
  'com.apple.quicktime.comment': ['Σχόλιο'],
  'com.apple.quicktime.content.identifier': ['Μοναδικός κωδικός λήψης'],
  'com.android.version': ['Έκδοση Android'],
  'com.android.manufacturer': ['Κατασκευαστής συσκευής'],
  'com.android.model': ['Μοντέλο συσκευής'],
};
const IGNORE_KEYS = new Set(['com.android.capture.fps', 'com.apple.quicktime.location.accuracy.horizontal']);
const GPP_STRINGS = { auth: '©aut', titl: '©nam', dscp: '©des', cprt: 'cprt', perf: '©prf', albm: '©alb', gnre: null, kywd: null, yrrc: null };

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function isType(t) {
  for (let i = 0; i < 4; i++) {
    const c = t.charCodeAt(i);
    if (!((c >= 0x20 && c <= 0x7e) || c === 0xa9)) return false;
  }
  return true;
}

export function isIsobmff(head) {
  if (head.length < 12) return false;
  const t = ascii(head, 4, 4);
  if (t === 'ftyp') return true;
  return ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(t) && u32be(head, 0) >= 8;
}

function* children(b, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    let hdr = 8;
    let large = false;
    if (size === 1) {
      if (off + 16 > end) return;
      size = u64be(b, off + 8);
      hdr = 16;
      large = true;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) return;
    yield { off, size, type, hdr, large, start: off + hdr, end: off + size };
    off += size;
  }
}

function neutralizeInPlace(b, c) {
  b.set(FREE, c.off + 4);
  b.fill(0, c.off + (c.large ? 16 : 8), c.off + c.size);
}

async function readHeader(file, off, limit) {
  if (off + 8 > limit) return null;
  const h = await readBytes(file, off, Math.min(off + 40, limit));
  let size = u32be(h, 0);
  const type = ascii(h, 4, 4);
  if (!isType(type)) return null;
  let hdr = 8;
  let large = false;
  if (size === 1) {
    if (h.length < 16) return null;
    size = u64be(h, 8);
    hdr = 16;
    large = true;
  } else if (size === 0) {
    size = limit - off;
  }
  let usertype = null;
  if (type === 'uuid') {
    if (h.length < hdr + 16) return null;
    usertype = hex(h.subarray(hdr, hdr + 16));
  }
  if (size < hdr) return null;
  if (off + size > limit) {
    if (type !== 'mdat') return null;
    size = limit - off; // truncated recording: keep what is there
  }
  return { off, size, type, hdr, large, usertype };
}

// Children of a "meta" box start after a version/flags field in MP4/HEIF, but not in QuickTime.
function metaChildrenStart(b, start) {
  return ascii(b, start + 4, 4) === 'hdlr' ? start : start + 4;
}

export async function cleanIsobmff(file, name = '') {
  const findings = [];
  const warnings = [];
  const patches = [];
  const size = file.size;
  let off = 0;
  let end = size;
  let brands = [];
  let hasMoov = false;
  let hasPict = false;

  const neutralizeTop = (h) => {
    patches.push({ off: h.off + 4, bytes: FREE });
    const zeroFrom = h.off + (h.large ? 16 : 8);
    patches.push({ off: zeroFrom, zeros: h.off + h.size - zeroFrom });
  };

  while (off < size) {
    const h = await readHeader(file, off, size);
    if (!h) {
      const rest = await readBytes(file, off, Math.min(size, off + 65536));
      if (rest.some((x) => x !== 0)) findings.push(finding('Κρυφά δεδομένα στο τέλος του αρχείου'));
      end = off;
      break;
    }
    if (h.type === 'ftyp') {
      const b = await readBytes(file, off + h.hdr, off + Math.min(h.size, 1024));
      brands = [ascii(b, 0, 4)];
      for (let i = 8; i + 4 <= b.length; i += 4) brands.push(ascii(b, i, 4));
    } else if (h.type === 'moov') {
      hasMoov = true;
      const b = await readBytes(file, off, off + h.size);
      walkMovie(b, h.hdr, b.length, findings, warnings);
      patches.push({ off, bytes: b });
    } else if (h.type === 'meta') {
      const b = await readBytes(file, off, off + h.size);
      const kidsStart = metaChildrenStart(b, h.hdr);
      const hdlr = [...children(b, kidsStart, b.length)].find((c) => c.type === 'hdlr');
      if (hdlr && ascii(b, hdlr.start + 8, 4) === 'pict') {
        hasPict = true;
        await cleanHeifItems(file, b, off, kidsStart, findings, patches);
      } else {
        parseMeta(b, { start: h.hdr, end: b.length }, findings);
        neutralizeTop(h);
      }
    } else if (h.type === 'udta') {
      const b = await readBytes(file, off, off + h.size);
      parseUdta(b, h.hdr, b.length, findings);
      neutralizeTop(h);
    } else if (h.type === 'uuid') {
      if (h.usertype === XMP_UUID) {
        const b = await readBytes(file, off + h.hdr + 16, off + Math.min(h.size, 4 << 20));
        findings.push(...parseXmp(utf8.decode(b)));
      } else if (h.usertype === C2PA_UUID) {
        findings.push(finding('Ψηφιακά διαπιστευτήρια περιεχομένου (C2PA)'));
      } else {
        findings.push(finding('Άλλα κρυφά δεδομένα'));
      }
      neutralizeTop(h);
    } else if (!TOP_KEEP.has(h.type)) {
      findings.push(finding('Άλλα κρυφά δεδομένα', h.type.trim()));
      neutralizeTop(h);
    }
    off += h.size;
  }

  let kind = 'video';
  if (hasPict && !hasMoov) kind = 'image';
  else if (brands.some((x) => AUDIO_BRANDS.has(x)) || /\.(m4a|m4b|m4p|aac)$/i.test(name)) kind = 'audio';

  return { blob: assemble(file, patches, end), findings, warnings, kind, brand: brands[0] || '' };
}

const ZERO_CHUNK = 8 << 20;
let zeroBuf = null;

function assemble(file, patches, end) {
  patches.sort((a, b) => a.off - b.off);
  const parts = [];
  let pos = 0;
  for (const p of patches) {
    if (p.off < pos) continue; // overlapping patch (should not happen)
    if (p.off > pos) parts.push(file.slice(pos, p.off));
    if (p.zeros != null) {
      zeroBuf ??= new Uint8Array(ZERO_CHUNK);
      let n = p.zeros;
      while (n > 0) {
        const k = Math.min(n, ZERO_CHUNK);
        parts.push(k === ZERO_CHUNK ? zeroBuf : zeroBuf.subarray(0, k));
        n -= k;
      }
      pos = p.off + p.zeros;
    } else {
      parts.push(p.bytes);
      pos = p.off + p.bytes.length;
    }
  }
  if (pos < end) parts.push(file.slice(pos, end));
  return new Blob(parts, { type: file.type || 'application/octet-stream' });
}

// ---------- movies ----------

function walkMovie(b, start, end, findings, warnings) {
  for (const c of children(b, start, end)) {
    switch (c.type) {
      case 'trak':
      case 'mdia':
      case 'minf':
      case 'stbl':
      case 'edts':
        walkMovie(b, c.start, c.end, findings, warnings);
        break;
      case 'mvhd':
      case 'tkhd':
      case 'mdhd':
        zeroTimes(b, c, findings);
        break;
      case 'stsd':
        for (const e of children(b, c.start + 8, c.end)) {
          if (TELEMETRY[e.type]) {
            warnings.push(`Το βίντεο έχει ξεχωριστή ροή τηλεμετρίας (${TELEMETRY[e.type]}) που μπορεί να περιέχει GPS. Αυτή δεν αφαιρείται.`);
          }
        }
        break;
      case 'udta':
        parseUdta(b, c.start, c.end, findings);
        neutralizeInPlace(b, c);
        break;
      case 'meta':
        parseMeta(b, c, findings);
        neutralizeInPlace(b, c);
        break;
      case 'uuid': {
        const ut = hex(b.subarray(c.start, c.start + 16));
        if (ut === XMP_UUID) {
          findings.push(...parseXmp(utf8.decode(b.subarray(c.start + 16, c.end))));
          neutralizeInPlace(b, c);
        } else if (ut === C2PA_UUID) {
          findings.push(finding('Ψηφιακά διαπιστευτήρια περιεχομένου (C2PA)'));
          neutralizeInPlace(b, c);
        }
        break;
      }
      default:
        break;
    }
  }
}

function zeroTimes(b, c, findings) {
  const v = b[c.start];
  const n = v === 1 ? 8 : 4;
  if (c.start + 4 + 2 * n > c.end) return;
  const created = v === 1 ? u64be(b, c.start + 4) : u32be(b, c.start + 4);
  if (c.type === 'mvhd' && created > 0) {
    const d = new Date((created - 2082844800) * 1000);
    const y = d.getUTCFullYear();
    if (y > 1971 && y < 2100) findings.push(finding('Ημερομηνία δημιουργίας', formatDate(d)));
  }
  b.fill(0, c.start + 4, c.start + 4 + 2 * n);
}

function qtText(b, start, end) {
  if (end - start >= 16 && ascii(b, start + 4, 4) === 'data') return dataValue(b, start, end);
  if (end - start >= 4) {
    const len = u16be(b, start);
    if (len > 0 && start + 4 + len <= end) return utf8.decode(b.subarray(start + 4, start + 4 + len)).replace(/\0/g, '').trim();
  }
  return utf8.decode(b.subarray(start, end)).replace(/[\0-\x08]/g, '').trim();
}

function dataValue(b, start, end) {
  for (const d of children(b, start, end)) {
    if (d.type !== 'data' || d.end - d.start < 8) continue;
    const type = u32be(b, d.start) & 0xffffff;
    const v = b.subarray(d.start + 8, d.end);
    if (type === 1 || type === 0) return utf8.decode(v).replace(/\0/g, '').trim();
    if (type === 2) {
      let s = '';
      for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]);
      return s.trim();
    }
    if (type === 13 || type === 14 || type === 27) return 'εικόνα';
    if (type === 21 || type === 22) {
      let x = 0;
      for (const byte of v) x = x * 256 + byte;
      return String(x);
    }
    return null;
  }
  return null;
}

function addItem(key, value, findings) {
  if (IGNORE_KEYS.has(key)) return false;
  const spec = ITEMS[key];
  if (!spec) {
    if (key.includes('.')) {
      findings.push(finding(`Πεδίο «${key}»`, value));
      return true;
    }
    return false;
  }
  const [label, level = 'normal', kind] = spec;
  let v = value;
  if (kind === 'iso' && v) v = parseIso6709(v) || v;
  if (kind === 'date' && v) v = prettyDate(v);
  findings.push(finding(label, v, level));
  return true;
}

function parseUdta(b, start, end, findings) {
  const before = findings.length;
  let any = false;
  for (const c of children(b, start, end)) {
    any = true;
    const t = c.type;
    if (t === 'meta') parseMeta(b, c, findings);
    else if (t === 'XMP_') findings.push(...parseXmp(utf8.decode(b.subarray(c.start, c.end))));
    else if (t === 'loci') parseLoci(b, c, findings);
    else if (t.charCodeAt(0) === 0xa9) addItem(t, qtText(b, c.start, c.end), findings);
    else if (t in GPP_STRINGS) {
      const key = GPP_STRINGS[t];
      const s = utf8.decode(b.subarray(c.start + 6, c.end)).replace(/\0/g, '').trim();
      if (key) addItem(key, s, findings);
    }
  }
  if (any && findings.length === before) findings.push(finding('Μεταδεδομένα βίντεο / ήχου'));
}

function parseLoci(b, c, findings) {
  try {
    let p = c.start + 6;
    const z = b.indexOf(0, p);
    const placeName = utf8.decode(b.subarray(p, z)).trim();
    p = z + 2;
    const s32 = (o) => (u32be(b, o) | 0) / 65536;
    const coords = formatCoords(s32(p + 4), s32(p));
    findings.push(finding('Τοποθεσία GPS', coords || placeName || null, 'high'));
  } catch {
    findings.push(finding('Τοποθεσία GPS', null, 'high'));
  }
}

function parseMeta(b, c, findings) {
  const s = metaChildrenStart(b, c.start);
  const kids = [...children(b, s, c.end)];
  let keys = null;
  const keysBox = kids.find((k) => k.type === 'keys');
  if (keysBox) {
    keys = [];
    const n = u32be(b, keysBox.start + 4);
    let p = keysBox.start + 8;
    for (let i = 0; i < n && p + 8 <= keysBox.end; i++) {
      const ks = u32be(b, p);
      if (ks < 8) break;
      keys.push(utf8.decode(b.subarray(p + 8, Math.min(p + ks, keysBox.end))));
      p += ks;
    }
  }
  const ilst = kids.find((k) => k.type === 'ilst');
  if (ilst) {
    for (const item of children(b, ilst.start, ilst.end)) {
      let key = item.type;
      if (keys) {
        const idx = u32be(b, item.off + 4);
        if (idx >= 1 && idx <= keys.length) key = keys[idx - 1];
      }
      if (key === '----') {
        const nameBox = [...children(b, item.start, item.end)].find((k) => k.type === 'name');
        key = nameBox ? utf8.decode(b.subarray(nameBox.start + 4, nameBox.end)) : 'iTunes';
        findings.push(finding(`Πεδίο «${key}»`, dataValue(b, item.start, item.end)));
        continue;
      }
      if (!addItem(key, dataValue(b, item.start, item.end), findings) && !keys) {
        findings.push(finding('Μεταδεδομένα βίντεο / ήχου'));
      }
    }
  }
  const xml = kids.find((k) => k.type === 'xml ');
  if (xml) findings.push(...parseXmp(utf8.decode(b.subarray(xml.start + 4, xml.end))));
}

// ---------- HEIF / AVIF photos ----------

async function cleanHeifItems(file, b, metaOff, kidsStart, findings, patches) {
  const kids = [...children(b, kidsStart, b.length)];
  const iinf = kids.find((k) => k.type === 'iinf');
  const iloc = kids.find((k) => k.type === 'iloc');
  const idat = kids.find((k) => k.type === 'idat');
  if (!iinf || !iloc) return;
  const items = parseIinf(b, iinf);
  const locs = parseIloc(b, iloc);
  const idatStart = idat ? metaOff + idat.start : null;

  for (const [id, it] of items) {
    const isExif = it.type === 'Exif';
    const isXmp = (it.type === 'mime' || it.type == null) && /rdf\+xml|xmp/i.test(it.contentType || '');
    if (!isExif && !isXmp) continue;
    const loc = locs.get(id);
    if (!loc) continue;
    const ranges = [];
    let ok = true;
    for (const ex of loc.extents) {
      let abs;
      if (loc.method === 0) abs = loc.base + ex.offset;
      else if (loc.method === 1 && idatStart != null) abs = idatStart + loc.base + ex.offset;
      else ok = false;
      if (!ok || ex.length === 0 || abs + ex.length > file.size) {
        ok = false;
        break;
      }
      ranges.push({ off: abs, len: ex.length });
    }
    if (!ok || !ranges.length) continue;
    const data = concat(await Promise.all(ranges.map((r) => readBytes(file, r.off, r.off + r.len))));
    let repl = new Uint8Array(data.length);

    if (isExif) {
      const tiffStart = 4 + u32be(data, 0);
      const t = tiffStart < data.length ? parseTiff(data, tiffStart) : { findings: [finding('Μεταδεδομένα EXIF')], orientation: null };
      findings.push(...t.findings);
      const mt = minimalTiff(t.orientation);
      if (tiffStart + mt.length <= data.length) {
        repl.set(data.subarray(0, tiffStart));
        repl.set(mt, tiffStart);
      }
    } else {
      const xml = it.encoding ? '' : utf8.decode(data);
      if (xml && isHdrOnlyXmp(xml)) continue; // HDR gain-map description: harmless, keep
      findings.push(...(xml ? parseXmp(xml) : [finding('Μεταδεδομένα XMP')]));
      const fill = data.length - MINIMAL_XMP_START.length - MINIMAL_XMP_END.length;
      if (!it.encoding && fill >= 0) repl = encoder.encode(MINIMAL_XMP_START + ' '.repeat(fill) + MINIMAL_XMP_END);
    }
    let p = 0;
    for (const r of ranges) {
      patches.push({ off: r.off, bytes: repl.subarray(p, p + r.len) });
      p += r.len;
    }
  }
}

function parseIinf(b, box) {
  const items = new Map();
  const v = b[box.start];
  const p = box.start + 4 + (v === 0 ? 2 : 4);
  for (const c of children(b, p, box.end)) {
    if (c.type !== 'infe') continue;
    const iv = b[c.start];
    let q = c.start + 4;
    const readStr = () => {
      let z = b.indexOf(0, q);
      if (z < 0 || z > c.end) z = c.end;
      const s = utf8.decode(b.subarray(q, z));
      q = z + 1;
      return s;
    };
    let id;
    let type = null;
    let contentType = null;
    let encoding = '';
    if (iv >= 2) {
      id = iv === 2 ? u16be(b, q) : u32be(b, q);
      q += (iv === 2 ? 2 : 4) + 2;
      type = ascii(b, q, 4);
      q += 4;
      readStr();
      if (type === 'mime') {
        contentType = readStr();
        if (q < c.end) encoding = readStr();
      }
    } else {
      id = u16be(b, q);
      q += 4;
      readStr();
      contentType = readStr();
      if (q < c.end) encoding = readStr();
    }
    items.set(id, { type, contentType, encoding });
  }
  return items;
}

function parseIloc(b, box) {
  const map = new Map();
  const v = b[box.start];
  let p = box.start + 4;
  const offSize = b[p] >> 4;
  const lenSize = b[p] & 15;
  const baseSize = b[p + 1] >> 4;
  const idxSize = v === 1 || v === 2 ? b[p + 1] & 15 : 0;
  p += 2;
  const readN = (n) => {
    let x = 0;
    for (let i = 0; i < n; i++) x = x * 256 + b[p + i];
    p += n;
    return x;
  };
  const count = v < 2 ? readN(2) : readN(4);
  for (let i = 0; i < count && p < box.end; i++) {
    const id = v < 2 ? readN(2) : readN(4);
    const method = v === 1 || v === 2 ? readN(2) & 15 : 0;
    readN(2); // data reference index
    const base = readN(baseSize);
    const ec = readN(2);
    const extents = [];
    for (let j = 0; j < ec; j++) {
      if (idxSize) readN(idxSize);
      const offset = readN(offSize);
      const length = readN(lenSize);
      extents.push({ offset, length });
    }
    map.set(id, { method, base, extents });
  }
  return map;
}
