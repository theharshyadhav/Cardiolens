#!/usr/bin/env python3
"""Build the built-in cine-MRI sample and the reference measurements the JavaScript port is tested against.

    python tools/make_cine_sample.py  <folder with the Sunnybrook short-axis DICOM folders>  [--crop 84,66,112,112]

Input : one subject of the Sunnybrook Cardiac Data (Radau et al. 2009; CC0 / public domain; Cardiac Atlas Project),
        11 short-axis slices x 20 cardiac phases, 256 x 256, as DICOM (de-identified).
Output: web/cine_sample.json     compact sample (lossless 8-bit crop around the heart, temporal-delta + gzip + base64) with geometry
        results/cine_reference.json   what cardiolens/cine.py measures on exactly that decoded sample (tests/test_cine.js must agree)
"""
from __future__ import annotations

import argparse
import base64
import collections
import glob
import gzip
import json
import os
import sys
import warnings
from pathlib import Path

import numpy as np
import pydicom

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cardiolens import cine  # noqa: E402
warnings.filterwarnings("ignore")


def read_series(folder: str):
    """-> (vol[S,T,H,W] float32, meta). Groups images by slice position, drops duplicate instances, orders phases by trigger time."""
    files = sorted(glob.glob(os.path.join(folder, "**", "*.dcm"), recursive=True))
    seen_uid, slices = set(), collections.defaultdict(list)
    for f in files:
        d = pydicom.dcmread(f)
        if d.get("Modality") != "MR" or "PixelData" not in d:
            continue
        uid = str(d.SOPInstanceUID)
        if uid in seen_uid:
            continue                      # a byte-identical second copy of an image (e.g. test.dcm)
        seen_uid.add(uid)
        pos = tuple(round(float(x), 2) for x in d.ImagePositionPatient)
        slices[pos].append((float(d.TriggerTime), int(d.InstanceNumber), d))
    order = sorted(slices, key=lambda p: min(t[1] for t in slices[p]))     # by first instance number: base -> apex
    T = collections.Counter(len(v) for v in slices.values()).most_common(1)[0][0]
    iop = np.array(slices[order[0]][0][2].ImageOrientationPatient, float)
    vol, trig, ipp, rr = [], [], [], []
    for p in order:
        lst = sorted(slices[p], key=lambda t: (t[0], t[1]))
        keep, last = [], None
        for t in lst:
            if last is not None and abs(t[0] - last) < 1e-3:
                continue                  # same trigger time twice
            keep.append(t)
            last = t[0]
        assert len(keep) == T, (p, len(keep), T)
        vol.append(np.stack([t[2].pixel_array.astype(np.float32) for t in keep]))
        trig.append([t[0] for t in keep])
        ipp.append([float(x) for x in keep[0][2].ImagePositionPatient])
        k0 = keep[0][2]
        rr.append(float(k0.NominalInterval) if "NominalInterval" in k0 else (60000.0 / float(k0.HeartRate) if "HeartRate" in k0 else None))
        assert np.allclose(keep[0][2].ImageOrientationPatient, iop, atol=1e-4)
    d0 = slices[order[0]][0][2]
    meta = dict(px_mm=[float(x) for x in d0.PixelSpacing], iop=[float(x) for x in iop], ipp=ipp, trigger_ms=trig,
                rr_ms=rr, hr_bpm=round(60000.0 / float(np.mean(rr)), 1) if all(r for r in rr) else None,
                slice_thickness_mm=float(d0.SliceThickness), field_strength_t=float(d0.MagneticFieldStrength),
                manufacturer=str(d0.Manufacturer).title(), model=str(d0.ManufacturerModelName))
    return np.stack(vol), meta


def encode(u8: np.ndarray) -> str:
    d = u8.copy()
    d[:, 1:] = u8[:, 1:] - u8[:, :-1]                      # temporal delta (mod 256) compresses far better
    return base64.b64encode(gzip.compress(d.tobytes(), 9, mtime=0)).decode()


def decode(b64: str, shape) -> np.ndarray:
    d = np.frombuffer(gzip.decompress(base64.b64decode(b64)), np.uint8).reshape(shape).copy()
    for t in range(1, shape[1]):
        d[:, t] = d[:, t] + d[:, t - 1]                    # uint8 wraps mod 256
    return d


