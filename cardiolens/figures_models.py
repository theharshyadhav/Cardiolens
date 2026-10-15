"""Figure 1: nested-CV model comparison.

Every panel uses the SAME row order (models sorted by their mean AUC over the four targets, prior at the bottom), so the shared
y-axis labels are correct for every target. (An earlier version sorted each panel on its own while labelling only the first,
which mislabelled rows in LAD / LCX / RCA.) The exported model of each target is drawn as a filled star.

    python -m cardiolens.figures_models        # re-draw results/figures/fig1_model_comparison.png from results/cv_summary.csv + metrics.json
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
T_ORDER = ["CAD", "LAD", "LCX", "RCA"]
from cardiolens.palette import COLORS  # noqa: E402  (validated, colour-vision-safe palette)


def plot_model_comparison(summ: pd.DataFrame, chosen: dict[str, str], path: Path) -> None:
    prior = [m for m in summ.model.unique() if m.lower().startswith("prior")]
    real = [m for m in summ.model.unique() if m not in prior]
    mean_auc = summ[summ.model.isin(real)].groupby("model").roc_auc_mean.mean().sort_values(ascending=False)
    order = list(mean_auc.index) + prior  # top row = best on average
    ypos = {m: len(order) - 1 - i for i, m in enumerate(order)}
    fig, axs = plt.subplots(1, 4, figsize=(13, 3.7), sharex=True, sharey=True)
    for ax, t in zip(axs, T_ORDER):
        s = summ[summ.target == t]
        for _, r in s.iterrows():
            y, star = ypos[r.model], r.model == chosen[t]
            ax.errorbar(r.roc_auc_mean, y, xerr=r.roc_auc_sd, fmt="*" if star else "o", ms=13 if star else 6, color=COLORS[t],
                        mec="black" if star else COLORS[t], mew=0.8, capsize=3, zorder=3 if star else 2)
        ax.set_title(t)
        ax.set_xlabel("ROC-AUC (nested CV, mean ± sd over 25 outer folds)", fontsize=8)
        ax.set_xlim(.45, 1)
    axs[0].set_yticks(range(len(order)))
    axs[0].set_yticklabels(order[::-1])
    for ax in axs[1:]:
        ax.tick_params(labelleft=False)
    fig.suptitle("Model comparison — 5×5 nested repeated stratified CV   (★ = exported model for that target; same row order in every panel)",
                 y=1.03, fontweight="bold", fontsize=10.5)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    plt.rcParams.update({"figure.dpi": 140, "savefig.dpi": 160, "axes.spines.top": False, "axes.spines.right": False,
                         "font.size": 9.5, "axes.titleweight": "bold", "axes.grid": True, "grid.alpha": .25})
    summ = pd.read_csv(ROOT / "results" / "cv_summary.csv")
    metrics = json.loads((ROOT / "results" / "metrics.json").read_text())
    chosen = {t: metrics[t]["model"] for t in T_ORDER}
    out = ROOT / "results" / "figures" / "fig1_model_comparison.png"
    plot_model_comparison(summ, chosen, out)
    print("wrote", out)
