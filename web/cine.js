/* CardioLens cine library - dependency free (browser + Node >= 18). Port of cardiolens/cine.py, step for step; tests/test_cine.js checks both
 * give the same numbers on the built-in sample. Short-axis bright-blood cine MRI -> left-ventricle volumes, ejection fraction, contours, mesh.
 * It is classical image processing (no learned model, no manual contours): an automatic ESTIMATE with a sensitivity range, not a validated
 * clinical measurement. Pixels stay in the caller; results are numbers and contours.
 *
 *   CineLib.measure(cine, {centre, variants, onProgress}) -> Promise<result>
 *   CineLib.volumes(result, keepSlices)                   -> re-sum volumes for a different choice of slices (no re-tracking)
 *   CineLib.qc(result, cine)                              -> plain-language warnings
 *   CineLib.buildMesh(result, cine, keep)                 -> beating LV cavity surface (positions per phase, patient LPS mm)
 *   CineLib.fromSample(json)                              -> Promise<cine> from the embedded sample (gzip + temporal delta)
 */
(function (root) {
  'use strict';
  var NA = 72, RSTEP = 0.5, RMAX_MM = 60.0, MED_WIN = 13, LEVEL = 0.5, MINRUN_MM = 4.0, REFINE_MM = 4.0, SIGMA = 1.0,
    CLIP_LO = 0.65, CLIP_HI = 1.25, MAX_GROWTH = 1.6, MAX_SHIFT_MM = 15.0, MIN_AREA_MM2 = 25.0,
    VARIANTS = [[LEVEL, MED_WIN, SIGMA], [0.45, MED_WIN, SIGMA], [0.55, MED_WIN, SIGMA], [LEVEL, MED_WIN, 1.4], [LEVEL, MED_WIN + 2, 0.8]];
  var STEP = (2 * Math.PI) / NA, COS = new Float64Array(NA), SIN = new Float64Array(NA);
  for (var q = 0; q < NA; q++) { var a = q * STEP; COS[q] = Math.cos(a); SIN[q] = Math.sin(a); }
  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  /* Python's round(): halves go to the even integer */
  function pyround(x) { var f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1); }

  /* ---- numeric primitives (the same arithmetic as numpy / scipy.ndimage, so results agree to rounding) --------------------- */
  function npsum(a) {                                  // numpy's pairwise summation for short arrays
    var n = a.length, i, s = 0;
    if (n < 8) { for (i = 0; i < n; i++) s += a[i]; return s; }
    var r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
    for (i = 8; i < n - (n % 8); i += 8) for (var j = 0; j < 8; j++) r[j] += a[i + j];
    s = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) s += a[i];
    return s;
  }
  function kernel(sigma, truncate) {
    var r = Math.floor(truncate * sigma + 0.5), w = new Float64Array(2 * r + 1), f = -0.5 / (sigma * sigma), i;
    for (i = -r; i <= r; i++) w[i + r] = Math.exp(f * i * i);
    var s = npsum(w); for (i = 0; i < w.length; i++) w[i] /= s;
    return { r: r, w: w };
  }
  function gauss(src, H, W, sigma) {                   // scipy.ndimage.gaussian_filter(mode='nearest', truncate=3), axis 0 then axis 1
    var K = kernel(sigma, 3.0), r = K.r, w = K.w, tmp = new Float64Array(H * W), out = new Float64Array(H * W), x, y, k;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = src[y * W + x] * w[r];
      for (k = 1; k <= r; k++) t += (src[Math.min(y + k, H - 1) * W + x] + src[Math.max(y - k, 0) * W + x]) * w[r + k];
      tmp[y * W + x] = t;
    }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var u = tmp[y * W + x] * w[r];
      for (k = 1; k <= r; k++) u += (tmp[y * W + Math.min(x + k, W - 1)] + tmp[y * W + Math.max(x - k, 0)]) * w[r + k];
      out[y * W + x] = u;
    }
    return out;
  }
  function gauss1dWrap(v, sigma) {                     // scipy.ndimage.gaussian_filter1d(mode='wrap', truncate=4)
    var K = kernel(sigma, 4.0), r = K.r, w = K.w, n = v.length, out = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var t = v[i] * w[r];
      for (var k = 1; k <= r; k++) t += (v[(i + k) % n] + v[((i - k) % n + n) % n]) * w[r + k];
      out[i] = t;
    }
    return out;
  }
  function sortedCopy(a) { var c = Float64Array.from(a); c.sort(); return c; }
  function median(a) { var c = sortedCopy(a), n = c.length; return n % 2 ? c[(n - 1) >> 1] : (c[n / 2 - 1] + c[n / 2]) / 2; }
  function percentile(a, q) {                          // numpy.percentile, linear interpolation
    var c = sortedCopy(a), v = (c.length - 1) * (q / 100), lo = Math.floor(v), hi = Math.min(lo + 1, c.length - 1), t = v - lo, x = c[lo], y = c[hi];
    return t >= 0.5 ? y - (y - x) * (1 - t) : x + (y - x) * t;
  }
  function bilinear(img, H, W, x, y) {
    x = x < 0 ? 0 : x > W - 1 ? W - 1 : x; y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
    var x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1), fx = x - x0, fy = y - y0;
    return (1 - fy) * ((1 - fx) * img[y0 * W + x0] + fx * img[y0 * W + x1]) + fy * ((1 - fx) * img[y1 * W + x0] + fx * img[y1 * W + x1]);
  }
  function circMedian(v, w) {
    var n = v.length, pad = w >> 1, out = new Float64Array(n), win = new Float64Array(w);
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < w; k++) win[k] = v[(((i - pad + k) % n) + n) % n];
      win.sort(); out[i] = win[w >> 1];
    }
    return out;
  }

  /* ---- step 1: centre -------------------------------------------------------------------------------------------------- */
  function diskN(r) { var n = 0; for (var dy = -r; dy <= r; dy++) n += 2 * Math.floor(Math.sqrt(r * r - dy * dy)) + 1; return n; }
  function diskMean(img, H, W, r) {                    // mean over x^2+y^2 <= r^2, border replicated; row prefix sums
    var PW = W + 2 * r, PH = H + 2 * r, cs = new Float64Array(PH * (PW + 1)), acc = new Float64Array(H * W), n = 0, x, y, dy;
    for (y = 0; y < PH; y++) {
      var sy = Math.min(Math.max(y - r, 0), H - 1), s = 0, o = y * (PW + 1);
      for (x = 0; x < PW; x++) { s += img[sy * W + Math.min(Math.max(x - r, 0), W - 1)]; cs[o + x + 1] = s; }
    }
    for (dy = -r; dy <= r; dy++) {
      var hw = Math.floor(Math.sqrt(r * r - dy * dy)), rowBase = (r + dy) * (PW + 1);
      for (y = 0; y < H; y++) { var ro = rowBase + y * (PW + 1), ao = y * W; for (x = 0; x < W; x++) acc[ao + x] += cs[ro + r + hw + 1 + x] - cs[ro + r - hw + x]; }
      n += 2 * hw + 1;
    }
    for (var i = 0; i < acc.length; i++) acc[i] /= n;
    return acc;
  }
  function findCentre(mean, H, W, pxMm) {
    var m = gauss(mean, H, W, 1.5), hi = percentile(m, 99.5), best = null, mrg = pyround(24 / pxMm), r0 = pyround(17 / pxMm), r1 = pyround(46 / pxMm);
    for (var r = r0; r <= r1; r++) {
      var d = diskMean(m, H, W, r), a2 = diskMean(m, H, W, r + 6), a1 = diskMean(m, H, W, r + 2), n2 = diskN(r + 6), n1 = diskN(r + 2), bs = -Infinity, bx = 0, by = 0;
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = y * W + x, ring = (a2[i] * n2 - a1[i] * n1) / (n2 - n1), sc = d[i] > 0.45 * hi ? d[i] - ring : (d[i] - ring) * 0;
        if (y < mrg || y >= H - mrg || x < mrg || x >= W - mrg) sc = -1e9;
        if (sc > bs) { bs = sc; bx = x; by = y; }
      }
      if (best === null || bs > best[0]) best = [bs, bx, by, r];
    }
    return best;
  }
  function meanImage(cine, s) {
    var H = cine.H, W = cine.W, T = cine.T, m = new Float64Array(H * W);
    for (var t = 0; t < T; t++) { var f = cine.frames[s][t]; for (var i = 0; i < H * W; i++) m[i] += f[i]; }
    for (var j = 0; j < m.length; j++) m[j] /= T;
    return m;
  }
  function startCentre(cine) {
    var S = cine.S, c = [], lo = Math.max(0, (S >> 1) - 2), hi = Math.min(S, (S >> 1) + 3), best = null;
    for (var s = lo; s < hi; s++) {
      var f = findCentre(meanImage(cine, s), cine.H, cine.W, cine.px[0]);
      if (f && (best === null || f[0] > best[0] || (f[0] === best[0] && s > best[1]))) best = [f[0], s, f];
    }
    if (!best || !(best[0] > 0)) throw new Error('No left-ventricle-like bright disk was found. This tool expects bright-blood short-axis cine; click the left ventricle to set its centre.');
    return { s0: best[1], cx: best[2][1], cy: best[2][2], r0: best[2][3] };
  }

  /* ---- step 2: boundary tracking ----------------------------------------------------------------------------------------- */
  function track(sm, H, W, cx, cy, r0, pxMm, level, med) {
    var rmax = RMAX_MM / pxMm, NR = Math.ceil(rmax / RSTEP), prof = new Float64Array(NA * NR), k, i;
    for (k = 0; k < NA; k++) for (i = 0; i < NR; i++) { var rr = i * RSTEP; prof[k * NR + i] = bilinear(sm, H, W, cx + COS[k] * rr, cy + SIN[k] * rr); }
    var inner = [], ring = [];
    for (i = 0; i < NR; i++) { var r = i * RSTEP, a = r < 0.5 * r0, b = r > r0 && r < 1.5 * r0; if (a || b) for (k = 0; k < NA; k++) (a ? inner : ring).push(prof[k * NR + i]); }
    var blood = median(inner), wall = percentile(ring, 15), thr = wall + level * (blood - wall),
      run = Math.max(2, pyround(MINRUN_MM / pxMm / RSTEP)), ref = Math.max(1, pyround(REFINE_MM / pxMm / RSTEP)), i0 = Math.floor(0.3 * r0 / RSTEP),
      rb = new Float64Array(NA), nopen = 0;
    for (k = 0; k < NA; k++) {
      var o = k * NR, j = NR - 1;
      for (i = i0; i < NR - run; i++) {
        if (!(prof[o + i] < thr)) continue;
        var all = true; for (var q = 1; q < run; q++) if (!(prof[o + i + q] < thr)) { all = false; break; }
        if (all) { j = i; break; }
      }
      if (j >= NR - 1) nopen++;
      else {
        var lo = Math.max(i0, j - ref), hi = Math.min(NR - 1, j + ref), bg = -Infinity, bj = lo;
        for (var t = lo; t <= hi; t++) {                // steepest descent: -gradient, central differences (one-sided at the ends)
          var g = t === 0 ? -(prof[o + 1] - prof[o]) / RSTEP : t === NR - 1 ? -(prof[o + NR - 1] - prof[o + NR - 2]) / RSTEP : -(prof[o + t + 1] - prof[o + t - 1]) / (2.0 * RSTEP);
          if (g > bg) { bg = g; bj = t; }
        }
        j = bj;
      }
      rb[k] = j * RSTEP;
    }
    return { rb: gauss1dWrap(circMedian(rb, med), 1.0), open: nopen / NA };
  }
  function polarArea(rb) {
    var s = new Float64Array(NA);
    for (var i = 0; i < NA; i++) { var j = (i + 1) % NA; s[i] = rb[i] * COS[i] * (rb[j] * SIN[j]) - rb[j] * COS[j] * (rb[i] * SIN[i]); }
    return 0.5 * Math.abs(npsum(s));
  }
  function centroidOf(rb, cx, cy) {
    var cr = new Float64Array(NA), sx = new Float64Array(NA), sy = new Float64Array(NA), i, j;
    for (i = 0; i < NA; i++) {
      j = (i + 1) % NA;
      var x = cx + rb[i] * COS[i], y = cy + rb[i] * SIN[i], x1 = cx + rb[j] * COS[j], y1 = cy + rb[j] * SIN[j];
      cr[i] = x * y1 - x1 * y; sx[i] = (x + x1) * cr[i]; sy[i] = (y + y1) * cr[i];
    }
    var a = npsum(cr) / 2;
    return [npsum(sx) / (6 * a), npsum(sy) / (6 * a)];
  }
  function medianOverPhases(R, T) {                    // R: Float64Array(T*NA) -> per-angle median
    var out = new Float64Array(NA), col = new Float64Array(T);
    for (var k = 0; k < NA; k++) { for (var t = 0; t < T; t++) col[t] = R[t * NA + k]; out[k] = median(col); }
    return out;
  }

  /* ---- step 3-5: stack ----------------------------------------------------------------------------------------------------- */
  function trackSlice(cine, s, cx, cy, r0, level, med, sigma) {
    var H = cine.H, W = cine.W, T = cine.T, sm = [], t;
    for (t = 0; t < T; t++) sm.push(gauss(cine.frames[s][t], H, W, sigma));
    var R = new Float64Array(T * NA), open = 0;
    for (var it = 0; it < 2; it++) {
      open = 0;
      for (t = 0; t < T; t++) { var o = track(sm[t], H, W, cx, cy, r0, cine.px[0], level, med); R.set(o.rb, t * NA); open += o.open; }
      var mc = medianOverPhases(R, T), c = centroidOf(mc, cx, cy); cx = c[0]; cy = c[1]; r0 = Math.max(6.0, Math.sqrt(polarArea(mc) / Math.PI));
    }
    return { R: R, state: [cx, cy, r0], open: open / T };
  }
  async function traceStack(cine, level, med, sigma, st, yieldFn) {
    var S = cine.S, res = {}, s0 = st.s0, state0 = [st.cx, st.cy, st.r0];
    for (var dir = -1; dir <= 1; dir += 2) {
      var state = state0, s = dir === -1 ? s0 : s0 + 1;
      while (s >= 0 && s < S) {
        var o = trackSlice(cine, s, state[0], state[1], state[2], level, med, sigma);
        res[s] = { R: o.R, centre: [o.state[0], o.state[1]], r0: o.state[2], open: o.open };
        state = o.state; if (dir === -1 && s === s0) state0 = o.state;
        s += dir;
        if (yieldFn) await yieldFn();
      }
    }
    return { res: res, s0: s0 };
  }
  function repair(R, T) {
    var med = medianOverPhases(R, T), out = new Float64Array(R.length);
    for (var t = 0; t < T; t++) for (var k = 0; k < NA; k++) { var v = R[t * NA + k], lo = CLIP_LO * med[k], hi = CLIP_HI * med[k]; out[t * NA + k] = v < lo ? lo : v > hi ? hi : v; }
    return out;
  }
  function areasPerPhase(R, T) { var a = new Float64Array(T); for (var t = 0; t < T; t++) a[t] = polarArea(R.subarray(t * NA, (t + 1) * NA)); return a; }
  function selectSlices(res, s0, pxMm, S) {
    var A = {}, keep = {}; keep[s0] = 1;
    Object.keys(res).forEach(function (s) { var ar = areasPerPhase(res[s].R, res[s].R.length / NA), c = new Float64Array(ar); A[s] = median(c) * (pxMm * pxMm); });
    [-1, 1].forEach(function (dir) {
      var prev = s0, s = s0 + dir;
      while (res[s]) {
        var a = A[s], ap = A[prev], dx = res[s].centre[0] - res[prev].centre[0], dy = res[s].centre[1] - res[prev].centre[1], shift = Math.hypot(dx, dy) * pxMm;
        if (a < MIN_AREA_MM2 || shift > MAX_SHIFT_MM || a / Math.max(ap, 1e-9) > MAX_GROWTH) break;
        keep[s] = 1; prev = s; s += dir;
      }
    });
    return { keep: Object.keys(keep).map(Number).sort(function (a, b) { return a - b; }), medArea: A };
  }
  function volumesFrom(areas, keep, dz, T) {
    var V = new Float64Array(T), i, t;
    for (t = 0; t < T; t++) { var s = 0; for (i = 0; i < keep.length; i++) s += areas[keep[i]][t]; V[t] = s * dz / 1000.0; }
    var Vs = new Float64Array(T);
    for (t = 0; t < T; t++) Vs[t] = ((V[(t - 1 + T) % T] + V[t]) + V[(t + 1) % T]) / 3.0;
    var ed = 0, es = 0; for (t = 1; t < T; t++) { if (Vs[t] > Vs[ed]) ed = t; if (Vs[t] < Vs[es]) es = t; }
    var edv = Vs[ed], esv = Vs[es];
    return { V: V, Vs: Vs, ed: ed, es: es, edv: edv, esv: esv, sv: edv - esv, ef: 100.0 * (edv - esv) / edv };
  }
  /** re-sum the volumes for another choice of slices (the contours are not re-computed) */
  function volumes(M, keep) {
    var ks = keep.slice().sort(function (a, b) { return a - b; });
    if (!ks.length) return null;
    var v = volumesFrom(M.areas, ks, M.dz, M.T); v.keep = ks;
    /* the spread: every segmentation setting keeps the slices it chose itself; the person's edits (slices switched off / on relative to the automatic choice) are applied on top of each */
    var VA = M.variantAreas || [M.areas], VK = M.variants ? M.variants.map(function (x) { return x.keep; }) : [M.keep], auto = M.keep, curves = [], st = [],
      removed = auto.filter(function (x) { return ks.indexOf(x) < 0; }), added = ks.filter(function (x) { return auto.indexOf(x) < 0; });
    VA.forEach(function (ar, i) {
      var set = VK[i].filter(function (x) { return removed.indexOf(x) < 0; });
      added.forEach(function (x) { if (set.indexOf(x) < 0) set.push(x); });
      if (!set.length) return;
      set.sort(function (a, b) { return a - b; });
      var m = volumesFrom(ar, set, M.dz, M.T); curves.push(m.Vs); st.push([m.ef, m.edv, m.esv]);
    });
    var col = function (i) { return st.map(function (r) { return r[i]; }); }, rng = function (a) { return [Math.min.apply(null, a), Math.max.apply(null, a)]; };
    v.spread = { ef: rng(col(0)), edv: rng(col(1)), esv: rng(col(2)), n: st.length, curves: curves };
    return v;
  }

  /** full measurement; resolves to the base result plus the spread over the segmentation settings */
  async function measure(cine, opts) {
    opts = opts || {};
    var variants = opts.variants === false ? VARIANTS.slice(0, 1) : VARIANTS, out = null, curves = [], stats = [], vres = [],
      work = variants.length * cine.S, done = 0, T = cine.T, vAreas = [];
    await tick();
    var start = opts.centre ? { s0: opts.centre[0], cx: opts.centre[1], cy: opts.centre[2], r0: 20.0 / cine.px[0] } : startCentre(cine);
    for (var v = 0; v < variants.length; v++) {
      var lv = variants[v], tr = await traceStack(cine, lv[0], lv[1], lv[2], start, async function () {
        done++; if (opts.onProgress) opts.onProgress(Math.min(1, done / (work * 1.0))); await tick();
      }), sel = selectSlices(tr.res, tr.s0, cine.px[0], cine.S), areas = {}, rep = {};
      Object.keys(tr.res).forEach(function (s) {
        rep[s] = repair(tr.res[s].R, T);
        var ar = areasPerPhase(rep[s], T); for (var t = 0; t < T; t++) ar[t] *= cine.px[0] * cine.px[0]; areas[s] = ar;
      });
      var m = volumesFrom(areas, sel.keep, cine.dz, T);
      curves.push(m.Vs); stats.push([m.ef, m.edv, m.esv]); vAreas.push(areas);
      vres.push({ level: lv[0], median_window: lv[1], sigma: lv[2], keep: sel.keep, ef: m.ef, edv: m.edv, esv: m.esv, ed: m.ed, es: m.es });
      if (v === 0) {
        Object.keys(tr.res).forEach(function (s) { tr.res[s].Rr = rep[s]; });
        out = { s0: tr.s0, keep: sel.keep, res: tr.res, areas: areas, medArea: sel.medArea, px: cine.px[0], dz: cine.dz, S: cine.S, T: T, ed: m.ed, es: m.es,
          edv: m.edv, esv: m.esv, sv: m.sv, ef: m.ef, V: m.V, Vs: m.Vs };
      }
    }
    var col = function (i) { return stats.map(function (r) { return r[i]; }); }, rng = function (a) { return [Math.min.apply(null, a), Math.max.apply(null, a)]; };
    out.spread = { ef: rng(col(0)), edv: rng(col(1)), esv: rng(col(2)), n: stats.length, curves: curves };
    out.variants = vres; out.variantAreas = vAreas;
    out.hr = cine.hr_bpm || null; out.co = out.hr ? out.sv * out.hr / 1000.0 : null;
    out.nominal_ms = cine.rr_ms ? cine.rr_ms.reduce(function (a, b) { return a + b; }, 0) / cine.rr_ms.length : null;
    out.warnings = qc(out, cine);
    return out;
  }

  /* ---- plain-language quality warnings --------------------------------------------------------------------------------- */
  function qc(M, cine) {
    var w = [], n = M.keep.length;
    if (n < 5) w.push('Only ' + n + ' slice(s) were accepted as left ventricle, so the volumes are rough. Switch slices on in the list if they look right.');
    if (n === cine.S) w.push('Every slice was accepted, including the ends. Check the first and last slice: an atrium or the aortic root there would inflate the volume.');
    if (M.ef < 5 || M.ef > 85) w.push('The ejection fraction (' + M.ef.toFixed(0) + '%) is outside the plausible range; check the contours and the LV centre.');
    var d = M.spread.ef[1] - M.spread.ef[0]; if (d > 10) w.push('The result is sensitive to the segmentation settings (EF range ' + M.spread.ef[0].toFixed(0) + '-' + M.spread.ef[1].toFixed(0) + '%): treat it as rough.');
    var T = cine.T; if (M.ed > 0.3 * T && M.ed < 0.7 * T) w.push('End-diastole was found mid-cycle (phase ' + (M.ed + 1) + ' of ' + T + '); check that the series covers one full heartbeat.');
    Object.keys(M.res).forEach(function (s) { if (M.res[s].open > 0.25 && M.keep.indexOf(+s) >= 0) w.push('Slice ' + (+s + 1) + ': the wall was not found around ' + Math.round(100 * M.res[s].open) + '% of the contour.'); });
    (cine.warnings || []).forEach(function (x) { w.push(x); });
    return w;
  }

  /* ---- 3D: the beating cavity surface --------------------------------------------------------------------------------- */
  function buildMesh(M, cine, keepIn) {
    var T = cine.T, keep = (keepIn || M.keep).slice().sort(function (a, b) { return a - b; });
    if (keep.length < 2) return null;
    if (M.medArea[keep[0]] < M.medArea[keep[keep.length - 1]]) keep.reverse();           // index 0 = base (larger cavity), last = apex
    var iop = cine.iop, fr = iop.slice(0, 3), fc = iop.slice(3), dr = cine.px[0], dc = cine.px[1], dz = cine.dz,
      nrm = [fr[1] * fc[2] - fr[2] * fc[1], fr[2] * fc[0] - fr[0] * fc[2], fr[0] * fc[1] - fr[1] * fc[0]],
      bI = cine.ipp[keep[0]], aI = cine.ipp[keep[keep.length - 1]], sg = (nrm[0] * (aI[0] - bI[0]) + nrm[1] * (aI[1] - bI[1]) + nrm[2] * (aI[2] - bI[2])) >= 0 ? 1 : -1,
      u = [nrm[0] * sg, nrm[1] * sg, nrm[2] * sg], Mn = keep.length, R = Mn + 4, nV = R * NA + 2, idx = [], phases = [], mv = [], t, m, j;
    for (m = 0; m < R - 1; m++) for (j = 0; j < NA; j++) {
      var a = m * NA + j, b = m * NA + (j + 1) % NA, c = (m + 1) * NA + j, d = (m + 1) * NA + (j + 1) % NA; idx.push(a, c, b, b, c, d);
    }
    var pb = R * NA, pa = R * NA + 1;
    for (j = 0; j < NA; j++) { idx.push(pb, j, (j + 1) % NA); idx.push(pa, (R - 1) * NA + (j + 1) % NA, (R - 1) * NA + j); }
    var index = new Uint16Array(idx);
    for (t = 0; t < T; t++) {
      var P = new Float32Array(nV * 3), ring = [];
      for (m = 0; m < Mn; m++) {
        var s = keep[m], cen = M.res[s].centre, Rr = M.res[s].Rr, ip = cine.ipp[s], pts = new Float64Array(NA * 3);
        for (j = 0; j < NA; j++) {
          var rr = Rr[t * NA + j], x = cen[0] + rr * COS[j], y = cen[1] + rr * SIN[j];
          for (var q = 0; q < 3; q++) pts[j * 3 + q] = ip[q] + x * dc * fr[q] + y * dr * fc[q];
        }
        ring.push(pts);
      }
      var cent = function (pts) { var c = [0, 0, 0]; for (var i = 0; i < NA; i++) for (var q = 0; q < 3; q++) c[q] += pts[i * 3 + q] / NA; return c; },
        shift = function (pts, k) { var o = new Float64Array(pts.length); for (var i = 0; i < NA; i++) for (var q = 0; q < 3; q++) o[i * 3 + q] = pts[i * 3 + q] + u[q] * k; return o; },
        first = ring[0], last = ring[Mn - 1], all = [shift(first, -0.5 * dz)].concat(ring), cLast = cent(last), areaLast = M.areas[keep[Mn - 1]][t],
        req = Math.sqrt(areaLast / Math.PI), L = Math.max(3.0, 0.6 * req);
      all.push(shift(last, 0.5 * dz));
      [0.6, 0.9].forEach(function (h) {
        var o = new Float64Array(NA * 3), f = Math.sqrt(1 - h * h);
        for (var i = 0; i < NA; i++) for (var q = 0; q < 3; q++) o[i * 3 + q] = cLast[q] + u[q] * (0.5 * dz + L * h) + (last[i * 3 + q] - cLast[q]) * f;
        all.push(o);
      });
      for (m = 0; m < R; m++) for (j = 0; j < NA * 3; j++) P[m * NA * 3 + j] = all[m][j];
      var c0 = cent(all[0]), c1 = [cLast[0] + u[0] * (0.5 * dz + L), cLast[1] + u[1] * (0.5 * dz + L), cLast[2] + u[2] * (0.5 * dz + L)];
      for (var q2 = 0; q2 < 3; q2++) { P[pb * 3 + q2] = c0[q2]; P[pa * 3 + q2] = c1[q2]; }
      phases.push(P);
    }
    var vol = function (P) {                           // signed volume of the closed surface, mL
      var s = 0; for (var i = 0; i < index.length; i += 3) {
        var a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
        s += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
      } return s / 6 / 1000;
    };
    if (vol(phases[0]) < 0) for (var i2 = 0; i2 < index.length; i2 += 3) { var tt = index[i2 + 1]; index[i2 + 1] = index[i2 + 2]; index[i2 + 2] = tt; }
    for (t = 0; t < T; t++) mv.push(vol(phases[t]));
    var cd = [0, 0, 0], ed = phases[M.ed]; for (var v = 0; v < R * NA; v++) for (var k3 = 0; k3 < 3; k3++) cd[k3] += ed[v * 3 + k3] / (R * NA);
    return { nVert: nV, rings: R, NA: NA, index: index, phases: phases, mesh_volume_ml: mv, axis: u, centroid: cd, ed: M.ed, es: M.es, keep: keep, hr: M.hr, T: T };
  }

  /* ---- the built-in sample -------------------------------------------------------------------------------------------- */
  async function fromSample(j) {
    var bin = typeof atob === 'function' ? Uint8Array.from(atob(j.data), function (c) { return c.charCodeAt(0); }) : new Uint8Array(Buffer.from(j.data, 'base64'));
    var raw = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
      S = j.shape[0], T = j.shape[1], H = j.shape[2], W = j.shape[3], n = H * W, k, t, i;
    for (k = 0; k < S; k++) for (t = 1; t < T; t++) { var o = (k * T + t) * n, p = (k * T + t - 1) * n; for (i = 0; i < n; i++) raw[o + i] = (raw[o + i] + raw[p + i]) & 255; }
    var frames = [], iop = j.iop, nrm = [iop[1] * iop[5] - iop[2] * iop[4], iop[2] * iop[3] - iop[0] * iop[5], iop[0] * iop[4] - iop[1] * iop[3]],
      pp = j.ipp.map(function (p) { return p[0] * nrm[0] + p[1] * nrm[1] + p[2] * nrm[2]; });
    for (k = 0; k < S; k++) { var f = []; for (t = 0; t < T; t++) f.push(raw.subarray((k * T + t) * n, (k * T + t + 1) * n)); frames.push(f); }
    return { kind: 'cine', S: S, T: T, H: H, W: W, px: j.px_mm.slice(), iop: iop.slice(), ipp: j.ipp.map(function (p) { return p.slice(); }), dz: Math.abs(pp[S - 1] - pp[0]) / (S - 1),
      trigger_ms: j.trigger_ms, rr_ms: j.rr_ms, hr_bpm: j.hr_bpm, frames: frames, peak: 255, slice_thickness_mm: j.slice_thickness_mm, field_strength_t: j.field_strength_t,
      scanner: j.scanner, description: j.name, warnings: [], sample: true, name: j.name, source: j.source, citation: j.citation, licence: j.licence };
  }

  root.CineLib = { measure: measure, volumes: volumes, qc: qc, buildMesh: buildMesh, fromSample: fromSample, NA: NA, ANG: { cos: COS, sin: SIN }, VARIANTS: VARIANTS,
    _p: { gauss: gauss, findCentre: findCentre, polarArea: polarArea, percentile: percentile, median: median, circMedian: circMedian, kernel: kernel, npsum: npsum, repair: repair } };
})(typeof module !== 'undefined' ? module.exports : window);
