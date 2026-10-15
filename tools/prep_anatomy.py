"""BodyParts3D heart meshes -> one compact, browser-ready anatomy blob (web/anatomy.b64).

Input : the 129 OBJ files of simonreisinger/Interactive-3D-Human-Heart-Visualization (data/Postnatal_anatomical_structure),
        which are BodyParts3D parts (c) DBCLS, licensed CC BY-SA 2.1 Japan.
Output: gzip(JSON) -> base64. One entry per anatomical group: int16-quantised positions + uint16 triangle indices.

Groups are decided from the FMA structure name in each file name. The three coronary groups (LAD / LCX / RCA) are the
meshes the risk model colours, so every coloured vessel belongs to exactly one model output (brief: "consistent
correspondence between model outputs and the displayed LAD, LCX and RCA structures"). Adding an anatomical structure =
add a rule to GROUPS below (or a new OBJ) and re-run; the viewer iterates over whatever groups the blob contains.

    python tools/prep_anatomy.py [path/to/Postnatal_anatomical_structure]
"""
import argparse, base64, gzip, json, os, re
import numpy as np
import fast_simplification as fs

ap = argparse.ArgumentParser()
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ap.add_argument("src", nargs="?", default=os.path.join(ROOT, "data", "anatomy_src", "data", "Postnatal_anatomical_structure"),
                help="folder with the BodyParts3D OBJ files: git clone https://github.com/simonreisinger/Interactive-3D-Human-Heart-Visualization data/anatomy_src")
args = ap.parse_args()
if not os.path.isdir(args.src):
    raise SystemExit(f"OBJ folder not found: {args.src}\nClone https://github.com/simonreisinger/Interactive-3D-Human-Heart-Visualization into data/anatomy_src "
                     "(or pass the Postnatal_anatomical_structure folder). The committed web/anatomy.b64 is the output of this script, so you only need this to change the anatomy.")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "anatomy.b64")
Q = 12000  # int16 quantisation: 1/12000 unit (~0.004 mm); heart normalised to 2.6 units tall (x up to +-1.3)

# (group, predicate on the lower-cased FMA name), first match wins
ATRIA_EXCEPTIONS = ("valve of coronary sinus", "valve of inferior vena cava", "tendon of todaro")
RULES = [
    ("LM",   lambda n: n.startswith("stem of left coronary")),
    ("LAD",  lambda n: "anterior interventricular" in n or "diagonal branch" in n or "left anterior branch" in n),
    ("LCX",  lambda n: "circumflex" in n or "left marginal artery" in n or "posterior interventricular branch of left" in n),
    ("RCA",  lambda n: "right coronary" in n),
    ("atria", lambda n: any(k in n for k in ATRIA_EXCEPTIONS)),
    ("conduction", lambda n: any(k in n for k in ("node", "bundle", "tract"))),
    ("veins", lambda n: "vein" in n or "coronary sinus" in n),
    ("valves", lambda n: any(k in n for k in ("valve", "leaflet", "cusp", "fibrous ring", "anulus", "scallop", "trigone"))),
    ("aorta", lambda n: "aorta" in n or "pulmonary trunk" in n),
    ("LV",   lambda n: "left ventricle" in n),
    ("RV",   lambda n: "right ventricle" in n or "supraventricular crest" in n or "septomarginal" in n),
    ("atria", lambda n: any(k in n for k in ("atrium", "auricle", "pectinate", "crista terminalis"))),
    ("septa", lambda n: "septum" in n),
]
# triangle budget per group after simplification (vessels are the focus, so they keep more detail)
BUDGET = {"LV": 7500, "RV": 4500, "atria": 5000, "septa": 1500, "valves": 3500, "aorta": 2500, "conduction": 1500,
          "veins": 4000, "LM": 10**6, "LAD": 8000, "LCX": 8000, "RCA": 8000, "other": 1500}


def group_of(name):
    n = name.lower()
    for g, rule in RULES:
        if rule(n):
            return g
    return "other"


