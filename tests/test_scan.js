// Scan library tests: NIfTI parsing (plain + gzip, slope/intercept), truncated input, region finder vs phantom ground truth.
const { ScanLib: S } = require('../web/scan.js'); const zlib = require('zlib'); let n = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } n++; };
function nii(dims, vals, slope, inter) {
  const b = Buffer.alloc(352 + vals.length * 2); b.writeInt32LE(348, 0); b.writeInt16LE(3, 40);
  dims.forEach((d, i) => b.writeInt16LE(d, 42 + 2 * i)); b.writeInt16LE(4, 70);
  [1.5, 1.5, 3].forEach((s, i) => b.writeFloatLE(s, 80 + 4 * i)); b.writeFloatLE(352, 108); b.writeFloatLE(slope, 112); b.writeFloatLE(inter, 116);
  vals.forEach((v, i) => b.writeInt16LE(v, 352 + 2 * i)); return b;
}
(async () => {
  const raw = nii([4, 3, 2], Array.from({ length: 24 }, (_, i) => i), 2, -1000);
  for (const buf of [raw, zlib.gzipSync(raw)]) {
    const v = await S.parseNifti(buf);
    ok(v.dims.join() === '4,3,2' && v.sp.join() === '1.5,1.5,3' && v.data[5] === -990 && v.data.length === 24, 'nifti parse: dims, spacing, scl_slope/inter');
  }
  let bad = 0; try { await S.parseNifti(raw.subarray(0, 300)); } catch (e) { bad = 1; } ok(bad, 'truncated file rejected');
  const ph = S.phantom(), r = S.regions(ph, { min: 130, max: 4000, minMm3: 1 }), pk = r.list.map(x => Math.round(x.peak_hu));
  ok(r.list.length === 3, 'phantom: 3 lesions, got ' + r.list.length);
  ok(r.list.every((x, i) => !i || x.volume_mm3 <= r.list[i - 1].volume_mm3), 'sorted by volume');
  ok(Math.abs(pk[0] - 420) < 40 && Math.abs(pk[1] - 320) < 40 && Math.abs(pk[2] - 230) < 40, 'peak HU recovered ' + pk);
  ok(r.list.every(x => x.agatston > 0 && x.volume_mm3 > 50) && Object.keys(r.map).length === 3, 'agatston + label map');
  ok(S.regions(ph, { min: 130, max: 4000, minMm3: 1e6 }).list.length === 0, 'min-volume filter');
  ok(S.regions(ph, { min: 100000, max: 200000, minMm3: 0 }).list.length === 0, 'empty window -> no regions');
  /* ---- heart box ---- */
  const bone = JSON.parse(JSON.stringify({ d: ph.dims })), vb = { dims: ph.dims, sp: ph.sp, data: Float32Array.from(ph.data) };
  for (let z = 20; z < 28; z++) for (let y = 4; y < 12; y++) for (let x = 80; x < 90; x++) vb.data[x + y * 96 + z * 96 * 96] = 700;      // bone-like blob in a corner, far from the heart
  const all = S.regions(vb, { min: 130, max: 4000, minMm3: 1 }), whole = S.wholeBox(vb), fov = S.fovMm(vb);
  ok(all.list.length === 4 && all.excluded === 0 && fov.join() === '142.5,142.5,141', 'whole-scan result: 4 candidates (3 lesions + the blob), nothing excluded');
  const box = { min: [20, 30, 40], max: [120, 100, 100] }, inb = S.regions(vb, { min: 130, max: 4000, minMm3: 1, box });
  ok(inb.list.length === 3 && inb.excluded === 1 && inb.excluded_mm3 > 1000, `box: lesions found, blob excluded (${inb.list.length} in, ${inb.excluded} out)`);
  const key = r => r.map(x => [x.volume_mm3, x.peak_hu, x.agatston].join()).join('|');
  ok(key(inb.list) === key(r.list) && Math.abs(inb.list.reduce((a, x) => a + x.agatston, 0) - r.list.reduce((a, x) => a + x.agatston, 0)) < 1e-9, 'scores, volumes and peaks of the lesions inside are exactly those without the box');
  ok(inb.list.map(x => x.id).join() === '1,2,3' && inb.list.every(x => inb.map[x.label] === x.id) && Object.keys(inb.out).length === 1, 'ids re-ranked inside the box; label map consistent; excluded label marked');
  const re = S.restrict(inb, vb, whole); ok(re.list.length === 4 && re.excluded === 0 && re.list[0].label === all.list[0].label, 'restrict() from a restricted result recovers the whole scan without re-labelling');
  const c0 = all.list[0], edge = S.restrict(all, vb, { min: [0, 0, 0], max: [c0.centroid[0] * vb.sp[0], 142.5, 141] }); ok(edge.list.some(x => x.label === c0.label), 'a centroid exactly on the box edge is inside');
  ok(S.restrict(all, vb, { min: [0, 0, 0], max: [1, 1, 1] }).list.length === 0, 'a box that holds no centroid gives an empty list');
  /* suggestion: lungs -> a box around the heart; no lungs -> central part of the scan */
  const ch = require('./synth.js').chest(), cs = S.suggestHeartBox(ch), inside = (p, b) => p.every((v, i) => v >= b.min[i] && v <= b.max[i]);
  ok(cs.basis === 'lungs' && /lungs/.test(cs.why), 'chest phantom: box comes from the lungs (' + cs.why + ')');
  ok(ch.truth.les.every(l => inside(l.slice(1, 4), cs)), 'chest phantom: the three coronary calcifications are inside the suggested box');
  ok(!inside(ch.truth.spine, cs) && cs.max[0] - cs.min[0] < 190 && cs.max[1] - cs.min[1] <= 130 && cs.max[2] - cs.min[2] <= 140.01, 'chest phantom: spine outside; box no larger than a heart + margin');
  const cr = S.regions(ch, { min: 130, max: 4000, minMm3: 1, box: cs }), cw = S.regions(ch, { min: 130, max: 4000, minMm3: 1 });
  ok(cr.list.length >= 3 && cr.excluded >= 8 && cw.list.length === cr.list.length + cr.excluded, `chest phantom: the box excludes ${cr.excluded} of ${cw.list.length} bone-like candidates (spine, lateral ribs, sternum)`);
  const fl = S.suggestHeartBox(require('./synth.js').chest({ flip: true })); ok(fl.basis === 'lungs' && fl.min[1] > 100, 'flipped orientation (front at the bottom) is honoured');
  const cp = S.suggestHeartBox(ph); ok(cp.basis === 'central_fov' && /no lungs/.test(cp.why) && cp.min.every(v => v >= 0) && cp.max.every((v, i) => v <= fov[i] + 1e-9), 'phantom without lungs: falls back to the central part of the scan, inside the scan');
  ok(S.regions(ph, { min: 130, max: 4000, minMm3: 1, box: cp }).list.length === 3, 'the central fallback keeps the three phantom lesions');
  const tiny = S.suggestHeartBox({ dims: [4, 3, 1], sp: [1, 1, 1], data: new Float32Array(12) }); ok(tiny.basis === 'central_fov' && tiny.max[2] === 0, 'a tiny one-slice volume does not crash and gets a central box');
  console.log(`scan tests OK (${n} checks)  lesions: ${r.list.map(x => `${x.volume_mm3.toFixed(0)}mm3/${Math.round(x.peak_hu)}HU/Ca${x.agatston.toFixed(1)}`).join('  ')}`);
})();
