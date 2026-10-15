/* CardioLens DICOM library - dependency free (browser + Node >= 18). Everything is decoded in the caller's tab; nothing is uploaded.
 *
 *   DicomLib.parse(bytes)               one DICOM file -> {tags, rows, cols, pixel, ...}   (uncompressed transfer syntaxes only)
 *   DicomLib.readZip(bytes)             .zip -> [{name, bytes}]                              (stored or deflate)
 *   DicomLib.readFiles(files, onProgress)  File[] (DICOM, folders, .zip) -> parsed instances + counts of what was skipped
 *   DicomLib.buildCine(instances)       short-axis cine series -> {S, T, H, W, px, ipp, iop, frames[S][T], trigger_ms, hr_bpm, ...}
 *   DicomLib.buildCT(instances)         CT series -> {dims, sp, data: Float32Array in HU}   (the shape ScanLib expects)
 *   DicomLib.classify(read)             what is in a selection? -> {kind: 'ct' | 'mr' | 'none', instances, counts, notes, message}
 *   DicomLib.explain(message)           an error message of this library -> plain language with a next step (no file names, no UIDs)
 *
 * Patient-identifying elements (names, ids, birth dates, ...) are never read: the table below lists everything that is parsed.
 * Free text (series descriptions) and the series / study UIDs are not read either; the two UIDs that are (instance UID for removing
 * duplicates, transfer syntax for decoding) stay inside the parsed objects and are never part of anything the builders return.
 * Slice geometry comes from ImagePositionPatient / ImageOrientationPatient, never from SliceLocation (which can disagree).
 */