def geometry(meta: dict):
    """slice normal and mean slice spacing (mm) from the position / orientation headers (not from SliceLocation)"""
    iop = np.array(meta["iop"])
    n = np.cross(iop[:3], iop[3:])
    P = np.array(meta["ipp"]) @ n
    return n, float(abs(P[-1] - P[0]) / (len(P) - 1))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--crop", default="84,66,112,112", help="x0,y0,width,height in pixels")
    a = ap.parse_args()
    vol, meta = read_series(a.folder)
    x0, y0, w, h = (int(v) for v in a.crop.split(","))
    S, T = vol.shape[:2]
    assert vol.min() >= 0 and vol.max() <= 255 and np.array_equal(vol, vol.astype(np.uint8)), "sample builder expects 8-bit data"
    u8 = np.ascontiguousarray(vol[:, :, y0:y0 + h, x0:x0 + w].astype(np.uint8))
    # the crop starts at pixel (x0, y0): shift every slice position accordingly so the geometry stays exact
    iop = np.array(meta["iop"]); fr, fc = iop[:3], iop[3:]
    dr, dc = meta["px_mm"]
    ipp = [list(np.array(p) + x0 * dc * fr + y0 * dr * fc) for p in meta["ipp"]]
    meta = {**meta, "ipp": [[round(float(v), 4) for v in p] for p in ipp]}
    n, dz = geometry(meta)
    b64 = encode(u8)
    sample = dict(
        name="Sunnybrook sample - short-axis cine, 11 slices x 20 phases", shape=[S, T, h, w], px_mm=meta["px_mm"], iop=meta["iop"], ipp=meta["ipp"],
        trigger_ms=meta["trigger_ms"], rr_ms=meta["rr_ms"], hr_bpm=meta["hr_bpm"], slice_thickness_mm=meta["slice_thickness_mm"],
        field_strength_t=meta["field_strength_t"], scanner=f'{meta["manufacturer"]} {meta["model"]}', crop=[x0, y0, w, h],
        source="Sunnybrook Cardiac Data (SCD0002001): 27-year-old man, heart failure without infarct; de-identified; cropped to the heart, lossless 8-bit",
        citation="Radau P, Lu Y, Connelly K, Paul G, Dick AJ, Wright GA. Evaluation Framework for Algorithms Segmenting Short Axis Cardiac MRI. "
                 "The MIDAS Journal - Cardiac MR Left Ventricle Segmentation Challenge, 2009. http://hdl.handle.net/10380/3070",
        licence="CC0 1.0 Universal (public domain), Cardiac Atlas Project", encoding="uint8, delta along phase (mod 256), gzip, base64", data=b64)
    out = ROOT / "web" / "cine_sample.json"
    out.write_text(json.dumps(sample, separators=(",", ":")))
    print(f"wrote {out}  {out.stat().st_size / 1e6:.2f} MB  shape {sample['shape']}  dz {dz:.4f} mm")

    # reference numbers: measured on exactly what a browser will decode
    back = decode(b64, u8.shape)
    assert np.array_equal(back, u8)
    m = cine.measure(back.astype(np.float64), meta["px_mm"][0], dz)
    sp = m["spread"]
    ref = dict(
        sample="web/cine_sample.json", px_mm=meta["px_mm"][0], dz_mm=dz, s0=m["s0"], keep=m["keep"], ed=m["ed"], es=m["es"],
        edv=m["edv"], esv=m["esv"], sv=m["sv"], ef=m["ef"], V=m["V"].tolist(), Vs=m["Vs"].tolist(),
        spread=dict(ef=sp["ef"], edv=sp["edv"], esv=sp["esv"], n=sp["n"], curves=sp["curves"].tolist()),
        area_mm2={str(s): m["areas"][s].tolist() for s in sorted(m["areas"])},
        median_area_mm2={str(s): v for s, v in sorted(m["med_area"].items())},
        centre_px={str(s): list(m["res"][s]["centre"]) for s in sorted(m["res"])},
        radii_px_slice5_phase0=m["res"][5]["R"][0].tolist(), radii_px_slice9_phase12=m["res"][9]["R"][12].tolist(),
        hr_bpm=meta["hr_bpm"], co_l_min=m["sv"] * meta["hr_bpm"] / 1000.0)
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results" / "cine_reference.json").write_text(json.dumps(ref, indent=1))
    print(f"reference: kept {ref['keep']}  EDV {ref['edv']:.2f} mL  ESV {ref['esv']:.2f} mL  EF {ref['ef']:.2f} %  "
          f"(range {sp['ef'][0]:.1f}-{sp['ef'][1]:.1f})  CO {ref['co_l_min']:.2f} L/min")


if __name__ == "__main__":
    main()
