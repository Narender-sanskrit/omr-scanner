/* ==========================================================================
   OMR Scanner — app shell
   No framework, no build step, no network calls. Everything runs in the tab.
   ========================================================================== */
'use strict';

const E = window.OMREngine;

/* ------------------------------------------------------------------ */
/* default template (mirrors templates/default-a4-90q.json)            */
/* ------------------------------------------------------------------ */
const DEFAULT_TEMPLATE = {
  id: 'default',
  name: 'Default A4 — 90 questions × 4 options',
  version: 1,
  canvas: { w: 1000, h: 1414 },
  markers: [[70, 70], [930, 70], [930, 1344], [70, 1344]],
  markerSize: 50,
  fields: [
    { key: 'roll', label: 'ROLL NUMBER', digits: 5, labels: '0123456789', x0: 110, y0: 326, dx: 34, dy: 20, r: 7 },
    { key: 'class', label: 'CLASS', digits: 2, labels: '0123456789', x0: 315, y0: 326, dx: 34, dy: 20, r: 7 },
    { key: 'section', label: 'SECTION', digits: 1, labels: 'ABCDEFGH', x0: 430, y0: 326, dx: 34, dy: 20, r: 7 }
  ],
  questions: {
    count: 90, columns: 3, perColumn: 30, options: 4,
    x0: 130, y0: 566, dxOption: 40, dyRow: 24, dxColumn: 310, r: 7.5
  },
  optionLabels: ['A', 'B', 'C', 'D']
};

const LS = {
  key: 'omr.key.v1',
  roster: 'omr.roster.v1',
  templates: 'omr.templates.v1',
  active: 'omr.activeTemplate.v1',
  tuning: 'omr.tuning.v1'
};

const state = {
  key: [],
  keyName: '',
  rosterRows: [],      // [{roll,name,class,section}]
  rosterIndex: {},     // roll -> [row]
  templates: [],
  activeId: 'default',
  rows: [],
  tuning: { relMin: 34, multiRel: 0.55 }
};

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function save() {
  try {
    localStorage.setItem(LS.key, JSON.stringify({ name: state.keyName, answers: state.key }));
    localStorage.setItem(LS.roster, JSON.stringify(state.rosterRows));
    localStorage.setItem(LS.templates, JSON.stringify(state.templates));
    localStorage.setItem(LS.active, state.activeId);
    localStorage.setItem(LS.tuning, JSON.stringify(state.tuning));
  } catch (e) { /* private mode — fine, just not persisted */ }
}

function load() {
  try {
    const k = JSON.parse(localStorage.getItem(LS.key) || 'null');
    if (k) { state.key = k.answers || []; state.keyName = k.name || ''; }
    const rr = JSON.parse(localStorage.getItem(LS.roster) || '[]');
    state.rosterRows = Array.isArray(rr) ? rr : Object.keys(rr || {}).map((roll) => ({
      roll: roll, name: (rr[roll] || {}).name || '', class: (rr[roll] || {}).class || '', section: ''
    }));
    buildRosterIndex();
    state.templates = JSON.parse(localStorage.getItem(LS.templates) || '[]');
    state.activeId = localStorage.getItem(LS.active) || 'default';
    const t = JSON.parse(localStorage.getItem(LS.tuning) || 'null');
    if (t) state.tuning = t;
  } catch (e) { /* ignore */ }
}

function activeTemplate() {
  if (state.activeId === 'default') return DEFAULT_TEMPLATE;
  return state.templates.find((t) => t.id === state.activeId) || DEFAULT_TEMPLATE;
}

function optLabel(tpl, i) {
  return (tpl.optionLabels && tpl.optionLabels[i]) || String.fromCharCode(65 + i);
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'results') renderResults();
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) showView(b.dataset.view);
});

/* ------------------------------------------------------------------ */
/* ANSWER KEY                                                          */
/* ------------------------------------------------------------------ */
function keyLetter(i) {
  const v = state.key[i];
  if (v === undefined || v === null) return '';
  if (v < 0) return '-';
  return optLabel(activeTemplate(), v);
}

function renderKeyGrid() {
  const tpl = activeTemplate();
  const q = tpl.questions;
  const grid = $('#keyGrid');
  grid.innerHTML = '';
  const cols = q.columns;
  const per = q.perColumn;
  for (let c = 0; c < cols; c++) {
    const col = document.createElement('div');
    col.className = 'keycol';
    for (let r = 0; r < per; r++) {
      const i = c * per + r;
      if (i >= q.count) break;
      const row = document.createElement('div');
      row.className = 'krow';
      row.innerHTML = `<span>${i + 1}</span>`;
      for (let o = 0; o < q.options; o++) {
        const b = document.createElement('button');
        b.textContent = optLabel(tpl, o);
        b.className = state.key[i] === o ? 'on' : '';
        b.addEventListener('click', () => {
          state.key[i] = state.key[i] === o ? undefined : o;
          renderKeyGrid(); save();
        });
        row.appendChild(b);
      }
      col.appendChild(row);
    }
    grid.appendChild(col);
  }
  const filled = state.key.filter((v) => v !== undefined && v !== null).length;
  $('#keyProgress').textContent = `— ${filled}/${q.count} filled`;
  $('#keyName').value = state.keyName;
}

