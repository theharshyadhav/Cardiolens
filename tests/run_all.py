#!/usr/bin/env python3
"""Run every CardioLens test suite, print one line per suite and write results/test_summary.json.

    python3 tests/run_all.py                 all suites (about 3 min; the browser suite is the slow one)
    python3 tests/run_all.py parity scan     only the named suites
    python3 tests/run_all.py --skip-browser  everything except Chromium

Exit code 0 only when every suite ran and passed. A suite that cannot run (missing dependency) counts as a failure,
except the optional real-DICOM part of test_dicom.js, which runs only when CARDIOLENS_DICOM_DIR and CARDIOLENS_DICOM_REF
are set (the summary says whether it ran) and the optional API section inside the browser suite (reported as "skipped").
Node suites stop at their first failing check, so for them a failure is reported as FAIL with the tail of the output.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY, NODE = sys.executable, "node"

# name, command, regex for the "N checks" count, timeout (s)
SUITES = [
    ("parity",  [NODE, "tests/test_parity.js"],  r"cases=(\d+)",        300),
    ("api",     [PY, "tests/test_api.py"],       r"\((\d+) checks",     300),
    ("scan",    [NODE, "tests/test_scan.js"],    r"\((\d+) checks\)",   600),
    ("room",    [NODE, "tests/test_room.js"],    r"\((\d+) checks\)",   900),
    ("dicom",   [NODE, "tests/test_dicom.js"],   r"\((\d+) checks",     600),
    ("cine",    [NODE, "tests/test_cine.js"],    r"\((\d+) checks\)",   900),
    ("browser", [PY, "tests/test_browser.py"],   None,                 1800),
]


def run(name, cmd, rx, timeout):
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        out, code = (p.stdout or "") + (p.stderr or ""), p.returncode
    except subprocess.TimeoutExpired as e:
        out, code = ((e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")) + f"\nTIMEOUT after {timeout}s", 124
    except FileNotFoundError as e:
        out, code = f"cannot start: {e}", 127
    secs = round(time.time() - t0, 1)
    passed = total = None
    skipped = len(re.findall(r"^\s*SKIP", out, flags=re.M))
    if name == "browser":
        m = re.search(r"(\d+)/(\d+) browser checks passed", out)
        if m:
            passed, total = int(m.group(1)), int(m.group(2))
    elif code == 0:
        m = re.search(rx, out)
        if m:
            passed = total = int(m.group(1))
    ok = code == 0 and passed is not None and passed == total
    rec = {"suite": name, "ok": ok, "passed": passed, "total": total, "seconds": secs, "exit_code": code, "skipped_sections": skipped}
    if name == "dicom":
        rec["real_dicom_files"] = bool(os.environ.get("CARDIOLENS_DICOM_DIR") and os.environ.get("CARDIOLENS_DICOM_REF"))
    if not ok:
        rec["output_tail"] = out.strip().splitlines()[-15:]
    return rec


def update_readme(summary):
    """keep the README "Latest run" line identical to results/test_summary.json (only after a full green run)."""
    rd = ROOT / "README.md"
    line = ("Latest run (" + summary["generated"][:10] + "): " + " · ".join(f"{r['suite']} {r['passed']}/{r['total']}" for r in summary["suites"])
            + f" · **{summary['total_passed']}/{summary['total_checks']} checks** (`results/test_summary.json`).")
    txt = rd.read_text()
    new, n = re.subn(r"^Latest run.*$", line.replace("\\", "\\\\"), txt, count=1, flags=re.M)
    if n:
        rd.write_text(new)


def main():
    args = sys.argv[1:]
    skip_browser = "--skip-browser" in args
    only = {a for a in args if not a.startswith("--")}
    results = []
    for name, cmd, rx, to in SUITES:
        if (only and name not in only) or (skip_browser and name == "browser"):
            continue
        r = run(name, cmd, rx, to)
        results.append(r)
        if r["ok"]:
            extra = f"  ({r['skipped_sections']} section skipped)" if r["skipped_sections"] else ""
            if r.get("real_dicom_files") is False:
                extra += "  (synthetic DICOM only: real-file part not run)"
            print(f"PASS  {name:<8} {r['passed']}/{r['total']}  {r['seconds']:.1f}s{extra}", flush=True)
        else:
            c = f"{r['passed']}/{r['total']}" if r["passed"] is not None else "stopped at first failing check"
            print(f"FAIL  {name:<8} {c}  {r['seconds']:.1f}s  exit={r['exit_code']}", flush=True)
            for line in r["output_tail"][-6:]:
                print("      " + line[:200])
    all_ok = bool(results) and all(r["ok"] for r in results)
    summary = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "all_passed": all_ok,
        "partial_run": bool(only) or skip_browser,
        "total_passed": sum(r["passed"] or 0 for r in results),
        "total_checks": sum(r["total"] or 0 for r in results),
        "suites": results,
    }
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results" / "test_summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    if all_ok and not summary["partial_run"]:
        update_readme(summary)
    print(f"{'ALL GREEN' if all_ok else 'FAILURES'}: {summary['total_passed']}/{summary['total_checks']} checks in {sum(r['seconds'] for r in results):.0f}s -> results/test_summary.json")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
