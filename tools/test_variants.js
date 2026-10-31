/* Runs the engine against sheets that are NOT the default 90-question one:
 * different question counts, option counts, column layouts and field sets. */
const fs = require('fs');
const path = require('path');
const E = require('../omr-engine.js');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'samples/variants');

if (!fs.existsSync(DIR)) {
  console.error('Run  python3 tools/make_variants.py  first.');
  process.exit(2);
}

let pass = 0, fail = 0;

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.truth.json')).sort()) {
  const name = file.replace('.truth.json', '');
  const truth = JSON.parse(fs.readFileSync(path.join(DIR, name + '.truth.json'), 'utf8'));
  const tpl = JSON.parse(fs.readFileSync(path.join(DIR, name + '.template.json'), 'utf8'));
  const [w, h] = truth.size;
  const raw = fs.readFileSync(path.join(DIR, name + '.raw'));
  const gray = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);

  const res = E.readSheet(gray, w, h, tpl);
  if (!res.ok) { console.log(`FAIL ${name}: ${res.reason}`); fail++; continue; }

  const problems = [];

  // the template's shape must be honoured exactly
  if (res.answers.length !== truth.count) problems.push(`read ${res.answers.length} questions, sheet has ${truth.count}`);

  if ((res.fields.roll || '') !== truth.roll) problems.push(`roll ${res.fields.roll} != ${truth.roll}`);
  // only compare the fields this template actually declares
  const declared = (tpl.fields || []).map((f) => f.key);
  if (declared.includes('class') && (res.fields.class || '') !== truth.class) {
    problems.push(`class ${res.fields.class} != ${truth.class}`);
  }
  if (declared.includes('section') && (res.fields.section || '') !== truth.section) {
    problems.push(`section ${res.fields.section} != ${truth.section}`);
  }

  let ok = 0;
  for (const [q, opts] of Object.entries(truth.answers)) {
    const a = res.answers[Number(q)];
    if (opts.length > 1) {
      if (a.status === 'multi') ok++;
      else problems.push(`Q${Number(q) + 1} expected multi, got ${a.status}`);
    } else if (a.status === 'ok' && a.choice === opts[0]) ok++;
    else problems.push(`Q${Number(q) + 1} expected ${opts[0]}, got ${a.status}/${a.choice}`);
  }
  for (const q of truth.blank) {
    if (res.answers[q].status !== 'blank') problems.push(`Q${q + 1} expected blank, got ${res.answers[q].status}`);
  }

  const good = problems.length === 0;
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'} ${name.padEnd(11)} ` +
    `${truth.count} questions · ${truth.options} options · ${tpl.questions.columns} column(s)` +
    ` · fields: ${(tpl.fields || []).map((f) => f.key).join('+') || 'none'}` +
    `  →  roll=${res.fields.roll} class=${res.fields.class || '-'} sec=${res.fields.section || '-'}` +
    `  answers ${ok}/${Object.keys(truth.answers).length + truth.blank.length}`);
  if (problems.length) console.log('     ' + problems.slice(0, 6).join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
