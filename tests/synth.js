// Test helpers shared by the node suites and the browser test: a DICOM / zip / NIfTI writer and synthetic volumes. NOT patient data.
const zlib = require('zlib'), fs = require('fs'), path = require('path');
/* ---- a small DICOM writer for the tests ---- */
const LONGV = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT']);
function u16(v, le) { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; }
function u32(v, le) { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v) : b.writeUInt32BE(v); return b; }
function str(s, pad) { const b = Buffer.from(s, 'latin1'); return b.length % 2 ? Buffer.concat([b, Buffer.from([pad === undefined ? 32 : pad])]) : b; }
function element(g, e, vr, val, enc) {
  const le = enc.little, ex = enc.explicit;
  if (!ex) return Buffer.concat([u16(g, le), u16(e, le), u32(val.length, le), val]);
  if (LONGV.has(vr)) return Buffer.concat([u16(g, le), u16(e, le), Buffer.from(vr), Buffer.alloc(2), u32(val.length, le), val]);
  return Buffer.concat([u16(g, le), u16(e, le), Buffer.from(vr), u16(val.length, le), val]);
}
const US = (v, le) => u16(v, le), DS = (...a) => str(a.join('\\')), IS = DS;
function sequenceUndefined(g, e, enc, inner) {   // SQ of undefined length with one item of undefined length
  const le = enc.little, hd = enc.explicit ? Buffer.concat([u16(g, le), u16(e, le), Buffer.from('SQ'), Buffer.alloc(2), u32(0xFFFFFFFF, le)]) : Buffer.concat([u16(g, le), u16(e, le), u32(0xFFFFFFFF, le)]);
  const item = Buffer.concat([u16(0xFFFE, le), u16(0xE000, le), u32(0xFFFFFFFF, le), inner, u16(0xFFFE, le), u16(0xE00D, le), u32(0, le)]);
  return Buffer.concat([hd, item, u16(0xFFFE, le), u16(0xE0DD, le), u32(0, le)]);
}
const TSX = { le: '1.2.840.10008.1.2.1', imp: '1.2.840.10008.1.2', be: '1.2.840.10008.1.2.2', jpeg: '1.2.840.10008.1.2.4.50' };
function dicom(o) {
  const t = o.ts || TSX.le, enc = { explicit: t !== TSX.imp, little: t !== TSX.be }, meta = { explicit: true, little: true },
    rows = o.rows || 2, cols = o.cols || 3, bits = o.bits || 16, signed = o.signed ? 1 : 0, le = enc.little, tg = o.tags || {};
  const vals = o.pixel || Array.from({ length: rows * cols }, (_, i) => signed ? i - 2 : i);
  const px = Buffer.alloc(rows * cols * bits / 8);
  vals.forEach((v, i) => { if (bits === 8) px.writeUInt8(v & 255, i); else if (signed) le ? px.writeInt16LE(v, i * 2) : px.writeInt16BE(v, i * 2); else le ? px.writeUInt16LE(v, i * 2) : px.writeUInt16BE(v, i * 2); });
  const E = (g, e, vr, v) => element(g, e, vr, v, enc), parts = [];
  if (tg.Modality) parts.push(E(0x0008, 0x0060, 'CS', str(tg.Modality)));
  if (tg.SOPInstanceUID) parts.push(E(0x0008, 0x0018, 'UI', str(tg.SOPInstanceUID, 0)));
  if (o.patient) parts.push(E(0x0010, 0x0010, 'PN', str(o.patient)));                           // must never be read
  const id = o.ident || {};                                                                      // identifying elements a real scanner writes; none of them may ever be read or shown
  if (id.InstitutionName) parts.push(E(0x0008, 0x0080, 'LO', str(id.InstitutionName)));
  if (id.SeriesDescription) parts.push(E(0x0008, 0x103E, 'LO', str(id.SeriesDescription)));
  if (id.PatientID) parts.push(E(0x0010, 0x0020, 'LO', str(id.PatientID)));
  if (id.PatientBirthDate) parts.push(E(0x0010, 0x0030, 'DA', str(id.PatientBirthDate)));
  if (id.StudyInstanceUID) parts.push(E(0x0020, 0x000D, 'UI', str(id.StudyInstanceUID, 0)));
  if (id.SeriesInstanceUID) parts.push(E(0x0020, 0x000E, 'UI', str(id.SeriesInstanceUID, 0)));
  if (id.FrameOfReferenceUID) parts.push(E(0x0020, 0x0052, 'UI', str(id.FrameOfReferenceUID, 0)));
  if (tg.TriggerTime !== undefined) parts.push(E(0x0018, 0x1060, 'DS', DS(tg.TriggerTime)));
  if (tg.NominalInterval) parts.push(E(0x0018, 0x1062, 'IS', IS(tg.NominalInterval)));
  if (tg.SliceThickness) parts.push(E(0x0018, 0x0050, 'DS', DS(tg.SliceThickness)));
  if (tg.InstanceNumber !== undefined) parts.push(E(0x0020, 0x0013, 'IS', IS(tg.InstanceNumber)));
  if (tg.IPP) parts.push(E(0x0020, 0x0032, 'DS', DS(...tg.IPP)));
  if (tg.IOP) parts.push(E(0x0020, 0x0037, 'DS', DS(...tg.IOP)));
  if (o.sequence) parts.push(sequenceUndefined(0x0008, 0x1111, enc, E(0x0008, 0x1150, 'UI', str('1.2.3.4', 0))));
  if (o.privateUN) parts.push(E(0x0029, 0x1010, 'OB', Buffer.from([1, 2, 3, 4])));
  parts.push(E(0x0028, 0x0002, 'US', US(1, le)), E(0x0028, 0x0004, 'CS', str(tg.Photometric || 'MONOCHROME2')), E(0x0028, 0x0010, 'US', US(rows, le)), E(0x0028, 0x0011, 'US', US(cols, le)));
  if (tg.PixelSpacing) parts.push(E(0x0028, 0x0030, 'DS', DS(...tg.PixelSpacing)));
  parts.push(E(0x0028, 0x0100, 'US', US(bits, le)), E(0x0028, 0x0101, 'US', US(bits, le)), E(0x0028, 0x0102, 'US', US(bits - 1, le)), E(0x0028, 0x0103, 'US', US(signed, le)));
  if (tg.RescaleIntercept !== undefined) parts.push(E(0x0028, 0x1052, 'DS', DS(tg.RescaleIntercept)), E(0x0028, 0x1053, 'DS', DS(tg.RescaleSlope)));
  if (tg.NumberOfFrames) parts.push(E(0x0028, 0x0008, 'IS', IS(tg.NumberOfFrames)));
  if (!o.noPixels) parts.push(o.encapsulated ? Buffer.concat([u16(0x7FE0, le), u16(0x0010, le), Buffer.from('OB'), Buffer.alloc(2), u32(0xFFFFFFFF, le)]) : E(0x7FE0, 0x0010, bits === 8 ? 'OB' : 'OW', px));
  const metaEl = element(0x0002, 0x0010, 'UI', str(t, 0), meta), grp = element(0x0002, 0x0000, 'UL', u32(metaEl.length, true), meta);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), grp, metaEl, ...parts]);
}
const IDENT = [1, 0, 0, 0, 1, 0];

