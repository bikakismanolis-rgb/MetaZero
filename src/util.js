// Shared byte helpers. Everything here works both in the browser and in Node (for tests).

export const utf8 = new TextDecoder('utf-8');
export const encoder = new TextEncoder();

export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

export async function readBytes(blob, start = 0, end = blob.size) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

export function ascii(b, start, len) {
  let s = '';
  const end = Math.min(start + len, b.length);
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function startsWith(b, offset, str) {
  if (offset < 0 || offset + str.length > b.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (b[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

export const u16be = (b, o) => (b[o] << 8) | b[o + 1];
export const u32be = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
export const u64be = (b, o) => u32be(b, o) * 0x100000000 + u32be(b, o + 4);
export const u16le = (b, o) => b[o] | (b[o + 1] << 8);
export const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

export function writeU32be(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

export function writeU32le(b, o, v) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

export function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

let crcTable = null;
export function crc32(b, start = 0, end = b.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A TIFF/EXIF block that holds nothing but the image orientation (or nothing at all).
// Orientation is kept so that photos are not displayed sideways after cleaning.
export function minimalTiff(orientation) {
  const keep = orientation >= 2 && orientation <= 8;
  const b = new Uint8Array(keep ? 26 : 14);
  b.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  if (keep) {
    b.set([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0], 8);
  }
  return b;
}

export const EXIF_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"

// Colour profiles are needed to show colours correctly, so standard ones are kept.
// A custom profile (e.g. from calibrating your own screen) can carry a personal name, so it is removed.
const STANDARD_ICC = /sRGB|Display P3|DCI.?P3|Image P3|Adobe RGB|Generic (RGB|Gray|CMYK)|ProPhoto|ROMM|Rec\.? ?(601|709|2020|2100)|BT\.? ?(601|709|2020|2100)|ITU-R|Apple RGB|ColorMatch|eciRGB|FOGRA|SWOP|GRACoL|Japan Color|Coated|Uncoated|Dot Gain|Gray Gamma|Linear|ACES|scRGB|Wide Gamut|^c2$|built-in/i;

export function iccDescription(b) {
  try {
    if (b.length < 132) return null;
    const n = u32be(b, 128);
    for (let i = 0; i < n && 144 + i * 12 <= b.length; i++) {
      const e = 132 + i * 12;
      if (ascii(b, e, 4) !== 'desc') continue;
      const off = u32be(b, e + 4);
      const type = ascii(b, off, 4);
      if (type === 'desc') return ascii(b, off + 12, u32be(b, off + 8)).replace(/\0[\s\S]*$/, '').trim() || null;
      if (type === 'mluc' && u32be(b, off + 8) > 0) {
        const len = u32be(b, off + 20);
        const start = off + u32be(b, off + 24);
        let s = '';
        for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(u16be(b, start + j));
        return s.replace(/\0[\s\S]*$/, '').trim() || null;
      }
    }
  } catch {
    // unreadable profile
  }
  return null;
}

/** null if the profile can stay, otherwise a finding explaining why it was removed */
export function judgeIcc(profile) {
  const desc = iccDescription(profile);
  if (!desc || STANDARD_ICC.test(desc)) return null;
  return finding('Προσωπικό προφίλ χρωμάτων', desc);
}

export async function inflate(bytes, format = 'deflate') {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export function decodeText(b, start = 0, end = b.length) {
  return utf8.decode(b.subarray(start, end)).replace(/\0+$/g, '').trim();
}

export function clip(s, max = 140) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// Accepts the many date spellings found in metadata and returns "dd/mm/yyyy hh:mm".
export function prettyDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  let m = s.match(/^D?:?(\d{4})[:\-]?(\d{2})[:\-]?(\d{2})(?:[T ]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00'] = m;
    if (Number(y) < 1900 || Number(mo) < 1 || Number(mo) > 12) return clip(s, 40);
    return h === '00' && mi === '00' && !m[4] ? `${d}/${mo}/${y}` : `${d}/${mo}/${y} ${h}:${mi}`;
  }
  return clip(s, 40);
}

export function formatCoords(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// ISO 6709 strings as used by phones in videos: "+37.9838+023.7275+095.000/"
export function parseIso6709(s) {
  const m = String(s).match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const conv = (v, degDigits) => {
    const sign = v[0] === '-' ? -1 : 1;
    const [intPart, frac = ''] = v.slice(1).split('.');
    if (intPart.length <= degDigits) return sign * parseFloat(v.slice(1));
    const deg = parseInt(intPart.slice(0, degDigits), 10);
    const rest = intPart.slice(degDigits);
    const min = parseInt(rest.slice(0, 2), 10);
    const sec = rest.length >= 4 ? parseFloat(rest.slice(2) + (frac ? '.' + frac : '')) : 0;
    const minFrac = rest.length === 2 && frac ? parseFloat('0.' + frac) : 0;
    return sign * (deg + (min + minFrac) / 60 + sec / 3600);
  };
  return formatCoords(conv(m[1], 2), conv(m[2], 3));
}

// Findings are what we show the user: "this is what was hidden in your file".
export function finding(label, value = null, level = 'normal') {
  return { label, value: value == null || value === '' ? null : clip(value), level };
}

export function dedupeFindings(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const key = f.label + '|' + (f.value ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  // Most sensitive first.
  return out.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1));
}
