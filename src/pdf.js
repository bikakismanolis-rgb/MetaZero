// PDF: drop the document info dictionary, XMP streams, private application data, the document ID,
// comment author names, old revisions and unreferenced objects. Photos embedded as JPEG are cleaned too.

import { needPdfLib } from './deps.js';
import { cleanJpegBytes, isJpeg } from './jpeg.js';
import { parseXmp } from './xmp.js';
import { UserError, finding, prettyDate, readBytes, utf8 } from './util.js';

const INFO_LABELS = {
  Title: ['Τίτλος'],
  Author: ['Δημιουργός', 'high'],
  Subject: ['Θέμα'],
  Keywords: ['Λέξεις-κλειδιά'],
  Creator: ['Πρόγραμμα δημιουργίας'],
  Producer: ['Πρόγραμμα που έφτιαξε το PDF'],
  CreationDate: ['Ημερομηνία δημιουργίας', 'normal', true],
  ModDate: ['Ημερομηνία αλλαγής', 'normal', true],
  Company: ['Εταιρεία', 'high'],
  SourceModified: ['Ημερομηνία αλλαγής πρωτοτύπου', 'normal', true],
};
const MARKUP = new Set([
  'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline',
  'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'Redact',
]);

export function isPdf(head) {
  const s = new TextDecoder('latin1').decode(head.subarray(0, 1024));
  return s.includes('%PDF-');
}

export async function cleanPdf(file) {
  const L = await needPdfLib();
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFRawStream, PDFString, PDFHexString, PDFNumber } = L;
  const N = (s) => PDFName.of(s);
  const bytes = await readBytes(file);
  const findings = [];
  const warnings = [];

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String(e?.name) + String(e?.message))) {
      throw new UserError('Το PDF είναι κλειδωμένο με κωδικό. Άνοιξέ το, αποθήκευσέ το χωρίς κωδικό και δοκίμασε ξανά.');
    }
    throw new UserError('Δεν μπόρεσα να διαβάσω αυτό το PDF. Ίσως είναι κατεστραμμένο.');
  }
  const ctx = doc.context;

  const text = (v) => {
    if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
    if (v instanceof PDFName) return v.decodeText();
    return v == null ? null : String(v);
  };

  // 1. Document info dictionary.
  const info = ctx.lookup(ctx.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const [k, v] of info.entries()) {
      const key = k.decodeText();
      if (key === 'Trapped') continue;
      const val = text(ctx.lookup(v));
      const [label, level = 'normal', isDate] = INFO_LABELS[key] || [`Πεδίο «${key}»`];
      if (val && val.trim()) findings.push(finding(label, isDate ? prettyDate(val) : val, level));
    }
  }
  ctx.trailerInfo.Info = undefined;
  if (ctx.trailerInfo.ID) findings.push(finding('Μοναδικός κωδικός εγγράφου'));
  ctx.trailerInfo.ID = undefined;

  // 2. Walk everything reachable from the catalog, cleaning dictionaries on the way.
  const reachable = new Set();
  const stack = [ctx.trailerInfo.Root];
  let comments = 0;
  let images = 0;
  let signed = false;
  let attachments = false;

  const cleanDict = (dict) => {
    const meta = dict.get(N('Metadata'));
    if (meta) {
      const stream = ctx.lookup(meta);
      let xml = '';
      if (stream instanceof PDFRawStream) {
        try {
          xml = utf8.decode(L.decodePDFRawStream(stream).decode());
        } catch {
          xml = '';
        }
      }
      findings.push(...(xml ? parseXmp(xml) : [finding('Μεταδεδομένα XMP')]));
      dict.delete(N('Metadata'));
    }
    if (dict.has(N('PieceInfo'))) {
      findings.push(finding('Ιδιωτικά δεδομένα του προγράμματος επεξεργασίας'));
      dict.delete(N('PieceInfo'));
    }
    dict.delete(N('LastModified'));
    const type = dict.get(N('Type'));
    const subtype = dict.get(N('Subtype'));
    const ft = dict.get(N('FT'));
    if ((type === N('Annot') || dict.has(N('Rect'))) && subtype instanceof PDFName && MARKUP.has(subtype.decodeText())) {
      const author = text(ctx.lookup(dict.get(N('T'))));
      if (author && author.trim()) findings.push(finding('Όνομα συντάκτη σχολίου', author, 'high'));
      if (subtype !== N('Popup')) comments++;
      dict.delete(N('T'));
      dict.delete(N('M'));
      dict.delete(N('CreationDate'));
    }
    if (type === N('Sig') || ft === N('Sig')) signed = true;
    if (dict.has(N('EmbeddedFiles')) || type === N('EmbeddedFile') || type === N('Filespec')) attachments = true;
  };

  const push = (v) => {
    if (v instanceof PDFRef) stack.push(v);
    else if (v instanceof PDFDict || v instanceof PDFArray || v instanceof PDFStream) stack.push(v);
  };

  while (stack.length) {
    let obj = stack.pop();
    let ref = null;
    if (obj instanceof PDFRef) {
      if (reachable.has(obj.tag)) continue;
      reachable.add(obj.tag);
      ref = obj;
      obj = ctx.lookup(obj);
    }
    if (obj instanceof PDFStream) {
      cleanDict(obj.dict);
      if (ref && obj instanceof PDFRawStream && isDct(obj.dict)) {
        const contents = obj.getContents();
        if (isJpeg(contents)) {
          try {
            const r = cleanJpegBytes(contents, { keepOrientation: false });
            if (r.findings.length) {
              images++;
              findings.push(...r.findings.map((f) => ({ ...f, label: 'Φωτογραφία μέσα στο PDF: ' + f.label })));
              obj.dict.set(N('Length'), PDFNumber.of(r.bytes.length));
              ctx.assign(ref, PDFRawStream.of(obj.dict, r.bytes));
            }
          } catch {
            // leave the image as it is
          }
        }
      }
      for (const [, v] of obj.dict.entries()) push(v);
    } else if (obj instanceof PDFDict) {
      cleanDict(obj);
      for (const [, v] of obj.entries()) push(v);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) push(obj.get(i));
    }
  }

  function isDct(dict) {
    const f = dict.get(N('Filter'));
    if (f === N('DCTDecode')) return true;
    return f instanceof PDFArray && f.size() === 1 && f.get(0) === N('DCTDecode');
  }

  // 3. Drop everything that is no longer referenced (old revisions, orphaned metadata).
  let orphans = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) {
      ctx.delete(ref);
      orphans++;
    }
  }
  if (orphans > 0 && findings.length === 0) findings.push(finding('Παλιές εκδόσεις ή αχρησιμοποίητα δεδομένα'));

  if (comments) warnings.push(`Το PDF έχει ${comments === 1 ? 'ένα σχόλιο' : comments + ' σχόλια'}. Τα ονόματα αφαιρέθηκαν, το κείμενο έμεινε.`);
  if (signed) warnings.push('Το PDF είχε ψηφιακή υπογραφή. Μετά τον καθαρισμό η υπογραφή δεν θα είναι πια έγκυρη.');
  if (attachments) warnings.push('Το PDF περιέχει συνημμένα αρχεία. Αυτά δεν καθαρίστηκαν.');

  const out = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
  return { blob: new Blob([out], { type: 'application/pdf' }), findings, warnings };
}
