"""Left-ventricle measurement from a short-axis cine MRI stack (reference implementation).

web/cine.js is a port of this file, step for step, and tests/test_cine.js checks that both give the same numbers on the sample data.
Input is a pixel array (slices, phases, rows, cols) plus the geometry from the DICOM headers. Everything is classical image
processing (no learned model, no manual contours), so the output is an automatic ESTIMATE with an uncertainty range, not a
validated clinical measurement. It is written for bright-blood short-axis cine (bSSFP / FGRE): blood bright, myocardium darker.

Pipeline
  1. LV centre   centre-surround detector on the temporal-mean image of the mid-ventricular slices (bright disk, dark ring).
  2. Tracking    for every slice and phase: radial profiles around the centre. Pass 1 finds, per ray, the first place where the signal
                 falls below the blood/myocardium mid-level and stays low (a wall, not speckle); pass 2 moves that point to the steepest
                 descent nearby (so the contour sits half-way up the blurred edge wherever this part of the cavity is brighter or dimmer).
                 An angular median filter (+-30 deg) keeps papillary muscles inside the cavity; light smoothing gives a closed polar
                 contour r(theta). The centre is refined from the contour and followed from slice to slice.
  3. Slices      slices whose contour is not a closed ring (aortic root / atrium at the base: area jumps) or is tiny (apex) are left out.
                 A reader can switch any slice on or off in the app; volumes are then re-summed.
  4. Volumes     modified Simpson: sum of slice areas x slice spacing, per phase. EDV / ESV = max / min of the 3-phase-smoothed curve.
  5. Spread      the same measurement is repeated with the threshold level +-0.05, smoothing sigma and median window changed; the range of
                 EDV / ESV / EF over these five settings is reported. It is a sensitivity range, not a confidence interval.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi

NA = 72                    # angular samples (5 deg)
RSTEP = 0.5                # px
RMAX_MM = 60.0             # search radius
MED_WIN = 13               # angular median window (samples) = +-30 deg
LEVEL = 0.5                # boundary level between wall (0) and blood (1) for the first pass
MINRUN_MM = 4.0            # the signal must stay below the level for this long
REFINE_MM = 4.0            # second pass: steepest descent within +- this distance
SIGMA = 1.0                # px, smoothing before profiles
ANG = np.linspace(0, 2 * np.pi, NA, endpoint=False)


# ---- primitives (each has an exact twin in cine.js) -----------------------------------------------------------------------
def gauss(img: np.ndarray, sigma: float) -> np.ndarray:
    return ndi.gaussian_filter(img.astype(np.float64), sigma, mode="nearest", truncate=3.0)


def disk_mean(img: np.ndarray, r: int) -> np.ndarray:
    """mean over the discrete disk x^2+y^2<=r^2, border replicated (row-wise prefix sums in the JS port)."""
    h, w = img.shape
    pad = np.pad(img, r, mode="edge")
    cs = np.concatenate([np.zeros((pad.shape[0], 1)), np.cumsum(pad, axis=1)], axis=1)
    acc = np.zeros((h, w))
    n = 0
    for dy in range(-r, r + 1):
        hw = int(np.floor(np.sqrt(r * r - dy * dy)))
        rows = slice(r + dy, r + dy + h)
        acc += cs[rows, r + hw + 1: r + hw + 1 + w] - cs[rows, r - hw: r - hw + w]
        n += 2 * hw + 1
    return acc / n


def disk_n(r: int) -> int:
    return sum(2 * int(np.floor(np.sqrt(r * r - dy * dy))) + 1 for dy in range(-r, r + 1))


def ring_mean(img: np.ndarray, r1: int, r2: int) -> np.ndarray:
    """mean over r1 < dist <= r2 computed from two disk sums"""
    a = disk_mean(img, r2)
    b = disk_mean(img, r1)
    n2, n1 = disk_n(r2), disk_n(r1)
    return (a * n2 - b * n1) / (n2 - n1)


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return ndi.map_coordinates(img, [y, x], order=1, mode="nearest")


def circ_median(v: np.ndarray, w: int) -> np.ndarray:
    n, pad = len(v), w // 2
    vv = np.concatenate([v[-pad:], v, v[:pad]])
    return np.array([np.sort(vv[i:i + w])[w // 2] for i in range(n)])


# ---- step 1: centre -------------------------------------------------------------------------------------------------------
def find_centre(mean_img: np.ndarray, px_mm: float, rmin_mm=17.0, rmax_mm=46.0):
    """best (score, x, y, r_px) of a bright disk with a darker ring around it; None if nothing is bright enough."""
    m = gauss(mean_img, 1.5)
    hi = np.percentile(m, 99.5)
    best = None
    mrg = int(round(24 / px_mm))
    for r in range(int(round(rmin_mm / px_mm)), int(round(rmax_mm / px_mm)) + 1):
        d = disk_mean(m, r)
        a = ring_mean(m, r + 2, r + 6)
        sc = (d - a) * (d > 0.45 * hi)
        sc[:mrg, :] = -1e9; sc[-mrg:, :] = -1e9; sc[:, :mrg] = -1e9; sc[:, -mrg:] = -1e9
        i = np.unravel_index(np.argmax(sc), sc.shape)
        if best is None or sc[i] > best[0]:
            best = (float(sc[i]), int(i[1]), int(i[0]), r)
    return best


# ---- step 2: boundary tracking --------------------------------------------------------------------------------------------
def profiles(sm: np.ndarray, cx: float, cy: float, rmax_px: float):
    rs = np.arange(0.0, rmax_px, RSTEP)
    X = cx + np.outer(np.cos(ANG), rs)
    Y = cy + np.outer(np.sin(ANG), rs)
    return bilinear(sm, X, Y), rs


def track(sm: np.ndarray, cx: float, cy: float, r0: float, px_mm: float, level: float = LEVEL, med: int = MED_WIN):
    """polar endocardial contour r(theta) in px, from an already smoothed image `sm`.

    Pass 1, per ray: the first place where the signal falls below  wall + level * (blood - wall)  and stays below for MINRUN_MM.
    Pass 2: move each boundary to the steepest descent within +-REFINE_MM.
    """
    prof, rs = profiles(sm, cx, cy, RMAX_MM / px_mm)
    blood = float(np.median(prof[:, rs < 0.5 * r0]))
    ringv = prof[:, (rs > r0) & (rs < 1.5 * r0)]
    wall = float(np.percentile(ringv, 15))
    thr = wall + level * (blood - wall)
    run = max(2, int(round(MINRUN_MM / px_mm / RSTEP)))
    ref = max(1, int(round(REFINE_MM / px_mm / RSTEP)))
    i0 = int(0.3 * r0 / RSTEP)
    g = -np.gradient(prof, RSTEP, axis=1)           # intensity lost per px
    rb = np.empty(NA)
    nopen = 0
    for k in range(NA):
        below = prof[k] < thr
        j = len(rs) - 1
        for i in range(i0, len(rs) - run):
            if below[i] and below[i:i + run].all():
                j = i
                break
        if j >= len(rs) - 1:
            nopen += 1
        else:
            lo, hi = max(i0, j - ref), min(len(rs) - 1, j + ref)
            j = lo + int(np.argmax(g[k, lo:hi + 1]))
        rb[k] = rs[j]
    rb = circ_median(rb, med)
    rb = ndi.gaussian_filter1d(rb, 1.0, mode="wrap")
    return rb, dict(blood=blood, wall=wall, thr=thr, open_frac=nopen / NA)


def polar_area(rb: np.ndarray) -> float:
    x, y = rb * np.cos(ANG), rb * np.sin(ANG)
    return 0.5 * abs(float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)))


def centroid_of(rb: np.ndarray, cx: float, cy: float):
    x, y = cx + rb * np.cos(ANG), cy + rb * np.sin(ANG)
    x1, y1 = np.roll(x, -1), np.roll(y, -1)
    cr = x * y1 - x1 * y
    a = cr.sum() / 2
    return float(((x + x1) * cr).sum() / (6 * a)), float(((y + y1) * cr).sum() / (6 * a))


# ---- step 3-5: stack -------------------------------------------------------------------------------------------------------
def track_slice(frames: np.ndarray, cx: float, cy: float, r0: float, px_mm: float, level=LEVEL, med=MED_WIN, iters=2, sigma=SIGMA):
    """track every phase of one slice; the centre is refined with the centroid of the median contour. Returns radii (T, NA)."""
    sm = [gauss(f, sigma) for f in frames]
    T = len(sm)
    for _ in range(iters):
        R = np.empty((T, NA))
        infos = []
        for t in range(T):
            R[t], inf = track(sm[t], cx, cy, r0, px_mm, level, med)
            infos.append(inf)
        mc = np.median(R, axis=0)
        cx, cy = centroid_of(mc, cx, cy)
        r0 = max(6.0, float(np.sqrt(polar_area(mc) / np.pi)))
    return R, infos, (cx, cy, r0)


def start_centre(vol: np.ndarray, px_mm: float):
    """the most LV-like bright disk among the middle slices: (slice, x, y, r_px)"""
    S = vol.shape[0]
    cands = []
    for s in range(max(0, S // 2 - 2), min(S, S // 2 + 3)):
        c = find_centre(vol[s].mean(0), px_mm)
        if c:
            cands.append((c[0], s, c))
    if not cands:
        raise ValueError("no left-ventricle-like bright disk found; pass centre=(slice, x, y)")
    _, s0, (_, cx0, cy0, r0) = max(cands)
    return s0, cx0, cy0, r0


def trace_stack(vol: np.ndarray, px_mm: float, level=LEVEL, med=MED_WIN, centre=None, sigma=SIGMA):
    """track every slice and phase. vol: (S, T, H, W). centre=(slice, x, y) overrides the automatic start."""
    S = vol.shape[0]
    if centre is None:
        s0, cx0, cy0, r0 = start_centre(vol, px_mm)
    else:
        s0, cx0, cy0 = centre
        r0 = 20.0 / px_mm
    res = {}
    state0 = (float(cx0), float(cy0), float(r0))
    for direction in (-1, +1):
        state = state0
        s = s0 if direction == -1 else s0 + 1
        while 0 <= s < S:
            R, infos, st = track_slice(vol[s], *state, px_mm, level, med, 2, sigma)
            res[s] = dict(R=R, centre=(st[0], st[1]), r0=st[2], open_frac=float(np.mean([i["open_frac"] for i in infos])))
            state = st
            if direction == -1 and s == s0:
                state0 = st
            s += direction
        if direction == -1:
            state = state0
    return res, s0


# ---- repair, slice selection, volumes -----------------------------------------------------------------------------------
CLIP_LO, CLIP_HI = 0.65, 1.25      # a contour radius may deviate this much from its own temporal median (thin walls leak at the apex)
MAX_GROWTH = 1.6                   # a slice this much bigger than its neighbour towards the start slice is atrium / aortic root, not LV
MAX_SHIFT_MM = 15.0                # centre jump between neighbouring slices
MIN_AREA_MM2 = 25.0                # smaller than 0.25 cm2: no cavity


def repair(R: np.ndarray) -> np.ndarray:
    """clip each angle's radius to [CLIP_LO, CLIP_HI] x its median over the cardiac cycle"""
    med = np.median(R, axis=0)
    return np.clip(R, CLIP_LO * med, CLIP_HI * med)


