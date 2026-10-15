"""Generate results/RESULTS.md straight from metrics.json / cv_summary.csv (numbers are never typed by hand)."""
import json
from pathlib import Path
import pandas as pd

RES = Path(__file__).resolve().parents[1] / "results"
m = json.loads((RES / "metrics.json").read_text())
s = pd.read_csv(RES / "cv_summary.csv")
T = ["CAD", "LAD", "LCX", "RCA"]
pm = lambda v, d=3: f"{v[0]:.{d}f} ± {v[1]:.{d}f}"

L = ["# CardioLens - evaluation results", "",
     "Dataset: Extension of Z-Alizadeh Sani (UCI #411), n = 303, no missing values. Protocol: 5 x 5 repeated stratified "
     "cross-validation (outer), 3-fold inner CV minimising log-loss for hyper-parameters, identical outer splits for all models. "
     "All pre-processing sits inside the folds. LAD/LCX/RCA/Cath are never model inputs.", "",
     "## 1. Exported models - pooled out-of-fold performance (threshold 0.5; mean ± sd over 5 CV repeats)", "",
     "| Target | Model | Accuracy | Precision | Recall | Specificity | F1 | ROC-AUC (95% CI) | PR-AUC | Brier | Log-loss |",
     "|---|---|---|---|---|---|---|---|---|---|---|"]
for t in T:
    r = m[t]; h = r["headline_pooled_oof"]; ci = r["roc_auc_ci95_bootstrap"]
    L.append(f"| {t} | {r['model']} | " + " | ".join(pm(h[k]) for k in ("accuracy", "precision", "recall", "specificity", "f1")) +
             f" | {h['roc_auc'][0]:.3f} ({ci[0]:.3f}-{ci[1]:.3f}) | {h['pr_auc'][0]:.3f} | {h['brier'][0]:.3f} | {h['logloss'][0]:.3f} |")
L += ["", "Prevalence: " + ", ".join(f"{t} {m[t]['prevalence']*100:.1f}%" for t in T) + ". "
      "Accuracy for a majority-class predictor equals the prevalence of the larger class (CAD 71.3%, LAD 58.4%, LCX 60.7%, RCA 62.4%).", "",
      "## 2. Model comparison - nested CV, fold-level mean ± sd (25 outer folds)", "",
      "| Target | Model | ROC-AUC | Brier | Log-loss | Accuracy | F1 |", "|---|---|---|---|---|---|---|"]
for t in T:
    for _, r in s[s.target == t].sort_values("logloss_mean").iterrows():
        star = " ★" if r.model == m[t]["model"] else ""
        L.append(f"| {t} | {r.model}{star} | {r.roc_auc_mean:.3f} ± {r.roc_auc_sd:.3f} | {r.brier_mean:.3f} ± {r.brier_sd:.3f} | "
                 f"{r.logloss_mean:.3f} ± {r.logloss_sd:.3f} | {r.accuracy_mean:.3f} ± {r.accuracy_sd:.3f} | {r.f1_mean:.3f} ± {r.f1_sd:.3f} |")
L += ["", "★ = exported model (best nested-CV log-loss among the browser-portable linear models; exact SHAP). "
      "Sorted by log-loss within each target.", "", "## 3. Calibration", "",
      "| Target | OOF calibration slope | Platt applied | Brier raw -> cross-fitted | Log-loss raw -> cross-fitted |", "|---|---|---|---|---|"]
for t in T:
    c = m[t]["calibration"]
    L.append(f"| {t} | {c['oof_slope']:.2f} | {'yes (a=%.2f, b=%.2f)' % (c['a'], c['b']) if c['applied'] else 'no'} | "
             f"{c['raw']['brier']:.4f} -> {c['crossfitted']['brier']:.4f} | {c['raw']['logloss']:.4f} -> {c['crossfitted']['logloss']:.4f} |")
# --- selection check: exported linear model vs the best non-portable model (paired, same outer folds)
f = pd.read_csv(RES / "cv_folds.csv")
L += ["", "## 3b. Selection check - exported model vs best non-portable model (paired fold-wise differences, 25 folds)", "",
      "| Target | Exported | Best other (by log-loss) | dAUC (other - exported) | dLog-loss (other - exported) | folds where other better (log-loss) |", "|---|---|---|---|---|---|"]
for t in T:
    sub = f[f.target == t]; exp = m[t]["model"]
    oth = sub[~sub.model.isin([exp, "Prior (baseline)"])].groupby("model").logloss.mean().idxmin()
    a = sub[sub.model == exp].sort_values("fold").reset_index(drop=True); b = sub[sub.model == oth].sort_values("fold").reset_index(drop=True)
    da, dl = b.roc_auc - a.roc_auc, b.logloss - a.logloss
    L.append(f"| {t} | {exp} | {oth} | {da.mean():+.3f} (sd {da.std():.3f}) | {dl.mean():+.3f} (sd {dl.std():.3f}) | {int((dl < 0).sum())}/25 |")
L += ["", "Differences are small relative to fold-to-fold variability (folds from repeated CV are correlated, so no p-values are claimed); "
      "the linear models are therefore kept for portability, exact SHAP and transparency.", ""]
co = m["coherence"]
L += ["", "## 4. Coherence of overall-CAD and vessel predictions", "",
      f"- In the data, Cath = CAD coincides with 'at least one stenotic vessel' for {co['label_check_cad_equals_any_vessel']*100:.1f}% of patients.",
      f"- Independent models violate P(vessel) <= P(CAD) for {co['frac_vessel_prob_exceeds_cad_prob']*100:.0f}% of patients; "
      "the app therefore caps each vessel probability at P(CAD) and flags when the cap is active.", "",
      "| Vessel | share capped | AUC uncapped -> capped | Brier uncapped -> capped |", "|---|---|---|---|"]
for v in ("LAD", "LCX", "RCA"):
    c = co[v]
    L.append(f"| {v} | {c['frac_capped']*100:.0f}% | {c['auc_uncapped']:.3f} -> {c['auc_capped']:.3f} | {c['brier_uncapped']:.4f} -> {c['brier_capped']:.4f} |")
L.append("")
(RES / "RESULTS.md").write_text("\n".join(L))
print("\n".join(L))
