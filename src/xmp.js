// XMP is XML embedded in images, PDFs and videos. We only read it to tell the user what it contained.

import { finding, prettyDate, xmlUnescape } from './util.js';

function prop(xml, name) {
  const esc = name.replace(':', '\\:');
  let m = xml.match(new RegExp(`\\b${esc}\\s*=\\s*"([^"]*)"`));
  if (m) return xmlUnescape(m[1]).trim() || null;
  m = xml.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`));
  if (m) {
    const items = [...m[1].matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((x) => x[1]);
    const text = (items.length ? items.join(', ') : m[1]).replace(/<[^>]+>/g, ' ');
    return xmlUnescape(text).replace(/\s+/g, ' ').trim() || null;
  }
  return null;
}

export function parseXmp(xml) {
  const f = [];
  if (!xml) return f;
  const add = (label, names, level = 'normal', transform = (v) => v) => {
    for (const n of names) {
      const v = prop(xml, n);
      if (v) {
        f.push(finding(label, transform(v), level));
        return;
      }
    }
  };
  add('Δημιουργός', ['dc:creator', 'pdf:Author', 'photoshop:AuthorsPosition'], 'high');
  add('Ιδιοκτήτης συσκευής', ['aux:OwnerName', 'exifEX:CameraOwnerName'], 'high');
  add('Σειριακός αριθμός συσκευής', ['aux:SerialNumber', 'exifEX:BodySerialNumber'], 'high');
  const lat = prop(xml, 'exif:GPSLatitude');
  const lon = prop(xml, 'exif:GPSLongitude');
  if (lat && lon) f.push(finding('Τοποθεσία GPS', `${lat}, ${lon}`, 'high'));
  const place = ['Iptc4xmpCore:Location', 'photoshop:City', 'photoshop:State', 'photoshop:Country']
    .map((n) => prop(xml, n))
    .filter(Boolean);
  if (place.length) f.push(finding('Τοποθεσία (όνομα)', place.join(', '), 'high'));
  const make = prop(xml, 'tiff:Make');
  const model = prop(xml, 'tiff:Model');
  if (make || model) f.push(finding('Συσκευή', [make, model].filter(Boolean).join(' ')));
  add('Πρόγραμμα', ['xmp:CreatorTool', 'pdf:Producer']);
  add('Ημερομηνία δημιουργίας', ['exif:DateTimeOriginal', 'photoshop:DateCreated', 'xmp:CreateDate'], 'normal', prettyDate);
  add('Ημερομηνία αλλαγής', ['xmp:ModifyDate', 'xmp:MetadataDate'], 'normal', prettyDate);
  add('Πνευματικά δικαιώματα', ['dc:rights']);
  add('Τίτλος / περιγραφή', ['dc:title', 'dc:description', 'exif:UserComment']);
  add('Λέξεις-κλειδιά', ['dc:subject', 'pdf:Keywords']);
  if (/xmpMM:History|stEvt:action/.test(xml)) f.push(finding('Ιστορικό επεξεργασίας (ποια προγράμματα και πότε)'));
  const docId = prop(xml, 'xmpMM:OriginalDocumentID') || prop(xml, 'xmpMM:DocumentID');
  if (docId) f.push(finding('Μοναδικός κωδικός εγγράφου', docId));
  if (/c2pa|contentcredentials/i.test(xml)) f.push(finding('Ψηφιακά διαπιστευτήρια περιεχομένου (C2PA)'));
  if (f.length === 0 && /<rdf:Description\b[^>]*[^/]>|<rdf:Description\b[^>]*\s\w+:\w+=/.test(xml)) f.push(finding('Μεταδεδομένα XMP'));
  return f;
}

// Gain-map descriptions for HDR photos carry no personal data; we can keep them intact.
export function isHdrOnlyXmp(xml) {
  return /HDRGainMap|hdrgm:/i.test(xml) && parseXmp(xml).every((x) => x.label === 'Μεταδεδομένα XMP');
}

export const MINIMAL_XMP_START = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
export const MINIMAL_XMP_END = '<?xpacket end="w"?>';