def median_areas_mm2(res: dict, px_mm: float) -> dict:
    return {s: float(np.median([polar_area(r) for r in v["R"]])) * px_mm ** 2 for s, v in res.items()}


def select_slices(res: dict, s0: int, px_mm: float) -> list:
    """contiguous run of slices around the start slice that behave like left ventricle"""
    A = median_areas_mm2(res, px_mm)
    keep = {s0}
    for direction in (-1, +1):
        prev = s0
        s = s0 + direction
        while s in res:
            a, ap = A[s], A[prev]
            shift = float(np.hypot(*(np.array(res[s]["centre"]) - np.array(res[prev]["centre"])))) * px_mm
            if a < MIN_AREA_MM2 or shift > MAX_SHIFT_MM or a / max(ap, 1e-9) > MAX_GROWTH:
                break
            keep.add(s)
            prev = s
            s += direction
    return sorted(keep)


def smooth3(v: np.ndarray) -> np.ndarray:
    return (np.roll(v, 1) + v + np.roll(v, -1)) / 3.0


def slice_areas(res: dict, px_mm: float) -> dict:
    """repaired contour area per slice and phase, mm2"""
    return {s: np.array([polar_area(r) for r in repair(v["R"])]) * px_mm ** 2 for s, v in res.items()}


def volumes(areas: dict, keep: list, dz_mm: float):
    """modified Simpson from the chosen slices: returns (V, Vs, ed, es, edv, esv, sv, ef) with V in mL"""
    V = np.sum([areas[s] for s in keep], axis=0) * dz_mm / 1000.0
    Vs = smooth3(V)
    ed, es = int(np.argmax(Vs)), int(np.argmin(Vs))
    edv, esv = float(Vs[ed]), float(Vs[es])
    return dict(V=V, Vs=Vs, ed=ed, es=es, edv=edv, esv=esv, sv=edv - esv, ef=100.0 * (edv - esv) / edv)


