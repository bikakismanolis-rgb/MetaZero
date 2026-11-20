// Office documents are ZIP packages of XML files.
//   OOXML: .docx .xlsx .pptx (and macro/template variants)
//   ODF:   .odt .ods .odp (LibreOffice)
// We rewrite the property files, remove thumbnails / printer data / file paths, anonymise
// comment and revision authors, clean embedded photos and reset every ZIP timestamp.

import { needJSZip } from './deps.js';
import { cleanJpegBytes, isJpeg } from './jpeg.js';
import { cleanPngBytes, isPng } from './png.js';
import { UserError, finding, prettyDate, readBytes, xmlUnescape } from './util.js';

const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

const MIN_CORE =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>';
const MIN_APP =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';
const minMeta = (version) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  `<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="${version}"><office:meta/></office:document-meta>`;

const CORE_FIELDS = [
  ['dc:creator', 'Δημιουργός', 'high'],
  ['cp:lastModifiedBy', 'Τελευταία αλλαγή από', 'high'],
  ['dcterms:created', 'Ημερομηνία δημιουργίας', 'normal', 'date'],
  ['dcterms:modified', 'Ημερομηνία αλλαγής', 'normal', 'date'],
  ['cp:lastPrinted', 'Τελευταία εκτύπωση', 'normal', 'date'],
  ['cp:revision', 'Αριθμός αποθηκεύσεων'],
  ['dc:title', 'Τίτλος'],
  ['dc:subject', 'Θέμα'],
  ['cp:keywords', 'Λέξεις-κλειδιά'],
  ['dc:description', 'Σχόλια εγγράφου'],
  ['cp:category', 'Κατηγορία'],
  ['cp:contentStatus', 'Κατάσταση'],
  ['dc:identifier', 'Κωδικός εγγράφου'],
];
const APP_FIELDS = [
  ['Company', 'Εταιρεία', 'high'],
  ['Manager', 'Προϊστάμενος', 'high'],
  ['Template', 'Πρότυπο'],
  ['HyperlinkBase', 'Βασική διαδρομή συνδέσμων', 'high'],
];
const ODF_FIELDS = [
  ['meta:initial-creator', 'Αρχικός δημιουργός', 'high'],
  ['dc:creator', 'Τελευταία αλλαγή από', 'high'],
  ['meta:printed-by', 'Εκτυπώθηκε από', 'high'],
  ['meta:creation-date', 'Ημερομηνία δημιουργίας', 'normal', 'date'],
  ['dc:date', 'Ημερομηνία αλλαγής', 'normal', 'date'],
  ['meta:print-date', 'Τελευταία εκτύπωση', 'normal', 'date'],
  ['meta:editing-duration', 'Συνολικός χρόνος επεξεργασίας', 'normal', 'duration'],
  ['meta:editing-cycles', 'Αριθμός αποθηκεύσεων'],
  ['meta:generator', 'Πρόγραμμα'],
  ['dc:title', 'Τίτλος'],
  ['dc:subject', 'Θέμα'],
  ['meta:keyword', 'Λέξεις-κλειδιά'],
  ['dc:description', 'Σχόλια εγγράφου'],
];

