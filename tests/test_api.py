"""Backend contract tests + leakage guard (run from the project root)."""
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient
from backend.server import app, FEATS
from cardiolens.data import KEYS, LEAKAGE_COLS

c = TestClient(app)
N = 0


def chk(cond, msg=""):
    """an assertion that is also counted (so run_all.py can report passed / total); a failure still raises."""
    global N
    N += 1
    if not cond:
        raise AssertionError(msg or "API check %d failed" % N)


chk(c.get("/api/health").json()["status"] == "ok")
sch = c.get("/api/schema").json()
chk([f["key"] for f in sch["features"]] == KEYS)
leak = {x.lower() for x in LEAKAGE_COLS}
chk(not leak & {k.lower() for k in KEYS} and not leak & {f["label"].lower() for f in sch["features"]}, "target leaked into inputs")
r = c.post("/api/predict", json={"features": {"age": 70, "typ_cp": 1, "dm": 1, "ef": 35}}).json()
chk(set(r["predictions"]) == {"CAD", "LAD", "LCX", "RCA"} and "disclaimer" in r and len(r["imputed"]) == len(KEYS) - 4)
for t, v in r["predictions"].items():
    chk(0 <= v["probability"] <= 1)
    chk(abs(sum(v["shap_log_odds"].values())) < 20)
    if t != "CAD": chk(v["probability"] <= r["predictions"]["CAD"]["probability"] + 1e-9)
chk(c.post("/api/predict", json={"features": {"LAD": 1}}).status_code == 422, "target columns must be rejected as inputs")
chk(c.post("/api/predict", json={"features": {"age": 200}}).json()["out_of_training_range"] == ["age"])
low = c.post("/api/predict", json={"features": {"age": 35, "ef": 60}}).json()["predictions"]["CAD"]["probability"]
hi = c.post("/api/predict", json={"features": {"age": 70, "ef": 30, "typ_cp": 1, "tinv": 1, "rwma": 3, "dm": 1}}).json()["predictions"]["CAD"]["probability"]
chk(hi > low + 0.3, (low, hi))
print("API OK  (%d checks; low-risk CAD p=%.2f, high-risk p=%.2f)" % (N, low, hi))