function applyKeyText(txt) {
  const tpl = activeTemplate();
  const chars = txt.toUpperCase().replace(/[^A-Z0-9\-]/g, '').split('');
  const out = [];
  for (const ch of chars) {
    if (ch === '-') { out.push(-1); continue; }
    if (/[A-Z]/.test(ch)) {
      const idx = ch.charCodeAt(0) - 65;
      if (idx < tpl.questions.options) out.push(idx);
      continue;
    }
    const d = parseInt(ch, 10);
    if (!isNaN(d)) out.push(d === 0 ? 9 : d - 1);
  }
  state.key = out;
  renderKeyGrid(); save();
  toast(`Key set: ${out.length} questions`);
}

$('#keyApply').addEventListener('click', () => applyKeyText($('#keyText').value));
$('#keyText').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyKeyText(e.target.value); });
$('#keyClear').addEventListener('click', () => { state.key = []; renderKeyGrid(); save(); });
$('#keyName').addEventListener('input', (e) => { state.keyName = e.target.value; save(); });

$('#keyExport').addEventListener('click', () => {
  download('answer-key.json', JSON.stringify({
    name: state.keyName || 'Answer key',
    template: activeTemplate().id,
    answers: state.key
  }, null, 2), 'application/json');
});

$('#keyImport').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    state.key = obj.answers || obj.key || [];
    state.keyName = obj.name || f.name;
    renderKeyGrid(); save();
    toast('Answer key loaded');
  } catch (err) { toast('Could not read that JSON file'); }
  e.target.value = '';
});

/* ------------------------------------------------------------------ */
/* ROSTER                                                              */
/* ------------------------------------------------------------------ */
function parseRoster(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l) => l.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));

  // work out the columns from the header, if there is one
  const head = split(lines[0]).map((h) => h.toLowerCase());
  let map = { roll: 0, name: 1, class: 2, section: 3 };
  let start = 0;
  if (head.some((h) => /roll|name|class|section/.test(h))) {
    start = 1;
    map = {
      roll: head.findIndex((h) => /roll|enrol|enroll|^id$/.test(h)),
      name: head.findIndex((h) => /name|student/.test(h)),
      class: head.findIndex((h) => /class|grade|std|standard/.test(h)),
      section: head.findIndex((h) => /sec/.test(h))
    };
    if (map.roll < 0) map.roll = 0;
  }

  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const p = split(lines[i]);
    const roll = (p[map.roll] || '').replace(/\s+/g, '');
    if (!roll) continue;
    rows.push({
      roll: roll,
      name: map.name >= 0 ? (p[map.name] || '') : '',
      class: map.class >= 0 ? (p[map.class] || '') : '',
      section: map.section >= 0 ? (p[map.section] || '') : ''
    });
  }
  return rows;
}

function buildRosterIndex() {
  state.rosterIndex = {};
  for (const r of state.rosterRows) {
    (state.rosterIndex[r.roll] = state.rosterIndex[r.roll] || []).push(r);
  }
}

const normKey = (v) => String(v === null || v === undefined ? '' : v)
  .trim().replace(/^0+(?=\d)/, '').toUpperCase();

// Roll numbers often repeat across sections, so disambiguate with class+section.
function lookupRoster(roll, cls, sec) {
  const cands = state.rosterIndex[roll];
  if (!cands || !cands.length) return null;
  if (cands.length === 1) return cands[0];
  const c = normKey(cls), s2 = normKey(sec);
  return cands.find((r) => normKey(r.class) === c && normKey(r.section) === s2)
    || cands.find((r) => normKey(r.class) === c)
    || cands[0];
}

function renderRosterInfo() {
  const n = state.rosterRows.length;
  if (!n) { $('#rosterInfo').textContent = 'No roster loaded — names will be blank.'; return; }
  const dupes = Object.keys(state.rosterIndex).filter((k) => state.rosterIndex[k].length > 1).length;
  $('#rosterInfo').textContent = `${n} students loaded` +
    (dupes ? ` · ${dupes} roll number(s) repeat across sections` : '');
}

$('#rosterImport').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  state.rosterRows = parseRoster(await f.text());
  buildRosterIndex();
  renderRosterInfo(); save(); refreshNames();
  toast(`${state.rosterRows.length} students loaded`);
  e.target.value = '';
});

