// A PDF like a phone "scan": the photo is embedded byte-for-byte (EXIF + GPS included) and a reviewer left a note.
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

const NAME = 'Maria Papadopoulou';
const doc = await PDFDocument.create();
doc.setAuthor(NAME);
doc.setTitle('Scan');
doc.setCreator('Microsoft Word');
doc.setProducer('macOS Quartz PDFContext');
doc.setKeywords(['private']);
const jpg = await doc.embedJpg(readFileSync('tests/fixtures/IMG_20261120_143205.jpg'));
const page = doc.addPage([595, 842]);
page.drawText('Scanned document', { x: 50, y: 800 });
page.drawImage(jpg, { x: 50, y: 300, width: 400, height: 300 });
const note = doc.context.obj({
  Type: 'Annot', Subtype: 'Text', Rect: [100, 100, 120, 120],
  Contents: PDFString.of('please fix the salary'), T: PDFString.of(NAME), M: PDFString.of('D:20261120143205'),
});
page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(note)]));
writeFileSync('tests/fixtures/scan.pdf', await doc.save());
console.log('scan.pdf written');
