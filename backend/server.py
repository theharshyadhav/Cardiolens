"""CardioLens API.  Run:  uvicorn backend.server:app --reload   ->  http://127.0.0.1:8000  (docs at /docs)

Single source of truth = web/web_model.json (exported by cardiolens/final.py). The math below is the same as
web/engine.js; at start-up it is cross-checked against the original sklearn pipelines (models/*.joblib).
Patient data is processed in memory only - nothing is stored or logged.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
MODEL = json.loads((ROOT / "web" / "web_model.json").read_text())
FEATS = {f["key"]: f for f in MODEL["features"]}
TARGETS = MODEL["meta"]["targets"]
DISCLAIMER = MODEL["meta"]["disclaimer"]


def _sig(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def _tf(f: dict, v: float) -> float:
    return math.log1p(v) if f["log"] else v


def predict(x: dict[str, float]) -> dict:
    out = {}
    for t in TARGETS:
        T = MODEL["targets"][t]
        z, phi = T["base"], {}
        for k, f in FEATS.items():
            phi[k] = T["w"][k] * (_tf(f, x[k]) - f["mu"]) / f["sd"]
            z += phi[k]
        out[t] = dict(z=z, p=_sig(z), base=T["base"], phi=phi)
    cad = out["CAD"]["p"]
    for t in TARGETS:  # a stenotic vessel implies CAD -> cap vessel probability by P(CAD)
        out[t]["p_model"] = out[t]["p"]
        out[t]["capped"] = t != "CAD" and out[t]["p"] > cad
        out[t]["p"] = min(out[t]["p"], cad) if t != "CAD" else cad
    return out


def _self_check() -> None:
    try:
        import joblib
        import pandas as pd
    except ImportError:
        return
    p = ROOT / "models" / "cardiolens_models.joblib"
    if not p.exists():
        return
    pack = joblib.load(p)
    x = {k: f["median"] for k, f in FEATS.items()}
    ours = predict(x)
    row = pd.DataFrame([{k: (math.log1p(x[k]) if FEATS[k]["log"] else x[k]) for k in FEATS}])
    for t in TARGETS:
        z = pack[t]["a"] * pack[t]["pipeline"].decision_function(row)[0] + pack[t]["b"]
        assert abs(_sig(z) - ours[t]["p_model"]) < 1e-9, f"backend/sklearn mismatch for {t}"


_self_check()

app = FastAPI(title="CardioLens API", version=MODEL["meta"]["version"],
              description="Research prototype - " + DISCLAIMER)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class PredictIn(BaseModel):
    features: dict[str, float] = Field(..., description="feature key -> raw value; missing keys are imputed (median / 0) and reported")


@app.get("/api/health")
def health():
    return {"status": "ok", "model_version": MODEL["meta"]["version"], "disclaimer": DISCLAIMER}


@app.get("/api/schema")
def schema():
    return {"meta": MODEL["meta"], "features": MODEL["features"], "presets": MODEL["presets"],
            "metrics": {t: {"model": MODEL["targets"][t]["model"], **MODEL["targets"][t]["metrics"],
                            "auc_ci95": MODEL["targets"][t]["auc_ci95"]} for t in TARGETS}}


@app.post("/api/predict")
def predict_endpoint(body: PredictIn):
    unknown = set(body.features) - set(FEATS)
    if unknown:
        raise HTTPException(422, f"unknown features: {sorted(unknown)}")
    x, imputed = {}, []
    for k, f in FEATS.items():
        if k in body.features:
            x[k] = float(body.features[k])
        else:
            x[k] = f["median"] if f["kind"] == "num" else 0.0
            imputed.append(k)
    res = predict(x)
    band = MODEL["meta"]["risk_bands"]
    label = lambda p: "High" if p >= band["high"] else "Intermediate" if p >= band["low"] else "Low"
    return {
        "disclaimer": DISCLAIMER, "imputed": imputed,
        "out_of_training_range": [k for k, f in FEATS.items() if f["kind"] == "num" and not f["train_min"] <= x[k] <= f["train_max"]],
        "predictions": {t: {"probability": round(res[t]["p"], 4), "probability_uncapped": round(res[t]["p_model"], 4),
                            "capped_by_cad": res[t]["capped"], "band": label(res[t]["p"]), "baseline": round(_sig(res[t]["base"]), 4),
                            "shap_log_odds": {k: round(v, 4) for k, v in sorted(res[t]["phi"].items(), key=lambda kv: -abs(kv[1]))}}
                        for t in TARGETS},
    }


if (ROOT / "web" / "index.html").exists():
    app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
