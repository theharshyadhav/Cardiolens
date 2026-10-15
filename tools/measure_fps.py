#!/usr/bin/env python3
"""Measure how responsive the 3D view is on a machine WITHOUT a GPU.

Launches headless Chromium with a software WebGL rasteriser (SwiftShader), loads web/index.html at three viewport sizes and reports

  * renders per second while the heart is being orbited continuously for 4 s      (the adaptive resolution governor is active)
  * the canvas size / quality the governor settled on, and the size of the sharp still frame once you stop
  * WebGL renders during 2 s of idleness after the interaction  (should be 0: an idle page costs nothing)
  * time from navigation to a ready 3D view

Writes results/perf.json.   python tools/measure_fps.py [--page web/index.html] [--seconds 4]
Numbers depend on the machine; on a real GPU the governor simply stays at full resolution.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
THREE = ROOT / "node_modules" / "three" / "build" / "three.min.js"

COUNT = """() => {
  window.__renders = 0;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const o = C.prototype.clear;
    C.prototype.clear = function () { window.__renders++; return o.apply(this, arguments); };
  }
}"""
CANVAS = "(() => { const c = document.querySelector('#v canvas'); return [c.width, c.height]; })()"
GPU = """(() => { const g = document.createElement('canvas').getContext('webgl'); if (!g) return 'no webgl';
  const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })()"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--page", default=str(ROOT / "web" / "index.html"))
    ap.add_argument("--seconds", type=float, default=4.0)
    a = ap.parse_args()
    page_url = Path(a.page).resolve().as_uri()
    out: dict = {"page": Path(a.page).name, "runs": []}
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
                                    "--enable-webgl", "--allow-file-access-from-files"])
        out["chromium"] = b.version
        for (w, h, label) in [(1440, 900, "desktop 1440x900"), (820, 1100, "tablet 820x1100"), (400, 800, "phone 400x800")]:
            ctx = b.new_context(viewport={"width": w, "height": h}, color_scheme="dark")
            pg = ctx.new_page()
            if THREE.exists():
                pg.route("**/three.min.js", lambda r: r.fulfill(path=str(THREE), content_type="application/javascript"))
            pg.route("https://fonts.googleapis.com/**", lambda r: r.abort())
            pg.route("https://fonts.gstatic.com/**", lambda r: r.abort())
            t0 = time.time()
            pg.goto(page_url)
            pg.wait_for_function("typeof V!=='undefined' && V && V.stats", timeout=90000)
            ready_s = time.time() - t0
            if "gpu" not in out:
                out["gpu"] = pg.evaluate(GPU)
                out["cores"] = pg.evaluate("navigator.hardwareConcurrency")
            time.sleep(1.2)
            pg.evaluate(COUNT)
            box = pg.locator("#v canvas").bounding_box()
            cx, cy, r = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, min(box["width"], box["height"]) * 0.18
            pg.mouse.move(cx + r, cy)
            pg.mouse.down()
            pg.evaluate("window.__renders = 0")
            t1 = time.time()
            k = 0
            while time.time() - t1 < a.seconds:
                k += 1
                ang = k * 0.22
                pg.mouse.move(cx + r * math.cos(ang), cy + r * 0.5 * math.sin(ang))
                time.sleep(0.004)
            dt = time.time() - t1
            renders = pg.evaluate("window.__renders")
            moving = pg.evaluate(CANVAS)
            st_moving = pg.evaluate("V.stats()")
            pg.mouse.up()
            time.sleep(2.5)  # still-frame refinement
            still = pg.evaluate(CANVAS)
            pg.evaluate("window.__renders = 0")
            time.sleep(2.0)
            idle = pg.evaluate("window.__renders")
            run = {"viewport": label, "ready_s": round(ready_s, 1), "orbit_renders_per_s": round(renders / dt, 1),
                   "canvas_while_moving": moving, "canvas_at_rest": still, "quality_while_moving": st_moving.get("quality"),
                   "software_renderer_detected": st_moving.get("software_renderer"), "degraded_mode": st_moving.get("degraded"),
                   "idle_renders_in_2s": idle, "triangles": st_moving.get("triangles")}
            out["runs"].append(run)
            print(json.dumps(run))
            ctx.close()
        b.close()
    (ROOT / "results" / "perf.json").write_text(json.dumps(out, indent=1))
    print("gpu:", out.get("gpu"), "| cores:", out.get("cores"), "| chromium", out.get("chromium"))
    print("wrote results/perf.json")


if __name__ == "__main__":
    main()
