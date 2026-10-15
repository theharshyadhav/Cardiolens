// End-to-end test of the built page (jsdom, no WebGL): WebMCP registration, every tool, actionable errors, approval gate, epoch cancel, agent brief.
// The 3D scene, hover/fly-to, layout and software-rendering behaviour are covered by tests/test_browser.py (real Chromium).
const { JSDOM, VirtualConsole } = require('jsdom'); const fs = require('fs'), path = require('path');
const SY = require('./synth.js'), html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const errs = [], vc = new VirtualConsole(); vc.on('jsdomError', e => { if (!/stylesheet/i.test(e.message)) errs.push(e.message); }); vc.on('error', m => errs.push(String(m)));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
  w.HTMLCanvasElement.prototype.getContext = () => ({ createImageData: (a, b) => ({ data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} });
  w.ResizeObserver = class { observe() {} };
  w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
} });
const w = dom.window, ev = s => w.eval(s), $ = s => w.document.querySelector(s), sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = (c, m) => { if (!c) { console.error('FAIL:', m, errs); process.exit(1); } n++; };
const call = async (name, args) => JSON.parse(JSON.stringify(await ev(`TOOLS.${name}(${JSON.stringify(args || {})})`)));
(async () => {
  ok(errs.length === 0, 'page loads without script errors: ' + errs.join('|'));
  ok(ev('typeof document.modelContext') === 'object' && ev('Object.keys(TOOLS).length') === 13, 'WebMCP polyfill + 13 tools registered (modelContext=' + ev('typeof document.modelContext') + ')');
  ok(/WebMCP · 13 tools/.test($('#wm').textContent), 'status chip: ' + $('#wm').textContent);
  let r = await call('describe_heart_model'); ok(!r.isError && r.structuredContent.patient_specific === false && r.structuredContent.geometry_withheld === true && !/positions|Float32Array/.test(JSON.stringify(r)), 'describe_heart_model: generic atlas, geometry withheld');
  ok(Object.keys(r.structuredContent.vessels).join() === 'LAD,LCX,RCA' && /not patient-specific/.test(r.content[0].text), 'describe_heart_model reports the three vessels and says the heart is not patient-specific');
  r = await call('focus_vessel', { vessel: 'LCX' }); ok(!r.isError && ev('sel') === 'LCX' && r.structuredContent.vessel === 'LCX', 'focus_vessel selects the vessel');
  r = await call('focus_vessel', { vessel: 'XYZ' }); ok(r.isError && /CAD, LAD, LCX or RCA/.test(r.content[0].text), 'focus_vessel rejects a bad vessel with the valid options');
  r = await call('describe_scan'); ok(r.isError && /No scan is loaded/.test(r.content[0].text), 'actionable error before a scan is loaded');
  $('#dm').click(); await sleep(1500);
  r = await call('describe_scan'); ok(!r.isError && r.structuredContent.dims.join() === '96,96,48', 'describe_scan on phantom');
  r = await call('find_calcifications', { limit: 5 }); ok(r.structuredContent.total === 3 && r.structuredContent.agatston_total > 500, 'find_calcifications finds 3 lesions');
  ok((await call('find_calcifications', { min_hu: 500, max_hu: 100 })).isError, 'inverted window rejected');
  r = await call('focus_region', { region_id: 99 }); ok(r.isError && /Available ids: 1, 2, 3/.test(r.content[0].text), 'focus_region error names valid ids');
  ok(!(await call('focus_region', { region_id: 1 })).isError && !(await call('set_view', { view: 'coronal' })).isError, 'focus_region + set_view');
  ok((await call('set_view', { view: 'oblique' })).isError, 'bad view rejected');
  ok(!(await call('assign_vessel', { region_id: 1, vessel: 'LAD' })).isError && /Ca \d+/.test(ev("caTxt('LAD')")), 'assign_vessel marks LAD for the 3D chip');
  r = await call('predict_risk', { features: { age: 70, typ_cp: 1 } }); ok(!r.isError && r.structuredContent.probabilities.CAD > 0.5, 'predict_risk');
  ok((await call('predict_risk', { features: { LAD: 1 } })).isError, 'target columns rejected as inputs');
  let p = call('export_findings', {}); await sleep(100); ok($('#md').classList.contains('on'), 'approval dialog opens'); $('#no').click();
  r = await p; ok(r.isError && /declined/.test(r.content[0].text) && !$('#md').classList.contains('on'), 'declined export is an error');
  p = call('export_findings', { note: 'x' }); await sleep(100); $('#ok').click(); r = await p;
  const s = JSON.stringify(r); ok(!r.isError && r.structuredContent.regions.length === 3 && s.length < 12000 && !/Float32Array|base64/.test(s), 'approved export contains numbers only');
  p = call('export_findings', {}); await sleep(100); $('#dm').click(); r = await p;
  ok(r.isError && /changed|declined/.test(r.content[0].text) && !$('#md').classList.contains('on'), 'loading a new scan cancels a pending approval');
  await sleep(1500);
  $('#run').click(); for (let i = 0; i < 80 && !$('#md').classList.contains('on'); i++) await sleep(100); $('#ok').click(); await sleep(500);
  ok(/Export approved/.test($('#say').textContent) && $('#lg').children.length >= 4, 'agent brief runs through the same tools: ' + $('#say').textContent.slice(0, 80));
  /* ---- heart box: tool, guard, refresh, export ---- */
  await sleep(300); $('#dm').click(); await sleep(1500);
  r = await call('describe_scan'); ok(r.structuredContent.heart_box_mm.whole_scan === true && r.structuredContent.fov_mm.join() === '142.5,142.5,141' && /whole scan/.test(r.content[0].text) && JSON.stringify(r).length < 1500, 'describe_scan reports the field of view and the heart box (whole scan by default), compactly');
  ok((await call('set_heart_region', {})).isError && (await call('set_heart_region', { region: 'auto', box_mm: { x: [0, 1], y: [0, 1], z: [0, 1] } })).isError && (await call('set_heart_region', { region: 'heart' })).isError, 'set_heart_region needs exactly one valid argument');
  r = await call('set_heart_region', { box_mm: { x: [0, 5], y: [0, 1] } }); ok(r.isError && /x, y and z/.test(r.content[0].text), 'a box without z is rejected with an example');
  r = await call('set_heart_region', { box_mm: { x: [500, 600], y: [0, 10], z: [0, 10] } }); ok(r.isError && /outside the scan/.test(r.content[0].text) && /142\.5/.test(r.content[0].text), 'a box outside the scan is rejected and names the scan size');
  r = await call('find_calcifications', { limit: 5 }); const base = r.structuredContent, key = x => x.regions.map(q => q.volume_mm3 + '/' + q.agatston).join();
  ok(base.total === 3 && base.excluded_outside_box === 0 && base.heart_box_mm.whole_scan, 'find_calcifications: 3 lesions, nothing excluded with the whole-scan box');
  r = await call('set_heart_region', { box_mm: { x: [120, 60], y: [0, 142.5], z: [0, 141] } });
  ok(!r.isError && r.structuredContent.candidates_inside === 2 && r.structuredContent.excluded_outside_box === 1 && r.structuredContent.heart_box_mm.source === 'agent' && !r.structuredContent.heart_box_mm.whole_scan, 'set_heart_region (corners in either order) refreshes the findings: 2 inside, 1 excluded');
  r = await call('find_calcifications', { limit: 5 }); ok(r.structuredContent.total === 2 && r.structuredContent.excluded_outside_box === 1 && /excluded as outside/.test(r.content[0].text), 'find_calcifications uses the box by default and reports the excluded count');
  ok(r.structuredContent.regions.every(q => base.regions.some(b0 => b0.volume_mm3 === q.volume_mm3 && b0.agatston === q.agatston && b0.peak_hu === q.peak_hu)), 'the lesions inside have exactly the volume, peak and score they have without the box');
  r = await call('describe_scan'); ok(r.structuredContent.heart_box_mm.x.join() === '60,120' && /set by an agent/.test(r.content[0].text), 'describe_scan reports the current box');
  r = await call('set_heart_region', { box_mm: { x: [60, 62], y: [0, 142.5], z: [0, 141] } }); ok(!r.isError && r.structuredContent.heart_box_mm.size[0] >= 10, 'a sliver is widened to the 10 mm minimum');
  await call('set_heart_region', { box_mm: { x: [60, 120], y: [0, 142.5], z: [0, 141] } });
  ok(!(await call('assign_vessel', { region_id: 1, vessel: 'LAD' })).isError, 'vessel assigned inside the box'); const lab = ev("RG.list.find(q=>q.id===1).label");
  await call('set_heart_region', { region: 'whole' }); ok(ev("RG.list.length") === 3 && ev("asg[" + lab + "]") === 'LAD' && ev("RG.list.filter(q=>asg[q.label]==='LAD').length") === 1, 'back to the whole scan: 3 candidates again and the vessel assignment follows the lesion, not its rank');
  r = await call('set_heart_region', { region: 'auto' }); ok(!r.isError && r.structuredContent.heart_box_mm.source === 'suggested' && r.structuredContent.heart_box_mm.basis === 'central_fov' && /guess, not a segmentation/.test(r.content[0].text), 'region "auto" on a scan without lungs: central part of the scan, labelled as a guess');
  ok(/Suggested|No heart outline/.test(ev("hbNote()")) && /not a segmentation/.test($('#hxn').textContent) && /x \d+–\d+ · y/.test($('#hxt').textContent), 'the page labels the suggestion and shows the numeric read-out');
  p = call('export_findings', {}); await sleep(100); ok(/"heart_box_mm"/.test($('#mj').textContent) && /candidates_excluded_outside_box/.test($('#mj').textContent), 'the approval dialog shows the heart box'); $('#ok').click(); r = await p;
  ok(!r.isError && r.structuredContent.heart_box_mm.source === 'suggested' && r.structuredContent.schema === 'cardiolens.room.v2', 'export_findings includes heart_box_mm');
  /* the box on a chest-like volume opened as NIfTI (through openFiles, like the drop zone) */
  const fileOf = (name, buf) => ({ name, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
  const waitVol = async (re) => { for (let i = 0; i < 100; i++) { await sleep(100); if (!ev('loading') && !ev('reading') && ev('VOL') && re.test(ev('VOL.name'))) return true; } return false; };
  const ch = SY.chest(); w.F1 = [fileOf('DOE^JANE_chest.nii', SY.nifti(ch))]; ev('openFiles(F1)');
  ok(await waitVol(/NIfTI/) && ev('VOL.name') === 'CT volume (NIfTI)' && !/DOE/.test(JSON.stringify(await call('describe_scan'))), 'a single .nii keeps the NIfTI path; the file name is not used as the label');
  r = await call('find_calcifications', { limit: 20 }); const nAll = r.structuredContent.total;
  r = await call('set_heart_region', { region: 'auto' }); ok(r.structuredContent.heart_box_mm.basis === 'lungs' && r.structuredContent.candidates_inside >= 3 && r.structuredContent.candidates_inside <= nAll, 'auto on a chest volume: box from the lungs, findings refreshed (' + r.structuredContent.candidates_inside + ' of ' + nAll + ' inside)');
  r = await call('find_calcifications', { limit: 20 }); ok(r.structuredContent.total >= 3 && r.structuredContent.total < nAll && r.structuredContent.excluded_outside_box === nAll - r.structuredContent.total, `bone-like candidates outside the box are excluded (${nAll} -> ${r.structuredContent.total})`);
  /* DICOM: identifying values everywhere, files / folder / zip, through the same entry point as the drop zone */
  const SECRET = ['DOE^JANE', 'PID-7731-X', '19480229', '1.2.826.0.1.3680043.77.1', '1.2.826.0.1.3680043.77.2', '1.2.826.0.1.3680043.77.3', 'St Mary Hospital', 'Mrs Doe chest'];
  const ID = { PatientID: SECRET[1], PatientBirthDate: SECRET[2], StudyInstanceUID: SECRET[3], SeriesInstanceUID: SECRET[4], FrameOfReferenceUID: SECRET[5], InstitutionName: SECRET[6], SeriesDescription: SECRET[7] };
  const sv = { dims: [64, 56, 20], sp: [2.5, 2.5, 3], data: new Float32Array(64 * 56 * 20).fill(40) };
  for (let z = 8; z < 11; z++) for (let y = 20; y < 24; y++) for (let x = 30; x < 35; x++) sv.data[x + y * 64 + z * 64 * 56] = 380;          // one lesion
  const ser = SY.ctSeries(sv, ID, { noext: true, reverse: true }).map(f => fileOf('DOE^JANE/Mrs Doe chest/' + f.name, f.bytes));
  w.F2 = ser; ev('openFiles(F2)'); ok(await waitVol(/DICOM series, 20 images/), 'DICOM files without extension, in reverse order, open as one CT series: ' + ev('VOL&&VOL.name'));
  r = await call('describe_scan'); ok(r.structuredContent.dims.join() === '64,56,20' && r.structuredContent.spacing_mm.join() === '2.5,2.5,3' && r.structuredContent.hu_max === 380 && r.structuredContent.hu_min === 40, 'DICOM CT: dimensions, spacing from the positions, HU from slope / intercept');
  r = await call('find_calcifications', {}); ok(r.structuredContent.total === 1 && Math.abs(r.structuredContent.regions[0].peak_hu - 380) < 1 && Math.abs(r.structuredContent.regions[0].centroid_mm[2] - 27) < 1.5, 'DICOM CT: the lesion is found where it was put (z ≈ 27 mm)');
  const zipf = fileOf('DOE^JANE.zip', SY.zip(SY.ctSeries(sv, ID).map(f => ({ name: 'DOE^JANE/' + f.name, data: f.bytes, method: 0 })))); w.F3 = [zipf]; ev('openFiles(F3)');
  ok(await waitVol(/DICOM series, 20 images/) && ev('VOL.dims[2]') === 20, 'a .zip of the series opens the same way');
  const ent = (name, f) => ({ isFile: true, isDirectory: false, name, file: cb => cb(f) }), dir = (name, kids) => ({ isFile: false, isDirectory: true, name, createReader() { let d = false; return { readEntries: cb => { if (d) cb([]); else { d = true; cb(kids); } } }; } });
  const kids = SY.ctSeries(sv, ID).map(f => ent(f.name, fileOf(f.name, f.bytes))); w.DT = { items: [{ webkitGetAsEntry: () => dir('DOE^JANE', [dir('sub', kids.slice(0, 10)), ...kids.slice(10)]) }], files: [] };
  ev('VOL=null'); w.F4 = null; ev('dropFiles(DT).then(f=>openFiles(f))'); ok(await waitVol(/DICOM series, 20 images/), 'a dropped folder (nested) opens the series');
  /* the privacy sweep: every tool, the approval dialog, the export, the page text */
  await call('find_calcifications', {}); const seen = [];
  for (const [n, a] of [['describe_heart_model'], ['focus_vessel', { vessel: 'LAD' }], ['describe_scan'], ['set_heart_region', { region: 'auto' }], ['find_calcifications'], ['focus_region', { region_id: 1 }], ['set_view', { view: 'coronal' }], ['assign_vessel', { region_id: 1, vessel: 'LAD' }], ['predict_risk'], ['describe_cine'], ['measure_lv'], ['show_lv_3d']]) seen.push(JSON.stringify(await call(n, a || {})));
  p = call('export_findings', { note: 'x' }); await sleep(100); seen.push($('#mj').textContent); $('#ok').click(); seen.push(JSON.stringify(await p)); seen.push($('#rg').textContent, $('#lg').textContent, $('#cmsg').textContent, $('#hxn').textContent);
  ok(SECRET.every(x => !seen.join('\n').includes(x)) && !/\b\d+\.\d+\.\d+\.\d+\.\d+/.test(seen.join('\n').replace(/\d+\.\d+\.\d+\.\d+\.\d+\.\d+/g, m => /^(0|\d)/.test(m) ? m : m).replace(/[\d.]*\d\.\d[\d.]*/g, '')), 'PRIVACY: no name, id, birth date, UID, institution, series text or file / folder name in any tool result, the approval dialog, the export or the page');
  /* a cine series goes to the Cardiac MRI panel and keeps the CT; mixed and unsupported selections give plain messages */
  const T = 6, S = 4, mr = []; for (let s0 = 0; s0 < S; s0++) for (let t = 0; t < T; t++) mr.push(fileOf(`DOE^JANE/mr${s0}_${t}`, SY.dicom({ rows: 48, cols: 48, ident: ID, tags: { Modality: 'MR', SOPInstanceUID: `1.9.${s0}.${t}`, TriggerTime: 20 + 50 * t, NominalInterval: 900, InstanceNumber: s0 * T + t + 1, IPP: [0, 0, 80 - 10 * s0], IOP: SY.IDENT, PixelSpacing: [1.5, 1.5] }, pixel: Array.from({ length: 2304 }, (_, i) => { const x = i % 48 - 24, y = (i / 48 | 0) - 24, R = 11 - 3 * Math.sin(Math.PI * t / T); return x * x + y * y < R * R ? 700 : 60 }) })));
  const nCt = ev('VOL.dims[2]'); w.F5 = mr; ev('openFiles(F5)'); for (let i = 0; i < 100 && !(ev('CN') && !ev('CBUSY')); i++) await sleep(100);
  r = await call('describe_cine'); ok(!r.isError && r.structuredContent.slices === 4 && r.structuredContent.phases === 6 && r.structuredContent.name === 'MRI cine (DICOM)' && ev('VOL.dims[2]') === nCt && !SECRET.some(x => JSON.stringify(r).includes(x)), 'a cine MR series opens in the Cardiac MRI panel (neutral name), the CT stays loaded ' + JSON.stringify(r).slice(0,400) + ev('VOL.dims[2]') + '/' + nCt);
  w.F6 = [...mr.slice(0, 3), ...ser.slice(0, 3)]; ev('openFiles(F6)'); await sleep(600); ok(/mixes CT images \(3\) and MR images \(3\).*Next step/.test($('#rg').textContent) && ev('VOL.dims[2]') === nCt, 'a mixed selection gives a plain message and keeps the open scan: ' + $('#rg').textContent.slice(0, 80));
  w.F7 = [fileOf('x.dcm', SY.dicom({ ts: SY.TSX.jpeg, tags: { Modality: 'CT' } }))]; ev('openFiles(F7)'); await sleep(600); ok(/compressed.*Next step/.test($('#rg').textContent), 'compressed DICOM: plain message that names the next step');
  w.F8 = [fileOf('x.dcm', SY.dicom({ tags: { Modality: 'CT', NumberOfFrames: 12 } }))]; ev('openFiles(F8)'); await sleep(600); ok(/multi-frame.*Next step/.test($('#rg').textContent), 'multi-frame DICOM: plain message that names the next step');
  ev('VOL=null'); ev('openFiles([])'); w.F9 = [fileOf('notes.txt', Buffer.from('hello')), fileOf('b.txt', Buffer.from('hi'))]; ev('openFiles(F9)'); await sleep(600); r = await call('describe_scan'); ok(/Could not open scan/.test($('#rg').textContent) && r.isError && /No scan is loaded: the last file could not be opened/.test(r.content[0].text), 'nothing readable and no scan open: error shown on the page and explained to an agent');
  ok(errs.length === 0, 'no script errors during the run: ' + errs.join('|'));
  console.log(`room tests OK (${n} checks)`); process.exit(0);
})();
