/* Headless UI smoke test: serve the repo, load the app, run the sample sheets,
 * check the table, the review dialog and the CSV export. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;

  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(base, { waitUntil: 'networkidle0' });

  const results = [];
  const check = (name, cond, extra) => {
    results.push({ name, ok: !!cond, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  };

  // --- answer key via text entry
  await page.type('#keyText', 'ABCD'.repeat(23).slice(0, 90));
  await page.click('#keyApply');
  const keyLen = await page.evaluate(() => state.key.length);
  check('answer key parsed from text', keyLen === 90, `got ${keyLen}`);

  // --- load the sample photos
  await page.evaluate(() => showView('scan'));
  await page.click('#loadDemo');
  await page.waitForFunction(() => document.querySelector('#countPill').textContent === '5', { timeout: 60000 });
  check('five sample sheets scanned', true);

  const rows = await page.evaluate(() => state.rows.map((r) => ({
    roll: r.fields.roll, cls: r.fields.class, sec: r.fields.section,
    correct: r.score.correct, multi: r.score.multi, blank: r.score.blank,
    scored: r.score.scored, needs: r.answers.some((a) => a.status === 'multi'),
    hasFile: !!r.file, ms: r.ms
  })));
  console.log('    rows:', JSON.stringify(rows));

  check('roll numbers read correctly',
    rows.map((r) => r.roll).join(',') === '12345,20267,98765,45678,31415',
    rows.map((r) => r.roll).join(','));
  check('class bubbles read correctly',
    rows.map((r) => r.cls).join(',') === '08,08,09,10,07',
    rows.map((r) => r.cls).join(','));
  check('section bubbles read correctly',
    rows.map((r) => r.sec).join(',') === 'A,A,B,C,D',
    rows.map((r) => r.sec).join(','));
  check('clean sheet scores 90/90', rows[0].correct === 90 && rows[0].scored === 90);
  check('double marks are flagged not guessed', rows[1].multi === 2 && rows[2].multi === 1);
  check('blank questions counted', rows[1].blank === 2);
  check('photos dropped for clean sheets', rows[0].hasFile === false);
  check('photos kept for flagged sheets', rows[1].hasFile === true);

  // --- results table
  await page.evaluate(() => showView('results'));
  const cellCount = await page.evaluate(() => document.querySelectorAll('#resultTable tbody tr').length);
  check('results table has 5 rows', cellCount === 5, `got ${cellCount}`);

  const perQ = await page.evaluate(() => document.querySelectorAll('#resultTable thead th').length);
  check('table has per-question columns', perQ === 101, `got ${perQ} headers`);

  // --- review dialog
  await page.evaluate(() => openReview(state.rows[1]));
  await new Promise((r) => setTimeout(r, 800));
  const reviewInfo = await page.evaluate(() => ({
    open: !document.querySelector('#reviewModal').classList.contains('hidden'),
    cards: document.querySelectorAll('#reviewBody .rvitem').length,
    crops: document.querySelectorAll('#reviewBody canvas').length
  }));
  check('review dialog opens with flagged questions',
    reviewInfo.open && reviewInfo.cards === 2, JSON.stringify(reviewInfo));
  check('review shows a crop of the actual bubbles', reviewInfo.crops >= 2, `${reviewInfo.crops} crops`);

  // override one flagged question, check the score moves
  const before = await page.evaluate(() => state.rows[1].score.correct);
  await page.evaluate(() => {
    const btn = document.querySelector('#reviewBody .rvitem .optrow button');
    if (btn) btn.click();
  });
  const after = await page.evaluate(() => ({
    correct: state.rows[1].score.correct,
    overrides: Object.keys(state.rows[1].overrides).length
  }));
  check('manual override recomputes the score',
    after.overrides === 1 && after.correct >= before, `before ${before} after ${after.correct}`);
  await page.click('#reviewClose');

  // --- CSV export
  const csv = await page.evaluate(() => buildCsv());
  const lines = csv.split('\r\n');
  check('CSV has a header and 5 data rows', lines.length === 6, `${lines.length} lines`);
  check('CSV header starts with Roll No,Class,Section,Name',
    lines[0].startsWith('Roll No,Class,Section,Name,Correct'), lines[0].slice(0, 48));
  check('CSV row carries class and section', lines[1].startsWith('12345,08,A,'), lines[1].slice(0, 40));
  check('CSV first student row correct', lines[1].startsWith('12345,'), lines[1].slice(0, 60));
  const cols = lines[0].split(',').length;
  check('CSV column count matches header', lines[1].split(',').length === cols, `${lines[1].split(',').length} vs ${cols}`);

  // --- roster lookup
  await page.evaluate(() => {
    state.rosterRows = [
      { roll: '12345', name: 'Aarav Sharma', class: '8', section: 'A' },
      // same roll number in another section — the bubbles must disambiguate
      { roll: '98765', name: 'Wrong Section Kid', class: '9', section: 'C' },
      { roll: '98765', name: 'Kabir Singh', class: '9', section: 'B' }
    ];
    buildRosterIndex();
    refreshNames();
  });
  const named = await page.evaluate(() => ({
    a: state.rows[0].who && state.rows[0].who.name,
    b: state.rows[2].who && state.rows[2].who.name
  }));
  check('roster fills in the student name', named.a === 'Aarav Sharma', String(named.a));
  check('repeated roll number resolved by section bubble',
    named.b === 'Kabir Singh', String(named.b));

  // --- template tab renders
  await page.evaluate(() => showView('sheet'));
  const tplRows = await page.evaluate(() => document.querySelectorAll('#templateList .tplrow').length);
  check('template list shows the default sheet', tplRows === 1, `${tplRows}`);

  // --- install / PWA surface
  await page.evaluate(() => showView('setup'));
  const pwa = await page.evaluate(() => ({
    card: !!document.querySelector('#installCard'),
    cardVisible: !document.querySelector('#installCard').classList.contains('hidden'),
    manual: document.querySelectorAll('#installCard details .steps div').length,
    manifest: document.querySelector('link[rel=manifest]') !== null,
    iosMeta: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
    sw: navigator.serviceWorker ? (navigator.serviceWorker.controller !== null || true) : false
  }));
  check('install card is shown in Setup', pwa.card && pwa.cardVisible);
  check('install card explains the manual route', pwa.manual === 3, `${pwa.manual} steps`);
  check('manifest + iOS meta tags present', pwa.manifest && pwa.iosMeta);

  const man = await page.evaluate(async () => {
    const r = await fetch('manifest.webmanifest');
    const j = await r.json();
    return { display: j.display, icons: (j.icons || []).length, start: j.start_url };
  });
  check('manifest is installable (standalone + icons)',
    man.display === 'standalone' && man.icons >= 2, JSON.stringify(man));

  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'none';
  });
  check('service worker registers', swState === 'registered', swState);

  // --- storage footprint of the result rows
  const bytes = await page.evaluate(() => {
    const payload = state.rows.map((r) => ({
      roll: r.roll, answers: r.answers, score: r.score, overrides: r.overrides
    }));
    return JSON.stringify(payload).length;
  });
  console.log(`    result payload for 5 sheets: ${bytes} bytes (${Math.round(bytes / 5)} per sheet)`);

  check('no javascript errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
