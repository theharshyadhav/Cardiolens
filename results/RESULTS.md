# CardioLens - evaluation results

Dataset: Extension of Z-Alizadeh Sani (UCI #411), n = 303, no missing values. Protocol: 5 x 5 repeated stratified cross-validation (outer), 3-fold inner CV minimising log-loss for hyper-parameters, identical outer splits for all models. All pre-processing sits inside the folds. LAD/LCX/RCA/Cath are never model inputs.

## 1. Exported models - pooled out-of-fold performance (threshold 0.5; mean ± sd over 5 CV repeats)

| Target | Model | Accuracy | Precision | Recall | Specificity | F1 | ROC-AUC (95% CI) | PR-AUC | Brier | Log-loss |
|---|---|---|---|---|---|---|---|---|---|---|
| CAD | LogReg-L2 | 0.873 ± 0.013 | 0.905 ± 0.011 | 0.918 ± 0.008 | 0.761 ± 0.030 | 0.911 ± 0.009 | 0.932 (0.909-0.964) | 0.971 | 0.092 | 0.298 |
| LAD | LogReg-L2 | 0.778 ± 0.011 | 0.793 ± 0.009 | 0.838 ± 0.013 | 0.692 ± 0.014 | 0.815 ± 0.009 | 0.831 (0.790-0.878) | 0.862 | 0.163 | 0.498 |
| LCX | LogReg-L2 | 0.663 ± 0.015 | 0.610 ± 0.029 | 0.392 ± 0.031 | 0.838 ± 0.017 | 0.477 ± 0.029 | 0.697 (0.623-0.743) | 0.558 | 0.215 | 0.619 |
| RCA | LogReg-L1 | 0.691 ± 0.019 | 0.607 ± 0.026 | 0.507 ± 0.049 | 0.802 ± 0.017 | 0.552 ± 0.037 | 0.733 (0.679-0.793) | 0.595 | 0.201 | 0.587 |

Prevalence: CAD 71.3%, LAD 58.4%, LCX 39.3%, RCA 37.6%. Accuracy for a majority-class predictor equals the prevalence of the larger class (CAD 71.3%, LAD 58.4%, LCX 60.7%, RCA 62.4%).

## 2. Model comparison - nested CV, fold-level mean ± sd (25 outer folds)

| Target | Model | ROC-AUC | Brier | Log-loss | Accuracy | F1 |
|---|---|---|---|---|---|---|
| CAD | LogReg-L2 ★ | 0.936 ± 0.029 | 0.092 ± 0.023 | 0.298 ± 0.065 | 0.873 ± 0.047 | 0.911 ± 0.032 |
| CAD | LogReg-L1 | 0.934 ± 0.031 | 0.091 ± 0.023 | 0.298 ± 0.066 | 0.877 ± 0.040 | 0.913 ± 0.028 |
| CAD | SVM-RBF | 0.936 ± 0.033 | 0.092 ± 0.026 | 0.301 ± 0.078 | 0.871 ± 0.042 | 0.909 ± 0.030 |
| CAD | ExtraTrees | 0.922 ± 0.036 | 0.101 ± 0.022 | 0.331 ± 0.055 | 0.877 ± 0.046 | 0.914 ± 0.032 |
| CAD | RandomForest | 0.918 ± 0.042 | 0.106 ± 0.019 | 0.349 ± 0.046 | 0.871 ± 0.047 | 0.912 ± 0.031 |
| CAD | HistGB | 0.903 ± 0.046 | 0.107 ± 0.026 | 0.355 ± 0.076 | 0.861 ± 0.043 | 0.905 ± 0.030 |
| CAD | Prior (baseline) | 0.500 ± 0.000 | 0.205 ± 0.003 | 0.600 ± 0.006 | 0.713 ± 0.007 | 0.832 ± 0.005 |
| LAD | ExtraTrees | 0.844 ± 0.059 | 0.157 ± 0.023 | 0.485 ± 0.053 | 0.802 ± 0.059 | 0.839 ± 0.047 |
| LAD | RandomForest | 0.851 ± 0.048 | 0.160 ± 0.017 | 0.494 ± 0.039 | 0.784 ± 0.038 | 0.824 ± 0.031 |
| LAD | SVM-RBF | 0.840 ± 0.055 | 0.161 ± 0.027 | 0.494 ± 0.071 | 0.782 ± 0.055 | 0.822 ± 0.045 |
| LAD | LogReg-L2 ★ | 0.839 ± 0.055 | 0.163 ± 0.025 | 0.498 ± 0.068 | 0.778 ± 0.054 | 0.815 ± 0.046 |
| LAD | LogReg-L1 | 0.834 ± 0.059 | 0.167 ± 0.030 | 0.508 ± 0.079 | 0.751 ± 0.054 | 0.786 ± 0.047 |
| LAD | HistGB | 0.824 ± 0.049 | 0.169 ± 0.020 | 0.513 ± 0.048 | 0.758 ± 0.038 | 0.798 ± 0.034 |
| LAD | Prior (baseline) | 0.500 ± 0.000 | 0.243 ± 0.001 | 0.679 ± 0.002 | 0.584 ± 0.006 | 0.737 ± 0.005 |
| LCX | RandomForest | 0.720 ± 0.071 | 0.207 ± 0.017 | 0.600 ± 0.039 | 0.669 ± 0.053 | 0.486 ± 0.089 |
| LCX | HistGB | 0.717 ± 0.069 | 0.208 ± 0.021 | 0.601 ± 0.048 | 0.665 ± 0.069 | 0.510 ± 0.115 |
| LCX | ExtraTrees | 0.703 ± 0.078 | 0.211 ± 0.020 | 0.608 ± 0.049 | 0.653 ± 0.071 | 0.499 ± 0.106 |
| LCX | LogReg-L2 ★ | 0.706 ± 0.076 | 0.215 ± 0.021 | 0.619 ± 0.048 | 0.663 ± 0.061 | 0.473 ± 0.105 |
| LCX | SVM-RBF | 0.681 ± 0.068 | 0.218 ± 0.018 | 0.625 ± 0.042 | 0.653 ± 0.052 | 0.480 ± 0.099 |
| LCX | LogReg-L1 | 0.713 ± 0.083 | 0.217 ± 0.027 | 0.628 ± 0.066 | 0.654 ± 0.074 | 0.522 ± 0.128 |
| LCX | Prior (baseline) | 0.500 ± 0.000 | 0.239 ± 0.001 | 0.670 ± 0.002 | 0.607 ± 0.005 | 0.000 ± 0.000 |
| RCA | LogReg-L1 ★ | 0.736 ± 0.049 | 0.201 ± 0.014 | 0.587 ± 0.035 | 0.691 ± 0.046 | 0.549 ± 0.081 |
| RCA | ExtraTrees | 0.724 ± 0.052 | 0.203 ± 0.016 | 0.589 ± 0.037 | 0.682 ± 0.058 | 0.492 ± 0.085 |
| RCA | HistGB | 0.727 ± 0.063 | 0.202 ± 0.022 | 0.589 ± 0.053 | 0.684 ± 0.053 | 0.488 ± 0.105 |
| RCA | LogReg-L2 | 0.724 ± 0.055 | 0.204 ± 0.016 | 0.592 ± 0.035 | 0.665 ± 0.050 | 0.463 ± 0.090 |
| RCA | RandomForest | 0.708 ± 0.059 | 0.206 ± 0.012 | 0.599 ± 0.027 | 0.681 ± 0.044 | 0.445 ± 0.103 |
| RCA | SVM-RBF | 0.699 ± 0.056 | 0.211 ± 0.015 | 0.608 ± 0.033 | 0.642 ± 0.052 | 0.421 ± 0.097 |
| RCA | Prior (baseline) | 0.500 ± 0.000 | 0.235 ± 0.001 | 0.662 ± 0.003 | 0.624 ± 0.005 | 0.000 ± 0.000 |

★ = exported model (best nested-CV log-loss among the browser-portable linear models; exact SHAP). Sorted by log-loss within each target.

## 3. Calibration

| Target | OOF calibration slope | Platt applied | Brier raw -> cross-fitted | Log-loss raw -> cross-fitted |
|---|---|---|---|---|
| CAD | 1.14 | no | 0.0919 -> 0.0939 | 0.2978 -> 0.3063 |
| LAD | 1.13 | no | 0.1626 -> 0.1638 | 0.4984 -> 0.5043 |
| LCX | 0.98 | no | 0.2149 -> 0.2167 | 0.6188 -> 0.6232 |
| RCA | 0.98 | no | 0.2007 -> 0.2006 | 0.5871 -> 0.5867 |

## 3b. Selection check - exported model vs best non-portable model (paired fold-wise differences, 25 folds)

| Target | Exported | Best other (by log-loss) | dAUC (other - exported) | dLog-loss (other - exported) | folds where other better (log-loss) |
|---|---|---|---|---|---|
| CAD | LogReg-L2 | LogReg-L1 | -0.003 (sd 0.014) | +0.000 (sd 0.029) | 11/25 |
| LAD | LogReg-L2 | ExtraTrees | +0.004 (sd 0.036) | -0.013 (sd 0.050) | 13/25 |
| LCX | LogReg-L2 | RandomForest | +0.014 (sd 0.050) | -0.019 (sd 0.031) | 18/25 |
| RCA | LogReg-L1 | ExtraTrees | -0.012 (sd 0.036) | +0.002 (sd 0.030) | 12/25 |

Differences are small relative to fold-to-fold variability (folds from repeated CV are correlated, so no p-values are claimed); the linear models are therefore kept for portability, exact SHAP and transparency.


## 4. Coherence of overall-CAD and vessel predictions

- In the data, Cath = CAD coincides with 'at least one stenotic vessel' for 99.7% of patients.
- Independent models violate P(vessel) <= P(CAD) for 19% of patients; the app therefore caps each vessel probability at P(CAD) and flags when the cap is active.

| Vessel | share capped | AUC uncapped -> capped | Brier uncapped -> capped |
|---|---|---|---|
| LAD | 17% | 0.834 -> 0.836 | 0.1598 -> 0.1581 |
| LCX | 15% | 0.705 -> 0.708 | 0.2123 -> 0.2107 |
| RCA | 13% | 0.744 -> 0.748 | 0.1962 -> 0.1947 |
