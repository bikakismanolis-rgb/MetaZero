// File names can give away as much as metadata: "IMG_20261120_143205.jpg" says when, "Screenshot..." says how.

const CAMERA = /(^|[^a-z])(IMG|VID|PXL|DSC[NF]?|MVIMG|MOV|GOPR|GH\d{2}|DJI|SAM|WP|PANO|BURST|Screenshot|Screen ?Shot|Screen Recording|Στιγμιότυπο|Εγγραφή οθόνης|WhatsApp|Signal|Telegram|Snapchat|received|FB_IMG|InShot|Messenger)([^a-z]|$)|^P\d{7}/i;
const DATE = /(19|20)\d{2}[-_.]?[01]\d[-_.]?[0-3]\d|\d{2}[-_.][01]\d[-_.](19|20)\d{2}/;
const PREFIX = { image: 'photo', video: 'video', audio: 'audio', document: 'document' };
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, ''];
}

export function isRevealing(name, category) {
  const [base] = splitExt(name);
  if (CAMERA.test(base)) return true;
  // Dates in document names are usually deliberate ("Τιμολόγιο 2026-11.pdf"); in photo names they are not.
  return category !== 'document' && DATE.test(base);
}

function randomTag() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** mode: "auto" | "keep" | "random" */
export function outputName(original, category, defaultExt, mode = 'auto') {
  const name = original || `file.${defaultExt}`;
  const [, ext] = splitExt(name);
  const finalExt = (ext || defaultExt || 'bin').toLowerCase();
  if (mode === 'keep') return name;
  if (mode === 'auto' && !isRevealing(name, category)) return name;
  return `${PREFIX[category] || 'file'}-${randomTag()}.${finalExt}`;
}