/* ------------------------------------------------------------------ */
/* TUNING SLIDERS                                                      */
/* ------------------------------------------------------------------ */
function syncTuning() {
  $('#relMin').value = state.tuning.relMin;
  $('#relMinOut').textContent = state.tuning.relMin;
  $('#multiRel').value = Math.round(state.tuning.multiRel * 100);
  $('#multiRelOut').textContent = Math.round(state.tuning.multiRel * 100);
}
$('#relMin').addEventListener('input', (e) => {
  state.tuning.relMin = +e.target.value; $('#relMinOut').textContent = e.target.value; save();
});
$('#multiRel').addEventListener('input', (e) => {
  state.tuning.multiRel = +e.target.value / 100; $('#multiRelOut').textContent = e.target.value; save();
});

/* ------------------------------------------------------------------ */
/* IMAGE -> GRAY                                                       */
/* ------------------------------------------------------------------ */
async function decodeToGray(blob, maxDim) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(blob);
    });
  }
  const w0 = bmp.width, h0 = bmp.height;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const cw = Math.max(1, Math.round(w0 * s));
  const ch = Math.max(1, Math.round(h0 * s));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch);
  if (bmp.close) bmp.close();
  return { gray: E.rgbaToGray(data.data, cw, ch), w: cw, h: ch };
}

/* ------------------------------------------------------------------ */
/* PROCESS ONE SHEET                                                   */
/* ------------------------------------------------------------------ */
let rowSeq = 1;

async function processFile(file) {
  const tpl = activeTemplate();
  const { gray, w, h } = await decodeToGray(file, 1600);
  const res = E.readSheet(gray, w, h, tpl, {
    relMin: state.tuning.relMin,
    multiRel: state.tuning.multiRel
  });

  if (!res.ok) {
    logLine(file.name + ' — ' + res.message, true);
    return null;
  }

  const fieldFlagCount = Object.keys(res.fieldFlags)
    .reduce((n, k) => n + res.fieldFlags[k].length, 0);
  const flags = res.answers.filter((a) => a.status === 'multi').length + fieldFlagCount;
  const row = {
    id: rowSeq++,
    fileName: file.name,
    file: flags > 0 ? file : null,     // keep the photo only if a human must look
    procW: w, procH: h,
    inverse: res.inverse,
    fields: res.fields,
    fieldFlags: res.fieldFlags,
    answers: res.answers,
    quality: res.quality,
    ms: res.ms,
    overrides: {},
    who: lookupRoster(res.fields.roll, res.fields.class, res.fields.section)
  };
  row.score = E.scoreSheet(res, state.key, row.overrides);
  state.rows.push(row);

  const bits = [`roll ${res.fields.roll}`];
  if (res.fields.class) bits.push('class ' + res.fields.class);
  if (res.fields.section) bits.push('sec ' + res.fields.section);
  if (row.who) bits.push(row.who.name);
  bits.push(`${row.score.correct}/${row.score.scored}`);
  if (flags) bits.push(`${flags} to review`);
  logLine(file.name + ' — ' + bits.join(' · '), false);
  return row;
}

function logLine(msg, isErr) {
  const d = document.createElement('div');
  if (isErr) d.className = 'err';
  d.textContent = msg;
  $('#scanLog').prepend(d);
}

function refreshStats() {
  const n = state.rows.length;
  const flagged = state.rows.filter(rowNeedsReview).length;
  const scored = state.rows.filter((r) => r.score.scored > 0);
  const avg = scored.length
    ? Math.round(scored.reduce((s, r) => s + r.score.percent, 0) / scored.length) + '%'
    : '—';
  $('#statScanned').textContent = n;
  $('#statFlagged').textContent = flagged;
  $('#statAvg').textContent = avg;
  $('#countPill').textContent = n;
}

function rowNeedsReview(r) {
  if (r.answers.some((a) => a.status === 'multi')) return true;
  return Object.keys(r.fieldFlags || {}).some((k) => r.fieldFlags[k].length > 0);
}

function flagCount(r) {
  const f = Object.keys(r.fieldFlags || {}).reduce((n, k) => n + r.fieldFlags[k].length, 0);
  return r.answers.filter((a) => a.status === 'multi').length + f;
}

/* ------------------------------------------------------------------ */
/* SCAN: files, demo, camera                                           */
/* ------------------------------------------------------------------ */
async function handleFiles(files) {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  for (const f of list) {
    try {
      await processFile(f);
    } catch (err) {
      logLine(f.name + ' — could not read this image', true);
    }
  }
  refreshStats();
  toast(`${list.length} sheet(s) processed`);
}

$('#filePick').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

$('#loadDemo').addEventListener('click', async () => {
  const names = ['demo-1', 'demo-2', 'demo-3', 'demo-4', 'demo-5'];
  const files = [];
  for (const n of names) {
    try {
      const r = await fetch('samples/' + n + '.jpg');
      if (!r.ok) continue;
      const b = await r.blob();
      files.push(new File([b], n + '.jpg', { type: 'image/jpeg' }));
    } catch (e) { /* offline: skip */ }
  }
  if (!files.length) return toast('Sample photos not found (open the app over http, not file://)');
  handleFiles(files);
});

