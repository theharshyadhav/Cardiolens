/* CardioLens scan library - dependency free (browser + Node). Voxels stay in the caller; only measurements are derived. */
(function (root) {
  'use strict';
  var T = { 2: Uint8Array, 4: Int16Array, 8: Int32Array, 16: Float32Array, 64: Float64Array, 256: Int8Array, 512: Uint16Array, 768: Uint32Array };
  var NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  async function gunzip(u) { return new Uint8Array(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }

  /** NIfTI-1 (.nii / .nii.gz, little-endian) -> {dims, sp(mm), data: Float32Array with scl_slope/inter applied (true HU for CT)} */
  async function parseNifti(buf) {
    var u = new Uint8Array(buf); if (u[0] === 31 && u[1] === 139) u = await gunzip(u);
    var v = new DataView(u.buffer, u.byteOffset, u.byteLength);
    if (v.byteLength < 352 || v.getInt32(0, true) !== 348) throw new Error('Only little-endian NIfTI-1 (.nii / .nii.gz) is supported');
    var d = [1, 2, 3].map(function (i) { return v.getInt16(40 + 2 * i, true); }),
      sp = [1, 2, 3].map(function (i) { return Math.abs(v.getFloat32(76 + 4 * i, true)) || 1; }),
      C = T[v.getInt16(70, true)], off = v.getFloat32(108, true), sl = v.getFloat32(112, true) || 1, ic = v.getFloat32(116, true) || 0;
    if (!C) throw new Error('Unsupported NIfTI datatype ' + v.getInt16(70, true));
    var n = d[0] * d[1] * d[2], b = C.BYTES_PER_ELEMENT;
    if (!(n > 0) || n > 2e8 || u.byteLength < off + n * b) throw new Error('Invalid or truncated NIfTI volume');
    var raw = new C(u.buffer.slice(u.byteOffset + off, u.byteOffset + off + n * b)), data = new Float32Array(n);
    for (var i = 0; i < n; i++) data[i] = raw[i] * sl + ic;
    return { dims: d, sp: sp, data: data };
  }

  /** 6-connected components with HU in [min,max]. Returns {list (largest first), L (label per voxel), map (rawLabel->id)}.
   *  agatston = simplified Agatston-style score: sum over slices of area(mm2) * density weight(1..4 by slice peak HU) * (thickness/3mm). */
  function regions(vol, o) {
    var nx = vol.dims[0], ny = vol.dims[1], nz = vol.dims[2], sx = vol.sp[0], sy = vol.sp[1], sz = vol.sp[2],
      N = nx * ny * nz, D = vol.data, L = new Int32Array(N), st = [], out = [], mm3 = sx * sy * sz, id = 0;
    function ok(i) { return D[i] >= o.min && D[i] <= o.max; }
    for (var s = 0; s < N; s++) {
      if (L[s] || !ok(s)) continue;
      id++; L[s] = id; st.push(s);
      var c = 0, X = 0, Y = 0, Z = 0, sum = 0, pk = -1e9, lo = [nx, ny, nz], hi = [-1, -1, -1], sl = {};
      while (st.length) {
        var i = st.pop(), x = i % nx, y = ((i - x) / nx) % ny, z = Math.floor(i / (nx * ny)), v = D[i];
        c++; X += x; Y += y; Z += z; sum += v; if (v > pk) pk = v;
        if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
        if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
        var a = sl[z] || (sl[z] = { n: 0, pk: -1e9 }); a.n++; if (v > a.pk) a.pk = v;
        for (var k = 0; k < 6; k++) {
          var cx = x + NB[k][0], cy = y + NB[k][1], cz = z + NB[k][2];
          if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) continue;
          var j = cx + cy * nx + cz * nx * ny; if (L[j] || !ok(j)) continue; L[j] = id; st.push(j);
        }
      }
      if (c * mm3 < (o.minMm3 || 0)) continue;
      var ag = 0; for (var q in sl) { var e = sl[q], w = e.pk >= 400 ? 4 : e.pk >= 300 ? 3 : e.pk >= 200 ? 2 : e.pk >= 130 ? 1 : 0; ag += e.n * sx * sy * w * (sz / 3); }
      out.push({ label: id, voxels: c, volume_mm3: c * mm3, peak_hu: pk, mean_hu: sum / c, centroid: [X / c, Y / c, Z / c],
        extent_mm: Math.max((hi[0] - lo[0] + 1) * sx, (hi[1] - lo[1] + 1) * sy, (hi[2] - lo[2] + 1) * sz), agatston: ag });
    }
    out.sort(function (a, b) { return b.volume_mm3 - a.volume_mm3; });
    var map = {}; out.forEach(function (r, i) { r.id = i + 1; map[r.label] = r.id; });
    var base = { list: out, L: L, map: map, out: {}, excluded: 0, excluded_mm3: 0 };
    return o.box ? restrict(base, vol, o.box) : base;
  }

  /* ---- heart box ----------------------------------------------------------------------------------------------------
   * A box is {min:[x,y,z], max:[x,y,z]} in millimetres in the scan's own frame: mm = voxel index x spacing, so the centre of the first
   * voxel is 0 mm and x, y, z follow the stored voxel axes. This is the frame `centroid_mm` is reported in.
   * RULE: a candidate region counts only if its centroid lies inside the box (edges included). Components are found on the whole scan
   * first, so a region inside the box has exactly the same volume, peak and score with or without the box. */
  function fovMm(vol) { return [(vol.dims[0] - 1) * vol.sp[0], (vol.dims[1] - 1) * vol.sp[1], (vol.dims[2] - 1) * vol.sp[2]]; }
  function wholeBox(vol) { return { min: [0, 0, 0], max: fovMm(vol) }; }
  function inBox(centroidVox, sp, b) {
    for (var i = 0; i < 3; i++) { var m = centroidVox[i] * sp[i]; if (m < b.min[i] - 1e-6 || m > b.max[i] + 1e-6) return false; }
    return true;
  }
  /** Re-filter an unrestricted result by a box without recomputing components. Ids are re-ranked by volume inside the box; `label`
   *  (the component) is stable, so vessel assignments can be keyed by it. `out` marks excluded labels (for display). */
  function restrict(res, vol, box) {
    var base = res.all || res, list = [], map = {}, out = {}, ex = 0, exv = 0;
    base.list.forEach(function (r) {
      if (!box || inBox(r.centroid, vol.sp, box)) { var q = {}; for (var k in r) q[k] = r[k]; q.id = list.length + 1; list.push(q); map[r.label] = q.id; }
      else { ex++; exv += r.volume_mm3; out[r.label] = 1; }
    });
    return { list: list, L: base.L, map: map, out: out, excluded: ex, excluded_mm3: exv, all: base };
  }

  /* ---- suggested heart box: a documented GUESS, not a segmentation --------------------------------------------------------
   * Typical adult heart with its coronary arteries: 150 (left-right) x 130 (front-back) x 140 (head-foot) mm = HEART_MM.
   * 1. LUNGS. On a coarse grid (cells of about 4 mm) air is HU < -400. In every axial slice an air cell is "inside the patient" when
   *    tissue lies on both sides of it in its row and on both sides in its column (so a field of view that cuts the body still
   *    works); inside-air pieces of at least 8 cm2 are lung.
   * 2. LEFT-RIGHT and HEAD-FOOT. In every row of a lung slice the two lungs leave a gap (heart, mediastinum). The widest gap of a slice
   *    (median of 3 rows) is the heart's width there. The heart level is the longest run of slices whose widest gap is at least 75 % of
   *    the widest of all. x = the median widest gap +/- 15 mm; z = that run, widened to 140 mm.
   * 3. FRONT-BACK. The heart's front is where the lungs first part in front of the widest row (the lungs touch in front of the heart);
   *    the box starts 10 mm before that and is 0.62 x the lung depth deep (105-130 mm), which stops short of the spine.
   *    The front is the top of the axial image; vol.frontAtTop === false flips it (DICOM sets it from the orientation tags, NIfTI is
   *    assumed to be displayed front-up).
   * 4. SANITY. Fewer than two lungs, a gap outside 60-190 mm, or a missing heart level -> basis 'central_fov': the central
   *    150 x 130 x 140 mm of the scan, clipped to the scan. Both outcomes are labelled as a guess in the UI. */
  var HEART_MM = [150, 130, 140];
  function suggestHeartBox(vol) {
    var nx = vol.dims[0], ny = vol.dims[1], nz = vol.dims[2], sp = vol.sp, D = vol.data, fov = fovMm(vol), i, x, y, z, q;
    function central(why) {
      var mn = [], mx = [];
      for (var a = 0; a < 3; a++) { var h = Math.min(HEART_MM[a], fov[a]); mn[a] = (fov[a] - h) / 2; mx[a] = mn[a] + h; }
      return { min: mn, max: mx, basis: 'central_fov', why: why };
    }
    var k = [0, 1, 2].map(function (a) { return Math.max(1, Math.round(4 / sp[a])); }), gx = Math.ceil(nx / k[0]), gy = Math.ceil(ny / k[1]), gz = Math.ceil(nz / k[2]);
    function at(c, a, n) { return Math.min(n - 1, c * k[a] + (k[a] >> 1)); }                 // voxel index sampled for coarse cell c
    var vx = [], vy = [], vz = [];
    for (i = 0; i < gx; i++) vx.push(at(i, 0, nx)); for (i = 0; i < gy; i++) vy.push(at(i, 1, ny)); for (i = 0; i < gz; i++) vz.push(at(i, 2, nz));
    var n2 = gx * gy, cell2 = k[0] * sp[0] * k[1] * sp[1], minCells = Math.max(4, Math.round(800 / cell2)),
      lung = new Uint8Array(n2 * gz), la = [], col = [], A = new Uint8Array(n2), M = new Uint8Array(n2), E = new Uint8Array(n2), U = new Uint8Array(n2), stack = new Int32Array(n2), comp = new Int32Array(n2);
    function flood(s0) {                                                                  // 4-connected component of A from s0; cells -> comp[], returns count
      var t = 0, c = 0; stack[t++] = s0; M[s0] = 1;
      while (t) {
        var j = stack[--t], jx = j % gx, jy = (j - jx) / gx; comp[c++] = j;
        if (jx > 0 && A[j - 1] && !M[j - 1]) { M[j - 1] = 1; stack[t++] = j - 1; }
        if (jx < gx - 1 && A[j + 1] && !M[j + 1]) { M[j + 1] = 1; stack[t++] = j + 1; }
        if (jy > 0 && A[j - gx] && !M[j - gx]) { M[j - gx] = 1; stack[t++] = j - gx; }
        if (jy < gy - 1 && A[j + gx] && !M[j + gx]) { M[j + gx] = 1; stack[t++] = j + gx; }
      }
      return c;
    }
    for (z = 0; z < gz; z++) {
      var zo = vz[z] * nx * ny, cnt = 0, cl = new Int32Array(gx), seen;
      for (y = 0; y < gy; y++) for (x = 0; x < gx; x++) A[x + y * gx] = D[vx[x] + vy[y] * nx + zo] < -400 ? 1 : 0;
      for (y = 0; y < gy; y++) {                                                          // tissue to the left AND right of the cell (E); above AND below (U)
        seen = 0; for (x = 0; x < gx; x++) { i = x + y * gx; E[i] = seen; if (!A[i]) seen = 1; }
        seen = 0; for (x = gx - 1; x >= 0; x--) { i = x + y * gx; E[i] &= seen; if (!A[i]) seen = 1; }
      }
      for (x = 0; x < gx; x++) {
        seen = 0; for (y = 0; y < gy; y++) { i = x + y * gx; U[i] = seen; if (!A[i]) seen = 1; }
        seen = 0; for (y = gy - 1; y >= 0; y--) { i = x + y * gx; U[i] &= seen; if (!A[i]) seen = 1; }
      }
      for (i = 0; i < n2; i++) A[i] = A[i] && E[i] && U[i] ? 1 : 0;
      M.fill(0);
      for (i = 0; i < n2; i++) if (A[i] && !M[i]) { var m = flood(i); if (m >= minCells) { for (q = 0; q < m; q++) { lung[z * n2 + comp[q]] = 1; cl[comp[q] % gx]++; } cnt += m; } }
      la.push(cnt); col.push(cl);
    }
    var maxLa = Math.max.apply(null, la);
    if (maxLa * cell2 < 4000) return central('no lungs were found in this scan');
    var info = [], wmax = 0;
    for (z = 0; z < gz; z++) {                                                            // per slice: the row where the two lungs are furthest apart
      info.push(null); if (la[z] < 0.25 * maxLa) continue;
      var rw = new Float64Array(gy), ra = new Float64Array(gy), rb = new Float64Array(gy), ws = new Float64Array(gy), top = 0, ty = -1;
      for (y = 0; y < gy; y++) {
        var o0 = z * n2 + y * gx, f = -1, l = -1, best = null, run = -1, left = 0, right = 0;
        for (x = 0; x < gx; x++) if (lung[o0 + x]) { if (f < 0) f = x; l = x; }
        if (f < 0 || l - f < 4) continue;
        for (x = f; x <= l; x++) { if (!lung[o0 + x]) { if (run < 0) run = x; } else if (run >= 0) { if (!best || x - run > best[1] - best[0]) best = [run, x]; run = -1; } }
        if (!best) continue;
        for (x = f; x < best[0]; x++) left += lung[o0 + x]; for (x = best[1]; x <= l; x++) right += lung[o0 + x];
        if (left < 3 || right < 3) continue;                                              // a gap needs lung on both sides
        ra[y] = vx[best[0] - 1] * sp[0]; rb[y] = vx[best[1]] * sp[0]; rw[y] = rb[y] - ra[y];
      }
      for (y = 1; y < gy - 1; y++) { var t3 = [rw[y - 1], rw[y], rw[y + 1]].sort(function (p, r) { return p - r; })[1]; ws[y] = t3; if (t3 > top) { top = t3; ty = y; } }   // median of 3 rows
      if (ty < 0) continue;
      var yy = rw[ty] === top ? ty : rw[ty - 1] === top ? ty - 1 : ty + 1, y1 = ty, y2 = ty;
      while (y1 > 1 && ws[y1 - 1] > 0) y1--; while (y2 < gy - 2 && ws[y2 + 1] > 0) y2++;  // the block of rows with a gap around the widest one
      info[z] = { w: top, a: ra[yy], b: rb[yy], yTop: vy[y1] * sp[1], yBot: vy[y2] * sp[1] }; if (top > wmax) wmax = top;
    }
    if (!(wmax > 0)) return central('no gap between two lungs was found');
    var run2 = null, cur = null;
    for (z = 0; z < gz; z++) {
      if (info[z] && info[z].w >= 0.75 * wmax) { if (!cur) cur = { z0: z, z1: z }; else cur.z1 = z; if (!run2 || cur.z1 - cur.z0 > run2.z1 - run2.z0) run2 = { z0: cur.z0, z1: cur.z1 }; } else cur = null;
    }
    function med(arr) { arr.sort(function (p, r) { return p - r; }); return arr[arr.length >> 1]; }
    var as = [], bs = [], fs = [], flip = vol.frontAtTop === false;
    for (z = run2.z0; z <= run2.z1; z++) { as.push(info[z].a); bs.push(info[z].b); fs.push(flip ? info[z].yBot : info[z].yTop); }
    var xa = med(as), xb = med(bs), gw = xb - xa, yf = med(fs);
    if (gw < 60 || gw > 190) return central('the gap between the lungs (' + Math.round(gw) + ' mm) is not heart-sized');
    var hist = new Float64Array(gy), tot = 0;
    for (z = run2.z0; z <= run2.z1; z++) for (i = 0; i < n2; i++) if (lung[z * n2 + i]) { hist[(i / gx) | 0]++; tot++; }
    function pct(fr) { var t = 0; for (var r = 0; r < gy; r++) { t += hist[r]; if (t >= fr * tot) return vy[r] * sp[1]; } return vy[gy - 1] * sp[1]; }
    var depth = Math.max(105, Math.min(HEART_MM[1], 0.62 * (pct(0.98) - pct(0.02)))), y0, y1b;
    if (flip) { y1b = yf + 10; y0 = y1b - depth; } else { y0 = yf - 10; y1b = y0 + depth; }
    var zA = vz[run2.z0] * sp[2], zB = vz[run2.z1] * sp[2], zc = (zA + zB) / 2, zh = Math.max(HEART_MM[2], zB - zA + 10) / 2,
      lo = [xa - 15, y0, zc - zh], hi = [xb + 15, y1b, zc + zh];
    for (i = 0; i < 3; i++) { lo[i] = Math.max(0, lo[i]); hi[i] = Math.min(fov[i], hi[i]); if (fov[i] >= 50 && hi[i] - lo[i] < 50) return central('the lung-based box was implausibly small'); }
    return { min: lo, max: hi, basis: 'lungs', why: 'two lungs found; the gap between them is ' + Math.round(gw) + ' mm wide at the heart level' };
  }

  /** Synthetic CT-like phantom (NOT patient data): lung, body, heart ellipsoid and three calcified lesions with known peak HU. */
  function phantom() {
    var nx = 96, ny = 96, nz = 48, sp = [1.5, 1.5, 3], data = new Float32Array(nx * ny * nz), s = 7,
      P = [{ n: 'LAD', c: [58, 40, 24], r: 2.6, hu: 420 }, { n: 'LCX', c: [66, 58, 22], r: 2.1, hu: 230 }, { n: 'RCA', c: [30, 52, 26], r: 2.4, hu: 320 }];
    function rnd() { s = s * 16807 % 2147483647; return s / 2147483647 - 0.5; }
    for (var z = 0; z < nz; z++) for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) {
      var h = Math.pow((x - 48) / 30, 2) + Math.pow((y - 48) / 26, 2) + Math.pow((z - 24) / 18, 2),
        b = Math.pow((x - 48) / 44, 2) + Math.pow((y - 48) / 40, 2), v = h < 1 ? 90 : b < 1 ? 35 : -800;
      v += rnd() * 30;
      for (var k = 0; k < 3; k++) {
        var p = P[k], dd = Math.sqrt(Math.pow((x - p.c[0]) * sp[0], 2) + Math.pow((y - p.c[1]) * sp[1], 2) + Math.pow((z - p.c[2]) * sp[2], 2)),
          t = 1 - Math.pow(dd / (p.r * 2.2), 2);
        if (t > 0) v = Math.max(v, p.hu * t);
      }
      data[x + y * nx + z * nx * ny] = v;
    }
    return { dims: [nx, ny, nz], sp: sp, data: data, truth: P };
  }

  root.ScanLib = { parseNifti: parseNifti, regions: regions, restrict: restrict, inBox: inBox, fovMm: fovMm, wholeBox: wholeBox, suggestHeartBox: suggestHeartBox, HEART_MM: HEART_MM, phantom: phantom };
})(typeof module !== 'undefined' ? module.exports : window);