(function (root) {
  'use strict';

  /* tag -> [name, VR].  Only these elements are decoded; everything else is skipped by its length. */
  var DICT = {
    '00020010': ['TransferSyntaxUID', 'UI'], '00080018': ['SOPInstanceUID', 'UI'], '00080060': ['Modality', 'CS'],
    '00080070': ['Manufacturer', 'LO'], '00081090': ['ManufacturerModelName', 'LO'], 
    '00180050': ['SliceThickness', 'DS'], '00180087': ['MagneticFieldStrength', 'DS'], '00180088': ['SpacingBetweenSlices', 'DS'],
    '00181060': ['TriggerTime', 'DS'], '00181062': ['NominalInterval', 'IS'], '00181088': ['HeartRate', 'IS'], '00181090': ['CardiacNumberOfImages', 'IS'],
    '00200011': ['SeriesNumber', 'IS'], '00200013': ['InstanceNumber', 'IS'],
    '00200032': ['ImagePositionPatient', 'DS'], '00200037': ['ImageOrientationPatient', 'DS'], '00201041': ['SliceLocation', 'DS'],
    '00280002': ['SamplesPerPixel', 'US'], '00280004': ['PhotometricInterpretation', 'CS'], '00280006': ['PlanarConfiguration', 'US'],
    '00280008': ['NumberOfFrames', 'IS'], '00280010': ['Rows', 'US'], '00280011': ['Columns', 'US'], '00280030': ['PixelSpacing', 'DS'],
    '00280100': ['BitsAllocated', 'US'], '00280101': ['BitsStored', 'US'], '00280102': ['HighBit', 'US'], '00280103': ['PixelRepresentation', 'US'],
    '00281050': ['WindowCenter', 'DS'], '00281051': ['WindowWidth', 'DS'], '00281052': ['RescaleIntercept', 'DS'], '00281053': ['RescaleSlope', 'DS']
  };
  var LONG = { OB: 1, OD: 1, OF: 1, OL: 1, OV: 1, OW: 1, SQ: 1, UC: 1, UN: 1, UR: 1, UT: 1, SV: 1, UV: 1 };
  var TS = {
    '1.2.840.10008.1.2': ['Implicit VR Little Endian', 1, 1], '1.2.840.10008.1.2.1': ['Explicit VR Little Endian', 0, 1],
    '1.2.840.10008.1.2.2': ['Explicit VR Big Endian', 0, 0]
  };
  var ZIP_LIMIT = 1.5e9;

  function hex4(v) { return ('0000' + v.toString(16).toUpperCase()).slice(-4); }
  function ascii(u, a, b) { var s = ''; for (var i = a; i < b; i++) s += String.fromCharCode(u[i]); return s; }
  function clean(s) { return s.replace(/[\0 ]+$/, '').replace(/^ +/, ''); }
  function nums(s) { return clean(s).split('\\').map(function (x) { return parseFloat(x); }).filter(function (x) { return isFinite(x); }); }

  /** one element value -> JS value (only called for tags in DICT) */
  function decode(vr, u, a, n, dv, little) {
    if (vr === 'US') { var o = []; for (var i = 0; i + 2 <= n; i += 2) o.push(dv.getUint16(a + i, little)); return o.length === 1 ? o[0] : o; }
    if (vr === 'DS' || vr === 'IS') { var v = nums(ascii(u, a, a + n)); return v.length === 1 ? v[0] : v; }
    return clean(ascii(u, a, a + n));
  }

  /** skip a sequence / item stream of undefined length starting at p; returns the position after its delimiter */
  function skipUndefined(u, p, end, dv, little, explicit, depth) {
    if (depth > 24) throw new Error('DICOM sequence nesting too deep');
    while (p + 8 <= end) {
      var g = dv.getUint16(p, little), e = dv.getUint16(p + 2, little), len = dv.getUint32(p + 4, little);
      if (g === 0xFFFE) {                       // item / delimiters carry no VR
        p += 8;
        if (e === 0xE0DD) return p;             // sequence delimiter
        if (e === 0xE00D) return p;             // item delimiter
        if (e === 0xE000) { if (len === 0xFFFFFFFF) p = skipUndefined(u, p, end, dv, little, explicit, depth + 1); else p += len; }
        continue;
      }
      // an ordinary element inside an item
      var hdr, vl, vr = '';
      if (explicit) {
        vr = ascii(u, p + 4, p + 6);
        if (LONG[vr]) { vl = dv.getUint32(p + 8, little); hdr = 12; } else { vl = dv.getUint16(p + 6, little); hdr = 8; }
      } else { vl = len; hdr = 8; }
      p += hdr;
      if (vl === 0xFFFFFFFF) p = skipUndefined(u, p, end, dv, little, vr === 'UN' ? false : explicit, depth + 1);
      else p += vl;
    }
    throw new Error('Truncated DICOM sequence');
  }

  /** parse one DICOM file. Throws a readable Error for anything that is not an uncompressed single-frame image. */
  function parse(bytes) {
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var dv = new DataView(u.buffer, u.byteOffset, u.byteLength), p = 0, tags = {}, ts = '1.2.840.10008.1.2.1', preamble = false;
    if (u.length > 132 && ascii(u, 128, 132) === 'DICM') { p = 132; preamble = true; }
    var explicit = true, little = true, end = u.length, metaEnd = -1, pix = null;
    if (!preamble) { explicit = false; ts = '1.2.840.10008.1.2'; }
    while (p + 8 <= end) {
      var g = dv.getUint16(p, little), e = dv.getUint16(p + 2, little), key = hex4(g) + hex4(e), isMeta = g === 2;
      // after the file-meta group the transfer syntax decides the encoding of everything else
      if (preamble && !isMeta && metaEnd < 0) {
        metaEnd = p;
        var info = TS[ts];
        if (!info) throw new Error('Compressed or unsupported DICOM transfer syntax (' + ts + '). Export the series uncompressed (Explicit VR Little Endian) and try again.');
        explicit = !info[1]; little = !!info[2];
        g = dv.getUint16(p, little); e = dv.getUint16(p + 2, little); key = hex4(g) + hex4(e);
      }
      var useExp = isMeta ? true : explicit, useLittle = isMeta ? true : little;
      if (isMeta) { g = dv.getUint16(p, true); e = dv.getUint16(p + 2, true); key = hex4(g) + hex4(e); }
      var vr = '', len, hdr;
      if (useExp) {
        vr = ascii(u, p + 4, p + 6);
        if (!/^[A-Z]{2}$/.test(vr)) throw new Error('Not a readable DICOM file');
        if (LONG[vr]) { len = dv.getUint32(p + 8, useLittle); hdr = 12; } else { len = dv.getUint16(p + 6, useLittle); hdr = 8; }
      } else { len = dv.getUint32(p + 4, useLittle); hdr = 8; }
      var vp = p + hdr;
      if (g === 0x7FE0 && e === 0x0010) {
        if (len === 0xFFFFFFFF) throw new Error('Compressed (encapsulated) DICOM pixel data is not supported. Export the series uncompressed and try again.');
        if (vp + len > end) throw new Error('Truncated DICOM pixel data');
        pix = { at: vp, len: len }; break;
      }
      if (len === 0xFFFFFFFF) { p = skipUndefined(u, vp, end, dv, useLittle, vr === 'UN' ? false : useExp, 0); continue; }
      if (vp + len > end) throw new Error('Truncated DICOM file');
      var d = DICT[key];
      if (d) {
        var v = decode(useExp ? vr : d[1], u, vp, len, dv, useLittle);
        tags[d[0]] = v;
        if (key === '00020010') {
          ts = v;
          if (!TS[ts]) throw new Error('Compressed or unsupported DICOM transfer syntax (' + ts + '). Export the series uncompressed (Explicit VR Little Endian) and try again.');
        }
      }
      p = vp + len;
    }
    if (!pix) throw new Error('This DICOM file has no pixel data');
    var t = tags, rows = t.Rows, cols = t.Columns, bits = t.BitsAllocated, spp = t.SamplesPerPixel || 1, nf = t.NumberOfFrames || 1;
    if (!(rows > 0 && cols > 0)) throw new Error('DICOM image size missing');
    if (nf > 1) throw new Error('Multi-frame (enhanced) DICOM is not supported. Export the images as one file per frame.');
    if (spp !== 1) throw new Error('Colour DICOM images are not supported (grey-scale MR / CT only)');
    if (bits !== 8 && bits !== 16) throw new Error('Unsupported DICOM bit depth (' + bits + ')');
    var n = rows * cols, nb = n * bits / 8;
    if (pix.len < nb) throw new Error('Truncated DICOM pixel data');
    var out, signed = t.PixelRepresentation === 1, le = (TS[ts] || TS['1.2.840.10008.1.2.1'])[2] === 1;
    if (bits === 8) out = new Uint8Array(u.buffer.slice(u.byteOffset + pix.at, u.byteOffset + pix.at + n));
    else {
      out = signed ? new Int16Array(n) : new Uint16Array(n);
      var pv = new DataView(u.buffer, u.byteOffset + pix.at, nb);
      for (var i = 0; i < n; i++) out[i] = signed ? pv.getInt16(i * 2, le) : pv.getUint16(i * 2, le);
    }
    if (t.PhotometricInterpretation === 'MONOCHROME1') t.inverted = true;
    return { tags: t, rows: rows, cols: cols, bits: bits, signed: signed, pixel: out, transferSyntax: ts };
  }

  /* ---- zip (stored / deflate, no zip64) ------------------------------------------------------------------------------- */
  async function inflateRaw(u) { return new Uint8Array(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
  async function readZip(bytes) {
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), e = -1;
    for (var i = u.length - 22; i >= Math.max(0, u.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Not a valid .zip file');
    var n = dv.getUint16(e + 10, true), p = dv.getUint32(e + 16, true), out = [], total = 0;
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged .zip directory');
      var flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true),
        nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true),
        name = ascii(u, p + 46, p + 46 + nl);
      p += 46 + nl + xl + cl;
      if (/\/$/.test(name) || /(^|\/)(__MACOSX|\.[^/]*)(\/|$)/.test(name)) continue;
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF) throw new Error('zip64 archives are not supported');
      if (flags & 1) throw new Error('Encrypted .zip files are not supported');
      total += usize; if (total > ZIP_LIMIT) throw new Error('The .zip is too large to open in a browser tab');
      if (dv.getUint32(off, true) !== 0x04034b50) throw new Error('Damaged .zip entry');
      var s = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), raw = u.subarray(s, s + csize);
      if (method === 0) out.push({ name: name, bytes: raw });
      else if (method === 8) out.push({ name: name, bytes: await inflateRaw(raw) });
      else throw new Error('Unsupported .zip compression method ' + method);
    }
    return out;
  }

  /* ---- many files -> parsed instances ---------------------------------------------------------------------------------- */
  var sleep0 = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  async function readFiles(files, onProgress) {
    var inst = [], st = { files: 0, dicom: 0, skipped: 0, errors: {}, zips: 0 }, queue = [];
    for (var i = 0; i < files.length; i++) queue.push({ name: files[i].webkitRelativePath || files[i].name, get: files[i] });
    var done = 0;
    async function take(item) {
      var u = item.get instanceof Uint8Array ? item.get : new Uint8Array(await item.get.arrayBuffer());
      st.files++;
      if (u.length > 3 && u[0] === 0x50 && u[1] === 0x4B && u[2] === 3 && u[3] === 4) {
        st.zips++; var ents = await readZip(u);
        for (var k = 0; k < ents.length; k++) await take({ name: item.name + '/' + ents[k].name, get: ents[k].bytes });
        return;
      }
      if (u.length > 2 && u[0] === 0x1F && u[1] === 0x8B) { st.skipped++; (st.errors['gzip / NIfTI file in a DICOM selection'] = st.errors['gzip / NIfTI file in a DICOM selection'] || []).push(item.name); return; }
      try { var d = parse(u); d.name = item.name; inst.push(d); st.dicom++; }
      catch (err) { st.skipped++; var m = err.message || 'unreadable'; (st.errors[m] = st.errors[m] || []).push(item.name); }
    }
    for (var q = 0; q < queue.length; q++) {
      await take(queue[q]); done++;
      if (onProgress && (done % 8 === 0 || done === queue.length)) { onProgress(done / queue.length); await sleep0(); }
    }
    return { instances: inst, stats: st };
  }

  /* ---- geometry helpers ------------------------------------------------------------------------------------------------- */
  var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
  var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
  var r3 = function (v) { return Math.round(v * 1000) / 1000; };
  /** images that share size and orientation (direction cosines within 0.02) -> [[...], ...] */
  function byOrientation(list) {
    var groups = [];
    list.forEach(function (i) {
      var o = i.tags.ImageOrientationPatient, hit = null;
      for (var g = 0; g < groups.length && !hit; g++) {
        var h = groups[g][0], q = h.tags.ImageOrientationPatient;
        if (h.rows === i.rows && h.cols === i.cols && o.every(function (v, k) { return Math.abs(v - q[k]) < 0.02; })) hit = groups[g];
      }
      if (hit) hit.push(i); else groups.push([i]);
    });
    return groups;
  }
  function hasGeom(i) { var t = i.tags; return Array.isArray(t.ImagePositionPatient) && t.ImagePositionPatient.length === 3 && Array.isArray(t.ImageOrientationPatient) && t.ImageOrientationPatient.length === 6; }

  /** cluster images by position along the slice normal: -> [{p, items[]}] sorted by p ascending */
  function bySlice(items, n) {
    var arr = items.map(function (i) { return { p: dot(i.tags.ImagePositionPatient, n), i: i }; }).sort(function (a, b) { return a.p - b.p; }), out = [];
    for (var k = 0; k < arr.length; k++) {
      var last = out[out.length - 1];
      if (last && Math.abs(arr[k].p - last.p) < 0.5) last.items.push(arr[k].i); else out.push({ p: arr[k].p, items: [arr[k].i] });
    }
    return out;
  }
  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (i) { var u = i.tags.SOPInstanceUID; if (u) { if (seen[u]) return; seen[u] = 1; } out.push(i); });
    return out;
  }

  /** short-axis cine MR -> stack. Chooses the orientation group with the most slices x phases (so scouts / long-axis views are ignored). */
  function buildCine(instances) {
    var warn = [], mr = instances.filter(function (i) { return hasGeom(i) && (i.tags.Modality === 'MR' || i.tags.Modality === undefined); });
    if (!mr.length) throw new Error('No MR images with position and orientation headers were found.');
    mr = dedupe(mr);
    var best = null, nOther = 0;
    byOrientation(mr).forEach(function (g) {
      var n = cross(g[0].tags.ImageOrientationPatient.slice(0, 3), g[0].tags.ImageOrientationPatient.slice(3)), sl = bySlice(g, n), cnt = {};
      sl.forEach(function (s) { cnt[s.items.length] = (cnt[s.items.length] || 0) + 1; });
      var T = +Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a] || b - a; })[0], score = sl.length * T;
      if (!best || score > best.score) best = { g: g, n: n, sl: sl, T: T, score: score };
    });
    nOther = mr.length - best.g.length;
    if (nOther) warn.push(nOther + ' image(s) with another orientation or size (other views / scouts) were ignored.');
    var T = best.T;
    if (T < 4) throw new Error('This does not look like a cine series: only ' + T + ' image(s) per slice position. Cine needs one image per cardiac phase at each slice (typically 20-30).');
    var slices = [], dropped = 0;
    best.sl.forEach(function (s) {
      var its = s.items.slice().sort(function (a, b) {
        var ta = a.tags.TriggerTime, tb = b.tags.TriggerTime;
        if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
        return (a.tags.InstanceNumber || 0) - (b.tags.InstanceNumber || 0);
      }), keep = [];
      its.forEach(function (i) { var last = keep[keep.length - 1]; if (last && last.tags.TriggerTime !== undefined && Math.abs(i.tags.TriggerTime - last.tags.TriggerTime) < 1e-3) return; keep.push(i); });
      if (keep.length !== T) { dropped++; return; }
      slices.push({ p: s.p, items: keep });
    });
    if (dropped) warn.push(dropped + ' slice position(s) had a different number of phases and were left out.');
    var S = slices.length;
    if (S < 3) throw new Error('Only ' + S + ' usable slice position(s) found; at least 3 short-axis slices are needed.');
    // keep the order the scanner wrote them (first instance number) so slice 1 is the first acquired - usually the base
    var hasInst = slices.every(function (s) { return s.items[0].tags.InstanceNumber !== undefined; });
    if (hasInst) slices.sort(function (a, b) { return a.items[0].tags.InstanceNumber - b.items[0].tags.InstanceNumber; });
    var pp = slices.map(function (s) { return s.p; }), mono = pp.every(function (v, i) { return i === 0 || (v - pp[i - 1]) * (pp[1] - pp[0]) > 0; });
    if (!mono) { slices.sort(function (a, b) { return a.p - b.p; }); pp = slices.map(function (s) { return s.p; }); warn.push('Slices were ordered by position (instance numbers did not follow the anatomy).'); }
    var steps = []; for (var k = 1; k < S; k++) steps.push(Math.abs(pp[k] - pp[k - 1]));
    var dz = Math.abs(pp[S - 1] - pp[0]) / (S - 1), dmax = Math.max.apply(null, steps), dmin = Math.min.apply(null, steps);
    if (dmax - dmin > 0.15 * dz) warn.push('Slice spacing is not uniform (' + dmin.toFixed(1) + '-' + dmax.toFixed(1) + ' mm); volumes use the mean ' + dz.toFixed(1) + ' mm.');
    var t0 = slices[0].items[0], px = t0.tags.PixelSpacing;
    if (!Array.isArray(px)) throw new Error('PixelSpacing is missing; volumes cannot be calibrated in mL.');
    if (Math.abs(px[0] - px[1]) > 0.01 * px[0]) warn.push('Pixels are not square (' + px[0] + ' x ' + px[1] + ' mm); the mean spacing is used.');
    var rr = slices.map(function (s) { var t = s.items[0].tags; return t.NominalInterval || (t.HeartRate ? 60000 / t.HeartRate : null); }),
      hr = rr.every(function (v) { return v; }) ? 60000 / (rr.reduce(function (a, b) { return a + b; }, 0) / S) : null;
    var trig = slices.map(function (s) { return s.items.map(function (i) { return i.tags.TriggerTime === undefined ? null : i.tags.TriggerTime; }); });
    var peak = 0;
    var frames = slices.map(function (s) { return s.items.map(function (i) { var a = i.pixel; for (var x = 0; x < a.length; x++) if (a[x] > peak) peak = a[x]; return a; }); });
    var tt = t0.tags;
    return {
      kind: 'cine', S: S, T: T, H: t0.rows, W: t0.cols, px: [px[0], px[1]], iop: tt.ImageOrientationPatient.slice(), ipp: slices.map(function (s) { return s.items[0].tags.ImagePositionPatient.slice(); }),
      dz: dz, trigger_ms: trig, rr_ms: rr, hr_bpm: hr === null ? null : Math.round(hr * 10) / 10, frames: frames, peak: peak, slice_thickness_mm: tt.SliceThickness || null,
      field_strength_t: tt.MagneticFieldStrength || null, scanner: [tt.Manufacturer, tt.ManufacturerModelName].filter(Boolean).join(' ') || null,
      warnings: warn
    };
  }

  /** CT series -> {dims, sp, data (HU)}.  A single image is accepted (a volume one slice deep). */
  function buildCT(instances) {
    var ct = instances.filter(function (i) { return hasGeom(i) && i.tags.Modality === 'CT'; });
    if (!ct.length) throw new Error('No CT images with position and orientation headers were found.');
    ct = dedupe(ct);
    var g = byOrientation(ct).sort(function (a, b) { return b.length - a.length; })[0],
      io = g[0].tags.ImageOrientationPatient, n = cross(io.slice(0, 3), io.slice(3)), sl = bySlice(g, n), warn = [];
    var ax = Math.abs(io[0]) > 0.99 && Math.abs(io[4]) > 0.99;
    if (!ax) warn.push('The CT is not axial (oblique or reformatted): slices are shown as stored.');
    var sl1 = sl.map(function (s) { return s.items[0]; }), D = sl1.length, t0 = sl1[0].tags, px = t0.PixelSpacing || [1, 1];
    var dz = D > 1 ? Math.abs(sl[D - 1].p - sl[0].p) / (D - 1) : (t0.SliceThickness || t0.SpacingBetweenSlices || 1);
    if (D > 2) { var mx = 0, mn = 1e9; for (var k = 1; k < D; k++) { var s = Math.abs(sl[k].p - sl[k - 1].p); mx = Math.max(mx, s); mn = Math.min(mn, s); } if (mx - mn > 0.15 * dz) warn.push('Slice spacing is not uniform; the mean ' + dz.toFixed(2) + ' mm is used.'); }
    var nx = sl1[0].cols, ny = sl1[0].rows, nz = 0;
    if (nx * ny * D > 2e8) throw new Error('This CT is too large to open in a browser tab (' + Math.round(nx * ny * D / 1e6) + ' million voxels).');
    var data = new Float32Array(nx * ny * D);
    sl1.forEach(function (im, z) {
      var sc = im.tags.RescaleSlope === undefined ? 1 : im.tags.RescaleSlope, ic = im.tags.RescaleIntercept || 0, a = im.pixel, o = z * nx * ny;
      if (im.tags.RescaleIntercept === undefined) nz++;
      for (var i = 0; i < nx * ny; i++) data[o + i] = a[i] * sc + ic;
    });
    if (nz) warn.push('RescaleIntercept is missing in ' + nz + ' image(s): values are raw, not guaranteed Hounsfield units.');
    return { kind: 'ct', dims: [nx, ny, D], sp: [px[1], px[0], dz], data: data, warnings: warn, frontAtTop: !(io[4] < -0.5),
      source: D + ' DICOM image' + (D > 1 ? 's' : '') + ', ' + nx + ' x ' + ny };
  }

  /* ---- what did the user select? -> CT / cine MR / a plain-language message ---------------------------------------------- */
  /** Error messages of this library -> plain language that names the next step. Never contains file names or UIDs. */
  var RULES = [
    [/compressed|encapsulated/i, 'These DICOM files are compressed (for example JPEG or JPEG 2000), which this page cannot decode. Next step: export the series again as uncompressed DICOM ("Explicit VR Little Endian"), or convert it to NIfTI, then open it.'],
    [/multi-frame/i, 'These are multi-frame ("enhanced") DICOM files, which this page cannot open. Next step: export the images as one file per slice (classic single-frame DICOM), or convert the series to NIfTI, then open it.'],
    [/colour/i, 'These are colour images (screenshots or reports), not a CT or MR series. Next step: select the original CT or MR images instead.'],
    [/bit depth/i, 'These images use a pixel format this page cannot read. Next step: export the series as uncompressed 8- or 16-bit DICOM, or convert it to NIfTI.'],
    [/truncated/i, 'The files look incomplete (cut off). Next step: copy the series again from its source and retry.'],
    [/not a valid \.zip|damaged \.zip/i, 'The .zip file cannot be read (it looks damaged). Next step: unzip it on your computer and open the folder, or create the .zip again.'],
    [/zip64|encrypted|unsupported \.zip/i, 'This .zip uses a format the page cannot read (encrypted, zip64 or an unusual compression). Next step: unzip it on your computer and open the folder instead.'],
    [/too large/i, 'This is too large to open in a browser tab. Next step: open a smaller or cropped series, for example only the heart region.'],
    [/no pixel data|not a readable dicom|image size missing/i, 'These files are not DICOM images (or hold no picture). Next step: select the .dcm files of one series (a folder or a .zip of them also works), or a single .nii / .nii.gz.'],
    [/No CT images with position/i, 'These CT images carry no slice-position headers, so they cannot be stacked into a volume. Next step: export the original series from the scanner or PACS (not screenshots), or convert it to NIfTI.'],
    [/No MR images with position/i, 'These MR images carry no slice-position headers, so they cannot be stacked. Next step: export the original cine series with its full headers.'],
    [/does not look like a cine/i, 'This MR series is not a cine: it has too few images per slice position (a cine has one image per heart phase at each slice, usually 20-30). Next step: open the short-axis cine series, or use "Load sample".'],
    [/usable slice position/i, 'Fewer than three short-axis slice positions were found. Next step: open the complete short-axis cine series (all slices), not a single view.'],
    [/PixelSpacing/i, 'The images do not say how large a pixel is, so volumes cannot be calibrated. Next step: export the series with its full DICOM headers.']
  ];
  function scrub(m) { return String(m || '').replace(/\b\d+(?:\.\d+){3,}\b/g, '').replace(/\s*\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim(); }
  function explain(message) {
    var m = String(message || '');
    if (/Next step:/.test(m)) return m;
    for (var i = 0; i < RULES.length; i++) if (RULES[i][0].test(m)) return RULES[i][1];
    return scrub(m) + (/[.!?]$/.test(scrub(m)) ? ' ' : '. ') + 'Next step: check that the selection is one CT series or one short-axis cine MR series (DICOM files, a folder or a .zip), or open a NIfTI CT.';
  }
  var NOTE = [[/compressed|encapsulated/i, 'compressed'], [/multi-frame/i, 'multi-frame'], [/no pixel data/i, 'no image data'], [/not a readable dicom/i, 'not DICOM'], [/gzip/i, 'NIfTI / gzip']];
  /** read = result of readFiles. kind 'ct' | 'mr': open it (instances = the images to build from). kind 'none': message says why and what to do next. */
  function classify(rd) {
    var inst = rd.instances || [], st = rd.stats || {}, errs = st.errors || {}, keys = Object.keys(errs), ct = [], mr = [], other = [], notes = [], i, j;
    inst.forEach(function (x) { var m = x.tags.Modality; if (m === 'CT') ct.push(x); else if (m === 'MR' || m === undefined) mr.push(x); else other.push(x); });
    var mods = []; other.forEach(function (x) { var m = String(x.tags.Modality).replace(/[^A-Z]/g, '').slice(0, 3); if (m && mods.indexOf(m) < 0) mods.push(m); });
    var counts = { files: st.files || 0, dicom: inst.length, ct: ct.length, mr: mr.length, other: other.length, skipped: st.skipped || 0 };
    function none(msg) { return { kind: 'none', instances: [], counts: counts, notes: notes, message: msg }; }
    if (!inst.length) {
      var order = [/compressed|encapsulated/i, /multi-frame/i, /colour/i, /bit depth/i, /truncated/i];
      for (i = 0; i < order.length; i++) for (j = 0; j < keys.length; j++) if (order[i].test(keys[j])) return none(explain(keys[j]));
      if (keys.some(function (k) { return /gzip/i.test(k); })) return none('A NIfTI file (.nii.gz) was selected together with other files. Next step: open the NIfTI file on its own (one .nii or .nii.gz), or select only DICOM files.');
      return none(explain('Not a readable DICOM file'));
    }
    if (ct.length && mr.length) return none('This selection mixes CT images (' + ct.length + ') and MR images (' + mr.length + '). Next step: open one series at a time: the CT folder for calcium, or the cine-MR folder for the left ventricle.');
    if (!ct.length && !mr.length) return none('These images are not CT or MR (' + (mods.join(', ') || 'unknown type') + '). CardioLens reads a CT series (calcium) or a short-axis cine MR series (left ventricle). Next step: open one of those, or a NIfTI CT.');
    if (st.skipped) {
      var parts = []; keys.forEach(function (k) { var lab = 'unreadable'; NOTE.forEach(function (r) { if (r[0].test(k)) lab = r[1]; }); parts.push(errs[k].length + ' ' + lab); });
      notes.push(st.skipped + ' of ' + (st.files || inst.length + st.skipped) + ' file(s) were skipped (' + parts.join(', ') + ').');
    }
    if (other.length) notes.push(other.length + ' image(s) of another type (' + mods.join(', ') + ') were ignored.');
    return { kind: ct.length ? 'ct' : 'mr', instances: ct.length ? ct : mr, counts: counts, notes: notes, message: '' };
  }

  root.DicomLib = { parse: parse, readZip: readZip, readFiles: readFiles, buildCine: buildCine, buildCT: buildCT, classify: classify, explain: explain, _bySlice: bySlice };
})(typeof module !== 'undefined' ? module.exports : window);
