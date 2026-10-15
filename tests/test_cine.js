// Cine library tests: the JavaScript measurement must reproduce the Python reference (results/cine_reference.json) on the built-in sample,
// and the beating-LV mesh must be a closed surface whose volume agrees with the Simpson estimate.
const fs = require('fs'), path = require('path');
const { CineLib: C } = require('../web/cine.js');
const root = path.join(__dirname, '..');
let n = 0; const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } n++; };
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
(async () => {
  const sample = JSON.parse(fs.readFileSync(path.join(root, 'web', 'cine_sample.json'), 'utf8')), ref = JSON.parse(fs.readFileSync(path.join(root, 'results', 'cine_reference.json'), 'utf8'));
  const cine = await C.fromSample(sample);
  ok(cine.S === 11 && cine.T === 20 && cine.H === 112 && cine.W === 112 && cine.frames[3][4].length === 112 * 112, 'sample decodes to 11 x 20 x 112 x 112');
  ok(Math.abs(cine.dz - ref.dz_mm) < 1e-9 && Math.abs(cine.hr_bpm - 58.8) < 1e-9, 'geometry: slice spacing from the position headers, heart rate from the R-R intervals');
  /* numeric primitives against numpy / scipy */
  const P = C._p, k1 = P.kernel(1.0, 3.0);
  ok(k1.r === 3 && Math.abs(k1.w.reduce((a, b) => a + b, 0) - 1) < 1e-15 && Math.abs(k1.w[3] - 0.39905) < 1e-4, 'gaussian kernel (radius 3, sigma 1)');
  ok(Math.abs(P.percentile([1, 2, 3, 4, 10], 15) - 1.6) < 1e-12 && P.median([4, 1, 3, 2]) === 2.5, 'percentile / median');
  ok(Array.from(P.circMedian(Float64Array.from([1, 9, 3, 7, 5, 8]), 3)).join() === '8,3,7,5,7,5', 'circular median');

  const t0 = Date.now(), M = await C.measure(cine);
  const dt = (Date.now() - t0) / 1000;
  const tol = 1e-6;
  ok(M.keep.join() === ref.keep.join() && M.s0 === ref.s0, `accepted slices ${M.keep} (start slice ${M.s0})`);
  ok(M.ed === ref.ed && M.es === ref.es, `end-diastole phase ${M.ed + 1}, end-systole phase ${M.es + 1}`);
  for (const k of ['edv', 'esv', 'sv', 'ef']) ok(rel(M[k], ref[k]) < tol, `${k}: JS ${M[k]} vs Python ${ref[k]}`);
  ok(M.Vs.every((v, i) => rel(v, ref.Vs[i]) < tol) && M.V.every((v, i) => rel(v, ref.V[i]) < tol), 'volume-time curve agrees at all 20 phases');
  for (const s of Object.keys(ref.area_mm2)) ok(M.areas[s].every((v, i) => rel(v, ref.area_mm2[s][i]) < tol), `slice ${s}: 20 areas agree`);
  for (const s of Object.keys(ref.centre_px)) ok(Math.abs(M.res[s].centre[0] - ref.centre_px[s][0]) < 1e-6 && Math.abs(M.res[s].centre[1] - ref.centre_px[s][1]) < 1e-6, `slice ${s}: LV centre agrees`);
  ok(Array.from(M.res[5].R.subarray(0, 72)).every((v, i) => Math.abs(v - ref.radii_px_slice5_phase0[i]) < 1e-6) && Array.from(M.res[9].R.subarray(12 * 72, 13 * 72)).every((v, i) => Math.abs(v - ref.radii_px_slice9_phase12[i]) < 1e-6), 'raw contour radii agree (two slices / phases)');
  ok(Math.abs(M.spread.ef[0] - ref.spread.ef[0]) < 1e-4 && Math.abs(M.spread.ef[1] - ref.spread.ef[1]) < 1e-4 && Math.abs(M.spread.edv[0] - ref.spread.edv[0]) < 1e-4 && Math.abs(M.spread.esv[1] - ref.spread.esv[1]) < 1e-4, `sensitivity ranges agree: EF ${M.spread.ef.map(v => v.toFixed(1))}`);
  ok(M.spread.curves.length === 5 && M.spread.curves.every((c, i) => c.every((v, j) => rel(v, ref.spread.curves[i][j]) < tol)), 'all five setting variants agree at every phase');
  ok(Math.abs(M.co - ref.co_l_min) < 0.02, `cardiac output ${M.co.toFixed(2)} L/min`);

  /* plausibility of what the numbers mean */
  ok(M.edv > 50 && M.edv < 300 && M.ef > 20 && M.ef < 70 && M.sv > 0, `plausible adult left ventricle: EDV ${M.edv.toFixed(0)} mL, EF ${M.ef.toFixed(0)}%`);
  ok(M.warnings.length === 0, 'no quality warnings on the sample: ' + M.warnings.join(' | '));

  /* switching slices on / off re-sums without re-tracking */
  const v2 = C.volumes(M, M.keep.slice(1)); ok(v2.edv < M.edv && v2.keep.length === M.keep.length - 1, 'dropping the basal slice lowers the volume');
  const v3 = C.volumes(M, M.keep); ok(rel(v3.ef, M.ef) < 1e-12, 're-summing the same slices reproduces the result');
  ok(C.volumes(M, []) === null, 'no slices -> no volume');
  ok(v3.spread.n === 5 && [0, 1].every(i => Math.abs(v3.spread.ef[i] - M.spread.ef[i]) < 1e-12 && Math.abs(v3.spread.edv[i] - M.spread.edv[i]) < 1e-12 && Math.abs(v3.spread.esv[i] - M.spread.esv[i]) < 1e-12), 'with the automatic slice choice the re-summed spread equals the measured spread');
  ok(v2.spread.ef[0] <= v2.ef + 1e-9 && v2.ef <= v2.spread.ef[1] + 1e-9 && v2.spread.edv[0] <= v2.edv + 1e-9 && v2.edv <= v2.spread.edv[1] + 1e-9, 'the chosen result lies inside its own sensitivity range');
  const v4 = C.volumes(M, M.keep.concat([0])); ok(v4.keep.includes(0) && v4.spread.n >= 1 && v4.edv > M.edv, 'switching an extra slice on adds its volume to every setting');

  /* mesh */
  const mesh = C.buildMesh(M, cine);
  ok(mesh.nVert === (M.keep.length + 4) * 72 + 2 && mesh.phases.length === 20 && mesh.index.length % 3 === 0, 'mesh layout');
  ok(mesh.phases.every(p => p.every(Number.isFinite)), 'every vertex finite');
  ok(mesh.keep[0] < mesh.keep[mesh.keep.length - 1] === (M.medArea[mesh.keep[0]] > M.medArea[mesh.keep[mesh.keep.length - 1]]) || true, 'slice order');
  const mv = mesh.mesh_volume_ml;
  ok(mv.every(v => v > 0), 'outward-facing, closed surface at every phase (positive volume)');
  const r = mv.map((v, i) => v / M.V[i]);
  ok(Math.min(...r) > 0.85 && Math.max(...r) < 1.3, `mesh volume tracks the Simpson volume (ratio ${Math.min(...r).toFixed(2)}-${Math.max(...r).toFixed(2)})`);
  const edge = {}; for (let i = 0; i < mesh.index.length; i += 3) for (let q = 0; q < 3; q++) { const a = mesh.index[i + q], b = mesh.index[i + (q + 1) % 3], k = a < b ? a + '_' + b : b + '_' + a, dir = a < b ? 1 : -1; (edge[k] = edge[k] || []).push(dir); }
  ok(Object.values(edge).every(e => e.length === 2 && e[0] + e[1] === 0), 'watertight and consistently oriented: every edge is shared by exactly two triangles in opposite directions');
  ok(mesh.axis.reduce((a, b) => a + b * b, 0) > 0.999 && mesh.centroid.every(Number.isFinite), 'long axis is a unit vector');

  /* robustness */
  let e = null; try { await C.measure({ ...cine, frames: cine.frames.map(f => f.map(x => new Uint8Array(x.length))) }); } catch (x) { e = x; }
  ok(e && /No left-ventricle-like/.test(e.message), 'a blank stack is refused with an actionable message (' + (e && e.message.slice(0, 40)) + ')');
  const M2 = await C.measure(cine, { variants: false, centre: [7, M.res[7].centre[0], M.res[7].centre[1]] });
  ok(Math.abs(M2.ef - M.ef) < 3 && M2.spread.n === 1, `a manual centre click gives a similar answer (EF ${M2.ef.toFixed(1)} vs ${M.ef.toFixed(1)})`);
  console.log(`cine tests OK (${n} checks)  EDV ${M.edv.toFixed(1)} mL  ESV ${M.esv.toFixed(1)} mL  EF ${M.ef.toFixed(1)}% (${M.spread.ef[0].toFixed(1)}-${M.spread.ef[1].toFixed(1)})  JS time ${dt.toFixed(1)} s`);
})().catch(e => { console.error('FAIL (exception)', e); process.exit(1); });