$('#dropImages').addEventListener('click', () => {
  state.rows.forEach((r) => { r.file = null; });
  toast('Stored photos released — results kept');
  refreshStats();
});

/* camera */
let stream = null;

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 2560 } },
      audio: false
    });
    const v = $('#video');
    v.srcObject = stream;
    await v.play();
    $('#camHint').classList.add('hidden');
    $('#camShot').disabled = false;
    $('#camStop').disabled = false;
    $('#camStart').disabled = true;
  } catch (err) {
    $('#camHint').textContent = 'Camera unavailable. Use “Choose photos” instead — or open this page over https.';
    toast('Camera blocked or not available');
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('#video').srcObject = null;
  $('#camHint').classList.remove('hidden');
  $('#camShot').disabled = true;
  $('#camStop').disabled = true;
  $('#camStart').disabled = false;
}

$('#camStart').addEventListener('click', startCamera);
$('#camStop').addEventListener('click', stopCamera);

$('#camShot').addEventListener('click', async () => {
  const v = $('#video');
  if (!v.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
  if (!blob) return toast('Capture failed');
  const f = new File([blob], 'capture-' + Date.now() + '.jpg', { type: 'image/jpeg' });
  await handleFiles([f]);
  showView('results');
});

/* ------------------------------------------------------------------ */
/* RESULTS TABLE                                                       */
/* ------------------------------------------------------------------ */
function answerCell(row, i) {
  const a = row.answers[i];
  const ov = row.overrides[a.q];
  if (ov !== undefined) return { text: optLabel(activeTemplate(), ov), cls: '' };
  if (a.status === 'multi') return { text: 'M', cls: 'multi' };
  if (a.status === 'blank') return { text: '-', cls: 'blank' };
  return { text: optLabel(activeTemplate(), a.choice), cls: '' };
}

function renderResults() {
  const tpl = activeTemplate();
  const q = tpl.questions;
  const perQ = $('#optPerQ').checked;
  const table = $('#resultTable');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  const head = ['#', 'Roll', 'Class', 'Sec', 'Name', 'Correct', 'Wrong', 'Blank', 'Review', 'Score', ''];
  if (perQ) for (let i = 0; i < q.count; i++) head.push('Q' + (i + 1));
  thead.innerHTML = '<tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr>';

  if (!state.rows.length) {
    tbody.innerHTML = '';
    $('#emptyResults').classList.remove('hidden');
    $('#resultSummary').textContent = '';
    return;
  }
  $('#emptyResults').classList.add('hidden');

  const frag = document.createDocumentFragment();
  state.rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    const s = row.score;
    const flags = flagCount(row);
    const cells = [
      idx + 1,
      esc(row.fields.roll),
      esc(row.fields.class || ''),
      esc(row.fields.section || ''),
      esc(row.who ? row.who.name : ''),
      s.correct + '/' + s.scored, s.wrong, s.blank, s.multi,
      s.percent + '%',
      flags ? `<span class="badge warn">review ${flags}</span>` : '<span class="badge ok">ok</span>'
    ];
    tr.innerHTML = cells.map((c) => `<td>${c}</td>`).join('');
    if (perQ) {
      for (let i = 0; i < q.count; i++) {
        const cell = answerCell(row, i);
        const td = document.createElement('td');
        td.className = 'q ' + cell.cls;
        td.textContent = cell.text;
        tr.appendChild(td);
      }
    }
    tr.addEventListener('click', () => openReview(row));
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);

  const scored = state.rows.filter((r) => r.score.scored > 0);
  const avg = scored.length
    ? Math.round(scored.reduce((a, r) => a + r.score.percent, 0) / scored.length) : 0;
  const totalFlags = state.rows.filter(rowNeedsReview).length;
  $('#resultSummary').textContent =
    `— ${state.rows.length} sheets · avg ${avg}% · ${totalFlags} need review`;
  refreshStats();
}

$('#optPerQ').addEventListener('change', renderResults);

/* ------------------------------------------------------------------ */
/* REVIEW                                                              */
/* ------------------------------------------------------------------ */
let reviewRow = null;
let reviewBitmap = null;

