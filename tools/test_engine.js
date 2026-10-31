/* Node test harness: runs the engine on the synthetic photos and compares
 * against the ground truth written by tools/generate_sheet.py */
const fs = require('fs');
const path = require('path');
const E = require('../omr-engine.js');

const ROOT = path.join(__dirname, '..');
const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/default-a4-90q.json'), 'utf8'));
const key = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/answer-key.json'), 'utf8')).answers;

let pass = 0, fail = 0;

const missing = ['demo-1', 'demo-2', 'demo-3', 'demo-4', 'demo-5']
  .filter((n) => !fs.existsSync(path.join(ROOT, `samples/${n}.raw`)));
if (missing.length) {
  console.error('Missing test fixtures:', missing.join(', '));
  console.error('Run  python3 tools/generate_sheet.py  first.');
  process.exit(2);
}

for (const name of ['demo-1', 'demo-2', 'demo-3', 'demo-4', 'demo-5']) {
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, `samples/${name}.truth.json`), 'utf8'));
  const [w, h] = truth.size;
  const raw = fs.readFileSync(path.join(ROOT, `samples/${name}.raw`));
  const gray = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);

  const t0 = Date.now();
  const res = E.readSheet(gray, w, h, tpl);
  const dt = Date.now() - t0;

  if (!res.ok) { console.log(`FAIL ${name}: ${res.reason}`); fail++; continue; }

  const expectedRoll = truth.roll;
  const rollOk = res.roll === expectedRoll;
  const classOk = (res.fields.class || '') === (truth.class || '');
  const sectionOk = (res.fields.section || '') === (truth.section || '');

  let qOk = 0, qBad = [];
  for (const [q, opts] of Object.entries(truth.answers)) {
    const a = res.answers[Number(q)];
    if (opts.length > 1) {
      if (a.status === 'multi') qOk++;
      else qBad.push(`Q${Number(q) + 1} expected multi got ${a.status}`);
    } else {
      if (a.status === 'ok' && a.choice === opts[0]) qOk++;
      else qBad.push(`Q${Number(q) + 1} expected ${opts[0]} got ${a.status}/${a.choice}`);
    }
  }
  const blanksOk = truth.blank.every(q => res.answers[q].status === 'blank');
  const total = Object.keys(truth.answers).length + truth.blank.length;

  const s = E.scoreSheet(res, key);
  const ok = rollOk && classOk && sectionOk && qBad.length === 0 && blanksOk;
  ok ? pass++ : fail++;

  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}  ${dt}ms  roll=${res.roll}${rollOk ? '' : ' (exp ' + expectedRoll + ')'}` +
    `  class=${res.fields.class}${classOk ? '' : ' (exp ' + truth.class + ')'}` +
    `  section=${res.fields.section}${sectionOk ? '' : ' (exp ' + truth.section + ')'}` +
    `  questions=${qOk}/${total}  blanks=${blanksOk ? 'ok' : 'BAD'}` +
    `  score=${s.correct}/${s.scored} multi=${s.multi} blank=${s.blank}`);
  if (qBad.length) console.log('   mismatches:', qBad.slice(0, 8).join(' | '));
  if (res.rollFlags.length) console.log('   roll flags at digits', res.rollFlags.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