function tag(xml, qname) {
  const m = xml.match(new RegExp(`<${qname}(?:\\s[^>]*)?>([\\s\\S]*?)</${qname}>`));
  if (!m) return null;
  return xmlUnescape(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || null;
}
function attr(s, name) {
  const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? xmlUnescape(m[1]) : null;
}
function formatDuration(v) {
  const m = String(v).match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return v;
  const h = Number(m[1] || 0) * 24 + Number(m[2] || 0);
  const min = Number(m[3] || 0);
  if (!h && !min) return null;
  return h ? `${h} ώρ. ${min} λεπ.` : `${min} λεπ.`;
}
function fieldFindings(xml, fields) {
  const out = [];
  for (const [q, label, level = 'normal', kind] of fields) {
    let v = tag(xml, q);
    if (!v) continue;
    if (kind === 'date') v = prettyDate(v);
    if (kind === 'duration') v = formatDuration(v);
    if (v) out.push(finding(label, v, level));
  }
  return out;
}

// Consistent pseudonyms: every distinct person becomes "Author 1", "Author 2", ...
class Pseudonyms {
  constructor() {
    this.map = new Map();
  }
  add(raw) {
    const v = xmlUnescape(raw).trim();
    if (v && !/^Author( \d+)?$/.test(v) && !this.map.has(v)) this.map.set(v, null);
  }
  finalize() {
    let i = 1;
    for (const k of this.map.keys()) this.map.set(k, this.map.size === 1 ? 'Author' : `Author ${i++}`);
  }
  get(raw) {
    const v = xmlUnescape(raw).trim();
    return this.map.get(v) || (v ? 'Author' : '');
  }
  initials(raw) {
    const n = this.get(raw);
    return n ? 'A' + n.replace(/\D/g, '') : '';
  }
  get names() {
    return [...this.map.keys()];
  }
}

// ---------- package helpers ----------

const files = (zip) => Object.keys(zip.files).filter((p) => !zip.files[p].dir);
const read = async (zip, p) => (zip.file(p) ? zip.file(p).async('string') : null);

function relsPathFor(part) {
  const i = part.lastIndexOf('/');
  return part.slice(0, i + 1) + '_rels/' + part.slice(i + 1) + '.rels';
}
function sourceOfRels(relsPath) {
  const m = relsPath.match(/^(.*?)_rels\/(.*)\.rels$/);
  return m ? m[1] + m[2] : null;
}
function resolveTarget(source, target) {
  if (target.startsWith('/')) return target.slice(1);
  const base = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : '';
  const out = [];
  for (const seg of (base + target).split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}
function parseRels(xml) {
  const rels = [];
  for (const m of (xml || '').matchAll(/<Relationship\b[^>]*?(?:\/>|>\s*<\/Relationship>)/g)) {
    rels.push({
      full: m[0],
      id: attr(m[0], 'Id'),
      type: attr(m[0], 'Type') || '',
      target: attr(m[0], 'Target') || '',
      external: /TargetMode="External"/i.test(m[0]),
    });
  }
  return rels;
}

async function removePart(zip, part) {
  zip.remove(part);
  zip.remove(relsPathFor(part));
  const dangling = [];
  for (const p of files(zip)) {
    if (!p.endsWith('.rels')) continue;
    const src = sourceOfRels(p);
    if (src == null) continue;
    let xml = await read(zip, p);
    let changed = false;
    for (const r of parseRels(xml)) {
      if (!r.external && resolveTarget(src, r.target).toLowerCase() === part.toLowerCase()) {
        xml = xml.replace(r.full, '');
        changed = true;
        dangling.push([src, r.id]);
      }
    }
    if (changed) zip.file(p, xml);
  }
  const ct = await read(zip, '[Content_Types].xml');
  if (ct) {
    const esc = ('/' + part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    zip.file('[Content_Types].xml', ct.replace(new RegExp(`<Override\\b[^>]*PartName="${esc}"[^>]*/>`, 'gi'), ''));
  }
  for (const [src, id] of dangling) {
    let xml = await read(zip, src);
    if (!xml) continue;
    xml = xml
      .replace(new RegExp(`(<[\\w:]*pageSetup\\b[^>]*?)\\s+r:id="${id}"`, 'g'), '$1')
      .replace(new RegExp(`<[\\w:]+\\s+r:id="${id}"\\s*/>`, 'g'), '');
    zip.file(src, xml);
  }
}

async function cleanPictures(zip, re, findings) {
  let count = 0;
  for (const p of files(zip)) {
    if (!re.test(p)) continue;
    const data = await zip.file(p).async('uint8array');
    let r = null;
    try {
      if (isJpeg(data)) r = cleanJpegBytes(data);
      else if (isPng(data)) r = await cleanPngBytes(data);
    } catch {
      r = null;
    }
    if (r && r.findings.length) {
      count++;
      findings.push(...r.findings.map((f) => ({ ...f, label: 'Φωτογραφία μέσα στο έγγραφο: ' + f.label })));
      zip.file(p, r.bytes);
    }
  }
  return count;
}

function resetZipEntries(zip) {
  zip.comment = null;
  zip.forEach((_, f) => {
    f.date = FIXED_DATE;
    f.comment = null;
    f.unixPermissions = null;
    f.dosPermissions = null;
  });
}

// ---------- entry point ----------

export async function cleanZipDocument(file) {
  const JSZip = await needJSZip();
  let zip;
  try {
    zip = await JSZip.loadAsync(await readBytes(file));
  } catch {
    throw new UserError('Δεν μπόρεσα να ανοίξω αυτό το αρχείο. Ίσως είναι κατεστραμμένο ή κλειδωμένο.');
  }
  if (zip.file('[Content_Types].xml')) return cleanOoxml(zip, file);
  const mt = zip.file('mimetype');
  if (mt) {
    const type = (await mt.async('string')).trim();
    if (type.startsWith('application/vnd.oasis.opendocument')) return cleanOdf(zip, file, type, JSZip);
  }
  return null;
}

async function cleanOoxml(zip, file) {
  const findings = [];
  const warnings = [];
  const rootRels = parseRels(await read(zip, '_rels/.rels'));
  const target = (suffix, fallback) => {
    const r = rootRels.find((x) => x.type.endsWith(suffix) && !x.external);
    const p = r ? resolveTarget('', r.target) : fallback;
    return p && zip.file(p) ? p : null;
  };

  const core = target('/metadata/core-properties', 'docProps/core.xml');
  if (core) {
    findings.push(...fieldFindings(await read(zip, core), CORE_FIELDS));
    zip.file(core, MIN_CORE);
  }
  const app = target('/extended-properties', 'docProps/app.xml');
  if (app) {
    const xml = await read(zip, app);
    findings.push(...fieldFindings(xml, APP_FIELDS));
    const appName = tag(xml, 'Application');
    if (appName) findings.push(finding('Πρόγραμμα', [appName, tag(xml, 'AppVersion')].filter(Boolean).join(' ')));
    const minutes = Number(tag(xml, 'TotalTime') || 0);
    if (minutes > 0) findings.push(finding('Συνολικός χρόνος επεξεργασίας', formatDuration(`PT${minutes}M`)));
    zip.file(app, MIN_APP);
  }
  const custom = target('/custom-properties', 'docProps/custom.xml');
  if (custom) {
    const xml = await read(zip, custom);
    let label = false;
    for (const m of xml.matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property>/g)) {
      const name = attr(m[1], 'name') || '';
      if (/^MSIP_Label/i.test(name)) label = true;
      else if (name === 'ContentTypeId') findings.push(finding('Δεδομένα SharePoint'));
      else findings.push(finding(`Προσαρμοσμένο πεδίο «${name}»`, xmlUnescape(m[2].replace(/<[^>]+>/g, '')).trim()));
    }
    if (label) findings.push(finding('Ετικέτα ευαισθησίας οργανισμού', null, 'high'));
    await removePart(zip, custom);
  }
  const thumb = target('/metadata/thumbnail', null);
  if (thumb) {
    findings.push(finding('Μικρογραφία προεπισκόπησης (μπορεί να δείχνει παλιότερη έκδοση)'));
    await removePart(zip, thumb);
  }

  let printers = 0;
  for (const p of files(zip)) {
    if (/^docMetadata\/LabelInfo\.xml$/i.test(p)) {
      findings.push(finding('Ετικέτα ευαισθησίας οργανισμού', null, 'high'));
      await removePart(zip, p);
    } else if (/printerSettings\d*\.bin$/i.test(p)) {
      printers++;
      await removePart(zip, p);
    } else if (p === 'ppt/revisionInfo.xml') {
      findings.push(finding('Ιστορικό αναθεωρήσεων'));
      await removePart(zip, p);
    }
  }
  if (printers) findings.push(finding('Ρυθμίσεις και όνομα εκτυπωτή'));

  // Word: path of the template on the author's computer (often contains their user name).
  const settingsRels = 'word/_rels/settings.xml.rels';
  const srXml = await read(zip, settingsRels);
  if (srXml) {
    let xml = srXml;
    for (const r of parseRels(srXml)) {
      if (r.type.endsWith('/attachedTemplate')) {
        findings.push(finding('Διαδρομή προτύπου στον υπολογιστή', decodeURIComponent(r.target.replace(/^file:\/\/\/?/, '')), 'high'));
        xml = xml.replace(r.full, '');
      }
    }
    if (xml !== srXml) zip.file(settingsRels, xml);
  }

  const pictures = await cleanPictures(zip, /^(word|xl|ppt)\/media\/[^/]+$/i, findings);
  if (files(zip).some((p) => /^(word|xl|ppt)\/embeddings\/.+\.(docx|xlsx|pptx|xlsm|docm|bin)$/i.test(p))) {
    warnings.push('Το έγγραφο περιέχει ενσωματωμένα αρχεία (π.χ. πίνακα Excel). Αυτά δεν καθαρίστηκαν.');
  }

  // Load every XML part once, collect people's names, then rewrite.
  const parts = new Map();
  for (const p of files(zip)) if (/^(word|xl|ppt)\/.*\.xml$/i.test(p)) parts.set(p, await read(zip, p));
  const people = new Pseudonyms();
  for (const xml of parts.values()) {
    for (const m of xml.matchAll(/\b(?:w:author|w15:author)="([^"]*)"/g)) people.add(m[1]);
    for (const m of xml.matchAll(/<author>([^<]*)<\/author>/g)) people.add(m[1]);
    for (const m of xml.matchAll(/<person\b[^>]*\bdisplayName="([^"]*)"/g)) people.add(m[1]);
    for (const m of xml.matchAll(/<(?:p:cmAuthor|p188:author)\b[^>]*\bname="([^"]*)"/g)) people.add(m[1]);
  }
  people.finalize();

  let tracked = false;
  let comments = false;
  let notes = false;
  let hiddenSheets = false;
  let hiddenSlides = 0;
  const personTag = (t, nameAttr) => {
    const name = attr(t, nameAttr) || '';
    const alias = people.get(name);
    return t
      .replace(new RegExp(`\\b${nameAttr}="[^"]*"`), `${nameAttr}="${alias}"`)
      .replace(/\binitials="[^"]*"/, `initials="${people.initials(name)}"`)
      .replace(/\buserId="[^"]*"/, `userId="${alias}"`)
      .replace(/\bproviderId="[^"]*"/, 'providerId="None"');
  };

  for (const [p, original] of parts) {
    let xml = original;
    if (p.startsWith('word/')) {
      xml = xml
        .replace(/\s+w:rsid[A-Za-z]*="[^"]*"/g, '')
        .replace(/\b(w:author|w15:author)="([^"]*)"/g, (_, a, v) => `${a}="${people.get(v)}"`)
        .replace(/\bw:initials="([^"]*)"/g, (_, v) => `w:initials="${people.initials(v)}"`)
        .replace(/\s+(?:w:date|w16du:dateUtc)="[^"]*"/g, '')
        .replace(/<w15:presenceInfo\b[^>]*\/>/g, '');
      if (p === 'word/settings.xml') {
        xml = xml
          .replace(/<w:rsids>[\s\S]*?<\/w:rsids>/g, '')
          .replace(/<w1[45]:docId\b[^>]*\/>/g, '')
          .replace(/<w:attachedTemplate\b[^>]*\/>/g, '');
      }
      if (p === 'word/document.xml' && /<w:(ins|del|moveFrom|moveTo)\b/.test(original)) tracked = true;
      if (p === 'word/comments.xml' && /<w:comment\b/.test(original)) comments = true;
    } else if (p.startsWith('xl/')) {
      xml = xml.replace(/\s+xr\d*:uid="\{[^"]*\}"/g, '');
      if (p === 'xl/workbook.xml') {
        const abs = original.match(/<x15ac:absPath\b[^>]*\burl="([^"]*)"/);
        if (abs) findings.push(finding('Διαδρομή αρχείου στον υπολογιστή', xmlUnescape(abs[1]), 'high'));
        xml = xml
          .replace(/<mc:AlternateContent\b[^>]*>(?:(?!<\/mc:AlternateContent>)[\s\S])*?x15ac:absPath[\s\S]*?<\/mc:AlternateContent>/g, '')
          .replace(/<x15ac:absPath\b[^>]*\/>/g, '')
          .replace(/<xr:revisionPtr\b[^>]*\/>/g, '');
        if (/<sheet\b[^>]*\bstate="(hidden|veryHidden)"/.test(original)) hiddenSheets = true;
      }
      if (/^xl\/comments(\d*\.xml$|\/)/i.test(p)) {
        xml = xml.replace(/<author>([^<]*)<\/author>/g, (_, v) => `<author>${people.get(v)}</author>`);
        if (/<comment\b/.test(original)) comments = true;
      }
      if (/^xl\/threadedComments\//i.test(p)) comments = true;
      if (/^xl\/persons\//i.test(p)) xml = xml.replace(/<person\b[^>]*>/g, (t) => personTag(t, 'displayName'));
    } else if (p.startsWith('ppt/')) {
      if (p === 'ppt/commentAuthors.xml' || p === 'ppt/authors.xml') {
        xml = xml.replace(/<(?:p:cmAuthor|p188:author)\b[^>]*>/g, (t) => personTag(t, 'name'));
      }
      if (/^ppt\/comments\//i.test(p) && /<p(?:188)?:cm\b/.test(original)) comments = true;
      if (/^ppt\/notesSlides\//i.test(p) && /<a:t>[^<]*\S[^<]*<\/a:t>/.test(original.replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, ''))) notes = true;
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(p) && /<p:sld\b[^>]*\bshow="0"/.test(original)) hiddenSlides++;
    }
    if (xml !== original) zip.file(p, xml);
  }

  if (people.names.length) findings.push(finding('Ονόματα σε σχόλια / αλλαγές', people.names.join(', '), 'high'));
  if (tracked) warnings.push('Το έγγραφο έχει «παρακολούθηση αλλαγών». Τα ονόματα αφαιρέθηκαν, αλλά οι διαγραμμένες/προσθεμένες φράσεις φαίνονται ακόμα. Αποδέξου ή απόρριψε τις αλλαγές πριν το στείλεις.');
  if (comments) warnings.push('Το έγγραφο έχει σχόλια. Τα ονόματα αφαιρέθηκαν, το κείμενο των σχολίων έμεινε.');
  if (notes) warnings.push('Η παρουσίαση έχει σημειώσεις ομιλητή, που τις βλέπει όποιος ανοίξει το αρχείο.');
  if (hiddenSheets) warnings.push('Το αρχείο έχει κρυφά φύλλα. Το περιεχόμενό τους φαίνεται σε όποιον τα εμφανίσει.');
  if (hiddenSlides) warnings.push(`Η παρουσίαση έχει ${hiddenSlides} κρυφές διαφάνειες.`);
  if (pictures === 0 && findings.length === 0) {
    // nothing found, still normalised
  }

  resetZipEntries(zip);
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  return { blob: new Blob([out], { type: file.type || 'application/octet-stream' }), findings, warnings };
}

async function cleanOdf(zip, file, mimetype, JSZip) {
  const findings = [];
  const warnings = [];

  const meta = await read(zip, 'meta.xml');
  if (meta) {
    findings.push(...fieldFindings(meta, ODF_FIELDS));
    for (const m of meta.matchAll(/<meta:user-defined\b([^>]*)>([^<]*)</g)) {
      findings.push(finding(`Προσαρμοσμένο πεδίο «${attr(m[1], 'meta:name') || ''}»`, xmlUnescape(m[2])));
    }
    const tpl = meta.match(/<meta:template\b[^>]*xlink:href="([^"]*)"/);
    if (tpl && tpl[1].trim()) findings.push(finding('Διαδρομή προτύπου', xmlUnescape(tpl[1]), /[\\/]/.test(tpl[1]) ? 'high' : 'normal'));
    zip.file('meta.xml', minMeta(attr(meta, 'office:version') || '1.2'));
  }

  const settings = await read(zip, 'settings.xml');
  if (settings) {
    const printer = settings.match(/<config:config-item config:name="PrinterName"[^>]*>([^<]*)</);
    if (printer && printer[1].trim()) findings.push(finding('Όνομα εκτυπωτή', xmlUnescape(printer[1])));
    const cleaned = settings.replace(/<config:config-item config:name="(?:PrinterName|PrinterSetup)"[^>]*>[^<]*<\/config:config-item>/g, '');
    if (cleaned !== settings) zip.file('settings.xml', cleaned);
  }

  const thumbs = files(zip).filter((p) => p.startsWith('Thumbnails/'));
  if (thumbs.length) {
    findings.push(finding('Μικρογραφία προεπισκόπησης (μπορεί να δείχνει παλιότερη έκδοση)'));
    for (const p of thumbs) zip.remove(p);
    zip.remove('Thumbnails');
    const manifest = await read(zip, 'META-INF/manifest.xml');
    if (manifest) zip.file('META-INF/manifest.xml', manifest.replace(/<manifest:file-entry\b[^>]*manifest:full-path="Thumbnails\/[^"]*"[^>]*\/>/g, ''));
  }

  await cleanPictures(zip, /^Pictures\/[^/]+$/i, findings);
  if (files(zip).some((p) => /^Object \d+\//.test(p))) warnings.push('Το έγγραφο περιέχει ενσωματωμένα αντικείμενα. Αυτά δεν καθαρίστηκαν.');

  const people = new Pseudonyms();
  const parts = new Map();
  for (const p of ['content.xml', 'styles.xml']) {
    const xml = await read(zip, p);
    if (!xml) continue;
    parts.set(p, xml);
    for (const m of xml.matchAll(/<dc:creator>([^<]*)<\/dc:creator>/g)) people.add(m[1]);
  }
  people.finalize();
  let tracked = false;
  let comments = false;
  for (const [p, original] of parts) {
    const xml = original
      .replace(/<dc:creator>([^<]*)<\/dc:creator>/g, (_, v) => `<dc:creator>${people.get(v)}</dc:creator>`)
      .replace(/<dc:date>[^<]*<\/dc:date>/g, '<dc:date>2000-01-01T00:00:00</dc:date>')
      .replace(/<(meta:creator-initials|loext:sender-initials)>([^<]*)<\/\1>/g, (_, t, v) => `<${t}>A</${t}>`);
    if (/<text:changed-region\b/.test(original)) tracked = true;
    if (/<office:annotation\b/.test(original)) comments = true;
    if (xml !== original) zip.file(p, xml);
  }
  if (people.names.length) findings.push(finding('Ονόματα σε σχόλια / αλλαγές', people.names.join(', '), 'high'));
  if (tracked) warnings.push('Το έγγραφο έχει καταγραφή αλλαγών. Τα ονόματα αφαιρέθηκαν, αλλά οι αλλαγές φαίνονται ακόμα. Αποδέξου ή απόρριψέ τες πριν το στείλεις.');
  if (comments) warnings.push('Το έγγραφο έχει σχόλια. Τα ονόματα αφαιρέθηκαν, το κείμενο των σχολίων έμεινε.');

  // ODF requires "mimetype" to be the first entry and stored uncompressed: rebuild the archive in order.
  const outZip = new JSZip();
  outZip.file('mimetype', mimetype, { compression: 'STORE', date: FIXED_DATE });
  for (const p of files(zip)) {
    if (p === 'mimetype') continue;
    outZip.file(p, await zip.file(p).async('uint8array'), { date: FIXED_DATE });
  }
  resetZipEntries(outZip);
  const out = await outZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  return { blob: new Blob([out], { type: file.type || mimetype }), findings, warnings };
}