async function cropQuestion(row, qIndex, maxW) {
  if (!row.file) return null;
  const tpl = activeTemplate();
  const q = tpl.questions;
  const col = Math.floor(qIndex / q.perColumn);
  const r = qIndex % q.perColumn;
  const x = q.x0 + col * q.dxColumn;
  const y = q.y0 + r * q.dyRow;
  const pad = 16;
  const x0c = x - pad - 38, y0c = y - pad;
  const x1c = x + (q.options - 1) * q.dxOption + pad, y1c = y + pad;

  const corners = [[x0c, y0c], [x1c, y0c], [x1c, y1c], [x0c, y1c]]
    .map((p) => E.applyH(row.inverse, p[0], p[1]));

  if (!reviewBitmap || reviewBitmap._rowId !== row.id) {
    if (reviewBitmap && reviewBitmap.close) reviewBitmap.close();
    reviewBitmap = await createImageBitmap(row.file);
    reviewBitmap._rowId = row.id;
  }
  const src = document.createElement('canvas');
  src.width = row.procW; src.height = row.procH;
  src.getContext('2d').drawImage(reviewBitmap, 0, 0, row.procW, row.procH);

  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  let x0 = Math.max(0, Math.min.apply(null, xs) - 4);
  let y0 = Math.max(0, Math.min.apply(null, ys) - 4);
  let x1 = Math.min(row.procW, Math.max.apply(null, xs) + 4);
  let y1 = Math.min(row.procH, Math.max.apply(null, ys) + 4);
  const sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0);

  const out = document.createElement('canvas');
  const scale = Math.min(3, maxW / sw);
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  out.getContext('2d').drawImage(src, x0, y0, sw, sh, 0, 0, out.width, out.height);
  return out;
}

async function openReview(row) {
  reviewRow = row;
  const tpl = activeTemplate();
  const body = $('#reviewBody');
  body.innerHTML = '';
  const title = () => {
    const bits = ['roll ' + row.fields.roll];
    if (row.fields.class) bits.push('class ' + row.fields.class);
    if (row.fields.section) bits.push('sec ' + row.fields.section);
    $('#reviewTitle').textContent = `Sheet ${row.id} — ` + bits.join(' · ');
  };
  title();
  const who = row.who
    ? `${row.who.name}${row.who.class ? ' · class ' + row.who.class : ''}${row.who.section ? ' · sec ' + row.who.section : ''}`
    : 'not in roster';
  $('#reviewSub').textContent = `${who} · read in ${row.ms} ms · ` +
    (row.file ? 'photo kept only for this review' : 'photo already released');

  // any field digit that had no single clear circle
  const badFields = Object.keys(row.fieldFlags || {}).filter((k) => row.fieldFlags[k].length);
  for (const key of badFields) {
    const tplF = (activeTemplate().fields || []).find((f) => f.key === key);
    const d = document.createElement('div');
    d.className = 'rvitem';
    d.innerHTML = `<div class="rvthumb"></div>
      <div>
        <div class="qtitle"><em>${esc((tplF && tplF.label) || key.toUpperCase())} needs a look</em></div>
        <div class="muted small">Position ${row.fieldFlags[key].map((i) => i + 1).join(', ')} had no single clear circle.</div>
        <div class="optrow" style="margin-top:8px"><input type="text" value="${esc(row.fields[key])}" placeholder="type the value" /></div>
      </div>`;
    body.appendChild(d);
    const inp = d.querySelector('input');
    inp.addEventListener('change', (e) => {
      row.fields[key] = e.target.value.trim();
      row.fieldFlags[key] = [];
      row.who = lookupRoster(row.fields.roll, row.fields.class, row.fields.section);
      title();
      renderResults();
    });
  }

  const flagged = row.answers.filter((a) => a.status === 'multi');
  if (!flagged.length) {
    const d = document.createElement('div');
    d.className = 'muted small';
    d.textContent = badFields.length
      ? 'No question was double-marked.'
      : 'Nothing flagged — every question had exactly one clear answer.';
    body.appendChild(d);
    $('#reviewModal').classList.remove('hidden');
    return;
  }

  const cards = [];
  for (const a of flagged) {
    const item = document.createElement('div');
    item.className = 'rvitem';
    const marks = a.marks.map((m) => optLabel(tpl, m)).join(' + ');
    item.innerHTML = `<div class="rvthumb"></div>
      <div>
        <div class="qtitle">Question ${a.q} <em>· double-marked</em></div>
        <div class="muted small">Circles read: ${marks}</div>
        <div class="optrow"></div>
      </div>`;
    const optrow = item.querySelector('.optrow');
    const current = row.overrides[a.q];

    const commit = (val, btn) => {
      row.overrides[a.q] = val;
      Array.from(optrow.children).forEach((c) => c.classList.remove('on'));
      btn.classList.add('on');
      row.score = E.scoreSheet({ answers: row.answers }, state.key, row.overrides);
      renderResults();
    };

    for (let o = 0; o < tpl.questions.options; o++) {
      const b = document.createElement('button');
      b.textContent = optLabel(tpl, o);
      if (current === o) b.classList.add('on');
      b.addEventListener('click', () => commit(o, b));
      optrow.appendChild(b);
    }
    const bl = document.createElement('button');
    bl.textContent = 'left blank';
    bl.className = 'blank';
    if (current === -1) bl.classList.add('on');
    bl.addEventListener('click', () => commit(-1, bl));
    optrow.appendChild(bl);

    body.appendChild(item);
    cards.push({ q: a.q, item: item });
  }

  $('#reviewModal').classList.remove('hidden');

  for (const c of cards) {
    const canvas = await cropQuestion(row, c.q - 1, 300);
    if (canvas) c.item.querySelector('.rvthumb').appendChild(canvas);
  }
}

