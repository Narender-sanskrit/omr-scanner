/*!
 * omr-engine.js — dependency-free OMR reader
 * ------------------------------------------------------------------
 * No OpenCV, no OCR, no network. Works in the browser and in Node.
 *
 * Pipeline
 *   1. RGBA -> grayscale
 *   2. downscale a copy for marker search (fast)
 *   3. find the four printed corner squares (connected components +
 *      brute-force largest convex quad)
 *   4. build the image -> sheet homography from those four points
 *   5. for every bubble in the template, project its centre into the
 *      photo and take the median darkness of a small inner disc
 *   6. per question: darkest bubble wins; two similarly dark bubbles
 *      = "multi" and is flagged for a human, never guessed
 *
 * The template lives in a fixed 1000 x 1414 "canonical" space that maps
 * onto A4. Only bubble centres are ever projected, so no full-size warped
 * image is ever created — that is what keeps memory and disk use tiny.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OMREngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* image helpers                                                       */
  /* ------------------------------------------------------------------ */

  function rgbaToGray(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      // luma, then undo gamma-ish so pen marks separate better from paper
      g[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) | 0;
    }
    return g;
  }

  function downscaleGray(gray, w, h, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(w, h));
    if (scale >= 1) return { gray: gray, w: w, h: h, scale: 1 };
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    const out = new Uint8Array(nw * nh);
    const sx = w / nw, sy = h / nh;
    for (let y = 0; y < nh; y++) {
      const y0 = (y * sy) | 0, y1 = Math.min(h, ((y + 1) * sy) | 0) || y0 + 1;
      for (let x = 0; x < nw; x++) {
        const x0 = (x * sx) | 0, x1 = Math.min(w, ((x + 1) * sx) | 0) || x0 + 1;
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx < x1; xx++) { sum += gray[row + xx]; n++; }
        }
        out[y * nw + x] = (sum / n) | 0;
      }
    }
    return { gray: out, w: nw, h: nh, scale: scale };
  }

  function otsu(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  /* two-pass connected components with union-find ---------------------- */
  function components(binary, w, h) {
    const labels = new Int32Array(w * h);
    const parent = [0];
    function find(a) {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    function union(a, b) {
      a = find(a); b = find(b);
      if (a !== b) parent[b] = a;
    }
    let next = 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!binary[i]) continue;
        const L = x > 0 ? labels[i - 1] : 0;
        const U = y > 0 ? labels[i - w] : 0;
        const UR = (y > 0 && x < w - 1) ? labels[i - w + 1] : 0;
        const UL = (y > 0 && x > 0) ? labels[i - w - 1] : 0;
        if (L) {
          labels[i] = L;
          if (U) union(L, U);
          if (UR) union(L, UR);
          if (UL) union(L, UL);
        } else if (U) {
          labels[i] = U;
          if (UR) union(U, UR);
          if (UL) union(U, UL);
        } else if (UR) {
          labels[i] = UR;
          if (UL) union(UR, UL);
        } else if (UL) {
          labels[i] = UL;
        } else {
          labels[i] = next;
          parent.push(next);
          next++;
        }
      }
    }
    const stats = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!labels[i]) continue;
        const r = find(labels[i]);
        let s = stats.get(r);
        if (!s) { s = { x0: x, y0: y, x1: x, y1: y, area: 0 }; stats.set(r, s); }
        s.area++;
        if (x < s.x0) s.x0 = x;
        if (x > s.x1) s.x1 = x;
        if (y < s.y0) s.y0 = y;
        if (y > s.y1) s.y1 = y;
      }
    }
    const out = [];
    stats.forEach(function (s) {
      s.w = s.x1 - s.x0 + 1;
      s.h = s.y1 - s.y0 + 1;
      s.cx = (s.x0 + s.x1) / 2;
      s.cy = (s.y0 + s.y1) / 2;
      s.extent = s.area / (s.w * s.h);
      out.push(s);
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* geometry                                                            */
  /* ------------------------------------------------------------------ */

  function homography(src, dst) {
    // solve 8x8 linear system by Gaussian elimination
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      const t = A[c]; A[c] = A[piv]; A[piv] = t;
      const tb = b[c]; b[c] = b[piv]; b[piv] = tb;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const hh = [];
    for (let i = 0; i < n; i++) hh.push(b[i] / A[i][i]);
    hh.push(1);
    return hh;
  }

  function invert3x3(m) {
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5],
      g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const id = 1 / det;
    return [
      A * id, (c * h - b * i) * id, (b * f - c * e) * id,
      B * id, (a * i - c * g) * id, (c * d - a * f) * id,
      C * id, (b * g - a * h) * id, (a * e - b * d) * id
    ];
  }

  function applyH(m, x, y) {
    const d = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d];
  }

  function quadArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
    }
    return Math.abs(a) / 2;
  }

  function isConvex(p) {
    let pos = 0, neg = 0;
    for (let i = 0; i < 4; i++) {
      const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cr > 0) pos++; else if (cr < 0) neg++;
    }
    return pos === 4 || neg === 4;
  }

  function orderCorners(pts) {
    // sort by angle around the centroid, then rotate so index 0 is top-left
    const cx = pts.reduce(function (s, p) { return s + p[0]; }, 0) / 4;
    const cy = pts.reduce(function (s, p) { return s + p[1]; }, 0) / 4;
    const sorted = pts.slice().sort(function (p, q) {
      return Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx);
    });
    // atan2 starts at -PI (left); find the point closest to top-left
    let best = 0, bestv = Infinity;
    for (let i = 0; i < 4; i++) {
      const v = sorted[i][0] + sorted[i][1];
      if (v < bestv) { bestv = v; best = i; }
    }
    return [sorted[best], sorted[(best + 1) % 4], sorted[(best + 2) % 4], sorted[(best + 3) % 4]];
  }

  /* ------------------------------------------------------------------ */
  /* marker detection                                                    */
  /* ------------------------------------------------------------------ */

  function detectMarkers(gray, w, h, opts) {
    opts = opts || {};
    const small = downscaleGray(gray, w, h, 900);
    const thr = otsu(small.gray);
    const bin = new Uint8Array(small.gray.length);
    for (let i = 0; i < bin.length; i++) bin[i] = small.gray[i] < thr ? 1 : 0;

    const N = small.w * small.h;
    const minDim = Math.min(small.w, small.h);
    const comps = components(bin, small.w, small.h);

    const cands = comps.filter(function (c) {
      if (c.area < 0.00025 * N || c.area > 0.03 * N) return false;
      if (c.extent < 0.60) return false;              // solid-ish blob
      if (c.w < 0.012 * minDim || c.w > 0.16 * minDim) return false;
      if (c.h < 0.012 * minDim || c.h > 0.16 * minDim) return false;
      const ar = c.w / c.h;
      if (ar < 0.45 || ar > 2.2) return false;
      return true;
    }).sort(function (a, b) { return b.area - a.area; }).slice(0, 14);

    if (cands.length < 4) return null;

    // Brute force the 4-combination that best looks like four printed squares
    // at the corners of one sheet: big quad, and every corner a solid blob.
    const like = cands.map(function (c) { return Math.pow(c.extent, 6); });
    let best = null, bestScore = -1, bestIdx = null;
    const n = cands.length;
    for (let a = 0; a < n - 3; a++)
      for (let b = a + 1; b < n - 2; b++)
        for (let c = b + 1; c < n - 1; c++)
          for (let d = c + 1; d < n; d++) {
            const raw = [[cands[a].cx, cands[a].cy], [cands[b].cx, cands[b].cy],
            [cands[c].cx, cands[c].cy], [cands[d].cx, cands[d].cy]];
            const q = orderCorners(raw);          // must be convex order for area
            if (!isConvex(q)) continue;
            const score = quadArea(q) * like[a] * like[b] * like[c] * like[d];
            if (score > bestScore) { bestScore = score; best = q; bestIdx = [a, b, c, d]; }
          }

    if (!best) return null;
    const ordered0 = best;
    const sizes = bestIdx.map(function (i) { return Math.sqrt(cands[i].area); });
    const sMin = Math.min.apply(null, sizes), sMax = Math.max.apply(null, sizes);
    if (sMax > sMin * 2.6) return null;   // not four identical corner marks
    const ordered = ordered0;

    // aspect sanity: an A4 portrait sheet's marker quad is ~0.675 w/h
    const topW = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
    const botW = Math.hypot(ordered[2][0] - ordered[3][0], ordered[2][1] - ordered[3][1]);
    const lefH = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
    const rigH = Math.hypot(ordered[2][0] - ordered[1][0], ordered[2][1] - ordered[1][1]);
    const aw = (topW + botW) / 2, ah = (lefH + rigH) / 2;
    if (ah < 1) return null;
    const aspect = aw / ah;
    const minA = (opts.minAspect || 0.40), maxA = (opts.maxAspect || 1.15);
    if (aspect < minA || aspect > maxA) return null;

    // back to full-resolution coordinates
    const s = 1 / small.scale;
    return ordered.map(function (p) { return [p[0] * s, p[1] * s]; });
  }

  /* ------------------------------------------------------------------ */
  /* bubble sampling                                                     */
  /* ------------------------------------------------------------------ */

  function sampleGray(gray, w, h, x, y) {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 255;
    const x0 = x | 0, y0 = y | 0;
    const fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    const a = gray[i], b = gray[i + 1], c = gray[i + w], d = gray[i + w + 1];
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  function median(arr) {
    const s = arr.slice().sort(function (a, b) { return a - b; });
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // sample a small disc inside a bubble, in canonical space, projected live
  const DISC = (function () {
    const pts = [[0, 0]];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pts.push([Math.cos(a) * 0.55, Math.sin(a) * 0.55]);
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      pts.push([Math.cos(a) * 0.30, Math.sin(a) * 0.30]);
    }
    return pts;
  })();

  function bubbleGray(gray, w, h, Hinv, cx, cy, r) {
    const vals = [];
    for (let i = 0; i < DISC.length; i++) {
      const u = cx + DISC[i][0] * r, v = cy + DISC[i][1] * r;
      const p = applyH(Hinv, u, v);
      vals.push(sampleGray(gray, w, h, p[0], p[1]));
    }
    return median(vals);
  }

  /* ------------------------------------------------------------------ */
  /* template expansion                                                  */
  /* ------------------------------------------------------------------ */

  function normalizeFields(tpl) {
    if (tpl.fields && tpl.fields.length) return tpl.fields;
    const r = tpl.roll;
    if (!r || !r.digits) return [];
    return [{
      key: 'roll', label: 'ROLL NUMBER', digits: r.digits,
      labels: '0123456789'.slice(0, r.rows || 10),
      x0: r.x0, y0: r.y0, dx: r.dx, dy: r.dy, r: r.r
    }];
  }

  function expandTemplate(tpl) {
    const q = tpl.questions;
    const questions = [];
    for (let i = 0; i < q.count; i++) {
      const col = Math.floor(i / q.perColumn), row = i % q.perColumn;
      const x = q.x0 + col * q.dxColumn, y = q.y0 + row * q.dyRow;
      const bubbles = [];
      for (let o = 0; o < q.options; o++) bubbles.push([x + o * q.dxOption, y]);
      questions.push({ index: i, x: x, y: y, bubbles: bubbles });
    }

    // a field is a grid of bubble columns; each column is one character
    const fields = normalizeFields(tpl).map(function (f) {
      const labels = String(f.labels || '0123456789');
      const columns = [];
      for (let d = 0; d < f.digits; d++) {
        const col = [];
        for (let v = 0; v < labels.length; v++) {
          col.push([f.x0 + d * f.dx, f.y0 + v * f.dy]);
        }
        columns.push(col);
      }
      return { key: f.key, label: f.label || f.key, labels: labels, r: f.r, columns: columns };
    });

    return { questions: questions, fields: fields, rq: q.r, options: q.options };
  }

  /* ------------------------------------------------------------------ */
  /* decision                                                            */
  /* ------------------------------------------------------------------ */

  function decide(dark, opts) {
    // `dark` is absolute darkness (bigger = darker ink). Two things can fool a
    // naive threshold: a shadow tilting a whole row, and a student filling
    // three of four circles. So:
    //   * a bubble is "inked" if it is clearly darker than the palest bubble
    //     of the same question (which cancels row shadows)
    //   * three or more inked bubbles = multi, no baseline games needed
    //   * otherwise subtract this question's median so shadows cancel out
    // an empty bubble in THIS question is the palest of the four, so shadows
    // inside a row are cancelled before we ask "how many circles are inked?"
    const pale = Math.min.apply(null, dark);
    const inked = dark.map(function (v) { return v - pale > opts.relMin; });
    const inkedCount = inked.filter(Boolean).length;

    if (inkedCount >= 3) {
      const marks = [];
      for (let i = 0; i < dark.length; i++) if (inked[i]) marks.push(i);
      return { status: 'multi', choice: -1, marks: marks };
    }

    const base = median(dark);
    const rel = dark.map(function (v) { return v - base; });
    const order = rel.map(function (v, i) { return [v, i]; })
      .sort(function (a, b) { return b[0] - a[0]; });
    const top1 = order[0], top2 = order[1] || [0, -1];
    if (top1[0] < opts.relMin) return { status: 'blank', choice: -1, marks: [] };

    const gapFloor = Math.max(opts.relMin * 0.9, top1[0] * opts.multiRel);
    if (top2[0] >= gapFloor) {
      const marks = order.filter(function (o) { return o[0] >= gapFloor; })
        .map(function (o) { return o[1]; }).sort(function (a, b) { return a - b; });
      return { status: 'multi', choice: -1, marks: marks };
    }
    return { status: 'ok', choice: top1[1], marks: [top1[1]] };
  }

  /* ------------------------------------------------------------------ */
  /* main entry                                                          */
  /* ------------------------------------------------------------------ */

  function readSheet(gray, w, h, tpl, options) {
    const opts = Object.assign({
      relMin: 34,          // ink above the row's baseline before it counts
      multiRel: 0.55,      // second bubble this close to the darkest => multi
      minAspect: 0.40,
      maxAspect: 1.15,
      markers: null        // caller may pass 4 manual points (image space)
    }, options || {});

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const markers = opts.markers || detectMarkers(gray, w, h, opts);
    if (!markers) {
      return { ok: false, reason: 'markers-not-found', message: 'Corner markers not detected. Retake the photo with all four black squares visible, or place them by hand.' };
    }

    const dst = tpl.markers; // canonical marker positions, TL TR BR BL
    const H = homography(markers, dst);       // image -> canonical
    if (!H) return { ok: false, reason: 'degenerate', message: 'Could not compute the sheet transform.' };
    const Hinv = invert3x3(H);                // canonical -> image
    if (!Hinv) return { ok: false, reason: 'degenerate', message: 'Could not invert the sheet transform.' };

    const ex = expandTemplate(tpl);

    // ---- sample every bubble exactly once -----------------------------
    const qGrays = [];
    const flat = [];
    for (let i = 0; i < ex.questions.length; i++) {
      const qq = ex.questions[i];
      const gs = [];
      for (let o = 0; o < qq.bubbles.length; o++) {
        const g = bubbleGray(gray, w, h, Hinv, qq.bubbles[o][0], qq.bubbles[o][1], ex.rq);
        gs.push(g);
        flat.push(g);
      }
      qGrays.push(gs);
    }
    flat.sort(function (a, b) { return a - b; });
    const paperWhite = flat[Math.floor(flat.length * 0.90)] || 240;

    const darks = qGrays.map(function (gs) {
      return gs.map(function (g) { return Math.max(0, paperWhite - g); });
    });

    // what an empty bubble looks like on THIS sheet (lighting independent)
    const mins = darks.map(function (d) { return Math.min.apply(null, d); });
    const unfilled = median(mins);
    const dOpts = { relMin: opts.relMin, multiRel: opts.multiRel, unfilled: unfilled };

    const answers = [];
    for (let i = 0; i < darks.length; i++) {
      const d = decide(darks[i], dOpts);
      answers.push({
        q: i + 1,
        status: d.status,
        choice: d.choice,
        marks: d.marks,
        dark: darks[i].map(function (v) { return Math.round(v); })
      });
    }

    const fieldValues = {};
    const fieldFlags = {};
    for (let fi = 0; fi < ex.fields.length; fi++) {
      const f = ex.fields[fi];
      let str = '', flags = [];
      for (let d = 0; d < f.columns.length; d++) {
        const dark = f.columns[d].map(function (b) {
          const g = bubbleGray(gray, w, h, Hinv, b[0], b[1], f.r);
          return Math.max(0, paperWhite - g);
        });
        const dd = decide(dark, dOpts);
        if (dd.status === 'ok') str += f.labels.charAt(dd.choice);
        else { str += '?'; flags.push(d); }
      }
      fieldValues[f.key] = str;
      fieldFlags[f.key] = flags;
    }

    // quality: how decisive were the questions?
    let decisive = 0, total = answers.length;
    for (let i = 0; i < answers.length; i++) {
      const dk = answers[i].dark.slice().sort(function (a, b) { return b - a; });
      if (dk[0] - dk[1] > 25) decisive++;
    }
    const quality = total ? decisive / total : 0;

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    return {
      ok: true,
      markers: markers,
      homography: H,
      inverse: Hinv,
      paperWhite: paperWhite,
      unfilled: unfilled,
      fields: fieldValues,
      fieldFlags: fieldFlags,
      // kept so older callers keep working
      roll: fieldValues.roll || '',
      rollFlags: fieldFlags.roll || [],
      answers: answers,
      quality: quality,
      ms: Math.round(t1 - t0)
    };
  }

  /* ------------------------------------------------------------------ */
  /* scoring                                                             */
  /* ------------------------------------------------------------------ */

  function scoreSheet(result, key, overrides) {
    // key: array of option indices, -1 = ignore / not counted
    overrides = overrides || {};
    const rows = [];
    let correct = 0, wrong = 0, blank = 0, multi = 0, skipped = 0;
    for (let i = 0; i < result.answers.length; i++) {
      const a = result.answers[i];
      const qno = a.q;
      let choice = a.choice;
      let status = a.status;
      if (overrides[qno] !== undefined && overrides[qno] !== null) {
        choice = overrides[qno];
        status = 'ok';
      }
      const k = key[i];
      if (k === undefined || k === null || k < 0) { skipped++; continue; }
      if (status === 'multi') { multi++; continue; }
      if (status === 'blank' || choice < 0) { blank++; continue; }
      if (choice === k) correct++; else wrong++;
    }
    const attempted = correct + wrong;
    const scored = result.answers.length - skipped;
    return {
      correct: correct, wrong: wrong, blank: blank, multi: multi,
      skipped: skipped,
      total: result.answers.length,
      scored: scored,
      attempted: attempted,
      // headline score is out of the questions the key actually covers
      percent: scored ? Math.round((correct / scored) * 1000) / 10 : 0,
      // how often the student was right when they answered at all
      attemptPercent: attempted ? Math.round((correct / attempted) * 1000) / 10 : 0
    };
  }

  return {
    rgbaToGray: rgbaToGray,
    downscaleGray: downscaleGray,
    otsu: otsu,
    components: components,
    homography: homography,
    invert3x3: invert3x3,
    applyH: applyH,
    detectMarkers: detectMarkers,
    orderCorners: orderCorners,
    isConvex: isConvex,
    readSheet: readSheet,
    scoreSheet: scoreSheet,
    expandTemplate: expandTemplate
  };
});
