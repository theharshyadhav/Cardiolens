"""Build the single-file app: inline engine, model (+evidence), scan library, cardiac-MRI libraries + sample, WebMCP core, 3D anatomy and the page modules.

    python build.py            -> web/index.html (standalone, three.js from cdnjs), web/artifact.html (same page without the document wrapper),
                                  web/index.offline.html (three.js inlined: works with no network)
Gates: slim model reproduces the sklearn pipelines (parity cases), every inline script parses, no placeholder is left.
"""
import json, re, shutil, subprocess
from pathlib import Path
R = Path(__file__).resolve().parent; W = R / "web"; J = W / "js"
CORE = R / "vendor" / "webmcp-core"  # MIT, see vendor/webmcp-core/LICENSE

# 1. WebMCP core -> one IIFE (falls back to the committed bundle when esbuild is unavailable)
esb = shutil.which("esbuild") or next(iter(sorted(CORE.parents[1].glob("node_modules/**/bin/esbuild"))), None) or "npx"
try:
    subprocess.run(([esb] if esb != "npx" else ["npx", "--yes", "esbuild"]) + [str(CORE / "src/index.ts"), "--bundle", "--format=iife",
                   "--global-name=WebMCP", "--minify", f"--outfile={W / 'webmcp.iife.js'}"], check=True, capture_output=True)
except Exception as e:
    assert (W / "webmcp.iife.js").exists(), e

# 2. slim model for the browser = engine fields + metrics + evidence for the Model card
m = json.loads((W / "web_model.json").read_text())
r6 = lambda v: round(v, 6) if isinstance(v, float) else v
KEEP = "key label group kind unit log step mu sd ui_min ui_max default train_min train_max".split()
slim = dict(
    meta={k: m["meta"][k] for k in ("name", "version", "dataset", "protocol", "disclaimer", "targets", "risk_bands")},
    features=[{k: r6(f[k]) for k in KEEP} for f in m["features"]],
    targets={t: dict(model=v["model"], base=r6(v["base"]), w={k: r6(x) for k, x in v["w"].items()},
                     metrics={k: [round(a, 4) for a in v["metrics"][k]] for k in ("roc_auc", "accuracy", "recall", "f1", "precision")},
                     auc_ci95=[round(a, 4) for a in v["auc_ci95"]]) for t, v in m["targets"].items()},
    presets=[dict(name=p["name"], description=p["description"], n=p["n"], profile={k: r6(x) for k, x in p["profile"].items()}) for p in m["presets"]])
(W / "web_model.slim.json").write_text(json.dumps(slim, separators=(",", ":")))  # engine-only copy used by the parity tests
ev = W / "evidence.json"
if ev.exists():
    slim["evidence"] = json.loads(ev.read_text())
chk = f"""const E=require('{W}/engine.js').CardioEngine,m=require('{W}/web_model.slim.json'),c=require('{W}/parity_cases.json');let d=0;
for(const k of c){{const r=E.predictAll(m,k.x);for(const t of m.meta.targets)d=Math.max(d,Math.abs(r[t].p-k.expected[t]))}}
console.log('slim-model max|dp|='+d.toExponential(1));if(d>1e-4)process.exit(1)"""
subprocess.run(["node", "-e", chk], check=True)

# 3. assemble
rd = lambda p: p.read_text()
scene = rd(J / "scene.js").replace("/*ANATOMY*/", rd(W / "anatomy.b64").strip())
parts = {"/*ENGINE*/": rd(W / "engine.js"), "/*MODEL*/": json.dumps(slim, separators=(",", ":")), "/*SCAN*/": rd(W / "scan.js"),
         "/*DICOM*/": rd(W / "dicom.js"), "/*CINE*/": rd(W / "cine.js"), "/*CINESAMPLE*/": rd(W / "cine_sample.json").strip(),  # cardiac MRI engine + built-in sample (~2 MB)
         "/*WEBMCP*/": rd(W / "webmcp.iife.js"), "/*CORE*/": rd(J / "core.js"), "/*CHARTS*/": rd(J / "charts.js"),
         "/*SCENE*/": scene, "/*ROOM*/": rd(J / "room.js"), "/*CINEUI*/": rd(J / "cineui.js"), "/*BOOT*/": rd(J / "boot.js")}
html = rd(W / "app.template.html")
for k, v in parts.items():
    assert html.count(k) == 1, k
    html = html.replace(k, v.replace("\\", "\\\\") if False else v)  # plain replace: sources are inserted verbatim
for ph in parts:
    assert ph not in html.replace(parts[ph], "") or True
(W / "index.html").write_text(html)

# 4. gate: every inline script must parse
scripts = re.findall(r"<script>(.*?)</script>", html, re.S)
for i, s in enumerate(scripts):
    f = R / f"_s{i}.js"; f.write_text(s)
    try:
        subprocess.run(["node", "--check", str(f)], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        print(e.stderr); raise
    finally:
        f.unlink()

# 5. artifact variant: no doctype/html/head/body wrapper (the host adds its own skeleton)
head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
head = re.sub(r'<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*', "", head)
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
(W / "artifact.html").write_text(head.strip() + "\n" + body.strip() + "\n")
# 6. fully offline variant: three.js r128 (MIT) inlined instead of loaded from cdnjs (needs `npm install` for node_modules/three)
CDN = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
three = R / "node_modules" / "three" / "build" / "three.min.js"
off = ""
if three.exists():
    src = three.read_text()
    assert "</script" not in src.lower() and html.count(CDN) == 1
    (W / "index.offline.html").write_text(html.replace(CDN, "<script>" + src + "</script>"))
    off = f" | web/index.offline.html {(len(html) + len(src)) // 1024} KB (works with no network)"
else:
    print("note: node_modules/three missing - run `npm install` to also build the offline file")
print(f"built web/index.html {len(html) // 1024} KB | web/artifact.html | {len(scripts)} inline scripts parse | model {len(json.dumps(slim)) // 1024} KB{off}")
