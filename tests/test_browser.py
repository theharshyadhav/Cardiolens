#!/usr/bin/env python3
"""End-to-end browser tests for CardioLens 3D (real Chromium via Playwright, software WebGL is fine).

What it proves, in order:
  boot          the page loads without script errors; the real BodyParts3D mesh renders; 13 WebMCP tools are registered
  interaction   rows, chips, hover tooltips, region clicks, modes, layers, keyboard, wheel, time-lapse, inputs, what-if, model card
  scan          phantom and real NIfTI upload, calcium finder, vessel assignment -> 3D chips, slice scroll, HU probe, bad-file handling
  ct            CT from the main drop zone: NIfTI, DICOM files, folder, .zip, cine routing; heart box dragged with the mouse in all three views
  agent         tools called through navigator.modelContextTesting (the WebMCP surface an external agent uses):
                results are measurements only, the guard blocks bulk payloads, export_findings blocks until a human decides,
                denial / Escape / study change cancel it, and nothing but the page and fonts/three.js ever leaves the tab
  mri           cardiac MRI sample: EF / EDV in range, slice toggle, 3D LV state, play / pause, no arrays in the cine tools,
                export_findings v2 (approval, cine_mri, Escape and study-change cancel), no overflow at 390 / 1440 px, console clean
  degraded      reduced motion, no WebGL, no three.js: the dashboard keeps working
  layout        400 px phone and 820 px tablet: no horizontal scroll
  api           (optional) served by backend/server.py the page shows the API parity badge and only ever POSTs clinical numbers

Run:  python3 tests/test_browser.py            (needs: pip install playwright; chromium; npm i three@0.128.0)
Screens are written to results/screens/.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "web" / "index.html").as_uri()
THREE = ROOT / "node_modules" / "three" / "build" / "three.min.js"
SHOTS = ROOT / "results" / "screens"
REAL_CT = Path(os.environ.get("CARDIOLENS_REAL_CT", str(ROOT / "demo" / "real_ct_slab_16x2.5mm.nii.gz")))
SHOTS.mkdir(parents=True, exist_ok=True)

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond, detail: str = "") -> bool:
    ok = bool(cond)
    RESULTS.append((name, ok, detail))
    print(("  PASS " if ok else "  FAIL ") + name + (f"   [{detail}]" if detail and not ok else ""))
    return ok


def launch(p):
    return p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
                                   "--enable-webgl", "--allow-file-access-from-files"])


class Page:
    """A page with error capture and network logging; three.js is served locally so the test also runs offline."""

    def __init__(self, browser, w=1440, h=900, scheme="dark", reduced=False, url=PAGE, block_three=False, no_webgl=False):
        self.ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, reduced_motion="reduce" if reduced else "no-preference",
                                       permissions=["clipboard-read", "clipboard-write"])
        if no_webgl:
            self.ctx.add_init_script("const g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){if(/webgl/.test(t))return null;return g.call(this,t,...a)}")
        self.pg = self.ctx.new_page()
        self.errors: list[str] = []
        self.requests: list[tuple[str, str, str | None]] = []
        self.pg.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)))
        self.pg.on("console", lambda m: self.errors.append("console." + m.type + ": " + m.text) if m.type == "error" and "ERR_FAILED" not in m.text and "Failed to load resource" not in m.text else None)
        self.pg.on("request", lambda r: self.requests.append((r.method, r.url, r.post_data)))
        if block_three:
            self.pg.route("**/three.min.js", lambda r: r.abort())
        elif THREE.exists():
            self.pg.route("**/three.min.js", lambda r: r.fulfill(path=str(THREE), content_type="application/javascript"))
        self.pg.route("https://fonts.googleapis.com/**", lambda r: r.abort())
        self.pg.route("https://fonts.gstatic.com/**", lambda r: r.abort())
        self.pg.goto(url)

    def ready(self, timeout=90000):
        self.pg.wait_for_function("typeof V!=='undefined' && V && V.stats", timeout=timeout)
        time.sleep(0.8)
        return self

    def ev(self, js, arg=None):
        return self.pg.evaluate(js, arg) if arg is not None else self.pg.evaluate(js)

    def settle(self, timeout=15000):
        """wait until the camera stopped moving (fly-to finished)."""
        self.ev("window.__k=''")
        self.pg.wait_for_function("()=>{const c=V.camera(),k=JSON.stringify([c.az,c.el,c.D,c.t]),r=window.__k===k;window.__k=k;return r}", polling=350, timeout=timeout)

    def tool(self, name, args=None):
        """call a tool exactly as an external WebMCP agent would; returns the parsed result."""
        raw = self.pg.evaluate("([n,a])=>navigator.modelContextTesting.executeTool(n,JSON.stringify(a||{}))", [name, args or {}])
        return json.loads(raw)

    def shot(self, name, **kw):
        self.pg.screenshot(path=str(SHOTS / f"{name}.png"), **kw)

    def close(self):
        self.ctx.close()


def find_hit(page: Page, vessel: bool, skip=()):
    """a canvas pixel whose +-5 px neighbourhood all hit the same vessel (or the same tissue group)."""
    return page.ev("""([vessel,skip])=>{const cv=document.querySelector('#v canvas'),r=cv.getBoundingClientRect(),O=[[0,0],[5,0],[-5,0],[0,5],[0,-5],[4,4],[-4,-4],[4,-4],[-4,4]];
      for(let y=r.top+70;y<r.bottom-80;y+=9)for(let x=r.left+160;x<r.right-70;x+=9){
        const h=V.pick(x,y);if(!h||h.vessel!==vessel||skip.includes(h.g))continue;
        if(O.every(([dx,dy])=>{const q=V.pick(x+dx,y+dy);return document.elementFromPoint(x+dx,y+dy)===cv&&q&&q.vessel===vessel&&q.g===h.g}))return{x,y,g:h.g}}return null}""", [vessel, list(skip)])


def start_export(page: Page, args="{}"):
    """fire export_findings without awaiting it (evaluate would wait for the human otherwise)."""
    page.ev("(a)=>{window.__done=false;window.__res=null;navigator.modelContextTesting.executeTool('export_findings',a).then(r=>{window.__done=true;window.__res=r});return 1}", args)


def freeze(page: Page, az=0.5, el=0.15, D=5.2):
    """park the camera (no pendulum, no chase) so hit-tests stay valid."""
    page.ev("([a,e,d])=>V.view({az:a,el:e,D:d})", [az, el, D])
    page.settle()


# ----------------------------------------------------------------------------------------------------------------------
def t_boot(b):
    print("boot")
    P = Page(b).ready()
    check("page loads with no script errors", not P.errors, "; ".join(P.errors[:3]))
    st = P.ev("V.stats()")
    check("real anatomy mesh is on screen (>50k triangles)", st["triangles"] > 50000, str(st))
    check("canvas has real size", P.ev("(()=>{const c=document.querySelector('#v canvas');return c.width>200&&c.height>200})()"))
    check("13 WebMCP tools registered", P.ev("$('#tc').textContent") == "13 tools" and P.ev("navigator.modelContextTesting.listTools().length") == 13)
    check("WebMCP badge shows tool count", "13 tools" in P.ev("$('#wm').textContent"))
    check("disclaimer banner is always visible", P.ev("!!document.querySelector('.dis')&&document.querySelector('.dis').offsetHeight>10"))
    check("generic-atlas note is on the stage", "Generic adult atlas" in P.ev("document.querySelector('.atlas').textContent"))
    risk = P.ev("RS.CAD.p")
    check("default CAD risk is a probability", 0 < risk < 1, str(risk))
    # colour agrees with band (the 38% regression: intermediate must not be green)
    P.ev("S.age=58;update()")
    rgb = P.ev("riskRgb(0.38)")
    check("38% (Intermediate) is amber, not green", rgb[0] > rgb[1] * 0.9 and rgb[0] > 180, str(rgb))
    rgb_lo = P.ev("riskRgb(0.2)")
    check("20% (Low) is teal", rgb_lo[1] > rgb_lo[0] + 40, str(rgb_lo))
    rgb_hi = P.ev("riskRgb(0.9)")
    check("90% (High) is red", rgb_hi[0] > 150 and rgb_hi[1] < 100, str(rgb_hi))
    P.shot("01_overview_dark")
    # theme toggle
    P.pg.click("#thm")
    time.sleep(0.8)
    check("theme toggle sets data-theme", P.ev("document.documentElement.dataset.theme") in ("light", "dark"))
    ramp = P.ev("getComputedStyle(document.documentElement).getPropertyValue('--ramp')")
    check("risk ramp variable is built", "rgb(" in ramp, ramp[:60])
    P.pg.click("#thm")
    time.sleep(0.5)
    P.close()


def t_interaction(b):
    print("interaction")
    P = Page(b).ready()
    # row click -> selection + fly-to
    az0 = P.ev("V.camera().az")
    P.pg.click(".vr[data-k=RCA]")
    P.settle()
    check("row click selects the vessel", P.ev("sel") == "RCA" and P.ev("document.querySelector('.vr[data-k=RCA]').getAttribute('aria-checked')") == "true")
    check("camera flew to the vessel", abs(P.ev("V.camera().az") - az0) > 0.2 or abs(P.ev("V.camera().D") - 6) > 0.5)
    check("camera never goes below the heart", P.ev("V.camera().el") >= 0.05)
    check("stage card names the vessel", "RCA" in P.ev("$('#vi').textContent"))
    check("hero chip is highlighted", P.ev("document.querySelector('.chip.on').textContent").startswith("●") or "RCA" in P.ev("document.querySelector('.chip.on').textContent"))
    P.shot("02_fly_to_rca", clip={"x": 0, "y": 96, "width": 870, "height": 745})
    for k in ("LAD", "LCX"):
        P.pg.click(f".vr[data-k={k}]")
        P.settle()
        check(f"{k} row selects and updates the explanation", P.ev("sel") == k and f"Why {k}" in P.ev("$('#dt').textContent"))
    # chip click
    P.pg.click(".chip:has-text('RCA')")
    P.settle()
    check("vessel chip button selects the vessel", P.ev("sel") == "RCA")
    # hover tooltip on a vessel, then click it
    freeze(P)
    P.pg.mouse.move(5, 5)
    hit = find_hit(P, True)
    check("a vessel can be hit-tested on the canvas", hit is not None)
    if hit:
        P.pg.mouse.move(hit["x"], hit["y"])
        time.sleep(0.3)
        P.pg.mouse.move(hit["x"] + 1, hit["y"] + 1)
        P.pg.wait_for_function("!document.querySelector('#tip').hidden", timeout=8000)
        check("hover tooltip shows the vessel probability", "click to inspect" in P.ev("$('#tip').textContent") and "%" in P.ev("$('#tip').textContent"), P.ev("$('#tip').textContent"))
        P.pg.mouse.click(hit["x"], hit["y"])
        time.sleep(0.5)
        check("clicking the vessel in 3D selects it", P.ev("sel") == hit["g"], f"{P.ev('sel')} vs {hit['g']}")
    # region click
    freeze(P)
    rh = find_hit(P, False)
    check("anatomical tissue can be hit-tested", rh is not None)
    if rh:
        P.pg.mouse.click(rh["x"], rh["y"])
        time.sleep(0.6)
        txt = P.ev("$('#vi').textContent")
        check("clicking tissue explains the region and says it is orientation only", "orientation only" in txt and P.ev("V.region()") == rh["g"], txt[:80])
        P.pg.click(".vr[data-k=LAD]")
        time.sleep(0.5)
        check("selecting a vessel clears the region card", P.ev("V.region()") in (None, "") and "orientation only" not in P.ev("$('#vi').textContent") and "LAD" in P.ev("$('#vi').textContent"))
    # display modes
    for m, label in (("solid", "Solid"), ("ghost", "Vessels"), ("glass", "Glass")):
        P.pg.click(f".seg button[data-m={m}]")
        time.sleep(0.5)
        check(f"{label} mode applies", P.ev("V.mode()") == m and P.ev(f"document.querySelector('.seg button[data-m={m}]').getAttribute('aria-checked')") == "true")
        if m == "solid":
            P.shot("03_solid", clip={"x": 0, "y": 96, "width": 870, "height": 745})
        if m == "ghost":
            P.shot("04_vessels_only", clip={"x": 0, "y": 96, "width": 870, "height": 745})
    # layers
    P.pg.click("#lyb")
    time.sleep(0.3)
    check("Layers popover opens", P.ev("!$('#lyr').hidden"))
    P.pg.uncheck("#lyr input[data-g=LV]")
    time.sleep(0.4)
    check("unchecking a layer hides the mesh", P.ev("V.layers.LV") is False)
    P.shot("05_layers_panel", clip={"x": 0, "y": 96, "width": 870, "height": 745})
    P.pg.click("#lya")
    check("Show all restores every layer", all(P.ev("Object.values(V.layers)")))
    P.pg.keyboard.press("Escape")
    check("Escape closes the Layers popover", P.ev("$('#lyr').hidden"))
    # keyboard and wheel
    P.ev("document.querySelector('#v canvas').focus()")
    P.pg.keyboard.press("ArrowLeft")
    az1 = P.ev("V.camera().az")
    P.pg.keyboard.press("ArrowLeft")
    az2 = P.ev("V.camera().az")
    check("arrow keys rotate the heart", abs((az2 - az1) - 0.12) < 0.02, f"{az2 - az1:.3f}")
    d1 = P.ev("V.camera().D")
    P.pg.keyboard.press("+")
    check("plus zooms in", P.ev("V.camera().D") < d1)
    box = P.pg.locator("#v canvas").bounding_box()
    P.pg.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.5)
    d2 = P.ev("V.camera().D")
    P.pg.mouse.wheel(0, 300)
    time.sleep(0.4)
    check("mouse wheel zooms", P.ev("V.camera().D") > d2)
    P.pg.keyboard.press("0")
    P.pg.wait_for_function("Math.abs(V.camera().D-5.2)<0.12", timeout=20000)
    check("0 resets the view", abs(P.ev("V.camera().D") - 5.2) < 0.2, str(P.ev("V.camera()")))
    # drag orbit
    cx, cy = box["x"] + box["width"] * 0.55, box["y"] + box["height"] * 0.55
    freeze(P)                                  # park the camera first: no reset fly-to or pendulum may move az between reading a0 and the drag
    a0 = P.ev("V.camera().az")
    P.pg.mouse.move(cx, cy)
    P.pg.mouse.down()
    for i in range(8):
        P.pg.mouse.move(cx + 14 * i, cy + 4 * i)
        time.sleep(0.04)
    P.pg.mouse.up()
    az1 = P.ev("V.camera().az")
    check("dragging orbits the camera", abs(az1 - a0) > 0.3, f"az {a0:.3f} -> {az1:.3f}")
    # inputs: sliders change risk, presets apply
    base = P.ev("RS.CAD.p")
    P.ev("(()=>{const i=document.querySelector('#in input[data-k=age]');i.value=75;i.dispatchEvent(new Event('input',{bubbles:true}))})()")
    check("raising age raises CAD probability", P.ev("RS.CAD.p") > base)
    P.pg.click("#ps [data-p='0']")
    time.sleep(0.4)
    check("a preset profile loads", P.ev("S.age") != 75)
    P.pg.click("#ps [data-p='-1']")
    check("Reset restores the default profile", P.ev("S.age") == P.ev("FEAT.age.default"))
    # time-lapse
    a_start = P.ev("S.age")
    P.pg.click("#ta")
    P.pg.wait_for_function(f"S.age>={a_start + 20}", timeout=20000)
    check("Age +20 y animates age by 20 years", P.ev("S.age") == a_start + 20)
    check("time-lapse is labelled illustrative", "illustrative" in P.ev("$('#nt').textContent"))
    p_old = P.ev("RS.CAD.p")
    P.shot("06_age_plus_20", clip={"x": 0, "y": 96, "width": 870, "height": 745})
    P.pg.click("#ta")
    P.pg.wait_for_function(f"S.age<={a_start}", timeout=20000)
    time.sleep(0.5)
    check("Back to now restores the original age and hides the note", P.ev("S.age") == a_start and P.ev("$('#nt').hidden"))
    check("time-lapse raised the estimate", p_old > P.ev("RS.CAD.p"))
    # what-if
    P.ev("(()=>{const s=document.querySelector('#wf');s.value='bmi';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
    check("what-if curve redraws for the chosen measurement", P.ev("!!document.querySelector('#wcs path')") and P.ev("$('#wc').textContent.includes(FEAT.bmi.label)"))
    check("what-if chart has a values table", P.ev("!!document.querySelector('#wc table')"))
    P.shot("07_dashboard_lower", full_page=True)
    # model card
    P.pg.click("#mcb")
    time.sleep(0.6)
    check("Model card opens as a dialog", P.ev("$('#mcm').classList.contains('on')"))
    check("Model card shows ROC and calibration charts", P.ev("document.querySelectorAll('#mcc svg.chart').length") >= 2)
    check("Model card lists AUC for every target", all(t in P.ev("$('#mcc table').textContent") for t in ("CAD", "LAD", "LCX", "RCA")))
    P.pg.click("#mcc [data-mt=LCX]")
    time.sleep(0.3)
    check("Model card switches target", "Calibration · LCX" in P.ev("$('#mcc').textContent"))
    mc = P.ev("$('#mcc').textContent")
    check("Model card states the tuning metric consistently (log-loss, never 'ROC-AUC tuning')", "log-loss" in mc and "ROC-AUC tuning" not in mc)
    P.shot("08_model_card")
    P.pg.keyboard.press("Escape")
    check("Escape closes the Model card", not P.ev("$('#mcm').classList.contains('on')"))
    check("no script errors during interaction", not P.errors, "; ".join(P.errors[:3]))
    P.close()


def t_scan(b):
    print("scan")
    P = Page(b).ready()
    check("before a scan is loaded the reading room says so", "Load a CT" in P.ev("$('#rg').textContent"))
    err = P.tool("describe_scan")
    check("describe_scan without a scan explains what to do", err.get("isError") and "No scan is loaded" in err["content"][0]["text"], str(err)[:120])
    P.pg.click("#dm")
    P.pg.wait_for_function("$('#sn').textContent.includes('axial')", timeout=30000)
    check("phantom loads into the viewer", P.ev("$('#sc').style.display") == "block")
    d = P.tool("describe_scan")
    sc = d["structuredContent"]
    check("describe_scan returns dimensions and HU range only (a few hundred bytes, no arrays)", sc["dims"] and "hu_max" in sc and not {"data", "voxels", "slice"} & set(sc) and len(json.dumps(d)) < 1500, str(len(json.dumps(d))))
    # agent finds calcifications
    P.pg.click("#fc")
    P.pg.wait_for_function("document.querySelectorAll('#rg select[data-r]').length>0", timeout=60000)
    n = P.ev("document.querySelectorAll('#rg select[data-r]').length")
    check("calcium finder lists regions with scores", n >= 3, str(n))
    rg = P.tool("find_calcifications", {"limit": 5})["structuredContent"]
    check("find_calcifications returns measurements per region", all(k in rg["regions"][0] for k in ("volume_mm3", "peak_hu", "agatston", "centroid_mm")))
    check("score is labelled simplified/unvalidated", "unvalidated" in P.tool("find_calcifications", {"limit": 1})["content"][0]["text"])
    # assign a region to a vessel -> the 3D chip shows the calcium score
    P.pg.select_option("#rg select[data-r]", "LAD")
    time.sleep(0.6)
    chips = P.ev("[...document.querySelectorAll('.chip')].map(c=>c.textContent)")
    check("assigning a lesion to LAD marks the 3D chip with its Ca score", any(re.search(r"LAD.*Ca \d+", c) for c in chips), str(chips))
    P.shot("09_scan_and_chips", full_page=True)
    # tool errors are actionable
    e1 = P.tool("assign_vessel", {"region_id": 9999, "vessel": "LAD"})
    check("unknown region id lists the valid ids", e1.get("isError") and "Available ids" in e1["content"][0]["text"])
    e2 = P.tool("find_calcifications", {"min_hu": 500, "max_hu": 100})
    check("inverted HU window is rejected with a fix", e2.get("isError") and "Swap them" in e2["content"][0]["text"])
    e3 = P.tool("focus_vessel", {"vessel": "XYZ"})
    check("bad vessel name is rejected with the valid options", e3.get("isError") and "CAD, LAD, LCX or RCA" in e3["content"][0]["text"])
    e4 = P.tool("predict_risk", {"features": {"not_a_feature": 3}})
    check("unknown feature is rejected with the valid keys", e4.get("isError") and "Valid keys" in e4["content"][0]["text"])
    # viewer
    P.pg.click("[data-v=coronal]")
    time.sleep(0.4)
    check("plane buttons switch the view", "coronal" in P.ev("$('#sn').textContent"))
    k0 = P.ev("vw.k")
    P.pg.locator("#sc").scroll_into_view_if_needed()
    box = P.pg.locator("#sc").bounding_box()
    P.pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    P.pg.mouse.wheel(0, 100)
    time.sleep(0.3)
    check("scrolling the slice canvas changes the slice", P.ev("vw.k") != k0)
    P.pg.mouse.move(box["x"] + box["width"] / 2 + 6, box["y"] + box["height"] / 2 + 4)
    time.sleep(0.3)
    check("pointer probe shows a Hounsfield value", re.search(r"voxel \d+,\d+,\d+ · -?\d+ HU", P.ev("$('#sn').textContent")) is not None, P.ev("$('#sn').textContent"))
    P.pg.select_option("#wl", "Calcium")
    check("window presets apply", P.ev("vw.wl")[0] == 300)
    f = P.tool("focus_region", {"region_id": 1})
    check("focus_region highlights a region", not f.get("isError"))
    # real CT slab
    if REAL_CT.exists():
        P.pg.set_input_files("#fl", str(REAL_CT))
        P.pg.wait_for_function("$('#sn').textContent.includes('real_ct')||$('#sn').textContent.includes('axial')", timeout=60000)
        time.sleep(1.0)
        d2 = P.tool("describe_scan")
        check("a real CT slab (NIfTI .gz) is parsed", not d2.get("isError") and d2["structuredContent"]["dims"][2] >= 8, str(d2)[:150])
        r2 = P.tool("find_calcifications", {"limit": 3})
        check("calcium finder runs on the real slab without error", not r2.get("isError"), str(r2)[:200])
    else:
        print("  SKIP real CT slab (file not present)")
    # a malformed file is handled
    bad = ROOT / "results" / "_bad.nii"
    bad.write_bytes(b"not a nifti file at all" * 40)
    P.pg.set_input_files("#fl", str(bad))
    P.pg.wait_for_function("$('#rg').textContent.includes('Could not open scan')", timeout=15000)
    check("a malformed file shows a readable error and does not crash", True)
    bad.unlink()
    check("the page still works after a bad file", P.ev("RS.CAD.p") > 0)
    check("no script errors during the scan flow", not P.errors, "; ".join(P.errors[:3]))
    P.close()


FX = Path(os.environ.get("CL_FIXTURES", ROOT / "results" / "fixtures"))


def box_rect(P):
    return P.pg.locator("#hxs .hxr").bounding_box()


def drag(P, dx, dy, handle=None):
    if handle:
        el = P.pg.locator(f'#hxs .hxg[data-h="{handle}"] .t')
        bb = el.bounding_box()
    else:
        bb = box_rect(P)
    x, y = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
    P.pg.mouse.move(x, y)
    P.pg.mouse.down()
    P.pg.mouse.move(x + dx / 2, y + dy / 2, steps=4)
    P.pg.mouse.move(x + dx, y + dy, steps=4)
    P.pg.mouse.up()
    time.sleep(0.4)


def t_ct(b):
    print("ct")
    shutil.rmtree(FX, ignore_errors=True)
    subprocess.run(["node", str(ROOT / "tests" / "make_fixtures.js"), str(FX)], check=True, capture_output=True)
    P = Page(b).ready()
    wait = lambda js: P.pg.wait_for_function(js, timeout=60000)
    # NIfTI
    P.pg.set_input_files("#fl", str(FX / "chest.nii"))
    wait("$('#sn').textContent.includes('axial')")
    check("NIfTI opens from the main file button with a neutral label", P.ev("VOL.name") == "CT volume (NIfTI)")
    # DICOM files, no extension
    P.pg.set_input_files("#fl", [str(f) for f in sorted((FX / "DOE^JANE").iterdir())])
    wait("VOL.name.includes('DICOM series, 60 images')")
    check("DICOM files without extension open as one CT series", P.ev("VOL.dims.join()") == "128,112,60", P.ev("VOL.dims.join()"))
    # folder
    P.ev("VOL=null")
    P.pg.set_input_files("#fd", str(FX / "DOE^JANE"))
    wait("VOL&&VOL.name.includes('DICOM series, 60 images')")
    check("a folder opens as a CT series (name of the folder not shown)", "DOE" not in P.ev("document.body.innerText"))
    # zip
    P.pg.set_input_files("#fl", str(FX / "ct.zip"))
    wait("VOL.name.includes('DICOM series, 60 images')")
    check("a .zip opens as a CT series", True)
    # cine routes to the MRI panel, CT stays
    P.pg.set_input_files("#fl", [str(f) for f in sorted((FX / "cine").iterdir())])
    wait("typeof CN!=='undefined'&&CN&&!CBUSY")
    cn = P.tool("describe_cine")
    check("a DICOM cine goes to the Cardiac MRI panel and the CT stays loaded", not cn.get("isError") and cn["structuredContent"]["slices"] == 4 and P.ev("VOL.dims[2]") == 60, str(cn)[:200])
    # mixed -> plain message
    P.pg.set_input_files("#fl", [str(FX / "cine" / "i0_0"), str(FX / "DOE^JANE" / "IM0")])
    time.sleep(1.2)
    check("a mixed selection says so and names the next step", "Next step" in P.ev("$('#rg').textContent") and P.ev("VOL.dims[2]") == 60, P.ev("$('#rg').textContent")[:160])
    # heart box on the chest volume
    P.pg.set_input_files("#fl", str(FX / "chest.nii"))
    wait("$('#sn').textContent.includes('axial')")
    P.pg.click("#fc")
    wait("document.querySelectorAll('#rg select[data-r]').length>0")
    n0 = P.tool("find_calcifications", {"limit": 30})["structuredContent"]["total"]
    check("whole-scan box: bone-like candidates and the coronary lesions are all listed", n0 >= 4, str(n0))
    P.pg.click("#hxa")
    time.sleep(0.8)
    t = P.ev("$('#hxt').textContent")
    check("Suggest heart box draws a box with a numeric read-out and says it is a guess", re.search(r"x \d+", t) and "not a segmentation" in P.ev("$('#hxn').textContent"), t)
    n1 = P.tool("find_calcifications", {"limit": 30})["structuredContent"]
    check("the suggestion limits the calcium list and reports the excluded count", 3 <= n1["total"] < n0 and n1["excluded_outside_box"] == n0 - n1["total"], f"{n0}->{n1['total']}")
    P.shot("15_box_axial")
    # drag in each view
    for view in ("axial", "coronal", "sagittal"):
        P.pg.click(f'[data-v="{view}"]')
        time.sleep(0.5)
        before = P.ev("JSON.stringify(hbD())")
        bb = box_rect(P)
        check(f"{view}: the box projection is drawn", bb and bb["width"] > 10 and bb["height"] > 10, str(bb))
        drag(P, 25, 18)
        after = P.ev("JSON.stringify(hbD())")
        check(f"{view}: dragging with the mouse moves the box (read-out: {P.ev('$(\'#hxt\').textContent')[:40]})", before != after and json.loads(after)["source"] == "user")
        drag(P, -12, -8, handle="se")
        check(f"{view}: dragging a corner handle resizes it", json.loads(P.ev("JSON.stringify(hbD())"))["size"] != json.loads(after)["size"])
        P.pg.locator("#hxs .hxr").focus()
        k0 = P.ev("JSON.stringify(hbD())")
        P.pg.keyboard.press("ArrowRight")
        check(f"{view}: arrow keys nudge the box", P.ev("JSON.stringify(hbD())") != k0)
        P.shot(f"15_box_{view}")
    # the list reacts to the box
    P.pg.click('[data-v="axial"]')
    P.pg.click("#hxw")
    time.sleep(0.5)
    check("Whole scan restores every candidate", P.tool("find_calcifications", {"limit": 30})["structuredContent"]["total"] == n0)
    P.pg.click("#hxa")
    time.sleep(0.5)
    P.pg.click('[data-v="axial"]')
    tot0 = P.tool("find_calcifications", {"limit": 30})["structuredContent"]["total"]
    drag(P, 2000, 0, handle="w")  # pull the left edge across the scan: the box shrinks to a sliver at the right edge, away from the heart
    bx = P.tool("describe_scan")["structuredContent"]
    check("a box dragged out of the scan stays inside it", bx["heart_box_mm"]["x"][1] <= bx["fov_mm"][0] + 0.01, str(bx["heart_box_mm"]))
    a = P.tool("find_calcifications", {"limit": 30})["structuredContent"]
    check("dragging the box away from the heart changes the calcium list", a["total"] < tot0 and a["excluded_outside_box"] > 0, f"{tot0}->{a['total']}")
    check("the list on the page follows the box", P.ev("document.querySelectorAll('#rg select[data-r]').length") == a["total"])
    check("no script errors", not P.errors, "|".join(P.errors)[:300])
    P.close()


def t_agent(b):
    print("agent")
    P = Page(b).ready()
    tools = json.loads(P.ev("JSON.stringify(navigator.modelContextTesting.listTools())"))
    names = {t["name"] for t in tools}
    check("all tools are discoverable via WebMCP", {"describe_heart_model", "focus_vessel", "describe_scan", "find_calcifications", "focus_region", "set_view", "assign_vessel", "predict_risk", "export_findings", "set_heart_region", "describe_cine", "measure_lv", "show_lv_3d"} == names, str(names))
    h = P.tool("describe_heart_model")["structuredContent"]
    check("describe_heart_model says the heart is generic and withholds geometry", h["patient_specific"] is False and h["geometry_withheld"] is True and "positions" not in json.dumps(h))
    check("the mesh never appears in any tool result", len(json.dumps(h)) < 2500)
    r = P.tool("focus_vessel", {"vessel": "LCX"})
    P.settle()
    check("focus_vessel moves the 3D view", not r.get("isError") and P.ev("sel") == "LCX")
    pr = P.tool("predict_risk", {"features": {"age": 78}})["structuredContent"]
    check("predict_risk returns probabilities and drivers, not the model", set(pr["probabilities"]) == {"CAD", "LAD", "LCX", "RCA"} and len(pr["top_drivers"]) == 5)
    check("what-if override does not change the page state", P.ev("S.age") == P.ev("FEAT.age.default"))
    # the guard
    blocked0 = P.ev("MT.blocked")
    try:
        P.ev("guard({content:[{type:'text',text:'x'.repeat(13000)}]})")
        check("guard blocks an oversized payload", False)
    except Exception as e:  # noqa: BLE001
        check("guard blocks an oversized payload", "boundary guard" in str(e))
    for needle in ("Float32Array", "data:image/png;base64,AAAA", "ImageData"):
        try:
            P.ev("(n)=>guard({content:[{type:'text',text:n}]})", needle)
            check(f"guard blocks '{needle[:14]}'", False)
        except Exception as e:  # noqa: BLE001
            check(f"guard blocks '{needle[:14]}'", "boundary guard" in str(e))
    check("blocked payloads are counted on the live meter", P.ev("MT.blocked") == blocked0 + 4 and P.ev("$('#pm3').textContent") == str(blocked0 + 4))
    # export without a scan works and is human-gated
    start_export(P, json.dumps({"note": "t1"}))
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=8000)
    time.sleep(0.6)
    check("export_findings blocks while waiting for the human", P.ev("window.__done") is False)
    j = P.ev("$('#mj').textContent")
    rep = json.loads(j)
    check("approval dialog shows exactly what would leave", rep["schema"] == "cardiolens.room.v2" and rep["heart_model"]["patient_specific"] is False and "clinical_risk" in rep)
    check("approval dialog contains no scan data", len(j) < 6000 and not re.search(r"Float32Array|base64|voxels\"", j))
    P.shot("10_approval_dialog")
    P.pg.click("#no")
    P.pg.wait_for_function("window.__done===true", timeout=8000)
    res = json.loads(P.ev("window.__res"))
    check("Deny returns an error to the agent and exports nothing", res.get("isError") and "declined" in res["content"][0]["text"] and not res.get("structuredContent"))
    # approve
    start_export(P)
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=8000)
    P.pg.click("#ok")
    P.pg.wait_for_function("window.__done===true", timeout=8000)
    res = json.loads(P.ev("window.__res"))
    check("Approve returns the report", not res.get("isError") and res["structuredContent"]["schema"] == "cardiolens.room.v2")
    # Escape denies
    start_export(P)
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=8000)
    P.pg.keyboard.press("Escape")
    P.pg.wait_for_function("window.__done===true", timeout=8000)
    check("Escape counts as Deny", json.loads(P.ev("window.__res")).get("isError") is True)
    # with a scan: must find first; study change cancels a pending approval
    P.pg.click("#dm")
    P.pg.wait_for_function("$('#sn').textContent.includes('axial')", timeout=30000)
    e = P.tool("export_findings")
    check("export before measuring is refused with the next step", e.get("isError") and "find_calcifications" in e["content"][0]["text"])
    P.tool("find_calcifications")
    start_export(P)
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=8000)
    P.ev("document.querySelector('#dm').click()")  # another study is loaded while approval is open (the dialog blocks the mouse, a drop or script does not)
    P.pg.wait_for_function("window.__done===true", timeout=30000)
    res = json.loads(P.ev("window.__res"))
    check("changing the study cancels a pending export", res.get("isError") and "scan changed" in res["content"][0]["text"], str(res)[:160])
    check("the approval dialog closes itself on a study change", not P.ev("$('#md').classList.contains('on')"))
    # built-in demo agent uses the same tool path
    P.pg.wait_for_function("$('#sn').textContent.includes('axial')", timeout=30000)
    P.pg.click("#run")
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=60000)
    P.shot("11_demo_agent_approval")
    P.pg.click("#ok")
    P.pg.wait_for_function("document.querySelector('#say').textContent.includes('Export approved')", timeout=30000)
    logs = P.ev("[...document.querySelectorAll('#lg .lg')].map(d=>d.textContent)")
    check("the demo agent log shows the tool sequence", any("describe_heart_model" in l for l in logs) and any("export_findings" in l and "human-approved" in l for l in logs))
    check("the boundary meter counts results and has no bulk data", int(P.ev("$('#pm1').textContent")) >= 8 and P.ev("MT.bytes") < 60000, f"{P.ev('MT.n')} results, {P.ev('MT.bytes')} bytes")
    P.shot("12_agent_panel", full_page=True)
    # the network: nothing but the page, three.js and fonts; no uploads of any kind
    allowed = re.compile(r"^(file://|data:|blob:|https://cdnjs\.cloudflare\.com/|https://fonts\.(googleapis|gstatic)\.com/)")
    stray = [(m, u) for m, u, _ in P.requests if not allowed.match(u)]
    posts = [(m, u) for m, u, _ in P.requests if m != "GET"]
    check("no network request leaves the allow-list (page, three.js, fonts)", not stray, str(stray[:3]))
    check("no POST/PUT of any kind from the standalone page", not posts, str(posts[:3]))
    check("no script errors during agent flows", not P.errors, "; ".join(P.errors[:3]))
    P.close()


def t_degraded(b):
    print("degraded")
    P = Page(b, reduced=True).ready()
    st = P.ev("V.stats()")
    check("reduced-motion: page runs and does not auto-rotate", st["triangles"] > 50000)
    a0 = P.ev("V.camera().az")
    time.sleep(1.5)
    check("reduced-motion: camera is still", abs(P.ev("V.camera().az") - a0) < 1e-6)
    P.pg.click(".vr[data-k=LCX]")
    time.sleep(0.8)
    check("reduced-motion: fly-to jumps without animation", abs(P.ev("V.camera().az") - a0) > 0.2)
    check("reduced-motion: no errors", not P.errors, "; ".join(P.errors[:2]))
    P.close()
    P = Page(b, no_webgl=True)
    P.pg.wait_for_function("document.querySelector('#v .fallback')!==null", timeout=30000)
    check("no WebGL: a readable fallback is shown", "3D view could not start" in P.ev("document.querySelector('#v .fallback').textContent"))
    check("no WebGL: the clinical dashboard still works", P.ev("RS.CAD.p") > 0 and P.ev("document.querySelectorAll('#risk .vr').length") == 3)
    P.pg.click(".vr[data-k=LCX]")
    check("no WebGL: selecting a vessel still explains the prediction", P.ev("sel") == "LCX" and "LCX" in P.ev("$('#dt').textContent"))
    t = P.tool("predict_risk")
    check("no WebGL: agent tools still answer", not t.get("isError"))
    check("no WebGL: describe_heart_model works without a renderer", "not patient-specific" in P.tool("describe_heart_model")["content"][0]["text"])
    P.close()
    P = Page(b, block_three=True)
    P.pg.wait_for_function("document.querySelector('#v .fallback')!==null", timeout=30000)
    check("three.js blocked: fallback explains and dashboard works", "three.js could not be loaded" in P.ev("document.querySelector('#v .fallback').textContent") and P.ev("RS.CAD.p") > 0)
    P.close()


def t_layout(b):
    print("layout")
    for (w, h, name) in ((400, 800, "phone"), (820, 1100, "tablet"), (1920, 1080, "desktop-wide")):
        P = Page(b, w, h).ready()
        sw = P.ev("document.documentElement.scrollWidth")
        check(f"{name} {w}px: no horizontal scroll", sw <= w + 1, f"scrollWidth {sw}")
        vh = P.ev("document.querySelector('#v').getBoundingClientRect().height")
        check(f"{name} {w}px: 3D stage has usable height", vh >= 360, str(vh))
        over = P.ev("""[...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+2&&!e.closest('.scrollx')&&!e.closest('pre')&&!e.closest('#lgw')&&getComputedStyle(e).position!=='fixed'}).slice(0,3).map(e=>e.tagName+'.'+e.className)""")
        check(f"{name} {w}px: no element overflows the viewport", not over, str(over))
        P.shot(f"13_{name}", full_page=True)
        if w == 400:
            P.pg.click(".vr[data-k=LAD]")
            time.sleep(1.0)
            check("phone: tapping a row selects and keeps layout intact", P.ev("sel") == "LAD" and P.ev("document.documentElement.scrollWidth") <= w + 1)
        P.close()


# ----------------------------------------------------------------------------------------------------------------------
BAD_KEYS = {"frames", "vertices", "positions", "index", "radii", "Rr", "phases", "curves", "data", "pixelData", "mesh", "res", "areas", "pixels_data"}
GUARD_RE = re.compile(r"Float32Array|Int16Array|Uint8Array|ImageData|base64|data:image/")


def bulk(obj, path="$"):
    """what must never reach a tool result: pixel / vertex / radius arrays, matrices, long arrays, long strings."""
    bad = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in BAD_KEYS and isinstance(v, (list, dict)):
                bad.append(f"{path}.{k}: forbidden key carrying {type(v).__name__}")
            bad += bulk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        if len(obj) > 12:
            bad.append(f"{path}: array of {len(obj)}")
        if any(isinstance(x, (list, dict)) for x in obj):
            bad.append(f"{path}: nested structure inside an array")
        for i, x in enumerate(obj):
            bad += bulk(x, f"{path}[{i}]")
    elif isinstance(obj, str) and len(obj) > 700:
        bad.append(f"{path}: string of {len(obj)} chars")
    return bad


def wait_measured(P, timeout=150000):
    P.pg.wait_for_function("typeof CM!=='undefined' && CM && CV && !CBUSY && !document.querySelector('#cb').hidden", timeout=timeout)


def mri_state(P):
    return P.ev("({ef:CV.ef,edv:CV.edv,esv:CV.esv,spread:{ef:CV.spread.ef,edv:CV.spread.edv},keep:CKP.map(s=>s+1)})")


OVERFLOW_JS = """[...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+2&&!e.closest('.scrollx')&&!e.closest('pre')&&!e.closest('#lgw')&&getComputedStyle(e).position!=='fixed'}).slice(0,3).map(e=>e.tagName+'#'+e.id+'.'+e.className)"""


def t_mri(b):
    print("mri")
    P = Page(b, 1440, 900).ready()
    t0 = time.time()
    P.pg.click("#cs")
    wait_measured(P)
    check("MRI sample loads and is measured in the browser", P.ev("!!CM && !!CV && !CBUSY") and not P.ev("$('#cb').hidden"), f"{time.time() - t0:.1f}s")
    base = mri_state(P)
    check("sample EF is between 38 and 44 %", 38 <= base["ef"] <= 44, f"EF {base['ef']:.1f}")
    check("sample EDV is between 115 and 130 mL", 115 <= base["edv"] <= 130, f"EDV {base['edv']:.1f}")
    check("the result states 'automatic estimate', 'not validated' and 'not a confidence interval'",
          all(x in P.ev("$('#cres').textContent") for x in ("Automatic estimate", "Not validated", "not a confidence interval")))
    # slice toggle: no re-trace, EDV and range change, and come back exactly
    P.pg.click('#cch input[data-i="5"]')
    P.pg.wait_for_function("CKP.length===8")
    off = mri_state(P)
    check("switching slice 6 off changes EDV", off["edv"] < base["edv"] - 1 and 6 not in off["keep"], f"{base['edv']:.1f} -> {off['edv']:.1f}")
    check("switching slice 6 off changes the EDV sensitivity range", off["spread"]["edv"] != base["spread"]["edv"], f"{base['spread']['edv']} -> {off['spread']['edv']}")
    P.pg.click('#cch input[data-i="5"]')
    P.pg.wait_for_function("CKP.length===9")
    back = mri_state(P)
    check("switching slice 6 on again restores EDV and range exactly", abs(back["edv"] - base["edv"]) < 1e-9 and back["spread"]["edv"] == base["spread"]["edv"])
    # 3D toggle <-> V.lvState()
    check("before the toggle V.lvState() says not shown", P.ev("V.lvState().shown") is False)
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===true", timeout=15000)
    st = P.ev("V.lvState()")
    check("after Show my LV, V.lvState() is loaded and shown", st["loaded"] and st["shown"] and st["vertices"] > 100, str(st))
    check("button, HUD toggle and info card agree with V.lvState()",
          P.ev("$('#clv').textContent") == "Hide my LV in 3D" and P.ev("$('#lvb').getAttribute('aria-pressed')") == "true" and P.ev("!$('#lvc').hidden"))
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===false")
    check("after Hide my LV, V.lvState() says not shown and the HUD toggle follows", P.ev("$('#lvb').getAttribute('aria-pressed')") == "false" and P.ev("$('#lvc').hidden"))
    # play / pause
    P.ev("cnStopKeepLv()")
    P.pg.click("#cpl")
    check("Play shows 'Pause' and the phase advances", P.ev("$('#cpl').textContent") == "Pause" and P.ev("CPLAY") is True)
    p0 = P.ev("CPH")
    time.sleep(0.6)
    check("the cine phase moves while playing", abs(P.ev("CPH") - p0) > 0.2, f"{p0} -> {P.ev('CPH')}")
    P.pg.click("#cpl")
    p1 = P.ev("CPH")
    time.sleep(0.5)
    check("Pause shows 'Play' and the phase stops", P.ev("$('#cpl').textContent") == "Play" and P.ev("CPLAY") is False and P.ev("CPH") == p1)
    # the three cine tools: text + small numbers only
    for name, args in (("describe_cine", {}), ("measure_lv", {}), ("show_lv_3d", {"on": True})):
        n0 = P.ev("MT.n")
        raw = P.pg.evaluate("([n,a])=>navigator.modelContextTesting.executeTool(n,JSON.stringify(a))", [name, args])
        r = json.loads(raw)
        sc = r.get("structuredContent")
        check(f"{name}: no arrays, no pixels, no vertices, nothing the guard looks for",
              not r.get("isError") and isinstance(sc, dict) and not bulk(sc) and not GUARD_RE.search(raw) and len(raw) < 6000, "; ".join(bulk(sc or {}))[:200] or raw[:100])
        check(f"{name}: the privacy meter counted the result and blocked none", P.ev("MT.n") == n0 + 1 and P.ev("$('#pm3').textContent") == str(P.ev("MT.blocked")))
    P.tool("show_lv_3d", {"on": False})
    # export_findings v2
    start_export(P, json.dumps({"note": "mri"}))
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=15000)
    time.sleep(0.6)
    check("export_findings (v2) blocks until a human decides", P.ev("window.__done") is False)
    rep = json.loads(P.ev("$('#mj').textContent"))
    cm = rep.get("cine_mri")
    check("the approval dialog shows schema v2 with the cine_mri block (numbers only)",
          rep["schema"] == "cardiolens.room.v2" and isinstance(cm, dict) and cm["edv_ml"] == round(base["edv"], 1) and cm["ef_pct"] == round(base["ef"], 1) and not bulk(cm), str(list(cm or {})[:6]))
    P.pg.keyboard.press("Escape")
    P.pg.wait_for_function("window.__done===true", timeout=8000)
    res = json.loads(P.ev("window.__res"))
    check("Escape cancels the export: error to the agent, nothing exported, dialog closed",
          res.get("isError") and not res.get("structuredContent") and not P.ev("$('#md').classList.contains('on')"), str(res)[:160])
    start_export(P)
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=15000)
    P.ev("document.querySelector('#cs').click()")        # another study is loaded while the human is deciding
    P.pg.wait_for_function("window.__done===true", timeout=20000)
    res = json.loads(P.ev("window.__res"))
    check("loading another study while the dialog is open cancels the export and closes the dialog",
          res.get("isError") and "cine MRI changed" in res["content"][0]["text"] and not res.get("structuredContent") and not P.ev("$('#md').classList.contains('on')"), str(res)[:160])
    wait_measured(P)
    start_export(P)
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=15000)
    P.pg.click("#ok")
    P.pg.wait_for_function("window.__done===true", timeout=8000)
    res = json.loads(P.ev("window.__res"))
    sc = res.get("structuredContent") or {}
    check("Approve returns the v2 report including cine_mri", not res.get("isError") and sc.get("schema") == "cardiolens.room.v2" and sc.get("cine_mri", {}).get("edv_ml") == round(base["edv"], 1))
    # layout with the MRI card in the page
    sw = P.ev("document.documentElement.scrollWidth")
    check("1440 px: no horizontal overflow with the MRI card", sw <= 1441 and not P.ev(OVERFLOW_JS), f"scrollWidth {sw} {P.ev(OVERFLOW_JS)}")
    P.pg.set_viewport_size({"width": 390, "height": 844})
    time.sleep(1.0)
    sw = P.ev("document.documentElement.scrollWidth")
    check("390 px: no horizontal overflow with the MRI card", sw <= 391 and not P.ev(OVERFLOW_JS), f"scrollWidth {sw} {P.ev(OVERFLOW_JS)}")
    check("console clean: no script errors, no console errors during the whole MRI session", not P.errors, "; ".join(P.errors[:3]))
    P.close()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def t_api(b):
    print("api")
    try:
        import fastapi  # noqa: F401
        import uvicorn  # noqa: F401
    except ImportError:
        print("  SKIP (fastapi/uvicorn not installed)")
        return
    port = free_port()
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.server:app", "--port", str(port), "--log-level", "warning"], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                socket.create_connection(("127.0.0.1", port), 0.3).close()
                break
            except OSError:
                time.sleep(0.5)
        P = Page(b, url=f"http://127.0.0.1:{port}/").ready()
        P.pg.wait_for_function("document.querySelector('#api').textContent.includes('matches')", timeout=20000)
        check("served by the backend, the page proves JS == scikit-learn parity", "matches" in P.ev("$('#api').textContent"), P.ev("$('#api').textContent"))
        P.pg.click("#dm")
        P.pg.wait_for_function("$('#sn').textContent.includes('axial')", timeout=30000)
        P.pg.click("#fc")
        time.sleep(2)
        P.ev("(()=>{const i=document.querySelector('#in input[data-k=age]');i.value=66;i.dispatchEvent(new Event('input',{bubbles:true}))})()")
        time.sleep(1.2)
        posts = [(u, d) for m, u, d in P.requests if m == "POST"]
        check("the page called /api/predict", len(posts) >= 1 and all(u.endswith("/api/predict") for u, _ in posts))
        bodies = [json.loads(d) for _, d in posts if d]
        check("POST bodies are clinical numbers only (no scan, mesh or regions)", all(set(x) == {"features"} for x in bodies) and all(isinstance(v, (int, float)) for x in bodies for v in x["features"].values()))
        check("API parity badge still green after changes", "matches" in P.ev("$('#api').textContent"))
        P.close()
    finally:
        proc.terminate()


def main():
    only = set(sys.argv[1:])
    with sync_playwright() as p:
        b = launch(p)
        for name, fn in (("boot", t_boot), ("interaction", t_interaction), ("scan", t_scan), ("ct", t_ct), ("agent", t_agent), ("mri", t_mri), ("degraded", t_degraded), ("layout", t_layout), ("api", t_api)):
            if only and name not in only:
                continue
            t0 = time.time()
            try:
                fn(b)
            except Exception as e:  # noqa: BLE001
                check(f"{name}: test aborted", False, repr(e)[:300])
            print(f"  ({time.time() - t0:.0f}s)")
        b.close()
    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} browser checks passed")
    for n, _, d in bad:
        print("FAILED:", n, d)
    (ROOT / "results" / "browser_tests.json").write_text(json.dumps([{"check": n, "pass": ok, "detail": d} for n, ok, d in RESULTS], indent=1))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
