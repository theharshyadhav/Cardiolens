#!/usr/bin/env python3
"""Build the hackathon submission folder.

    python3 tools/package_submission.py                  build, run all test suites, check, package
    python3 tools/package_submission.py --skip-tests     do not run the suites (the checklist then says so and the run is NOT clean)
    python3 tools/package_submission.py --no-build       do not rebuild web/*.html first
    python3 tools/package_submission.py --exclude-real-ct   leave demo/real_ct_slab_16x2.5mm.nii.gz out of the project zip
                                                         (its licence is unconfirmed, see SUBMISSION.md)

Steps (stops at the first hard failure, exit code 1):
  1. python3 -I build.py                       -> web/index.html, web/artifact.html, web/index.offline.html
  2. python3 tests/run_all.py                  -> all seven suites must pass (results/test_summary.json)
  3. python3 -I docs/make_pdf.py               -> documentation PDF (rebuilt after the tests so it quotes the fresh counts), <= 6 pages
  4. checks: script timings, words per second, chapters, abstract length, disclaimer in every deliverable, numbers vs results/
  5. submission/ gets exactly:
       CardioLens_documentation.pdf  demo_video_script.md  SUBMISSION.md  cardiolens_project.zip
       cardiolens.html  cardiolens_offline.html  checklist.md
Items that only the team can do (video, URLs, names) are written to checklist.md as unticked boxes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "submission"
PY = sys.executable

CRITERIA = ["Predictive", "3D visualisation", "Clinical interpretability", "System integration", "Technical implementation"]
DISCLAIMER_CORE = "Not a substitute for formal diagnostic imaging"      # banner text in the page
ZIP_EXCLUDE_DIRS = {"node_modules", "__pycache__", ".pytest_cache", ".git", "submission", "scratch", "tmp", ".idea", ".vscode"}
ZIP_EXCLUDE_SUFFIX = (".pyc", ".pyo", ".tmp", ".bak", ".swp", ".orig", "~")
ZIP_EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "cardiolens-handoff.zip", "cardiolens_project.zip"}
REAL_CT = "demo/real_ct_slab_16x2.5mm.nii.gz"

results: list[tuple[bool, str]] = []        # (ok, text) for automatic checks
manual: list[str] = []


def ok(cond: bool, text: str) -> bool:
    results.append((bool(cond), text))
    print(("  ok   " if cond else "  FAIL ") + text)
    return bool(cond)


def run(cmd: list[str], label: str, timeout: int) -> tuple[bool, str]:
    print(f"== {label}: {' '.join(cmd)}")
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        out = (p.stdout or "") + (p.stderr or "")
        good = p.returncode == 0
    except subprocess.TimeoutExpired:
        out, good = f"timeout after {timeout}s", False
    print("\n".join(out.strip().splitlines()[-6:]))
    return good, out


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def mmss(m: str, s: str) -> int:
    return int(m) * 60 + int(s)


# ------------------------------------------------------------------ script checks
def check_script(text: str) -> None:
    print("== demo_video_script.md")
    heads = list(re.finditer(r"^### (S\d+) · (\d+):(\d\d)–(\d+):(\d\d) · (.+)$", text, flags=re.M))
    ok(len(heads) >= 8, f"{len(heads)} timecoded segments")
    segs = []
    for i, m in enumerate(heads):
        end_pos = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[m.end():end_pos]
        segs.append(dict(id=m.group(1), a=mmss(m.group(2), m.group(3)), b=mmss(m.group(4), m.group(5)), title=m.group(6).strip(), body=body))
    contiguous = segs[0]["a"] == 0 and all(s["b"] > s["a"] for s in segs) and all(segs[i]["b"] == segs[i + 1]["a"] for i in range(len(segs) - 1))
    total = segs[-1]["b"] - segs[0]["a"]
    ok(contiguous, "segments start at 0:00, are contiguous and in order")
    ok(180 <= total <= 600, f"total length {total // 60}:{total % 60:02d} ({total} s, allowed 3:00-10:00)")
    ok(sum(s["b"] - s["a"] for s in segs) == total, "segment lengths add up to the total")
    for s in segs:
        crit = re.search(r"\*\*Criterion:\*\*(.+)", s["body"])
        vo = re.search(r"\*\*Voice-over:\*\*\s*\n((?:>.*\n?)+)", s["body"])
        clicks = re.findall(r"^\d+\. (\d+):(\d\d) ", s["body"], flags=re.M)
        words = len(re.sub(r"[>*_`]", " ", vo.group(1)).split()) if vo else 0
        dur = s["b"] - s["a"]
        wps = words / dur
        in_range = all(s["a"] <= mmss(*c) < s["b"] for c in clicks) and bool(clicks)
        good = bool(crit) and any(c in crit.group(1) for c in CRITERIA) and bool(vo) and in_range and 1.6 <= wps <= 2.7
        ok(good, f"{s['id']} {s['a'] // 60}:{s['a'] % 60:02d}-{s['b'] // 60}:{s['b'] % 60:02d}: criterion named, {len(clicks)} timed clicks inside the segment, "
                 f"{words} words = {wps:.2f} words/s (allowed 1.6-2.7)")
    # chapters in the YouTube description must equal the segment starts
    desc = re.search(r"## YouTube description.*?```\n(.*?)```", text, flags=re.S)
    chap = re.findall(r"^(\d+):(\d\d) (.+)$", desc.group(1), flags=re.M) if desc else []
    ok([mmss(a, b) for a, b, _ in chap] == [s["a"] for s in segs], "YouTube chapters equal the segment start times (first at 0:00)")
    title = re.search(r"## YouTube title.*?```\n(.*?)\n```", text, flags=re.S)
    ok(bool(title) and len(title.group(1)) <= 100, f"YouTube title {len(title.group(1)) if title else 0} characters (max 100)")
    ok(bool(desc) and "DISCLAIMER" in desc.group(1) and "not a diagnostic device" in desc.group(1).lower(), "YouTube description carries the disclaimer")
    for credit in ["BodyParts3D", "CC BY-SA 2.1", "Sunnybrook", "CC0", "UCI", "WebMCP", "three.js", "Faraday"]:
        ok(bool(desc) and credit in desc.group(1), f"YouTube description credits {credit}")
    spoken = " ".join(s["body"] for s in segs).lower()
    for must in ["generic adult atlas", "unvalidated", "outside the model's age range", "no external validation", "not a diagnostic device"]:
        ok(must in spoken, f"limit / disclaimer said in the script: '{must}'")
    ok("pre-flight checklist" in text.lower() and "fallback if webgl" in text.lower() and "## shot list" in text.lower(), "pre-flight checklist, WebGL fallback and shot list present")
    ok("1440 × 900" in text, "1440 x 900 named in the pre-flight checklist")


def check_numbers(script: str) -> None:
    """The numbers spoken in the script must equal the files in results/."""
    print("== numbers in the script vs results/")
    met = json.loads((ROOT / "results/metrics.json").read_text())
    for tgt, spoken in {"CAD": 0.93, "LAD": 0.83, "LCX": 0.70, "RCA": 0.73}.items():
        auc = met[tgt]["headline_pooled_oof"]["roc_auc"][0]
        ok(round(auc, 2) == spoken, f"{tgt} pooled out-of-fold ROC-AUC {auc:.3f} -> spoken {spoken}")
    h = met["CAD"]["headline_pooled_oof"]
    ok((round(h["accuracy"][0], 2), round(h["recall"][0], 2), round(h["f1"][0], 2)) == (0.87, 0.92, 0.91), "CAD accuracy 0.87 / recall 0.92 / F1 0.91")
    ok(round(met["CAD"]["prevalence"] * 100) == 71, "CAD prevalence 71 %")
    rs = (ROOT / "results/RESULTS.md").read_text()
    ok("0.932 (0.909-0.964)" in rs, "CAD AUC interval 0.909-0.964 -> spoken '0.91 to 0.96'")
    ok("+0.014 (sd 0.050)" in rs, "largest tree-minus-linear AUC gap +0.014 (LCX)")
    cr = json.loads((ROOT / "results/cine_reference.json").read_text())
    ok((round(cr["ef"]), round(cr["edv"]), round(cr["esv"]), round(cr["hr_bpm"])) == (41, 122, 72, 59), "MRI EF 41 / EDV 122 / ESV 72 / HR 59 equal results/cine_reference.json")
    sm = (ROOT / "results/smoke_mri.json").read_text()
    ok("EF 40.7" in sm and "EDV 102.2" in sm, "slice 6 off: EF 40.7 / EDV 102.2 in results/smoke_mri.json")
    perf = json.loads((ROOT / "results/perf.json").read_text())["runs"][0]
    ok(round(perf["orbit_renders_per_s"]) == 27 and perf["idle_renders_in_2s"] == 0 and perf["viewport"].startswith("desktop 1440x900"), "27 orbit renders/s and 0 idle renders (results/perf.json, 1440x900)")
    an = json.loads((ROOT / "results/anatomy_report.json").read_text())
    ok(len(an["groups"]) == 12 and sum(g["tris"] for g in an["groups"].values()) == 54487, "12 groups and 54,487 triangles (results/anatomy_report.json)")
    bt = json.loads((ROOT / "results/browser_tests.json").read_text())
    names = {r["check"]: r for r in bt}
    ok(names.get("13 WebMCP tools registered", {}).get("pass") is True and names.get("disclaimer banner is always visible", {}).get("pass") is True, "13 tools and always-visible disclaimer pass in results/browser_tests.json")
    ts = json.loads((ROOT / "results/test_summary.json").read_text())
    ok(str(ts["total_passed"]) in script, f"{ts['total_passed']} automatic checks named in the script equals results/test_summary.json")


def check_submission_md(md: str) -> None:
    print("== SUBMISSION.md")
    ab = re.search(r"## Abstract[^\n]*\n+(.+?)\n\n", md, flags=re.S)
    n = len(ab.group(1).split()) if ab else 0
    ok(n == 150, f"abstract has {n} words (150 wanted)")
    for sec in ["Title", "One-liner", "Track", "Tech stack", "How to run", "Evaluation criteria", "Licences and credits"]:
        ok(re.search(rf"^## {sec}", md, flags=re.M) is not None, f"section '{sec}'")
    for c in CRITERIA:
        ok(c.lower() in md.lower(), f"crosswalk names {c}")
    for ph in ["[TEAM NAME", "[ARTIFACT URL]", "[YOUTUBE URL]"]:
        ok(ph in md, f"placeholder {ph}")
    for lic in ["BodyParts3D", "CC BY-SA 2.1", "Sunnybrook", "CC0", "10.24432/C5461K", "WebMCP", "three.js", "Faraday", "MIT"]:
        ok(lic in md, f"credit/licence: {lic}")
    steps = re.search(r"## How to run.*?\n(.*?)\n## ", md, flags=re.S)
    ok(bool(steps) and len(re.findall(r"^\d\. ", steps.group(1), flags=re.M)) == 3, "how to run has exactly three numbered steps")
    ok("disclaimer" in md.lower() and "not a diagnostic device" in md.lower(), "disclaimer in SUBMISSION.md")
    manual.extend(["Fill the placeholders in SUBMISSION.md: team, artifact URL, YouTube URL, contact, project licence",
                   "Confirm the licence of demo/real_ct_slab_16x2.5mm.nii.gz or rebuild with --exclude-real-ct"])


# ------------------------------------------------------------------ main
def build_zip(dest: Path, exclude_ct: bool) -> list[str]:
    names = []
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(ROOT.rglob("*")):
            rel = p.relative_to(ROOT)
            if p.is_dir() or any(part in ZIP_EXCLUDE_DIRS for part in rel.parts):
                continue
            if p.name in ZIP_EXCLUDE_NAMES or p.name.endswith(ZIP_EXCLUDE_SUFFIX):
                continue
            if exclude_ct and rel.as_posix() == REAL_CT:
                continue
            z.write(p, "cardiolens/" + rel.as_posix())
            names.append(rel.as_posix())
    return names


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-tests", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--exclude-real-ct", action="store_true")
    a = ap.parse_args()

    if not a.no_build:
        good, _ = run([PY, "-I", "build.py"], "build pages", 600)
        ok(good, "build.py passed (slim-model parity gate, every inline script parses)")
        if not good:
            return finish(a, 1)
    if a.skip_tests:
        ok(False, "test suites were NOT run (--skip-tests): this package is not a clean run")
    else:
        good, _ = run([PY, "tests/run_all.py"], "all test suites", 1800)
        ts = json.loads((ROOT / "results/test_summary.json").read_text())
        ok(good and ts["all_passed"] and not ts["partial_run"], f"all suites green: {ts['total_passed']}/{ts['total_checks']} checks "
           + ", ".join(f"{s['suite']} {s['passed']}/{s['total']}" for s in ts["suites"]))
        if not good:
            return finish(a, 1)

    good, _ = run([PY, "-I", "docs/make_pdf.py"], "documentation PDF", 300)
    pdf = ROOT / "docs/CardioLens_documentation.pdf"
    pages = 0
    if good and pdf.exists():
        from pypdf import PdfReader
        pages = len(PdfReader(str(pdf)).pages)
    ok(good and 1 <= pages <= 6, f"documentation PDF built, {pages} pages (max 6)")

    script = (ROOT / "demo_video_script.md").read_text()
    sub = (ROOT / "SUBMISSION.md").read_text()
    check_script(script)
    check_numbers(script)
    check_submission_md(sub)

    # page checks
    print("== pages")
    for name in ("index.html", "index.offline.html", "artifact.html"):
        p = ROOT / "web" / name
        t = p.read_text(errors="ignore")
        ok(p.stat().st_size <= 16 * 1024 * 1024, f"web/{name} {p.stat().st_size / 1e6:.1f} MB (limit 16 MB)")
        ok(DISCLAIMER_CORE in t, f"web/{name} contains the disclaimer text")
        ok(all(k in t for k in ("CineLib", "DicomLib", "lvSet")), f"web/{name} contains CineLib, DicomLib and lvSet (MRI build)")
        srcs = set(re.findall(r'<script[^>]+src="(https?://[^"]+)"', t))
        allowed = name != "index.offline.html"
        ok(all("cdnjs.cloudflare.com" in s for s in srcs) and (allowed or not srcs), f"web/{name} external scripts: {sorted(srcs) or 'none'}")

    # assemble
    print("== submission/")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copy2(pdf, OUT / "CardioLens_documentation.pdf")
    shutil.copy2(ROOT / "demo_video_script.md", OUT / "demo_video_script.md")
    shutil.copy2(ROOT / "SUBMISSION.md", OUT / "SUBMISSION.md")
    shutil.copy2(ROOT / "web/index.html", OUT / "cardiolens.html")
    shutil.copy2(ROOT / "web/index.offline.html", OUT / "cardiolens_offline.html")
    names = build_zip(OUT / "cardiolens_project.zip", a.exclude_real_ct)
    ok(not any("node_modules" in n or "__pycache__" in n or n.endswith(".pyc") for n in names), f"project zip: {len(names)} files, no node_modules, caches or scratch files")
    need = ["web/index.html", "web/index.offline.html", "web/artifact.html", "build.py", "tests/run_all.py", "tools/package_submission.py", "HANDOFF.md",
            "README.md", "SUBMISSION.md", "demo_video_script.md", "docs/CardioLens_documentation.pdf", "results/RESULTS.md", "models/cardiolens_models.joblib", "requirements.txt"]
    ok(all(n in names for n in need), "project zip holds the build, tests, models, results, docs and both submission texts")
    ok(sha(OUT / "cardiolens.html") == sha(ROOT / "web/index.html") and sha(OUT / "cardiolens_offline.html") == sha(ROOT / "web/index.offline.html"),
       "cardiolens.html / cardiolens_offline.html are byte copies of web/index.html / web/index.offline.html")
    if a.exclude_real_ct:
        ok(REAL_CT not in names, "real CT slab left out of the project zip")
    else:
        manual.append("The project zip contains demo/real_ct_slab_16x2.5mm.nii.gz (licence unconfirmed): confirm it or rerun with --exclude-real-ct")
    return finish(a, 0 if all(r[0] for r in results) else 1)


def finish(a, code: int) -> int:
    fails = [t for good, t in results if not good]
    if OUT.exists():
        write_checklist(a, fails)
    print(f"\n{len(results) - len(fails)}/{len(results)} automatic checks ok" + ("" if not fails else "; FAILED: " + "; ".join(fails)))
    return code if not fails else 1


def write_checklist(a, fails) -> None:
    files = ["CardioLens_documentation.pdf", "demo_video_script.md", "SUBMISSION.md", "cardiolens_project.zip", "cardiolens.html", "cardiolens_offline.html"]
    L = ["# Submission checklist", "", f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} by `tools/package_submission.py`"
         + (" (tests skipped: not a clean run)" if a.skip_tests else "") + ".", "",
         "## The six items", ""]
    for f in files:
        p = OUT / f
        L.append(f"- [{'x' if p.exists() and p.stat().st_size else ' '}] `{f}`" + (f" ({p.stat().st_size / 1e6:.2f} MB, sha256 {sha(p)[:12]})" if p.exists() else " MISSING"))
    L += ["", "## Automatic checks (all must be ticked)", ""]
    L += [f"- [{'x' if good else ' '}] {t}" for good, t in results]
    L += ["", "## Yours to do (cannot be automated)", ""]
    L += ["- [ ] Record the video from `demo_video_script.md` (3:00-10:00, target 6:30), upload it to YouTube, paste the title and description",
          "- [ ] Paste the YouTube URL, team names, artifact URL and contact into `SUBMISSION.md` (and into the YouTube description placeholders)"]
    L += [f"- [ ] {m}" for m in dict.fromkeys(manual)]
    L += ["- [ ] Open `cardiolens_offline.html` once on the recording machine and look at the 3D view before you start"]
    (OUT / "checklist.md").write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    sys.exit(main())