/* ---- zip writer ---- */
function zip(entries) {
  const locals = [], central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = e.data, comp = e.method === 8 ? zlib.deflateRawSync(raw) : raw, crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const lh = Buffer.concat([u32(0x04034b50, true), u16(20, true), u16(0, true), u16(e.method, true), u16(0, true), u16(0, true), u32(crc, true), u32(comp.length, true), u32(raw.length, true), u16(name.length, true), u16(0, true), name]);
    locals.push(lh, comp);
    central.push(Buffer.concat([u32(0x02014b50, true), u16(20, true), u16(20, true), u16(e.flags || 0, true), u16(e.method, true), u16(0, true), u16(0, true), u32(crc, true), u32(comp.length, true), u32(raw.length, true), u16(name.length, true), u16(0, true), u16(0, true), u16(0, true), u16(0, true), u32(0, true), u32(off, true), name]));
    off += lh.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.concat([u32(0x06054b50, true), u16(0, true), u16(0, true), u16(entries.length, true), u16(entries.length, true), u32(cd.length, true), u32(off, true), u16(0, true)]);
  return Buffer.concat([...locals, cd, end]);
}
const file = (name, buf) => ({ name, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });


/* ---- synthetic chest CT (NOT patient data): body, two lungs, heart, spine, sternum, ribs, three coronary calcifications ---- */
function chest(o) {
  o = o || {}; const nx = 128, ny = 112, nz = 60, sp = [2.8, 2.8, 4], data = new Float32Array(nx * ny * nz), cx = 178, cy = 150;
  const els = (x, y, a, b, x0, y0) => ((x - x0) / a) ** 2 + ((y - y0) / b) ** 2;
  let s = 11; const rnd = () => { s = s * 16807 % 2147483647; return s / 2147483647 - 0.5; };
  const front = o.flip ? -1 : 1, heart = { x: cx + 10, y: cy - 25 * front, z: 110, a: 62, b: 46, c: 65 };
  const les = [['LAD', cx + 25, cy - 48 * front, 112, 420], ['LCX', cx + 58, cy - 12 * front, 100, 330], ['RCA', cx - 38, cy - 38 * front, 96, 300]];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = i * sp[0], y = j * sp[1], z = k * sp[2]; let v = -1000;
    if (els(x, y, 150, 105, cx, cy) < 1) {
      v = 35; const thorax = z > 20 && z < 200;
      if (thorax && els(x, y, 128, 84, cx, cy) < 1) {
        v = -850;
        const dx = (x - heart.x) / (heart.a + 8), dy = (y - heart.y) / (heart.b + 8), dz = (z - heart.z) / (heart.c + 8);
        if (dx * dx + dy * dy + dz * dz < 1) v = 35;
        const med = z > 150 ? 50 : 36; if (Math.abs(x - cx) < med && (y - cy) * front > -10) v = 35;
        if (z > 150 && Math.abs(x - cx) < 30) v = 35;
      }
      if (els(x, y, 22, 20, cx, cy + 68 * front) < 1) v = 300;                                    // vertebral body
      if (Math.abs(x - cx) < 18 && Math.abs(y - (cy - 94 * front)) < 6) v = 320;                  // sternum
      for (let r = 0; r < 14; r++) { const t = r / 14 * Math.PI * 2, rx = cx + 118 * Math.cos(t), ry = cy + 72 * Math.sin(t); if ((x - rx) ** 2 + (y - ry) ** 2 + (z - 100) ** 2 < 49 && thorax) v = 350; }   // ribs
      for (const [, lx, ly, lz, hu] of les) { const d = Math.hypot(x - lx, y - ly, z - lz); if (d < 7) v = Math.max(v, hu * (1 - (d / 7) ** 2)); }
      v += rnd() * 20;
    }
    data[i + j * nx + k * nx * ny] = v;
  }
  const vol = { dims: [nx, ny, nz], sp, data, truth: { les, spine: [cx, cy + 68 * front, 100], sternum: [cx, cy - 94 * front, 100] } };
  if (o.flip) vol.frontAtTop = false; return vol;
}
/* a NIfTI-1 file (int16) of a volume */
function nifti(vol) {
  const n = vol.data.length, b = Buffer.alloc(352 + n * 2); b.writeInt32LE(348, 0); b.writeInt16LE(3, 40); vol.dims.forEach((d, i) => b.writeInt16LE(d, 42 + 2 * i)); b.writeInt16LE(4, 70);
  vol.sp.forEach((s, i) => b.writeFloatLE(s, 80 + 4 * i)); b.writeFloatLE(352, 108); b.writeFloatLE(1, 112); b.writeFloatLE(0, 116);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(vol.data[i]))), 352 + 2 * i); return b;
}
/* a CT series of a volume as DICOM files (one per axial slice, HU through RescaleSlope/Intercept, positions in patient space) */
function ctSeries(vol, ident, o) {
  o = o || {}; const [nx, ny, nz] = vol.dims, out = [];
  for (let k = 0; k < nz; k++) {
    const px = Array.from({ length: nx * ny }, (_, i) => Math.round(vol.data[i + k * nx * ny]) + 1024);
    out.push({ name: o.noext ? `IM${k}` : `IM${String(k).padStart(4, '0')}.dcm`, bytes: dicom({ rows: ny, cols: nx, pixel: px, ident, tags: { Modality: 'CT', SOPInstanceUID: `1.2.826.0.1.3680043.${900 + k}`,
      InstanceNumber: k + 1, IPP: [-100, -80, -50 + k * vol.sp[2]], IOP: IDENT, PixelSpacing: [vol.sp[1], vol.sp[0]], SliceThickness: vol.sp[2], RescaleSlope: 1, RescaleIntercept: -1024 } }) });
  }
  return o.reverse ? out.reverse() : out;
}
module.exports = { dicom, zip, element, TSX, IDENT, str, chest, nifti, ctSeries };
