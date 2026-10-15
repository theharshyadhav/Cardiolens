"""Nested, repeated, stratified cross-validation for every (target, model).

Outer loop  : RepeatedStratifiedKFold(5 x N_REPEATS) -> unbiased performance estimate.
Inner loop  : 3-fold GridSearchCV (log-loss: a proper scoring rule -> calibrated probabilities) on the outer-training part only -> hyper-parameters.
Identical outer splits for all models of a target, so models can be compared fold-by-fold.
Outputs     : results/cv_folds.csv, results/oof_probs.npz (repeat x sample out-of-fold probabilities).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.metrics import (accuracy_score, average_precision_score, brier_score_loss, confusion_matrix,
                             f1_score, log_loss, precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import GridSearchCV, RepeatedStratifiedKFold, StratifiedKFold

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cardiolens.data import load_xy  # noqa: E402
from cardiolens.models import model_zoo  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "results"
N_SPLITS, N_REPEATS, SEED = 5, 5, 42
ORDER = ["Prior (baseline)", "LogReg-L2", "LogReg-L1", "SVM-RBF", "HistGB", "RandomForest", "ExtraTrees"]


def fold_metrics(y, p, thr=0.5):
    yhat = (p >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, yhat, labels=[0, 1]).ravel()
    return dict(
        accuracy=accuracy_score(y, yhat), precision=precision_score(y, yhat, zero_division=0),
        recall=recall_score(y, yhat, zero_division=0), specificity=tn / max(tn + fp, 1),
        f1=f1_score(y, yhat, zero_division=0), roc_auc=roc_auc_score(y, p) if len(set(y)) > 1 else np.nan,
        pr_auc=average_precision_score(y, p), brier=brier_score_loss(y, p),
        logloss=log_loss(y, np.clip(p, 1e-6, 1 - 1e-6), labels=[0, 1]),
    )


def main(models=None, targets=None):
    X, Y = load_xy()
    zoo = model_zoo(SEED)
    models = models or ORDER
    targets = targets or list(Y.columns)
    rows, oof = [], {}
    if (OUT / "cv_folds.csv").exists() and (OUT / "oof_probs.npz").exists():  # resume: keep finished (target, model) pairs
        rows = pd.read_csv(OUT / "cv_folds.csv").to_dict("records")
        oof = dict(np.load(OUT / "oof_probs.npz"))
    for model in models:
        for tgt in targets:
            if f"{tgt}|{model}" in oof:
                continue
            y = Y[tgt].to_numpy()
            outer = RepeatedStratifiedKFold(n_splits=N_SPLITS, n_repeats=N_REPEATS, random_state=SEED)
            est, grid = zoo[model]
            P = np.zeros((N_REPEATS, len(y)))
            t0 = time.time()
            for i, (tr, te) in enumerate(outer.split(X, y)):
                rep = i // N_SPLITS
                if grid:
                    gs = GridSearchCV(est, grid, cv=StratifiedKFold(3, shuffle=True, random_state=i),
                                      scoring="neg_log_loss", refit=True, n_jobs=1)
                    gs.fit(X.iloc[tr], y[tr]); fit, params = gs.best_estimator_, gs.best_params_
                else:
                    fit, params = clone(est).fit(X.iloc[tr], y[tr]), {}
                p = fit.predict_proba(X.iloc[te])[:, 1]
                P[rep, te] = p
                rows.append(dict(target=tgt, model=model, fold=i, repeat=rep, params=json.dumps(params),
                                 **fold_metrics(y[te], p)))
            oof[f"{tgt}|{model}"] = P
            auc = np.mean([r["roc_auc"] for r in rows if r["target"] == tgt and r["model"] == model])
            print(f"[{time.strftime('%H:%M:%S')}] {model:17s} {tgt}  AUC={auc:.3f}  ({time.time()-t0:.0f}s)", flush=True)
            pd.DataFrame(rows).to_csv(OUT / "cv_folds.csv", index=False)
            np.savez_compressed(OUT / "oof_probs.npz", **oof)


if __name__ == "__main__":
    a = sys.argv[1:]
    main(models=[m for m in a if m in ORDER] or None)
