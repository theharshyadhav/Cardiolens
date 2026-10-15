"""Select final models from the nested-CV results, calibrate, explain, validate and export.

Reads  : results/cv_folds.csv, results/oof_probs.npz   (from benchmark.py)
Writes : models/cardiolens_models.joblib   sklearn pipelines + calibration (Python backend)
         web/web_model.json                portable weights + schema + stats (browser / any backend)
         results/metrics.json, cv_summary.csv, feature_audit.csv, figures/*.png
SHAP   : the exported models are (calibrated) logistic regressions, so interventional SHAP is exact and
         closed-form: phi_j = w_j * (t(x_j) - mu_j) / sd_j   (log-odds units); verified against shap.LinearExplainer.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import shap
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score, roc_curve
from sklearn.model_selection import GridSearchCV, RepeatedStratifiedKFold, StratifiedKFold

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cardiolens.benchmark import fold_metrics  # noqa: E402
from cardiolens.data import FEATURES, KEYS, TARGETS, build_features, feature_audit, load_raw, load_xy  # noqa: E402
from cardiolens.models import EXPORTABLE, model_zoo  # noqa: E402

RES, FIG, MOD, WEB = ROOT / "results", ROOT / "results" / "figures", ROOT / "models", ROOT / "web"
for d in (FIG, MOD, WEB):
    d.mkdir(parents=True, exist_ok=True)
T_ORDER = ["CAD", "LAD", "LCX", "RCA"]
METRICS = ["accuracy", "precision", "recall", "specificity", "f1", "roc_auc", "pr_auc", "brier", "logloss"]
from cardiolens.palette import COLORS  # validated, colour-vision-safe palette (see palette.py)
# plausible physiological bounds for the UI sliders (training range is exported separately for extrapolation warnings)
BOUNDS = dict(age=(18, 95), bmi=(14, 50), sbp=(70, 230), pr=(35, 160), fbs=(50, 450), cr=(0.3, 6), tg=(30, 1200),
              ldl=(10, 300), hdl=(10, 120), bun=(3, 100), esr=(1, 120), hb=(6, 20), k=(2.5, 7), na=(120, 160),
              wbc=(2000, 25000), lymph=(3, 70), neut=(20, 95), plt=(20, 800), ef=(10, 75))
ORD_MAX = dict(fclass=3, rwma=4, vhd=3)

plt.rcParams.update({"figure.dpi": 140, "savefig.dpi": 160, "axes.spines.top": False, "axes.spines.right": False,
                     "font.size": 9.5, "axes.titleweight": "bold", "axes.grid": True, "grid.alpha": .25})


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def fit_platt(z, y):
    lr = LogisticRegression(C=1e6, solver="lbfgs", max_iter=2000).fit(z.reshape(-1, 1), y)
    return float(lr.coef_[0, 0]), float(lr.intercept_[0])


def crossfit_platt(Z, y, seed=0):
    """Honest estimate of Platt recalibration: (a, b) fitted on 4/5 of the samples, applied to the other 1/5."""
    R, n = Z.shape
    out = np.zeros_like(Z)
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=seed).split(np.zeros(n), y):
        a, b = fit_platt(Z[:, tr].ravel(), np.tile(y[tr], R))
        out[:, te] = sigmoid(a * Z[:, te] + b)
    return out


def boot_ci(y, p, fn, B=2000, seed=0):
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(B):
        i = rng.integers(0, len(y), len(y))
        if y[i].min() != y[i].max():
            vals.append(fn(y[i], p[i]))
    return [float(v) for v in np.percentile(vals, [2.5, 97.5])]


def calib_slope_intercept(p, y):
    z = logit(p)
    lr = LogisticRegression(C=1e6, max_iter=2000).fit(z.reshape(-1, 1), y)
    return float(lr.coef_[0, 0]), float(lr.intercept_[0])


def main():
    t0 = time.time()
    df = load_raw()
    X, Y = load_xy()
    folds = pd.read_csv(RES / "cv_folds.csv")
    oof = np.load(RES / "oof_probs.npz")
    feature_audit(df).to_csv(RES / "feature_audit.csv", index=False)

    # ------------------------------------------------------------------ 1. model comparison table
    g = folds.groupby(["target", "model"])[METRICS]
    summ = g.mean().add_suffix("_mean").join(g.std().add_suffix("_sd")).reset_index()
    summ.to_csv(RES / "cv_summary.csv", index=False)

    # ------------------------------------------------------------------ 2. choose exportable model per target
    chosen = {}
    for t in T_ORDER:
        s = folds[(folds.target == t) & folds.model.isin(EXPORTABLE)].groupby("model").logloss.mean()
        chosen[t] = s.idxmin()  # exportable model with the lowest nested-CV log-loss
    best_any = {t: summ[summ.target == t].sort_values("roc_auc_mean").iloc[-1][["model", "roc_auc_mean"]].tolist() for t in T_ORDER}
    print("chosen exportable:", chosen, "\nbest overall   :", best_any)

    zoo = model_zoo(0)
    pack, web_targets, report = {}, {}, {}
    Xv = X.to_numpy()
    for t in T_ORDER:
        y = Y[t].to_numpy()
        est, grid = zoo[chosen[t]]
        gs = GridSearchCV(est, grid, cv=RepeatedStratifiedKFold(n_splits=5, n_repeats=3, random_state=7),
                          scoring="neg_log_loss", refit=True).fit(X, y)
        pipe = gs.best_estimator_
        sc, clf = pipe.named_steps["sc"], pipe.named_steps["clf"]
        mu, sd, coef, icpt = sc.mean_, sc.scale_, clf.coef_[0], float(clf.intercept_[0])

        # ---------------------------------------------- calibration (cross-fitted evidence, then final a, b)
        P = oof[f"{t}|{chosen[t]}"]
        Z = logit(P)
        Pcal = crossfit_platt(Z, y)
        raw = dict(brier=float(np.mean([np.mean((P[r] - y) ** 2) for r in range(len(P))])),
                   logloss=float(np.mean([log_loss(y, np.clip(P[r], 1e-6, 1 - 1e-6)) for r in range(len(P))])))
        cal = dict(brier=float(np.mean([np.mean((Pcal[r] - y) ** 2) for r in range(len(P))])),
                   logloss=float(np.mean([log_loss(y, np.clip(Pcal[r], 1e-6, 1 - 1e-6)) for r in range(len(P))])))
        slope, cint = calib_slope_intercept(P.mean(0), y)
        apply = (raw["brier"] - cal["brier"] >= 0.002) and (raw["logloss"] - cal["logloss"] >= 0.002)
        a, b = fit_platt(Z.ravel(), np.tile(y, P.shape[0])) if apply else (1.0, 0.0)
        Pfinal = Pcal if apply else P

        # ---------------------------------------------- exact SHAP (closed form) + verification vs shap library
        w = a * coef
        base = a * icpt + b
        Xs = (Xv - mu) / sd
        phi = Xs * w
        z_final = base + phi.sum(1)
        z_pipe = a * pipe.decision_function(X) + b
        assert np.abs(z_final - z_pipe).max() < 1e-9, "closed-form logit != sklearn pipeline"
        masker = shap.maskers.Independent(Xs, max_samples=Xs.shape[0])  # use ALL 303 rows as background (default subsamples to 100)
        expl = shap.LinearExplainer((w, base), masker)
        phi_lib = np.asarray(expl.shap_values(Xs))
        assert np.abs(phi_lib - phi).max() < 1e-8, "closed-form SHAP != shap.LinearExplainer"
        assert np.abs(base + phi.sum(1) - z_final).max() < 1e-9

        # ---------------------------------------------- headline metrics of the *exported* model (per-repeat pooled OOF)
        per_rep = pd.DataFrame([fold_metrics(y, Pfinal[r]) for r in range(len(Pfinal))])
        head = {m: [float(per_rep[m].mean()), float(per_rep[m].std())] for m in METRICS}
        auc_ci = boot_ci(y, Pfinal[0], roc_auc_score)
        fm = folds[(folds.target == t) & (folds.model == chosen[t])]
        nested = {m: [float(fm[m].mean()), float(fm[m].std())] for m in METRICS}
        fpr, tpr, thr = roc_curve(y, Pfinal.mean(0))
        yj = int(np.argmax(tpr - fpr))
        youden = dict(threshold=float(thr[yj]), sensitivity=float(tpr[yj]), specificity=float(1 - fpr[yj]))

        report[t] = dict(model=chosen[t], best_C=float(clf.C), prevalence=float(y.mean()), n_positive=int(y.sum()),
                         headline_pooled_oof=head, roc_auc_ci95_bootstrap=auc_ci, nested_cv_fold_level=nested,
                         calibration=dict(applied=bool(apply), a=a, b=b, oof_slope=slope, oof_intercept=cint,
                                          raw=raw, crossfitted=cal), youden_operating_point=youden,
                         n_nonzero_coef=int(np.sum(np.abs(coef) > 1e-9)))
        pack[t] = dict(pipeline=pipe, a=a, b=b, y=y, P=Pfinal, phi=phi, base=base, w=w, mu=mu, sd=sd)
        imp = np.abs(phi).mean(0)
        web_targets[t] = dict(model=chosen[t], base=float(base), w={k: float(v) for k, v in zip(KEYS, w)},
                              prevalence=float(y.mean()), calibration=dict(applied=bool(apply), a=a, b=b),
                              metrics=head, auc_ci95=auc_ci, youden=youden,
                              importance={k: float(v) for k, v in zip(KEYS, imp)})
        print(f"{t}: {chosen[t]} C={clf.C:g}  AUC={head['roc_auc'][0]:.3f} [{auc_ci[0]:.3f},{auc_ci[1]:.3f}]  "
              f"acc={head['accuracy'][0]:.3f} F1={head['f1'][0]:.3f}  calib slope={slope:.2f} applied={apply}")

    # ------------------------------------------------------------------ 3. coherence between CAD and vessel models
    Pm = {t: pack[t]["P"].mean(0) for t in T_ORDER}
    pmax = np.max([Pm[v] for v in ("LAD", "LCX", "RCA")], axis=0)
    ycad = Y["CAD"].to_numpy()
    report["coherence"] = dict(
        frac_vessel_prob_exceeds_cad_prob=float(np.mean(pmax > Pm["CAD"])),
        label_check_cad_equals_any_vessel=float(np.mean(ycad == Y[["LAD", "LCX", "RCA"]].max(axis=1).to_numpy())))
    for v in ("LAD", "LCX", "RCA"):  # effect of capping each vessel probability at P(CAD) (out-of-fold)
        yv, pv = Y[v].to_numpy(), Pm[v]
        pc = np.minimum(pv, Pm["CAD"])
        report["coherence"][v] = dict(frac_capped=float(np.mean(pv > Pm["CAD"])), auc_uncapped=float(roc_auc_score(yv, pv)),
                                      auc_capped=float(roc_auc_score(yv, pc)), brier_uncapped=float(np.mean((pv - yv) ** 2)),
                                      brier_capped=float(np.mean((pc - yv) ** 2)))

    # ------------------------------------------------------------------ 4. figures
    from cardiolens.figures_models import plot_model_comparison  # same row order in every panel (see module docstring)
    plot_model_comparison(summ, chosen, FIG / "fig1_model_comparison.png")

    fig, ax = plt.subplots(figsize=(5.2, 4.8))
    for t in T_ORDER:
        fpr, tpr, _ = roc_curve(pack[t]["y"], pack[t]["P"].mean(0))
        h = report[t]["headline_pooled_oof"]["roc_auc"][0]
        ax.plot(fpr, tpr, lw=2, color=COLORS[t], label=f"{t}  AUC {h:.3f}")
    ax.plot([0, 1], [0, 1], "--", color="gray"); ax.set_xlabel("1 − specificity"); ax.set_ylabel("Sensitivity")
    ax.set_title("Out-of-fold ROC"); ax.legend(loc="lower right"); fig.tight_layout()
    fig.savefig(FIG / "fig2_roc.png"); plt.close(fig)

    fig, axs = plt.subplots(1, 4, figsize=(13, 3.4))
    for ax, t in zip(axs, T_ORDER):
        p, y = pack[t]["P"].mean(0), pack[t]["y"]
        q = pd.qcut(p, 6, duplicates="drop")
        d = pd.DataFrame({"p": p, "y": y, "q": q}).groupby("q", observed=True).agg(p=("p", "mean"), y=("y", "mean"), n=("y", "size"))
        ax.plot([0, 1], [0, 1], "--", color="gray"); ax.plot(d.p, d.y, "o-", color=COLORS[t])
        ax.set_title(f"{t}  (slope {report[t]['calibration']['oof_slope']:.2f})"); ax.set_xlabel("Predicted probability")
        ax.set_ylabel("Observed frequency" if t == "CAD" else ""); ax.set_xlim(0, 1); ax.set_ylim(0, 1)
    fig.suptitle("Calibration (out-of-fold, equal-count bins)", y=1.03, fontweight="bold"); fig.tight_layout()
    fig.savefig(FIG / "fig3_calibration.png", bbox_inches="tight"); plt.close(fig)

    fig, axs = plt.subplots(1, 4, figsize=(12.5, 3.2))
    for ax, t in zip(axs, T_ORDER):
        yy, pp = pack[t]["y"], (pack[t]["P"][0] >= .5).astype(int)
        cm = np.array([[np.sum((yy == i) & (pp == j)) for j in (0, 1)] for i in (0, 1)])
        ax.imshow(cm, cmap="Blues"); ax.grid(False)
        for i in (0, 1):
            for j in (0, 1):
                ax.text(j, i, cm[i, j], ha="center", va="center", color="white" if cm[i, j] > cm.max() / 2 else "black", fontsize=13)
        ax.set_xticks([0, 1]); ax.set_xticklabels(["Pred −", "Pred +"]); ax.set_yticks([0, 1])
        ax.set_yticklabels(["True −", "True +"]); ax.set_title(t)
    fig.suptitle("Confusion matrices (out-of-fold, threshold 0.5, repeat 1)", y=1.04, fontweight="bold"); fig.tight_layout()
    fig.savefig(FIG / "fig4_confusion.png", bbox_inches="tight"); plt.close(fig)

    labels = [f.label for f in FEATURES]
    Xdisp = build_features(df, apply_log=False)
    for t in T_ORDER:
        shap.plots.beeswarm(shap.Explanation(values=pack[t]["phi"], base_values=np.full(len(Y), pack[t]["base"]),
                                             data=Xdisp.to_numpy(), feature_names=labels), max_display=12, show=False)
        plt.title(f"SHAP summary — {t} (log-odds)", fontweight="bold"); plt.gcf().set_size_inches(7, 4.6)
        plt.tight_layout(); plt.savefig(FIG / f"fig5_shap_{t}.png"); plt.close()

    groups = sorted({f.group for f in FEATURES}, key=[f.group for f in FEATURES].index)
    gi = pd.DataFrame({t: [np.abs(pack[t]["phi"][:, [i for i, f in enumerate(FEATURES) if f.group == gname]].sum(1)).mean()
                           for gname in groups] for t in T_ORDER}, index=groups)
    ax = gi.plot.barh(figsize=(7, 4), color=[COLORS[t] for t in T_ORDER], width=.8)
    ax.invert_yaxis(); ax.set_xlabel("mean |net SHAP| per clinical group (log-odds)"); ax.set_title("Which clinical domains drive each prediction")
    plt.tight_layout(); plt.savefig(FIG / "fig6_group_importance.png"); plt.close()
    report["group_importance"] = gi.round(4).to_dict()

    # ------------------------------------------------------------------ 5. web export
    raw_df = build_features(df, apply_log=False)
    cad_mask = ycad == 1
    feats = []
    for i, f in enumerate(FEATURES):
        col = raw_df[f.key]
        d = dict(key=f.key, label=f.label, group=f.group, kind=f.kind, unit=f.unit, log=f.log, step=f.step,
                 mu=float(pack["CAD"]["mu"][i]), sd=float(pack["CAD"]["sd"][i]),
                 train_min=float(col.min()), train_max=float(col.max()), median=float(col.median()),
                 pop=dict(all=float(col.mean()), cad=float(col[cad_mask].mean()), normal=float(col[~cad_mask].mean())))
        if f.kind == "num":
            lo, hi = BOUNDS[f.key]
            d.update(ui_min=lo, ui_max=hi, default=float(round(col.median() / f.step) * f.step),
                     q={k: [float(np.quantile(col[m], p)) for p in (.05, .25, .5, .75, .95)]
                        for k, m in (("all", np.ones(len(col), bool)), ("cad", cad_mask), ("normal", ~cad_mask))})
        elif f.kind == "ord":
            d.update(ui_min=0, ui_max=ORD_MAX[f.key], default=0)
        else:
            d.update(ui_min=0, ui_max=1, default=0)
        feats.append(d)

    nv = Y[["LAD", "LCX", "RCA"]].sum(axis=1).to_numpy()
    def archetype(mask, name, desc):
        sub = raw_df[mask]
        prof = {}
        for f in FEATURES:
            v = sub[f.key]
            prof[f.key] = float(round(v.median() / f.step) * f.step) if f.kind == "num" else float(int(round(v.median())) if f.kind == "ord" else int(v.mean() >= .5))
        return dict(name=name, description=desc, n=int(mask.sum()), profile=prof)
    presets = [archetype(nv == 0, "Normal coronaries", "Median profile of the 86 patients with no stenotic vessel"),
               archetype(nv == 1, "Single-vessel disease", "Median profile of patients with exactly one stenotic vessel"),
               archetype(nv == 2, "Two-vessel disease", "Median profile of patients with two stenotic vessels"),
               archetype(nv == 3, "Three-vessel disease", "Median profile of patients with all three vessels stenotic")]
    # sanity: archetype ordering of predicted CAD risk should be monotone (otherwise presets would look broken in the UI)
    prs = []
    for pz in presets:
        xx = pd.DataFrame([{f.key: (np.log1p(pz["profile"][f.key]) if f.log else pz["profile"][f.key]) for f in FEATURES}])
        prs.append(float(pack["CAD"]["a"] * pack["CAD"]["pipeline"].decision_function(xx)[0] + pack["CAD"]["b"]))
    report["preset_cad_logits"] = dict(zip([p["name"] for p in presets], prs))

    web = dict(
        meta=dict(name="CardioLens", version="1.0", created=time.strftime("%Y-%m-%d"),
                  dataset="Extension of Z-Alizadeh Sani dataset (UCI #411), n=303, CC BY 4.0",
                  protocol="5x5 nested repeated stratified CV; log-loss tuning; logistic regression (L2/L1); closed-form exact SHAP",
                  disclaimer="Decision support / educational use only. Not a substitute for formal diagnostic imaging or clinical judgement.",
                  targets=T_ORDER, risk_bands=dict(low=0.33, high=0.66)),
        features=feats, targets=web_targets, presets=presets,
        coherence=dict(rule="p_vessel_displayed = min(p_vessel, p_CAD)  (a stenotic vessel implies CAD)", **report["coherence"]))
    (WEB / "web_model.json").write_text(json.dumps(web, separators=(",", ":")))
    joblib.dump({t: dict(pipeline=pack[t]["pipeline"], a=pack[t]["a"], b=pack[t]["b"], features=KEYS) for t in T_ORDER},
                MOD / "cardiolens_models.joblib")

    # parity cases for the JS engine (independent code path: sklearn pipeline + Platt)
    rng = np.random.default_rng(1)
    idx = rng.choice(len(X), 60, replace=False)
    cases = []
    for i in idx:
        exp = {t: float(sigmoid(pack[t]["a"] * pack[t]["pipeline"].decision_function(X.iloc[[i]])[0] + pack[t]["b"])) for t in T_ORDER}
        cases.append(dict(x={k: float(raw_df.iloc[i][k]) for k in KEYS}, expected=exp))
    (WEB / "parity_cases.json").write_text(json.dumps(cases))
    (RES / "metrics.json").write_text(json.dumps(report, indent=1))
    print(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