def load_obj(path):
    V, F = [], []
    for line in open(path, errors="ignore"):
        if line.startswith("v "):
            V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("f "):
            ix = [int(t.split("/")[0]) - 1 for t in line.split()[1:]]
            F += [[ix[0], ix[k], ix[k + 1]] for k in range(1, len(ix) - 1)]
    return np.array(V, float), np.array(F, int)


groups, members = {}, {}
for f in sorted(os.listdir(args.src)):
    if not f.endswith(".obj"):
        continue
    name = re.match(r"MM\d+_BP\d+_FMA\d+_(.*)\.obj", f).group(1)
    V, F = load_obj(os.path.join(args.src, f))
    g = group_of(name)
    vs, fs_ = groups.setdefault(g, ([], []))
    off = sum(len(v) for v in vs)
    vs.append(V); fs_.append(F + off); members.setdefault(g, set()).add(name)

allv = np.vstack([np.vstack(v[0]) for v in groups.values()])
lo, hi = allv.min(0), allv.max(0); ctr = (lo + hi) / 2
scale = 2.6 / (hi[2] - lo[2]); mm_per_unit = 1 / scale
# BodyParts3D axes: x = patient left, y = posterior, z = superior  ->  three.js: x = patient left, y = up, z = anterior
to_three = lambda V: np.c_[V[:, 0] - ctr[0], V[:, 2] - ctr[2], -(V[:, 1] - ctr[1])] * scale
b64 = lambda b: base64.b64encode(b).decode()
out, anchor, info = {}, {}, {}
for k, (Vs, Fs) in groups.items():
    V, F = np.vstack(Vs), np.vstack(Fs)
    u, inv = np.unique(np.round(V, 2), axis=0, return_inverse=True)           # weld duplicate vertices -> smooth normals
    F = inv.reshape(-1)[F]
    F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
    n0 = len(F)
    if len(F) > BUDGET[k]:
        V, F = fs.simplify(u.astype(np.float32), F.astype(np.int32), target_reduction=min(0.97, 1 - BUDGET[k] / len(F)))
    else:
        V = u
    P = to_three(np.asarray(V, float))
    assert len(P) < 65536 and np.abs(P).max() * Q < 32767, k
    out[k] = {"p": b64(np.round(P * Q).astype("<i2").tobytes()), "i": b64(np.asarray(F).astype("<u2").tobytes())}
    ctr_g = P.mean(0)
    anchor[k] = [round(float(x), 4) for x in P[np.argmin(((P - ctr_g) ** 2).sum(1))]]  # on-surface vertex nearest the centroid
    info[k] = dict(parts=len(members[k]), tris_in=n0, tris=len(F), verts=len(P),
                   bbox=[np.round(P.min(0), 3).tolist(), np.round(P.max(0), 3).tolist()])
    print(f"{k:10s} parts {len(members[k]):3d}  tris {n0:6d} -> {len(F):6d}  verts {len(P):6d}")

meta = {"q": Q, "mm": round(mm_per_unit, 3), "g": out, "a": {k: anchor[k] for k in ("LAD", "LCX", "RCA")},
        "n": {k: info[k]["tris"] for k in info},
        "src": "BodyParts3D (c) DBCLS, CC BY-SA 2.1 JP; via simonreisinger/Interactive-3D-Human-Heart-Visualization"}
blob = base64.b64encode(gzip.compress(json.dumps(meta, separators=(",", ":")).encode(), 9)).decode()
open(OUT, "w").write(blob)
json.dump({"mm_per_unit": mm_per_unit, "groups": info, "members": {k: sorted(v) for k, v in members.items()}},
          open(os.path.join(os.path.dirname(OUT), "..", "results", "anatomy_report.json"), "w"), indent=1)
print(f"anatomy.b64: {len(blob) // 1024} KB | {mm_per_unit:.1f} mm per unit | total tris {sum(i['tris'] for i in info.values())}")
