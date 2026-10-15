"""Can the strong overall-CAD signal help the weaker vessel models?  (same 5x5 outer folds as benchmark.py)

  baseline : LogReg-L2 on features                              (already in cv_folds.csv)
  stacked  : LogReg-L2 on [features, OOF CAD logit]             (stays linear in the raw features -> exact SHAP kept)
  hurdle   : sigma(z_CAD) * sigma(z_vessel | CAD)               (coherent: P(vessel) <= P(CAD); not linear)
All CAD information is derived from *training-fold labels only*; the vessel/CAD labels of test rows are never used.
"""
import sys, json
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, brier_score_loss
from sklearn.model_selection import GridSearchCV, RepeatedStratifiedKFold, StratifiedKFold, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT))
from cardiolens.data import load_xy

GRID = {"clf__C": [0.003, 0.01, 0.03, 0.1, 0.3, 1.0]}
mk = lambda: Pipeline([("sc", StandardScaler()), ("clf", LogisticRegression(max_iter=5000))])
tune = lambda i: GridSearchCV(mk(), GRID, cv=StratifiedKFold(3, shuffle=True, random_state=i), scoring="roc_auc")

X, Y = load_xy(); Xv = X.to_numpy(); ycad = Y["CAD"].to_numpy()
out = []
for tgt in ["LAD", "LCX", "RCA"]:
    y = Y[tgt].to_numpy()
    for i, (tr, te) in enumerate(RepeatedStratifiedKFold(n_splits=5, n_repeats=5, random_state=42).split(Xv, y)):
        cad = tune(i).fit(Xv[tr], ycad[tr]).best_estimator_
        z_tr = cross_val_predict(cad, Xv[tr], ycad[tr], cv=StratifiedKFold(5, shuffle=True, random_state=i), method="decision_function")
        z_te = cad.decision_function(Xv[te])
        # stacked
        st = tune(i).fit(np.c_[Xv[tr], z_tr], y[tr]).best_estimator_
        p_st = st.predict_proba(np.c_[Xv[te], z_te])[:, 1]
        # hurdle (conditional model only on CAD patients)
        m = ycad[tr] == 1
        hv = tune(i).fit(Xv[tr][m], y[tr][m]).best_estimator_
        p_hu = (1 / (1 + np.exp(-z_te))) * hv.predict_proba(Xv[te])[:, 1]
        out += [dict(target=tgt, model="stacked", fold=i, roc_auc=roc_auc_score(y[te], p_st), brier=brier_score_loss(y[te], p_st)),
                dict(target=tgt, model="hurdle", fold=i, roc_auc=roc_auc_score(y[te], p_hu), brier=brier_score_loss(y[te], p_hu))]
    print(tgt, "done", flush=True)
r = pd.DataFrame(out); r.to_csv(ROOT / "results" / "experiments_cv.csv", index=False)
base = pd.read_csv(ROOT / "results" / "cv_folds.csv"); base = base[base.model.isin(["LogReg-L2", "LogReg-L1"])]
allr = pd.concat([base[["target", "model", "fold", "roc_auc", "brier"]], r])
s = allr.groupby(["target", "model"])[["roc_auc", "brier"]].agg(["mean", "std"]).round(3); print(s)
# paired fold-wise difference vs LogReg-L2
l2 = base[base.model == "LogReg-L2"].set_index(["target", "fold"]).roc_auc
for mname in ["stacked", "hurdle"]:
    for t in ["LAD", "LCX", "RCA"]:
        d = r[(r.model == mname) & (r.target == t)].set_index(["target", "fold"]).roc_auc - l2
        d = d.dropna(); print(f"paired dAUC {mname:8s} {t}: {d.mean():+.4f}  (sd {d.std():.3f}, wins {int((d>0).sum())}/{len(d)})")
