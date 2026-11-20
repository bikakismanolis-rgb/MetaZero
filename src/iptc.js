// Photoshop "Image Resource Blocks" (JPEG APP13) and the IPTC records inside them.

import { finding, prettyDate, startsWith, u16be, u32be, utf8 } from './util.js';

const DATASETS = {
  5: ['Τίτλος', 'normal'],
  25: ['Λέξεις-κλειδιά', 'normal'],
  55: ['Ημερομηνία δημιουργίας', 'normal'],
  80: ['Δημιουργός', 'high'],
  85: ['Ιδιότητα δημιουργού', 'normal'],
  90: ['Πόλη', 'high'],
  92: ['Περιοχή', 'high'],
  95: ['Νομός / περιφέρεια', 'high'],
  101: ['Χώρα', 'normal'],
  105: ['Επικεφαλίδα', 'normal'],
  110: ['Πηγή', 'normal'],
  116: ['Πνευματικά δικαιώματα', 'normal'],
  118: ['Στοιχεία επικοινωνίας', 'high'],
  120: ['Λεζάντα', 'normal'],
  122: ['Συντάκτης λεζάντας', 'high'],
};

export function parseApp13(b, start, end) {
  const f = [];
  try {
    let p = start;
    if (startsWith(b, p, 'Photoshop 3.0\0')) p += 14;
    while (p + 12 <= end && startsWith(b, p, '8BIM')) {
      const id = u16be(b, p + 4);
      const nameLen = b[p + 6];
      let q = p + 7 + nameLen;
      if ((nameLen + 1) % 2) q++;
      const size = u32be(b, q);
      const dataStart = q + 4;
      if (id === 0x0404) f.push(...parseIptc(b, dataStart, Math.min(dataStart + size, end)));
      p = dataStart + size + (size % 2);
    }
  } catch {
    // ignore malformed blocks
  }
  if (f.length === 0) f.push(finding('Μεταδεδομένα Photoshop / IPTC'));
  return f;
}

function parseIptc(b, start, end) {
  const f = [];
  const values = new Map();
  let p = start;
  while (p + 5 <= end && b[p] === 0x1c) {
    const record = b[p + 1];
    const dataset = b[p + 2];
    const size = u16be(b, p + 3);
    const v = utf8.decode(b.subarray(p + 5, Math.min(p + 5 + size, end))).trim();
    if (record === 2 && DATASETS[dataset] && v) {
      if (!values.has(dataset)) values.set(dataset, []);
      values.get(dataset).push(v);
    }
    p += 5 + size;
  }
  for (const [ds, vals] of values) {
    const [label, level] = DATASETS[ds];
    f.push(finding(label, ds === 55 ? prettyDate(vals[0]) : vals.join(', '), level));
  }
  return f;
}
