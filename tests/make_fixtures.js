// Writes synthetic fixtures for the browser test: node tests/make_fixtures.js <outdir>
const fs = require('fs'), path = require('path'), SY = require('./synth.js');
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const ID = { PatientID: 'PID-7731-X', PatientBirthDate: '19480229', StudyInstanceUID: '1.2.826.0.1.3680043.77.1', SeriesInstanceUID: '1.2.826.0.1.3680043.77.2', InstitutionName: 'St Mary Hospital' };
const ch = SY.chest(); fs.writeFileSync(path.join(out, 'chest.nii'), SY.nifti(ch));
const ser = SY.ctSeries(ch, ID, { noext: true });
fs.mkdirSync(path.join(out, 'DOE^JANE'), { recursive: true });
ser.forEach(f => fs.writeFileSync(path.join(out, 'DOE^JANE', f.name), f.bytes));
fs.writeFileSync(path.join(out, 'ct.zip'), SY.zip(SY.ctSeries(ch, ID).map(f => ({ name: 'DOE^JANE/' + f.name, data: f.bytes, method: 0 }))));
fs.mkdirSync(path.join(out, 'cine'), { recursive: true });
const T = 6, S = 4;
for (let s = 0; s < S; s++) for (let t = 0; t < T; t++) fs.writeFileSync(path.join(out, 'cine', `i${s}_${t}`), SY.dicom({ rows: 48, cols: 48, ident: ID, tags: { Modality: 'MR', SOPInstanceUID: `1.9.${s}.${t}`, TriggerTime: 20 + 50 * t, NominalInterval: 900, InstanceNumber: s * T + t + 1, IPP: [0, 0, 80 - 10 * s], IOP: SY.IDENT, PixelSpacing: [1.5, 1.5] }, pixel: Array.from({ length: 2304 }, (_, i) => { const x = i % 48 - 24, y = (i / 48 | 0) - 24, R = 11 - 3 * Math.sin(Math.PI * t / T); return x * x + y * y < R * R ? 700 : 60 }) }));
console.log('ok', ch.dims.join('x'));