$('#reviewClose').addEventListener('click', () => {
  $('#reviewModal').classList.add('hidden');
  if (reviewBitmap && reviewBitmap.close) reviewBitmap.close();
  reviewBitmap = null;
  // once nothing is left to check, drop the photo for good
  if (reviewRow && !rowNeedsReview(reviewRow)) reviewRow.file = null;
  reviewRow = null;
  refreshStats();
});

/* ------------------------------------------------------------------ */
/* EXPORT                                                              */
/* ------------------------------------------------------------------ */
function buildCsv() {
  const tpl = activeTemplate();
  const q = tpl.questions;
  const perQ = $('#optPerQ').checked;
  const head = ['Roll No', 'Class', 'Section', 'Name', 'Correct', 'Wrong', 'Blank', 'Review',
    'Scored Out Of', 'Attempted', 'Percent'];
  if (perQ) for (let i = 0; i < q.count; i++) head.push('Q' + (i + 1));
  head.push('Flags');

  const lines = [head.map(csvCell).join(',')];
  for (const row of state.rows) {
    const s = row.score;
    const cells = [
      row.fields.roll,
      row.fields.class || '',
      row.fields.section || '',
      row.who ? row.who.name : '',
      s.correct, s.wrong, s.blank, s.multi, s.scored, s.attempted, s.percent
    ];
    if (perQ) {
      for (let i = 0; i < q.count; i++) cells.push(answerCell(row, i).text);
    }
    const flags = [];
    Object.keys(row.fieldFlags || {}).forEach((k) => {
      if (row.fieldFlags[k].length) flags.push(k + ' unreadable');
    });
    if (s.multi) flags.push(s.multi + ' double-marked');
    cells.push(flags.join('; '));
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

$('#exportCsv').addEventListener('click', () => {
  if (!state.rows.length) return toast('Nothing to export yet');
  const stamp = new Date().toISOString().slice(0, 10);
  download(`omr-results-${stamp}.csv`, '\uFEFF' + buildCsv(), 'text/csv;charset=utf-8');
  toast('CSV downloaded');
});

$('#exportJson').addEventListener('click', () => {
  if (!state.rows.length) return toast('Nothing to export yet');
  const tpl = activeTemplate();
  const out = {
    generated: new Date().toISOString(),
    template: tpl.id,
    keyName: state.keyName,
    answerKey: state.key,
    students: state.rows.map((r) => ({
      roll: r.fields.roll,
      class: r.fields.class,
      section: r.fields.section,
      name: r.who ? r.who.name : '',
      score: r.score,
      answers: r.answers.map((a) => ({
        q: a.q,
        status: a.status,
        choice: a.status === 'ok' ? optLabel(tpl, a.choice) : null,
        marked: a.marks.map((m) => optLabel(tpl, m)),
        override: r.overrides[a.q] !== undefined ? optLabel(tpl, r.overrides[a.q]) : undefined
      }))
    }))
  };
  download('omr-results.json', JSON.stringify(out, null, 2), 'application/json');
  toast('JSON downloaded');
});

$('#clearAll').addEventListener('click', () => {
  if (!state.rows.length) return;
  if (!confirm('Delete all scanned results? This cannot be undone.')) return;
  state.rows = [];
  refreshStats(); renderResults();
  $('#scanLog').innerHTML = '';
});

function refreshNames() {
  state.rows.forEach((r) => { r.who = lookupRoster(r.fields.roll, r.fields.class, r.fields.section); });
  if (state.rows.length) renderResults();
}

/* ------------------------------------------------------------------ */
/* TEMPLATES LIST                                                      */
/* ------------------------------------------------------------------ */
function renderTemplateList() {
  const list = $('#templateList');
  list.innerHTML = '';
  const all = [DEFAULT_TEMPLATE].concat(state.templates);
  for (const t of all) {
    const d = document.createElement('div');
    d.className = 'tplrow' + (t.id === state.activeId ? ' on' : '');
    const q = t.questions;
    const fs = (t.fields || (t.roll ? [{ key: 'roll', digits: t.roll.digits }] : []))
      .map((f) => `${f.key} ${f.digits}`).join(' · ');
    d.innerHTML = `<div><b>${esc(t.name)}</b><div class="muted small">${q.count} questions · ${q.options} options${fs ? ' · ' + esc(fs) : ''}</div></div>`;
    const right = document.createElement('div');
    right.className = 'row gap';
    if (t.id !== state.activeId) {
      const use = document.createElement('button');
      use.className = 'btn ghost';
      use.textContent = 'Use';
      use.addEventListener('click', () => {
        state.activeId = t.id; save();
        renderTemplateList(); renderKeyGrid(); renderResults();
        toast('Template: ' + t.name);
      });
      right.appendChild(use);
    }
    if (t.id !== 'default') {
      const del = document.createElement('button');
      del.className = 'btn ghost danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => {
        state.templates = state.templates.filter((x) => x.id !== t.id);
        if (state.activeId === t.id) state.activeId = 'default';
        save(); renderTemplateList(); renderKeyGrid(); renderResults();
      });
      right.appendChild(del);
    }
    d.appendChild(right);
    list.appendChild(d);
  }
}

