// End-to-end check in a real browser: pick files, wait for cleaning, download results, test the share-target path.
// Usage: node tests/e2e.cjs [baseUrl]   (serve the repo first: npm run serve)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8080/';
const FX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'e2e-out');
const SHOTS = path.join(__dirname, 'screens');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  let failures = 0;
  const check = (ok, msg) => {
    console.log(`${ok ? '✓' : '✗'} ${msg}`);
    if (!ok) failures++;
  };

  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: scheme, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(BASE);
    await page.screenshot({ path: `${SHOTS}/1-start-${scheme}.png`, fullPage: true });

    const files = ['IMG_20261120_143205.jpg', 'CV_final.docx', 'IMG_4522.MOV', 'report.pdf'].map((f) => path.join(FX, f));
    await page.setInputFiles('#picker', files);
    await page.waitForFunction(() => document.querySelectorAll('.card .badge-busy').length === 0 && document.querySelectorAll('.card').length === 4, null, { timeout: 30000 });
    const statuses = await page.$$eval('.card', (cards) => cards.map((c) => [c.querySelector('.name').textContent, c.querySelector('.badge').textContent.trim()]));
    check(statuses.every(([, s]) => s === 'Καθαρό'), `${scheme}: all 4 cards show "Καθαρό" (${statuses.map((s) => s.join(' → ')).join(', ')})`);
    const renamed = statuses.find(([n]) => n.startsWith('photo-'));
    check(!!renamed, `${scheme}: camera-style name was replaced (${renamed?.[0]})`);
    check(errors.length === 0, `${scheme}: no console errors ${errors.join(' | ')}`);
    await page.screenshot({ path: `${SHOTS}/2-results-${scheme}.png`, fullPage: true });

    if (scheme === 'light') {
      // Download every cleaned file through the real "Αποθήκευση" buttons.
      for (const btn of await page.$$('[data-action="save"]')) {
        const [dl] = await Promise.all([page.waitForEvent('download'), btn.click()]);
        await dl.saveAs(path.join(OUT, dl.suggestedFilename()));
      }
      const [zip] = await Promise.all([page.waitForEvent('download'), page.click('#save-all')]);
      await zip.saveAs(path.join(OUT, zip.suggestedFilename()));
      check(fs.readdirSync(OUT).length === 5, `downloads saved: ${fs.readdirSync(OUT).join(', ')}`);

      // Expand a card and screenshot the details.
      await page.click('.more summary');
      await page.screenshot({ path: `${SHOTS}/3-details-${scheme}.png`, fullPage: true });

      // Share-target path: POST files to the service worker like Android does, then open ?shared=1.
      await page.goto(BASE);
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload();
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      const status = await page.evaluate(async () => {
        const fd = new FormData();
        const bytes = await (await fetch('tests/fixtures/photo.webp')).blob();
        fd.append('files', new File([bytes], 'PXL_20261120_150000.webp', { type: 'image/webp' }));
        const r = await fetch('./share-target', { method: 'POST', body: fd, redirect: 'manual' });
        return r.type === 'opaqueredirect' ? 303 : r.status;
      });
      check(status === 303, `share-target POST answered with redirect (${status})`);
      await page.goto(BASE + '?shared=1');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 1 && !document.querySelector('.badge-busy'), null, { timeout: 15000 });
      const shared = await page.$eval('.card', (c) => c.querySelector('.badge').textContent.trim() + ' / ' + c.querySelector('.summary').textContent.trim());
      check(shared.startsWith('Καθαρό'), `shared file cleaned: ${shared}`);

      // Offline: reload with the network cut off.
      await ctx.setOffline(true);
      await page.reload();
      const offlineOk = await page.isVisible('#pick');
      check(offlineOk, 'app loads offline from the service worker cache');
      await page.setInputFiles('#picker', [path.join(FX, 'scan.pdf'), path.join(FX, 'deck.pptx')]);
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 2 && !document.querySelector('.badge-busy'), null, { timeout: 30000 });
      const off = await page.$$eval('.card .badge', (b) => b.map((x) => x.textContent.trim()));
      check(off.every((s) => s === 'Καθαρό'), `offline cleaning of PDF + PowerPoint works (${off.join(', ')})`);
      await ctx.setOffline(false);
    }
    await ctx.close();
  }

  // Desktop layout.
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const dp = await desk.newPage();
  await dp.goto(BASE);
  await dp.screenshot({ path: `${SHOTS}/4-desktop-start.png` });
  const asBuffer = (name, mimeType) => ({ name, mimeType, buffer: fs.readFileSync(path.join(FX, name)) });
  await dp.setInputFiles('#picker', [
    asBuffer('Screenshot_2026-11-20-14-32-05.png', 'image/png'),
    asBuffer('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello\n') },
    { name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 1, 2, 3]) },
  ]);
  await dp.waitForFunction(() => !document.querySelector('.badge-busy') && document.querySelectorAll('.card').length === 4, null, { timeout: 30000 });
  const badges = await dp.$$eval('.card', (cs) => cs.map((c) => c.querySelector('.name').textContent + ':' + c.querySelector('.badge').textContent.trim()));
  check(badges.includes('setup.exe:Δεν υποστηρίζεται') && badges.includes('notes.txt:Καθαρό'), `unsupported and text files handled (${badges.join(', ')})`);
  const unsupportedButtons = await dp.$$eval('.card', (cs) => cs.filter((c) => c.querySelector('.badge-warn')).reduce((n, c) => n + c.querySelectorAll('[data-action]').length, 0));
  check(unsupportedButtons === 0, 'no save/share button on unsupported files');
  await dp.screenshot({ path: `${SHOTS}/5-desktop-results.png`, fullPage: true });
  await desk.close();

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nE2E OK');
  process.exit(failures ? 1 : 0);
})();
