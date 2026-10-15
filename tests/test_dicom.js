// DICOM library tests: every supported encoding, hostile / unsupported input, zip reading, cine and CT assembly - all synthetic, so they run anywhere.
// With a folder of real files (CARDIOLENS_DICOM_DIR) and a pydicom reference (CARDIOLENS_DICOM_REF, see tests/dump_dicom_reference.py) it also
// checks every file against pydicom: geometry, trigger times and pixel checksums.
const D = require('../web/dicom.js').DicomLib, zlib = require('zlib'), fs = require('fs'), path = require('path');
let n = 0; const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } n++; };
const throws = async (f, re, m) => { let e = null; try { await f(); } catch (x) { e = x; } ok(e && re.test(e.message), `${m} (got: ${e && e.message})`); };

const { dicom, zip, TSX, IDENT } = require('./synth.js');
const file = (name, buf) => ({ name, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

(async () => {
  /* encodings */
  const base = { Modality: 'MR', SOPInstanceUID: '1.2.3', PixelSpacing: [1.25, 1.5], IPP: [1, 2, 3], IOP: IDENT, InstanceNumber: 7 };
  for (const [label, ts] of [['explicit LE', TSX.le], ['implicit LE', TSX.imp], ['explicit BE', TSX.be]]) {
    const r = D.parse(dicom({ ts, tags: base, signed: 1, patient: 'DOE^JANE', sequence: true, privateUN: true }));
    ok(r.rows === 2 && r.cols === 3 && r.bits === 16 && r.signed && r.pixel instanceof Int16Array, `${label}: size, bits, signedness`);
    ok(Array.from(r.pixel).join() === '-2,-1,0,1,2,3', `${label}: pixel values (${Array.from(r.pixel)})`);
    ok(r.tags.Modality === 'MR' && r.tags.PixelSpacing.join() === '1.25,1.5' && r.tags.ImagePositionPatient.join() === '1,2,3' && r.tags.InstanceNumber === 7 && r.tags.SOPInstanceUID === '1.2.3', `${label}: tags`);
    ok(!JSON.stringify(r.tags).includes('DOE') && !('PatientName' in r.tags), `${label}: patient name is never read`);
  }
  let r = D.parse(dicom({ bits: 8, pixel: [0, 128, 255, 7, 8, 9], tags: base })); ok(r.pixel instanceof Uint8Array && r.pixel[2] === 255, '8-bit unsigned pixels');
  r = D.parse(dicom({ bits: 16, signed: 0, pixel: [0, 40000, 65535, 1, 2, 3], tags: base })); ok(r.pixel instanceof Uint16Array && r.pixel[1] === 40000, '16-bit unsigned pixels');
  /* unsupported / hostile input is refused with a readable message, never a crash */
  await throws(() => D.parse(dicom({ ts: TSX.jpeg, tags: base })), /Compressed or unsupported.*1\.2\.840\.10008\.1\.2\.4\.50/, 'JPEG-compressed file refused');
  await throws(() => D.parse(dicom({ tags: base, encapsulated: true })), /Compressed \(encapsulated\)/, 'encapsulated pixel data refused');
  await throws(() => D.parse(dicom({ tags: base, noPixels: true })), /no pixel data/, 'file without pixels refused');
  await throws(() => D.parse(dicom({ tags: { ...base, NumberOfFrames: 20 } })), /Multi-frame/, 'multi-frame refused');
  await throws(() => D.parse(Buffer.from('this is not a dicom file at all, just text'.repeat(20))), /./, 'text file refused');
  await throws(() => D.parse(crypto_random(4000)), /./, 'random bytes refused');
  const whole = dicom({ tags: base }); await throws(() => D.parse(whole.subarray(0, whole.length - 5)), /Truncated/, 'truncated pixel data refused');
  for (let cut = 140; cut < whole.length; cut += 23) { let e = null; try { D.parse(whole.subarray(0, cut)); } catch (x) { e = x; } ok(e instanceof Error, `truncated at ${cut} bytes throws an Error`); }
  /* zip */
  const a = Buffer.from('hello world '.repeat(500)), b = Buffer.from([1, 2, 3, 4, 5]);
  const z = zip([{ name: 'dir/a.txt', data: a, method: 8 }, { name: 'b.bin', data: b, method: 0 }, { name: '__MACOSX/._b.bin', data: b, method: 0 }, { name: '.DS_Store', data: b, method: 0 }]);
  const ents = await D.readZip(z); ok(ents.length === 2 && Buffer.from(ents[0].bytes).equals(a) && Buffer.from(ents[1].bytes).equals(b), 'zip: deflate + stored entries, hidden files skipped');
  await throws(() => D.readZip(Buffer.from('PK\x03\x04 not really')), /valid .zip/, 'broken zip refused');
  await throws(() => D.readZip(zip([{ name: 'x', data: b, method: 0, flags: 1 }])), /Encrypted/, 'encrypted zip refused');

  /* cine assembly: 4 slices x 6 phases, one duplicate image, one image from another view, shuffled input, zipped */
  const T = 6, S = 4, imgs = [];
  for (let s = 0; s < S; s++) for (let t = 0; t < T; t++) imgs.push({ s, t, buf: dicom({ rows: 4, cols: 5, tags: { Modality: 'MR', SOPInstanceUID: `1.9.${s}.${t}`, TriggerTime: 20 + 50 * t, NominalInterval: 900 + 10 * s, InstanceNumber: s * T + t + 1,
    IPP: [0, 0, 80 - 10 * s], IOP: IDENT, PixelSpacing: [1.5, 1.5], SliceThickness: 8 }, pixel: Array.from({ length: 20 }, (_, i) => s * 1000 + t * 10 + (i % 7)), signed: 1 }) });
  const dup = imgs[7].buf, other = dicom({ rows: 4, cols: 5, tags: { Modality: 'MR', SOPInstanceUID: '7.7', TriggerTime: 10, InstanceNumber: 999, IPP: [0, 0, 5], IOP: [0, 1, 0, 0, 0, -1], PixelSpacing: [1.5, 1.5] } });
  const order = imgs.map((_, i) => i).sort((p, q) => ((p * 7919) % 31) - ((q * 7919) % 31));
  const files = order.map(i => file(`f${i}`, imgs[i].buf)); files.push(file('dup', dup), file('other', other), file('notes.txt', Buffer.from('hello')));
  const read = await D.readFiles(files); ok(read.stats.dicom === imgs.length + 2 && read.stats.skipped === 1, `readFiles counts (${JSON.stringify(read.stats)})`);
  const c = D.buildCine(read.instances);
  ok(c.S === S && c.T === T && c.H === 4 && c.W === 5, 'cine: S x T x H x W');
  ok(Math.abs(c.dz - 10) < 1e-9 && c.ipp[0][2] === 80 && c.ipp[3][2] === 50, 'cine: slice order by instance number (first acquired first) and spacing from the position headers');
  ok(c.trigger_ms[2].join() === '20,70,120,170,220,270', 'cine: phases ordered by trigger time');
  ok(c.frames[2][3][1] === 2000 + 30 + 1, 'cine: pixel data lands in [slice][phase]');
  ok(Math.abs(c.hr_bpm - 60000 / 915) < 0.06, `cine: heart rate from the mean R-R interval (${c.hr_bpm})`);
  ok(c.warnings.some(w => /another orientation/.test(w)), 'cine: stray view ignored with a warning');
  const zr = await D.readFiles([file('series.zip', zip(imgs.map(i => ({ name: `ser/${i.s}/${i.t}.dcm`, data: i.buf, method: 8 }))))]); ok(zr.stats.dicom === imgs.length && zr.stats.zips === 1, 'cine: a .zip of files reads like loose files');
  ok(D.buildCine(zr.instances).S === S, 'cine from zip');
  await throws(() => D.buildCine(read.instances.filter(i => i.tags.IPP === undefined && i.tags.ImagePositionPatient[2] === 80 && i.tags.TriggerTime < 50)), /./, 'a single image is not a cine');
  await throws(() => D.buildCine(read.instances.filter(i => i.tags.TriggerTime === 20)), /does not look like a cine/, 'one phase per slice is not a cine');

  /* CT assembly */
  const ctI = [0, 1, 2].map(k => dicom({ rows: 3, cols: 3, signed: 1, pixel: Array.from({ length: 9 }, (_, i) => i * 100 + k), tags: { Modality: 'CT', SOPInstanceUID: '5.' + k, IPP: [0, 0, 10 - 2.5 * k], IOP: IDENT, PixelSpacing: [0.5, 0.75], RescaleSlope: 1, RescaleIntercept: -1024, InstanceNumber: k + 1 } }));
  const ct = D.buildCT((await D.readFiles(ctI.map((b, i) => file('c' + i, b)))).instances);
  ok(ct.dims.join() === '3,3,3' && ct.sp.join() === '0.75,0.5,2.5' && ct.data[0] === -1024 + 2 && ct.data[9] === -1024 + 1 && ct.data[26] === -1024 + 800, `CT: dims, spacing (x=column spacing), slices ascending by position, HU (${ct.data[0]},${ct.data[9]})`);
  const one = D.buildCT((await D.readFiles([file('one', ctI[0])])).instances); ok(one.dims[2] === 1 && one.warnings.length === 0, 'CT: a single image is a one-slice volume');
  await throws(() => D.buildCT(read.instances), /No CT images/, 'MR series is not a CT');

  /* privacy: identifying elements in the file never reach any parsed or built object, and no message names a file or a UID */
  const SECRET = ['DOE^JANE', 'PID-7731-X', '19480229', '1.2.826.0.1.3680043.77.1', '1.2.826.0.1.3680043.77.2', '1.2.826.0.1.3680043.77.3', 'St Mary Hospital', 'Mrs Doe chest', 'Dr Roe'];
  const IDENT_TAGS = { PatientID: 'PID-7731-X', PatientBirthDate: '19480229', StudyInstanceUID: SECRET[3], SeriesInstanceUID: SECRET[4], FrameOfReferenceUID: SECRET[5], InstitutionName: SECRET[6], SeriesDescription: SECRET[7] };
  const clean = (o, m) => { const j = JSON.stringify(o, (k, v) => ArrayBuffer.isView(v) ? undefined : v); ok(SECRET.every(x => !j.includes(x)), m + ' carries none of the identifying values'); };
  const sch = require('./synth.js').chest(), idf = require('./synth.js').ctSeries({ dims: [8, 6, 4], sp: [2, 2, 3], data: Float32Array.from({ length: 192 }, (_, i) => (i % 50) * 20 - 100) }, IDENT_TAGS);
  const idP = D.parse(Buffer.from(dicom({ patient: 'DOE^JANE', ident: IDENT_TAGS, tags: base })));
  clean(idP.tags, 'parse()'); ok(Object.keys(idP.tags).every(k => !/^Patient|Study|Institution|Description|FrameOfReference|SeriesInstance/.test(k)), 'parse() has no identifying keys: ' + Object.keys(idP.tags).join());
  const idRead = await D.readFiles(idf.map(f => file('DOE^JANE/' + f.name, f.bytes))), idCt = D.buildCT(idRead.instances); clean(idCt, 'buildCT()'); clean(idRead.stats.errors, 'read errors');
  ok(idCt.dims.join() === '8,6,4' && Math.abs(idCt.data[0] + 100) < 1e-9, 'identifying tags do not disturb the volume (HU from slope / intercept)');
  const idCine = D.buildCine(read.instances); clean(idCine, 'buildCine()');
  { const k = D.classify(idRead); clean({ counts: k.counts, notes: k.notes, message: k.message }, 'classify() (counts, notes, message)'); }
  /* classification and plain-language messages */
  const rdOf = fl => D.readFiles(fl.map((b, i) => file('f' + i, b)));
  const jpeg = dicom({ ts: TSX.jpeg, tags: base }), mframe = dicom({ tags: { ...base, NumberOfFrames: 20 } }), txt = Buffer.from('hello'), gz = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
  const ctImgs = idf.map(f => f.bytes), us = dicom({ tags: { Modality: 'US', IPP: [0, 0, 0], IOP: IDENT } });
  let cl = D.classify(await rdOf(ctImgs)); ok(cl.kind === 'ct' && cl.instances.length === 4 && cl.message === '', 'classify: a CT series is a CT');
  cl = D.classify(await rdOf(ctImgs.concat([txt]))); ok(cl.kind === 'ct' && /1 of 5 file\(s\) were skipped \(1 (not DICOM|no image data)\)/.test(cl.notes.join(' ')), 'classify: a stray text file is skipped with a note: ' + cl.notes);
  cl = D.classify(read); ok(cl.kind === 'mr' && cl.counts.mr === read.instances.length, 'classify: the cine images are MR');
  cl = D.classify(await rdOf(ctImgs.concat([read.instances.length ? dicom({ tags: base }) : txt]))); ok(cl.kind === 'none' && /mixes CT images \(4\) and MR images \(1\).*Next step/.test(cl.message), 'classify: CT + MR together -> mixed message with a next step');
  cl = D.classify(await rdOf([us])); ok(cl.kind === 'none' && /not CT or MR \(US\).*Next step/.test(cl.message), 'classify: another modality is named and refused');
  cl = D.classify(await rdOf([jpeg, jpeg])); ok(cl.kind === 'none' && /compressed.*uncompressed DICOM.*NIfTI/.test(cl.message) && !/1\.2\.840/.test(cl.message), 'classify: compressed -> plain message, no UID: ' + cl.message.slice(0, 60));
  cl = D.classify(await rdOf([mframe])); ok(cl.kind === 'none' && /multi-frame.*one file per slice/.test(cl.message), 'classify: multi-frame -> plain message with a next step');
  cl = D.classify(await rdOf([txt, Buffer.from('hi')])); ok(cl.kind === 'none' && /not DICOM images.*Next step/.test(cl.message), 'classify: no DICOM at all -> plain message');
  cl = D.classify(await rdOf([gz, ctImgs[0].subarray(0, 10)])); ok(cl.kind === 'none' && /Next step/.test(cl.message), 'classify: gzip + junk -> message');
  cl = D.classify(await rdOf([gz])); ok(cl.kind === 'none' && /NIfTI.*on its own/.test(cl.message), 'classify: a NIfTI.gz inside a DICOM selection -> open it on its own');
  cl = D.classify(await rdOf(ctImgs.concat([jpeg]))); ok(cl.kind === 'ct' && /1 compressed/.test(cl.notes.join(' ')), 'classify: a few compressed files next to a CT series are reported, not hidden');
  ok(D.explain(D.explain('Not a readable DICOM file')) === D.explain('Not a readable DICOM file') && !/\d+\.\d+\.\d+\.\d+/.test(D.explain('Compressed or unsupported DICOM transfer syntax (1.2.840.10008.1.2.4.50). Export')), 'explain() is idempotent and drops UIDs');
  ok(/Next step/.test(D.explain('something odd 1.2.3.4.5.6')) && !/1\.2\.3\.4/.test(D.explain('something odd 1.2.3.4.5.6')), 'explain(): unknown messages get a generic next step and lose UIDs');
  await throws(() => D.readZip(zip([{ name: 'DOE^JANE/x.dcm', data: b, method: 9 }])), /Unsupported .zip compression method 9$/, 'zip errors do not name the entry');
  const noGeo = D.classify(await rdOf([dicom({ tags: { Modality: 'CT', SOPInstanceUID: '9' } })])); await throws(() => D.buildCT(noGeo.instances), /position and orientation/, 'CT without geometry cannot be stacked'); ok(/slice-position headers.*Next step/.test(D.explain('No CT images with position and orientation headers were found.')), 'that error is explained with a next step');
  ok(D.buildCT((await rdOf(ctImgs.slice().reverse())).instances).data[0] === idCt.data[0] && D.buildCT((await rdOf(ctImgs.slice().reverse())).instances).frontAtTop === true, 'CT: slice order does not depend on file order; front-at-top follows the orientation tags');

  /* real files */
  const dir = process.env.CARDIOLENS_DICOM_DIR, ref = process.env.CARDIOLENS_DICOM_REF; let real = '';
  if (dir && ref && fs.existsSync(dir) && fs.existsSync(ref)) {
    const R = JSON.parse(fs.readFileSync(ref, 'utf8')), close = (x, y) => x === null ? y === undefined : Math.abs(x - y) < 1e-9, closeA = (x, y) => x === null ? y === undefined : x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-9);
    let bad = 0, sums = 0;
    for (const e of R) {
      const rd = D.parse(fs.readFileSync(path.join(dir, e.name))), t = rd.tags; let a = 0, q = 0; for (const v of rd.pixel) { a += v; q += v * v; }
      const good = t.Modality === e.modality && rd.rows === e.rows && rd.cols === e.cols && rd.bits === e.bits && (rd.signed ? 1 : 0) === e.signed && t.SOPInstanceUID === e.sop &&
        closeA(e.ipp, t.ImagePositionPatient) && closeA(e.iop, t.ImageOrientationPatient) && closeA(e.px, t.PixelSpacing) && close(e.trigger, t.TriggerTime) && t.InstanceNumber === e.instance &&
        close(e.nominal, t.NominalInterval) && close(e.hr, t.HeartRate) && close(e.slope, t.RescaleSlope) && close(e.intercept, t.RescaleIntercept) && close(e.thickness, t.SliceThickness) &&
        a === e.sum && q === e.sumsq && rd.pixel[0] === e.first && rd.pixel[rd.pixel.length - 1] === e.last && rd.pixel[rd.pixel.length >> 1] === e.mid;
      if (!good) { bad++; console.error('MISMATCH', e.name); } else sums++;
    }
    ok(bad === 0 && sums === R.length, `${R.length} real files agree with pydicom (${bad} mismatches)`);
    real = `  real files vs pydicom: ${sums}/${R.length}`;
    if (R[0].modality === 'MR') {
      const all = R.map(e => file(e.name, fs.readFileSync(path.join(dir, e.name)))), rr = await D.readFiles(all), cc = D.buildCine(rr.instances);
      ok(cc.S === 11 && cc.T === 20 && cc.H === 256 && cc.W === 256, 'real cine: 11 x 20 x 256 x 256, duplicate frames dropped');
      real += `  cine ${cc.S}x${cc.T}, HR ${cc.hr_bpm}, dz ${cc.dz.toFixed(3)} mm`;
    }
  }
  console.log(`dicom tests OK (${n} checks)${real}`);
})().catch(e => { console.error('FAIL (exception)', e); process.exit(1); });

function crypto_random(len) { let s = 12345; const b = Buffer.alloc(len); for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = s >> 16; } return b; }