$('#tplExport').addEventListener('click', () => {
  download('template-' + state.activeId + '.json', JSON.stringify(activeTemplate(), null, 2), 'application/json');
});

$('#tplImport').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const t = JSON.parse(await f.text());
    t.id = t.id || 'custom-' + Date.now();
    if (!t.markers || !t.questions) throw new Error('bad');
    state.templates = state.templates.filter((x) => x.id !== t.id).concat([t]);
    state.activeId = t.id;
    save(); renderTemplateList(); renderKeyGrid(); renderResults();
    toast('Template imported and active');
  } catch (err) { toast('That file is not a valid template'); }
  e.target.value = '';
});

/* ------------------------------------------------------------------ */
/* TEMPLATE BUILDER                                                    */
/* ------------------------------------------------------------------ */
const builder = { img: null, cw: 0, ch: 0, clicks: [], Hinv: null, H: null, imgW: 0, imgH: 0 };
const CANON_MARKERS = [[70, 70], [930, 70], [930, 1344], [70, 1344]];

function builderFields() {
  return {
    count: +$('#tqCount').value, options: +$('#tqOptions').value,
    columns: +$('#tqCols').value, perColumn: +$('#tqPer').value,
    dxOption: +$('#tqDx').value, dyRow: +$('#tqDy').value, dxColumn: +$('#tqDc').value,
    r: +$('#tqR').value, x0: +$('#tqX').value, y0: +$('#tqY').value,
    digits: +$('#trDigits').value, rows: +$('#trRows').value,
    rx: +$('#trX').value, ry: +$('#trY').value,
    rdx: +$('#trDx').value, rdy: +$('#trDy').value,
    cDigits: +$('#tcDigits').value, cx: +$('#tcX').value,
    sCount: +$('#tsCount').value, sx: +$('#tsX').value
  };
}

function builderTemplate() {
  const f = builderFields();
  return {
    id: 'custom-' + Date.now(),
    name: $('#tplName').value || 'My sheet',
    version: 1,
    canvas: { w: 1000, h: 1414 },
    markers: CANON_MARKERS,
    markerSize: 50,
    fields: (function () {
      const out = [];
      if (f.digits > 0) out.push({
        key: 'roll', label: 'ROLL NUMBER', digits: f.digits,
        labels: '0123456789'.slice(0, f.rows), x0: f.rx, y0: f.ry, dx: f.rdx, dy: f.rdy, r: 7
      });
      if (f.cDigits > 0) out.push({
        key: 'class', label: 'CLASS', digits: f.cDigits,
        labels: '0123456789', x0: f.cx, y0: f.ry, dx: f.rdx, dy: f.rdy, r: 7
      });
      if (f.sCount > 0) out.push({
        key: 'section', label: 'SECTION', digits: 1,
        labels: 'ABCDEFGHIJKL'.slice(0, f.sCount), x0: f.sx, y0: f.ry, dx: f.rdx, dy: f.rdy, r: 7
      });
      return out;
    })(),
    questions: {
      count: f.count, columns: f.columns, perColumn: f.perColumn, options: f.options,
      x0: f.x0, y0: f.y0, dxOption: f.dxOption, dyRow: f.dyRow, dxColumn: f.dxColumn, r: f.r
    },
    optionLabels: ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, Math.max(4, f.options))
  };
}