VARIANTS = [(LEVEL, MED_WIN, SIGMA), (0.45, MED_WIN, SIGMA), (0.55, MED_WIN, SIGMA), (LEVEL, MED_WIN, 1.4), (LEVEL, MED_WIN + 2, 0.8)]


def measure(vol: np.ndarray, px_mm: float, dz_mm: float, centre=None, variants=True):
    """full measurement; returns the base result plus the EF / EDV / ESV spread over the segmentation variants"""
    vol = np.asarray(vol, np.float64)
    out = None
    curves, stats = [], []
    for i, (lv, md, sg) in enumerate(VARIANTS if variants else VARIANTS[:1]):
        res, s0 = trace_stack(vol, px_mm, lv, md, centre, sg)
        keep = select_slices(res, s0, px_mm)
        areas = slice_areas(res, px_mm)
        m = volumes(areas, keep, dz_mm)
        curves.append(m["Vs"])
        stats.append((m["ef"], m["edv"], m["esv"]))
        if i == 0:
            out = dict(res=res, s0=s0, keep=keep, areas=areas, med_area=median_areas_mm2(res, px_mm), **m)
    sp = np.array(stats)
    out["spread"] = dict(ef=(float(sp[:, 0].min()), float(sp[:, 0].max())), edv=(float(sp[:, 1].min()), float(sp[:, 1].max())),
                         esv=(float(sp[:, 2].min()), float(sp[:, 2].max())), n=len(sp), curves=np.array(curves))
    return out
