"""Evidence for the in-app Model card, computed from the stored out-of-fold predictions (results/oof_probs.npz).

Nothing here re-fits a model: ROC curves, reliability bins and confusion matrices are derived from the pooled
5 x 5 repeated-CV out-of-fold probabilities of the *exported* model for each target, and global importance is
the mean |SHAP| already stored in web/web_model.json. Output: web/evidence.json (a few KB), inlined by build.py.
"""
import json
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_curve

from cardiolens.data import load_xy

ROOT = Path(__file__).resolve().parents[1]
RES, WEB = ROOT / "results", ROOT / "web"
T = ["CAD", "LAD", "LCX", "RCA"]


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return float(max(0, c - h)), float(min(1, c + h))


def thin(fpr, tpr, k=48):
    """Keep k points along the ROC curve (evenly spaced in arc length) so the file stays small but the shape is exact enough."""
    pts = np.c_[fpr, tpr]
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    keep = np.unique(np.searchsorted(s, np.linspace(0, s[-1], k)).clip(0, len(pts) - 1))
    return [[round(float(a), 3), round(float(b), 3)] for a, b in pts[keep]]


def main():
    _, Y = load_xy()
    oof = np.load(RES / "oof_probs.npz")
    m = json.loads((RES / "metrics.json").read_text())
    web = json.loads((WEB / "web_model.json").read_text())
    ev = {"protocol": web["meta"]["protocol"], "n": int(len(Y)), "targets": {}}
    for t in T:
        y = Y[t].to_numpy()
        P = oof[f"{t}|{m[t]['model']}"]            # (5 repeats, 303)
        yy, pp = np.tile(y, P.shape[0]), P.ravel()
        fpr, tpr, _ = roc_curve(yy, pp)
        # reliability: 8 equal-count bins on the pooled predictions
        order = np.argsort(pp)
        bins = []
        for idx in np.array_split(order, 8):
            k, n = int(yy[idx].sum()), len(idx)
            lo, hi = wilson(k, n)
            bins.append([round(float(pp[idx].mean()), 3), round(k / n, 3), round(lo, 3), round(hi, 3), n])
        # confusion matrix at 0.5, averaged over the 5 repeats (counts per 303 patients)
        cm = np.mean([[((P[r] >= .5) & (y == 1)).sum(), ((P[r] >= .5) & (y == 0)).sum(),
                       ((P[r] < .5) & (y == 0)).sum(), ((P[r] < .5) & (y == 1)).sum()] for r in range(P.shape[0])], axis=0)
        imp = sorted(web["targets"][t]["importance"].items(), key=lambda kv: -kv[1])[:10]
        h = m[t]["headline_pooled_oof"]
        ev["targets"][t] = dict(
            model=m[t]["model"], prevalence=round(m[t]["prevalence"], 4), auc=round(h["roc_auc"][0], 4),
            auc_ci95=[round(x, 4) for x in m[t]["roc_auc_ci95_bootstrap"]],
            metrics={k: [round(h[k][0], 4), round(h[k][1], 4)] for k in ("accuracy", "precision", "recall", "specificity", "f1", "pr_auc", "brier")},
            roc=thin(fpr, tpr), reliability=bins,
            confusion=dict(tp=round(float(cm[0]), 1), fp=round(float(cm[1]), 1), tn=round(float(cm[2]), 1), fn=round(float(cm[3]), 1)),
            importance=[[k, round(v, 4)] for k, v in imp], calibration_slope=round(m[t]["calibration"]["oof_slope"], 3),
            youden=web["targets"][t]["youden"])
    (WEB / "evidence.json").write_text(json.dumps(ev, separators=(",", ":")))
    print("web/evidence.json", (WEB / "evidence.json").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