function drawBuilder() {
  const c = $('#tplCanvas');
  if (!builder.img) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(builder.img, 0, 0, c.width, c.height);

  // clicked corners
  builder.clicks.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,60,60,.85)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p[0], p[1]);
  });

  if (!builder.Hinv) return;
  const t = builderTemplate();
  ctx.strokeStyle = 'rgba(60,60,255,.85)';
  ctx.lineWidth = 1.4;
  const q = t.questions;
  for (let i = 0; i < q.count; i++) {
    const col = Math.floor(i / q.perColumn), rr = i % q.perColumn;
    const x = q.x0 + col * q.dxColumn, y = q.y0 + rr * q.dyRow;
    for (let o = 0; o < q.options; o++) {
      const p = E.applyH(builder.Hinv, x + o * q.dxOption, y);
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = 'rgba(0,170,90,.9)';
  for (const f of (t.fields || [])) {
    for (let d = 0; d < f.digits; d++) {
      for (let v = 0; v < f.labels.length; v++) {
        const p = E.applyH(builder.Hinv, f.x0 + d * f.dx, f.y0 + v * f.dy);
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

$('#tplImage').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const bmp = await createImageBitmap(f);
  builder.img = bmp;
  builder.imgW = bmp.width; builder.imgH = bmp.height;
  const maxW = 1000;
  const s = Math.min(1, maxW / bmp.width);
  const c = $('#tplCanvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  builder.cw = c.width; builder.ch = c.height;
  builder.clicks = []; builder.Hinv = null; builder.H = null;
  $('#tplStage').classList.remove('hidden');
  $('#tplForm').classList.add('hidden');
  $('#tplHint').textContent = 'Click the four corner squares in order: top-left → top-right → bottom-right → bottom-left.';
  drawBuilder();
  e.target.value = '';
});

$('#tplCanvas').addEventListener('click', (e) => {
  const c = $('#tplCanvas');
  const r = c.getBoundingClientRect();
  const x = (e.clientX - r.left) * (c.width / r.width);
  const y = (e.clientY - r.top) * (c.height / r.height);
  if (builder.clicks.length >= 4) builder.clicks = [];
  builder.clicks.push([x, y]);
  if (builder.clicks.length === 4) {
    const H = E.homography(builder.clicks, CANON_MARKERS);
    if (!H) { $('#tplHint').textContent = 'Those four points do not form a usable rectangle. Try again.'; builder.clicks = []; drawBuilder(); return; }
    builder.H = H;
    builder.Hinv = E.invert3x3(H);
    $('#tplForm').classList.remove('hidden');
    $('#tplHint').textContent = 'Locked. Now tune the numbers until the blue dots sit on the circles.';
  } else {
    $('#tplHint').textContent = `Click corner ${builder.clicks.length + 1} of 4.`;
  }
  drawBuilder();
});

$$('#tplForm input').forEach((inp) => inp.addEventListener('input', drawBuilder));

$('#tplSave').addEventListener('click', () => {
  if (!builder.H) return toast('Click the four corner squares first');
  const t = builderTemplate();
  if (!t.name || t.name === 'My sheet') {
    const n = prompt('Name this template', 'My sheet');
    if (n) t.name = n;
  }
  state.templates = state.templates.filter((x) => x.name !== t.name).concat([t]);
  state.activeId = t.id;
  save(); renderTemplateList(); renderKeyGrid(); renderResults();
  toast('Template saved and active');
  showView('setup');
});

/* ------------------------------------------------------------------ */
/* INSTALL AS AN APP (PWA)                                             */
/* ------------------------------------------------------------------ */
let installPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.indexOf('android-app://') === 0;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function setInstallVisible(on) {
  ['#installBtn', '#installBtn2'].forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', !on);
  });
}

async function doInstall() {
  if (!installPrompt) {
    const msg = isIOS()
      ? 'On iPhone: Share icon → Add to Home Screen'
      : 'Open the browser menu → Install app / Add to Home screen';
    toast(msg, 5200);
    return;
  }
  installPrompt.prompt();
  const choice = await installPrompt.userChoice;
  installPrompt = null;
  setInstallVisible(false);
  if (choice && choice.outcome === 'accepted') {
    toast('Installed — the OMR icon is now on your home screen');
  }
}

function setupInstall() {
  const state = $('#installState');
  if (isStandalone()) {
    // already running as an installed app
    const card = $('#installCard');
    if (card) card.classList.add('hidden');
    setInstallVisible(false);
    return;
  }
  if (isIOS()) {
    state.textContent = 'On iPhone the install button cannot appear — use Share → “Add to Home Screen”.';
    setInstallVisible(false);
    return;
  }
  // Chrome/Edge/Android fire this once the app is installable
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    setInstallVisible(true);
    state.textContent = 'Ready to install — tap the button.';
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    setInstallVisible(false);
    state.textContent = 'Installed. Open it from your home screen.';
    toast('Installed — look for the OMR icon');
  });
  if (state && !state.textContent) {
    state.textContent = 'If nothing happens, use your browser menu → “Add to Home screen”.';
  }
  ['#installBtn', '#installBtn2'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('click', doInstall);
  });
}

/* ------------------------------------------------------------------ */
/* BOOT                                                                */
/* ------------------------------------------------------------------ */
function boot() {
  load();
  $('#relMin').value = state.tuning.relMin;
  $('#relMinOut').textContent = state.tuning.relMin;
  $('#multiRel').value = Math.round(state.tuning.multiRel * 100);
  $('#multiRelOut').textContent = Math.round(state.tuning.multiRel * 100);
  renderKeyGrid();
  renderRosterInfo();
  renderTemplateList();
  refreshStats();
  renderResults();
  setupInstall();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* file:// or http, fine */ });
    });
  }
}

boot();
