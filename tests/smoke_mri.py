#!/usr/bin/env python3
"""Smoke test for the cardiac-MRI wiring (HANDOFF task a): real headless Chromium via Playwright, software WebGL is fine.

Proves on the built page web/index.html (three.js and the font stylesheet are served from local stubs, so the run is offline):
  boot     zero console errors and zero failed requests; 13 WebMCP tools; status chip
  sample   "Load sample": EF ~41 % (range ~38-43), EDV ~122 mL, ESV ~72 mL, slices 3-11; equals results/cine_reference.json
  slices   switching a slice off/on changes the volumes without re-tracing; the sensitivity range stays sensible
  lv3d     "Show my LV in 3D": a beating LV inside the heart (Glass and Solid), hides again; pixel-level proof in reduced motion
  tools    describe_cine / measure_lv / show_lv_3d return text + numbers only; the privacy meter and the guard behave as before
  export   export_findings v2 still needs a human, carries the cine_mri block, is cancelled when the cine changes
  ui       controls, chart, centre picker, EF hand-off, demo agent, no-WebGL fallback, 390 px phone width, contrast in both themes
Writes results/smoke_mri.json and the screenshots results/screens/14_*.png (override: SMOKE_SHOTS, SMOKE_JSON, SMOKE_PAGE).
Run:  python3 tests/smoke_mri.py        (needs: playwright + chromium, Pillow, numpy, node_modules/three, a built web/index.html)
Task (c) should fold these checks into tests/test_browser.py; this file is a standalone proof, not part of the 126 browser checks.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE = Path(os.environ.get("SMOKE_PAGE", str(ROOT / "web" / "index.html"))).resolve().as_uri()
THREE = ROOT / "node_modules" / "three" / "build" / "three.min.js"
SHOTS = Path(os.environ.get("SMOKE_SHOTS", str(ROOT / "results" / "screens")))
OUT = Path(os.environ.get("SMOKE_JSON", str(ROOT / "results" / "smoke_mri.json")))
REF = json.loads((ROOT / "results" / "cine_reference.json").read_text())
SHOTS.mkdir(parents=True, exist_ok=True)
RESULTS: list[dict] = []
NUM: dict = {}


def check(name: str, cond, detail="") -> bool:
    ok = bool(cond)
    RESULTS.append({"name": name, "ok": ok, "detail": str(detail)[:500]})
    print(("  PASS " if ok else "  FAIL ") + name + (f"   [{str(detail)[:300]}]" if detail and not ok else ""))
    return ok


def launch(p):
    return p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
                                   "--enable-webgl", "--allow-file-access-from-files"])


class Page:
    """Page with strict error / network capture. Any http(s) request other than three.js and the font CSS is aborted and counted."""

    def __init__(self, browser, w=1440, h=900, scheme="dark", reduced=False, dpr=1, no_webgl=False):
        self.ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, device_scale_factor=dpr,
                                       reduced_motion="reduce" if reduced else "no-preference", permissions=["clipboard-read", "clipboard-write"])
        if no_webgl:
            self.ctx.add_init_script("const g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){if(/webgl/.test(t))return null;return g.call(this,t,...a)}")
        self.pg = self.ctx.new_page()
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.failed: list[str] = []
        self.external: list[str] = []
        self.pg.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)))
        self.pg.on("console", self._console)
        self.pg.on("requestfailed", lambda r: self.failed.append(f"{r.url[:100]} {r.failure}"))
        self.pg.on("response", lambda r: self.failed.append(f"HTTP {r.status} {r.url[:100]}") if r.status >= 400 else None)
        self.pg.route(re.compile(r"^https?://"), self._abort)            # registered first = matched last
        self.pg.route("**/three.min.js", lambda r: r.fulfill(path=str(THREE), content_type="application/javascript"))
        self.pg.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="text/css", body="/* offline stub */"))
        self.pg.route("https://fonts.gstatic.com/**", lambda r: r.fulfill(status=200, content_type="font/woff2", body=b""))
        self.pg.goto(PAGE)

    def _console(self, m):
        if m.type == "error":
            self.errors.append("console.error: " + m.text)
        elif m.type == "warning":
            self.warnings.append(m.text)

    def _abort(self, route):
        self.external.append(route.request.url)
        route.abort()

    def ready(self, timeout=90000, webgl=True):
        if webgl:
            self.pg.wait_for_function("typeof V!=='undefined' && V && V.stats", timeout=timeout)
        else:
            self.pg.wait_for_function("document.querySelector('#tc') && document.querySelector('#tc').textContent.length>0", timeout=timeout)
        time.sleep(0.6)
        return self

    def ev(self, js, arg=None):
        return self.pg.evaluate(js, arg) if arg is not None else self.pg.evaluate(js)

    def tool(self, name, args=None):
        """call a tool exactly as an external WebMCP agent would; returns the parsed result."""
        raw = self.pg.evaluate("([n,a])=>navigator.modelContextTesting.executeTool(n,JSON.stringify(a||{}))", [name, args or {}])
        return json.loads(raw)

    def img(self, sel):
        return Image.open(io.BytesIO(self.pg.locator(sel).screenshot())).convert("RGB")

    def shot(self, name, sel=None, **kw):
        if sel:
            self.pg.locator(sel).screenshot(path=str(SHOTS / f"{name}.png"))
        else:
            self.pg.screenshot(path=str(SHOTS / f"{name}.png"), **kw)

    def clean(self, label, allow=()):
        errs = [e for e in self.errors if not any(a in e for a in allow)]
        check(f"{label}: zero console errors / page errors", not errs, "; ".join(errs[:3]))
        check(f"{label}: zero failed requests, nothing fetched outside the page", not self.failed and not self.external, "; ".join((self.failed + self.external)[:3]))

    def close(self):
        self.ctx.close()


# ---------------------------------------------------------------------------------------------------------------- helpers
def load_sample(P, timeout=150000):
    t0 = time.time()
    P.pg.click("#cs")
    P.pg.wait_for_function("typeof CM!=='undefined' && CM && CV && !CBUSY && !document.querySelector('#cb').hidden", timeout=timeout)
    return round(time.time() - t0, 2)


def state(P):
    return P.ev("""(()=>({ef:CV.ef,edv:CV.edv,esv:CV.esv,sv:CV.sv,ed:CV.ed,es:CV.es,spread:{ef:CV.spread.ef,edv:CV.spread.edv,esv:CV.spread.esv},
      keep:CKP.map(s=>s+1),auto:CM.keep.map(s=>s+1),hr:CN.hr_bpm,sample:!!CN.sample,S:CN.S,T:CN.T,lv:CLVON}))()""")


def tiles(P):
    return P.ev("[...document.querySelectorAll('#cres .tile')].map(t=>({v:t.querySelector('b').textContent.trim(),l:t.querySelector('span').textContent.trim(),r:((t.querySelector('em')||{}).textContent||'').trim()}))")


def meter(P):
    return P.ev("({n:MT.n,b:MT.bytes,k:MT.blocked,t:[$('#pm1').textContent,$('#pm2').textContent,$('#pm3').textContent]})")


BAD_KEYS = {"frames", "vertices", "positions", "index", "radii", "Rr", "phases", "curves", "data", "pixelData", "mesh", "res", "areas", "pixels_data"}
GUARD = re.compile(r"Float32Array|Int16Array|Uint8Array|ImageData|base64|data:image/")


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
        if any(isinstance(x, (list, dict)) for x in obj) and path != "$.regions":
            bad.append(f"{path}: nested structure inside an array")
        for i, x in enumerate(obj):
            bad += bulk(x, f"{path}[{i}]")
    elif isinstance(obj, str) and len(obj) > 700:
        bad.append(f"{path}: string of {len(obj)} chars")
    return bad


def start_export(P, args="{}"):
    """fire export_findings without awaiting it (evaluate would wait for the human otherwise)."""
    P.ev("(a)=>{window.__done=false;window.__res=null;navigator.modelContextTesting.executeTool('export_findings',a).then(r=>{window.__done=true;window.__res=r});return 1}", args)


def dialog_open(P):
    P.pg.wait_for_function("document.querySelector('#md').classList.contains('on')", timeout=15000)


def wait_done(P, timeout=30000):
    P.pg.wait_for_function("window.__done===true", timeout=timeout)
    return json.loads(P.ev("window.__res"))


def diff_count(a: Image.Image, b: Image.Image, thr: int) -> int:
    x = np.asarray(a, dtype=np.int16)
    y = np.asarray(b, dtype=np.int16)
    h, w = min(x.shape[0], y.shape[0]), min(x.shape[1], y.shape[1])
    x, y = x[:h, :w], y[:h, :w]
    return int((np.abs(x - y).sum(axis=2) > thr).sum())


def view_img(P):
    """the 3D stage at a fixed scroll position (it is sticky), so two frames are comparable pixel by pixel."""
    P.ev("window.scrollTo({top:0,behavior:'instant'})")
    time.sleep(0.25)
    bb = P.pg.locator("#v").bounding_box()
    clip = {"x": round(bb["x"]), "y": round(bb["y"]), "width": round(bb["width"]), "height": round(bb["height"])}
    return Image.open(io.BytesIO(P.pg.screenshot(clip=clip))).convert("RGB")


def wait_measured(P, timeout=150000):
    P.pg.wait_for_function("typeof CM!=='undefined' && CM && CV && !CBUSY && !document.querySelector('#cb').hidden", timeout=timeout)


CONTRAST_JS = r"""(pairs)=>{
  const parse=s=>{let m=String(s).match(/rgba?\(([^)]+)\)/);if(m){const p=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}}
    m=String(s).match(/color\(srgb ([^)]+)\)/);if(m){const p=m[1].split(/[ \/]+/).filter(Boolean).map(Number);return{r:p[0]*255,g:p[1]*255,b:p[2]*255,a:p.length>3?p[3]:1}}return null};
  const over=(f,b)=>({r:f.r*f.a+b.r*(1-f.a),g:f.g*f.a+b.g*(1-f.a),b:f.b*f.a+b.b*(1-f.a),a:1});
  const bgOf=e=>{const st=[];for(let n=e;n;n=n.parentElement){const c=parse(getComputedStyle(n).backgroundColor||'');if(c&&c.a>0){st.push(c);if(c.a>=1)break}}
    let acc={r:255,g:255,b:255,a:1};for(let i=st.length-1;i>=0;i--)acc=over(st[i],acc);return acc};
  const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)};
  const ratio=(a,b)=>{const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)};
  return pairs.map(([sel,prop])=>{const e=document.querySelector(sel);if(!e)return[sel,prop,null];const cs=getComputedStyle(e),fg0=parse(cs[prop]);if(!fg0)return[sel,prop,null];
    fg0.a*=parseFloat(cs.opacity||1);const own=['backgroundColor','borderTopColor'].includes(prop),host=own?e.parentElement:(e.closest('svg')||e),bg=bgOf(host);return[sel,prop,+ratio(over(fg0,bg),bg).toFixed(2)]})}"""
CONTRAST_TEXT = [("#cine .tile b", "color"), ("#cine .tile span", "color"), ("#cine .tile em", "color"), ("#cinfo", "color"), ("#ccl", "color"),
                 ("#cmsg .mu", "color"), ("#cres .sm", "color"), ("#cine .gl2", "color"), ("#cvc text.lb", "fill"), ("#cvc text.ax", "fill"),
                 ("#cvc text.ms", "fill"), ("#cine .tbl td", "color"), ("#cine .tbl th", "color"), ("#cine .btn.pri", "color"), ("#cine .cc1 button", "color"),
                 ("#lvc .nm", "color"), ("#lvc .ds", "color")]
CONTRAST_UI = [("#cvc .ln", "stroke"), ("#cvc .mk", "stroke"), ("#cine .gauge i.gr", "backgroundColor"), ("#cine .cc1.cur button", "borderTopColor")]

AUDIT_JS = r"""()=>{const vw=document.documentElement.clientWidth,out=[];
  for(const e of document.querySelectorAll('#cine *,#v *')){const r=e.getBoundingClientRect(),cs=getComputedStyle(e);if(!r.width||!r.height||cs.visibility==='hidden'||cs.display==='none'||e.closest('.sr')||e.classList.contains('sr')||e.closest('.ramp'))continue;
    const tag=e.tagName+(e.id?'#'+e.id:'')+(typeof e.className==='string'&&e.className?'.'+e.className.split(' ')[0]:'');
    if(!(e.closest('svg')&&e.tagName!=='svg')&&(r.right>vw+1||r.left<-1))out.push(['outside-viewport',tag,Math.round(r.left),Math.round(r.right)]);
    if(e.scrollWidth>e.clientWidth+2&&!['auto','scroll'].includes(cs.overflowX)&&cs.display!=='inline'&&!(e instanceof SVGElement))out.push(['content-wider-than-box',tag,e.scrollWidth,e.clientWidth])}
  const s=document.querySelector('#cvc svg'),k=s?s.getBoundingClientRect().width/s.viewBox.baseVal.width:null;
  return{scrollWidth:document.documentElement.scrollWidth,clientWidth:vw,issues:out.slice(0,25),chart_font_px:s?[...new Set([...s.querySelectorAll('text')].map(t=>+(parseFloat(getComputedStyle(t).fontSize)*k).toFixed(1)))]:null}}"""


# ---------------------------------------------------------------------------------------------------------------- sections
def s_nocine(b):
    print("fresh page, no cine loaded")
    P = Page(b).ready()
    names = json.loads(P.ev("JSON.stringify(navigator.modelContextTesting.listTools().map(t=>t.name))"))
    check("status chip says 13 tools", "13 tools" in P.ev("$('#wm').textContent") and P.ev("$('#tc').textContent") == "13 tools", P.ev("$('#wm').textContent"))
    check("13 tools discoverable via WebMCP, incl. describe_cine, measure_lv, show_lv_3d",
          len(names) == 13 and {"describe_cine", "measure_lv", "show_lv_3d"} <= set(names), str(names))
    check("registered-tools list shows 13 entries", P.ev("$$('#tl > div').length") == 13)
    check("Cardiac MRI panel is there; results, My LV button and LV card stay hidden until measured",
          P.ev("!!$('#cine') && $('#cb').hidden && $('#lvb').hidden && $('#lvc').hidden"))
    check("--lv token is defined (sequential blue)", re.fullmatch(r"#[0-9a-fA-F]{6}", P.ev("getComputedStyle(document.documentElement).getPropertyValue('--lv').trim()") or ""))
    foot = P.ev("document.querySelector('footer').textContent")
    check("footer credits Sunnybrook (CC0) + citation and keeps the not-validated / not-a-registration labels",
          "Sunnybrook" in foot and "MIDAS" in foot and "not validated" in foot and "not an anatomical registration" in foot)
    check("clinical disclaimer banner still visible", P.ev("document.querySelector('.dis').offsetHeight>10"))
    r = P.tool("describe_cine")
    check("describe_cine without a cine: actionable error", r.get("isError") and "Load sample" in r["content"][0]["text"], r["content"][0]["text"][:120])
    r = P.tool("show_lv_3d", {"on": True})
    check("show_lv_3d without a cine: actionable error", r.get("isError") and "No cine MRI is loaded" in r["content"][0]["text"])
    h = P.tool("describe_heart_model")
    pl = h["structuredContent"]["patient_lv"]
    check("describe_heart_model: patient_lv {loaded:false, shown:false} and still 'not patient-specific'",
          pl == {"loaded": False, "shown": False} and h["structuredContent"]["patient_specific"] is False and "not patient-specific" in h["content"][0]["text"], str(pl))
    start_export(P, json.dumps({"note": "no cine"}))
    dialog_open(P)
    rep = json.loads(P.ev("$('#mj').textContent"))
    check("export without a cine: schema v2, cine_mri is null, nothing resolved before the human decides",
          rep["schema"] == "cardiolens.room.v2" and rep["cine_mri"] is None and P.ev("window.__done") is False, str(rep.get("schema")))
    P.pg.click("#no")
    res = wait_done(P)
    check("deny returns an error and exports nothing", res.get("isError") and "declined" in res["content"][0]["text"])
    P.clean("fresh page")
    P.close()


def s_main(b):
    """one long session (dark, 1440x900, motion on): sample -> slices -> LV -> tools -> export -> demo agent -> controls."""
    print("sample")
    P = Page(b).ready()
    sec = load_sample(P)
    NUM["measure_seconds_in_chromium_swiftshader"] = sec
    s = state(P)
    t = tiles(P)
    tv = {x["l"]: x for x in t}
    ef_lo, ef_hi = s["spread"]["ef"]
    NUM.update(ef_pct=round(s["ef"], 2), ef_range_pct=[round(ef_lo, 2), round(ef_hi, 2)], edv_ml=round(s["edv"], 2), esv_ml=round(s["esv"], 2), sv_ml=round(s["sv"], 2),
               edv_range_ml=[round(v, 1) for v in s["spread"]["edv"]], esv_range_ml=[round(v, 1) for v in s["spread"]["esv"]], heart_rate_bpm=s["hr"],
               slices_counted=s["keep"], ed_phase=s["ed"] + 1, es_phase=s["es"] + 1, tiles=[f'{x["l"]}: {x["v"]} {x["r"]}'.strip() for x in t])
    print(f"    EF {s['ef']:.1f} % (range {ef_lo:.1f}-{ef_hi:.1f}), EDV {s['edv']:.1f} mL, ESV {s['esv']:.1f} mL, SV {s['sv']:.1f}, HR {s['hr']}, slices {s['keep']}, measured in {sec} s")
    check("the sample is loaded and measured", s["sample"] and s["S"] == 11 and s["T"] == 20, str(s["S"]))
    check("EF is about 41 % (40-42)", 40 <= s["ef"] <= 42, f"{s['ef']:.2f}")
    check("EF sensitivity range is about 38-43", 37.5 <= ef_lo <= 39.5 and 42.5 <= ef_hi <= 44.5, f"{ef_lo:.2f}-{ef_hi:.2f}")
    check("EDV is about 122 mL and ESV about 72 mL", 120 <= s["edv"] <= 125 and 70 <= s["esv"] <= 74, f"{s['edv']:.1f} / {s['esv']:.1f}")
    check("slices 3-11 are counted (9 slices)", s["keep"] == list(range(3, 12)) and len(s["keep"]) == 9, str(s["keep"]))
    check("browser result equals the Python reference (results/cine_reference.json) to 1e-6",
          max(abs(s["edv"] - REF["edv"]), abs(s["esv"] - REF["esv"]), abs(s["ef"] - REF["ef"]), abs(ef_lo - REF["spread"]["ef"][0]), abs(ef_hi - REF["spread"]["ef"][1])) < 1e-6
          and s["ed"] == REF["ed"] and s["es"] == REF["es"], f"{s['edv']} vs {REF['edv']}")
    check("tiles on screen show the same numbers",
          tv["Ejection fraction"]["v"].replace(" ", "") == f"{round(s['ef'])}%" and tv["End-diastolic volume"]["v"].replace(" ", "") == f"{round(s['edv'])}mL"
          and tv["End-systolic volume"]["v"].replace(" ", "") == f"{round(s['esv'])}mL" and tv["Ejection fraction"]["r"] == f"range {round(ef_lo)}–{round(ef_hi)}", str(t[:3]))
    check("honesty labels are on screen (automatic estimate, not validated, range is not a confidence interval)",
          all(x in P.ev("$('#cres').textContent") for x in ("Automatic estimate", "Not validated", "not a confidence interval", "outside the clinical model")))
    check("20 phases in the volume table, 11 slice chips, 9 ticked",
          P.ev("$$('#cres tbody tr').length") == 20 and P.ev("$$('#cch .cc1').length") == 11 and P.ev("$$('#cch input:checked').length") == 9)
    check("the first draw happened: caption names slice and phase", re.search(r"slice \d+/11 · phase \d+/20", P.ev("$('#ccl').textContent") or ""), P.ev("$('#ccl').textContent"))

    # ---- slice switching without re-tracing
    print("slices")
    P.ev("""(()=>{window.__nm=0;window.__nv=0;const m=CineLib.measure,v=CineLib.volumes;CineLib.measure=function(){window.__nm++;return m.apply(this,arguments)};
      CineLib.volumes=function(){window.__nv++;return v.apply(this,arguments)};window.__cm0=CM;window.__res0=CM.res;return 1})()""")
    base = state(P)

    def sensible(x, label):
        lo, hi = x["spread"]["ef"]
        elo, ehi = x["spread"]["edv"]
        slo, shi = x["spread"]["esv"]
        return (all(map(np.isfinite, [lo, hi, elo, ehi, slo, shi])) and lo <= x["ef"] + 1e-9 and x["ef"] <= hi + 1e-9 and hi - lo < 12 and elo - 1e-9 <= x["edv"] <= ehi + 1e-9
                and slo - 1e-9 <= x["esv"] <= shi + 1e-9), f"{label}: EF {x['ef']:.1f} range {lo:.1f}-{hi:.1f}, EDV {x['edv']:.1f} ({elo:.1f}-{ehi:.1f}), ESV {x['esv']:.1f} ({slo:.1f}-{shi:.1f})"

    P.pg.click('#cch input[data-i="5"]')                                      # slice 6 off
    P.pg.wait_for_function("CKP.length===8")
    off = state(P)
    ok_s, det = sensible(off, "slice 6 off")
    print("    " + det)
    NUM["slice6_off"] = {"ef": round(off["ef"], 2), "edv": round(off["edv"], 2), "esv": round(off["esv"], 2), "ef_range": [round(v, 2) for v in off["spread"]["ef"]]}
    check("slice 6 off: volumes change (EDV and ESV drop)", off["edv"] < base["edv"] - 1 and off["esv"] < base["esv"] - 0.5 and 6 not in off["keep"], f"{base['edv']:.1f}->{off['edv']:.1f}")
    check("slice 6 off: no re-tracing (measure never called, same measurement object, volumes recomputed)",
          P.ev("window.__nm") == 0 and P.ev("window.__nv") >= 1 and P.ev("CM===window.__cm0 && CM.res===window.__res0"), f"measure calls {P.ev('window.__nm')}")
    check("slice 6 off: the sensitivity range stays sensible (finite, contains the estimate, EF band < 12 points wide)", ok_s, det)
    t_off = {x["l"]: x for x in tiles(P)}
    check("slice 6 off: tiles and chip updated, chip says 'changed by you'",
          t_off["End-diastolic volume"]["v"].replace(" ", "") == f"{round(off['edv'])}mL" and P.ev("$('#cch input[data-i=\"5\"]').checked") is False
          and "changed by you" in P.ev("$('#cch input[data-i=\"5\"]').title"))
    r = P.tool("measure_lv")["structuredContent"]
    check("measure_lv reports the user's slice edit (slices_switched_by_user, slice 6 not counted)",
          r["slices_switched_by_user"] is True and 6 not in r["slices_used"] and abs(r["edv_ml"] - round(off["edv"], 1)) < 1e-9, str(r["slices_used"]))
    P.pg.click('#cch input[data-i="5"]')                                      # slice 6 on again
    P.pg.wait_for_function("CKP.length===9")
    again = state(P)
    check("slice 6 on again: numbers return exactly to the start", max(abs(again["edv"] - base["edv"]), abs(again["esv"] - base["esv"]), abs(again["ef"] - base["ef"])) < 1e-9)
    P.pg.click('#cch input[data-i="1"]')                                      # slice 2 (left out automatically) on
    P.pg.wait_for_function("CKP.length===10")
    on2 = state(P)
    ok_s, det = sensible(on2, "slice 2 on")
    print("    " + det)
    NUM["slice2_on"] = {"ef": round(on2["ef"], 2), "edv": round(on2["edv"], 2), "esv": round(on2["esv"], 2), "ef_range": [round(v, 2) for v in on2["spread"]["ef"]]}
    check("slice 2 on (auto-excluded): volumes change, still no re-tracing, range sensible",
          on2["edv"] > base["edv"] + 1 and 2 in on2["keep"] and P.ev("window.__nm") == 0 and ok_s, det)
    P.pg.click('#cch input[data-i="1"]')
    P.pg.wait_for_function("CKP.length===9")
    check("slice 2 off again: back to the start", abs(state(P)["edv"] - base["edv"]) < 1e-9)
    for i in (2, 3, 4, 5, 6, 7, 8, 9):                                        # leave exactly one slice: the last cannot be switched off
        P.pg.click(f'#cch input[data-i="{i}"]')
    P.pg.wait_for_function("CKP.length===1")
    P.pg.click('#cch input[data-i="10"]')
    check("the last counted slice cannot be switched off (checkbox springs back)", P.ev("CKP.length") == 1 and P.ev("$('#cch input[data-i=\"10\"]').checked") is True)
    for i in (2, 3, 4, 5, 6, 7, 8, 9):
        P.pg.click(f'#cch input[data-i="{i}"]')
    P.pg.wait_for_function("CKP.length===9")
    check("all nine slices back: numbers equal the start", abs(state(P)["edv"] - base["edv"]) < 1e-9 and P.ev("window.__nm") == 0)

    # ---- 3D: real-time beating
    print("lv3d")
    check("before pressing the button: LV not shown, My LV button visible but unpressed",
          P.ev("V.lvState().shown") is False and P.ev("!$('#lvb').hidden") and P.ev("$('#lvb').getAttribute('aria-pressed')") == "false")
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===true", timeout=15000)
    st = P.ev("V.lvState()")
    check("Show my LV in 3D: LV is loaded and shown (surface vertices exist, long-axis tilt reported)", st["loaded"] and st["shown"] and st["vertices"] > 100 and "axis_deg" in st, str(st))
    check("button, HUD toggle and info card agree",
          P.ev("$('#clv').textContent") == "Hide my LV in 3D" and P.ev("$('#lvb').getAttribute('aria-pressed')") == "true" and P.ev("!$('#lvc').hidden")
          and all(x in P.ev("$('#lvc').textContent").lower() for x in ("not an anatomical registration", "true size", "end-diastole")), P.ev("$('#lvc').textContent")[:160])
    ph0 = P.ev("[CPH,V.lvState().phase,CPLAY]")
    time.sleep(0.45)
    ph1 = P.ev("[CPH,V.lvState().phase,CPLAY]")
    check("the LV beats in real time (playback runs, 3D phase follows the 2D phase)", ph0[2] and ph1[2] and abs(ph1[0] - ph0[0]) > 0.3 and abs(ph1[1] - ph0[1]) > 0.3, f"{ph0} -> {ph1}")
    NUM["lv_phase_advance_in_0.45s"] = round(abs(ph1[0] - ph0[0]), 2)
    P.pg.click("#lvb")                                                        # HUD toggle hides it
    P.pg.wait_for_function("V.lvState().shown===false")
    check("My LV (3D HUD) hides it; panel button follows", P.ev("$('#clv').textContent") == "Show my LV in 3D" and P.ev("$('#lvc').hidden") and P.ev("$('#lvb').getAttribute('aria-pressed')") == "false")
    P.pg.click("#lvb")
    P.pg.wait_for_function("V.lvState().shown===true")
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===false")
    check("shown again via the HUD, hidden again via the panel button; the heart's own beat resumes", P.ev("V.lvState().shown") is False and P.ev("!$('#lvb').hidden"))

    # ---- tools: text + numbers only
    print("tools")
    h0 = P.tool("describe_heart_model")
    check("describe_heart_model: patient_lv has numbers only and the text keeps 'not an anatomical registration'",
          h0["structuredContent"]["patient_lv"]["loaded"] is True and h0["structuredContent"]["patient_lv"]["shown"] is False
          and set(h0["structuredContent"]["patient_lv"]) == {"loaded", "shown", "edv_ml", "ef_pct"} and "not an anatomical registration" in h0["content"][0]["text"]
          and len(json.dumps(h0)) < 2800, str(h0["structuredContent"]["patient_lv"]))
    sizes = {}
    m0 = meter(P)
    for name, args in (("describe_cine", {}), ("measure_lv", {}), ("show_lv_3d", {"on": True}), ("show_lv_3d", {"on": False})):
        mb = meter(P)
        raw = P.pg.evaluate("([n,a])=>navigator.modelContextTesting.executeTool(n,JSON.stringify(a))", [name, args])
        r = json.loads(raw)
        ma = meter(P)
        txt = r["content"][0]["text"]
        sc = r.get("structuredContent")
        label = f"{name}({json.dumps(args)})"
        check(f"{label}: ok, text + small structured numbers", not r.get("isError") and isinstance(txt, str) and 0 < len(txt) < 1200 and isinstance(sc, dict), txt[:100])
        check(f"{label}: no pixel / vertex / radius arrays, no matrices, nothing the guard looks for", not bulk(sc) and not GUARD.search(raw) and len(raw) < 6000, "; ".join(bulk(sc))[:200])
        check(f"{label}: privacy meter counts one result, no block", ma["n"] == mb["n"] + 1 and ma["b"] > mb["b"] and ma["k"] == mb["k"] and ma["t"][0] == str(ma["n"]) and ma["t"][2] == str(ma["k"]),
              f"{mb} -> {ma}")
        sizes[f"{name}:{args.get('on', '')}"] = len(raw)
        if name == "describe_cine":
            check("describe_cine reports dimensions and heart rate as numbers", sc["slices"] == 11 and sc["phases"] == 20 and sc["pixels"] == [112, 112] and sc["measured"] is True and abs(sc["heart_rate_bpm"] - 58.8) < 0.05, str(sc)[:200])
        if name == "measure_lv":
            check("measure_lv returns the same numbers as the panel (EDV, ESV, EF, ranges, slices)",
                  abs(sc["edv_ml"] - round(base["edv"], 1)) < 1e-9 and abs(sc["esv_ml"] - round(base["esv"], 1)) < 1e-9 and abs(sc["ef_pct"] - round(base["ef"], 1)) < 1e-9
                  and sc["slices_used"] == list(range(3, 12)) and sc["slices_switched_by_user"] is False and "not validated" in sc["method"] and "not a confidence interval" in sc["method"], str(sc)[:240])
            NUM["measure_lv_structured"] = sc
        if name == "show_lv_3d" and args["on"]:
            check("show_lv_3d(on) really shows the LV in the 3D scene", P.ev("V.lvState().shown") is True and sc["shown"] is True)
        if name == "show_lv_3d" and not args["on"]:
            check("show_lv_3d(off) hides it again", P.ev("V.lvState().shown") is False and sc["shown"] is False)
    NUM["tool_result_bytes"] = sizes
    m1 = meter(P)
    NUM["meter_after_cine_tools"] = {"tool_results": m1["n"] - m0["n"], "bytes": m1["b"] - m0["b"], "blocked": m1["k"] - m0["k"]}
    # the guard is untouched and still counts blocked payloads
    k0 = P.ev("MT.blocked")
    for needle in ("Float32Array", "data:image/png;base64,AAAA", "ImageData"):
        try:
            P.ev("(n)=>guard({content:[{type:'text',text:n}]})", needle)
            check(f"guard still blocks '{needle[:14]}'", False)
        except Exception as e:  # noqa: BLE001
            check(f"guard still blocks '{needle[:14]}'", "boundary guard" in str(e))
    try:
        P.ev("guard({content:[{type:'text',text:'x'.repeat(13000)}]})")
        check("guard still blocks an oversized payload", False)
    except Exception as e:  # noqa: BLE001
        check("guard still blocks an oversized payload", "boundary guard" in str(e))
    check("blocked payloads are counted on the live meter", P.ev("MT.blocked") == k0 + 4 and P.ev("$('#pm3').textContent") == str(k0 + 4))
    e1 = P.tool("measure_lv", {"centre_slice": 6})
    check("measure_lv with a partial centre is refused with the next step", e1.get("isError") and "together" in e1["content"][0]["text"])
    e2 = P.tool("measure_lv", {"centre_slice": 99, "centre_x": 5, "centre_y": 5})
    check("measure_lv with a centre outside the image is refused", e2.get("isError") and "inside the image" in e2["content"][0]["text"])
    cx, cy = P.ev("CM.res[5].centre")
    t0 = time.time()
    r = P.tool("measure_lv", {"centre_slice": 6, "centre_x": cx + 1.5, "centre_y": cy - 1.5})
    NUM["measure_lv_with_centre_seconds"] = round(time.time() - t0, 2)
    check("measure_lv with a centre inside the LV re-traces and returns numbers (EF within 4 points of the automatic one)",
          not r.get("isError") and abs(r["structuredContent"]["ef_pct"] - base["ef"]) < 4 and not bulk(r["structuredContent"]), str(r["structuredContent"].get("ef_pct")) if not r.get("isError") else r["content"][0]["text"])
    NUM["measure_lv_with_centre_ef_pct"] = r["structuredContent"]["ef_pct"] if not r.get("isError") else None

    # ---- the centre experiments changed the measurement: load the sample again (fresh trace) and prove it is the same as at the start
    load_sample(P)
    check("loading the sample again re-traces from scratch and gives exactly the first numbers (EDV, ESV, EF)",
          max(abs(state(P)["edv"] - base["edv"]), abs(state(P)["esv"] - base["esv"]), abs(state(P)["ef"] - base["ef"])) < 1e-9 and state(P)["keep"] == list(range(3, 12)))

    # ---- export v2
    print("export")
    P.tool("show_lv_3d", {"on": True})
    start_export(P, json.dumps({"note": "smoke"}))
    dialog_open(P)
    time.sleep(0.8)
    check("export_findings blocks while it waits for the human", P.ev("window.__done") is False)
    j = P.ev("$('#mj').textContent")
    rep = json.loads(j)
    cm = rep["cine_mri"]
    check("approval dialog shows schema v2 and the cine_mri block (numbers only)",
          rep["schema"] == "cardiolens.room.v2" and isinstance(cm, dict) and abs(cm["ef_pct"] - round(base["ef"], 1)) < 1e-9 and cm["edv_ml"] == round(base["edv"], 1)
          and cm["slices_used"] == list(range(3, 12)) and "not validated" in cm["method"] and not bulk(cm) and not GUARD.search(j) and len(j) < 6000, str(list(cm)[:6]) if cm else "no block")
    check("approval dialog still carries the CT-free fields (scan null, clinical risk, generic heart, disclaimer)",
          rep["scan"] is None and "clinical_risk" in rep and rep["heart_model"]["patient_specific"] is False and "disclaimer" in rep)
    P.shot("14_approval_dialog_with_cine", "#md .card")
    P.pg.click("#no")
    res = wait_done(P)
    check("Deny returns an error to the agent and exports nothing", res.get("isError") and "declined" in res["content"][0]["text"] and not res.get("structuredContent"))
    start_export(P)
    dialog_open(P)
    P.pg.click("#ok")
    res = wait_done(P)
    sc = res.get("structuredContent") or {}
    check("Approve returns the v2 report with the cine block; text says no pixels or mesh were exported",
          not res.get("isError") and sc.get("schema") == "cardiolens.room.v2" and sc.get("cine_mri", {}).get("edv_ml") == round(base["edv"], 1)
          and "cine-MRI left-ventricle" in res["content"][0]["text"] and "pixels and mesh geometry were not included" in res["content"][0]["text"] and len(json.dumps(res)) < 12000)
    start_export(P)
    dialog_open(P)
    P.pg.keyboard.press("Escape")
    check("Escape counts as Deny", wait_done(P).get("isError") is True)
    start_export(P)
    dialog_open(P)
    P.ev("document.querySelector('#cs').click()")                             # another cine is opened while the human is deciding
    res = wait_done(P)
    check("changing the cine cancels a pending export and closes the dialog",
          res.get("isError") and "cine MRI changed" in res["content"][0]["text"] and not P.ev("$('#md').classList.contains('on')"), str(res)[:200])
    r = P.pg.evaluate("(()=>{document.querySelector('#cs').click();return navigator.modelContextTesting.executeTool('export_findings','{}')})()")
    r = json.loads(r)
    check("export_findings fails while a cine is being measured (and says what to do)", r.get("isError") and "still being measured" in r["content"][0]["text"], r["content"][0]["text"][:100])
    wait_measured(P)
    check("after the re-measure the numbers are the same as before", abs(state(P)["edv"] - base["edv"]) < 1e-9)

    # ---- demo agent uses the same tool path
    print("demo agent")
    P.ev("$('#lg').innerHTML=''")
    P.pg.click("#run")
    dialog_open(P)
    names = P.ev("[...document.querySelectorAll('#lg .lg b')].map(b=>b.textContent).reverse()")
    want = ["describe_heart_model", "predict_risk", "focus_vessel", "describe_cine", "measure_lv", "show_lv_3d", "export_findings"]
    it = iter(names)
    check("demo agent calls describe_cine -> measure_lv -> show_lv_3d before asking to export", all(any(x == w for x in it) for w in want), str(names))
    check("the demo agent's show_lv_3d actually showed the LV", P.ev("V.lvState().shown") is True)
    P.pg.click("#ok")
    P.pg.wait_for_function("document.querySelector('#say').textContent.includes('Export approved by the clinician')", timeout=15000)
    check("demo agent finishes after the human approves", "Highest-risk vessel" in P.ev("$('#say').textContent") and "Left ventricle (cine MRI, automatic estimate)" in P.ev("$('#say').textContent"))
    P.tool("show_lv_3d", {"on": False})

    # ---- panel controls
    print("controls")
    P.ev("cnStopKeepLv()")
    P.pg.click("#cpl")
    check("Play toggles to Pause and the phase advances", P.ev("$('#cpl').textContent") == "Pause" and P.ev("$('#cpl').getAttribute('aria-pressed')") == "true")
    p0 = P.ev("CPH")
    P.pg.select_option("#cspd", "2")
    time.sleep(0.5)
    check("speed 2x runs", abs(P.ev("CPH") - p0) > 0.3 or P.ev("CPLAY"), f"{p0} -> {P.ev('CPH')}")
    P.pg.click("#cpl")
    check("Pause stops it", P.ev("$('#cpl').textContent") == "Play" and P.ev("CPLAY") is False)
    P.ev("(()=>{const e=$('#csl');e.value=6;e.dispatchEvent(new Event('input',{bubbles:true}));return 1})()")
    check("slice slider moves the image and the caption", P.ev("CSL") == 6 and "slice 7/11" in P.ev("$('#ccl').textContent") and P.ev("$$('#cch .cc1')[6].classList.contains('cur')"))
    P.ev("(()=>{const e=$('#cph');e.value=11;e.dispatchEvent(new Event('input',{bubbles:true}));return 1})()")
    check("phase slider moves the image and the caption", int(P.ev("CPH")) == 11 and "phase 12/20" in P.ev("$('#ccl').textContent"))
    P.pg.click('#cch button[data-v="3"]')
    check("slice chip selects the slice", P.ev("CSL") == 3 and "slice 4/11" in P.ev("$('#ccl').textContent"))
    P.pg.click("#cgh")
    check("ED / ES outlines checkbox toggles the overlay state", P.ev("CGH") is False)
    P.pg.click("#cgh")
    box = P.pg.locator("#cvc svg").bounding_box()
    P.pg.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.4)
    time.sleep(0.2)
    tip = P.ev("[$('#cvt').hidden,$('#cvt').textContent]")
    check("hovering the volume curve shows phase, time, volume and range", tip[0] is False and re.search(r"phase \d+ · \d+ ms · [\d.]+ mL \(\d+–\d+\)", tip[1]), str(tip))
    P.pg.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.4)
    check("clicking the curve jumps to that phase (and pauses)", 7 <= int(P.ev("CPH")) <= 12 and P.ev("CPLAY") is False, str(P.ev("CPH")))
    r0 = P.ev("RS.CAD.p")
    P.pg.click("#cef")
    check("'Use this EF in the risk model' moves only the EF input (50 -> 41) and the risk responds, with an undo",
          P.ev("S.ef") == round(base["ef"]) and P.ev("RS.CAD.p") != r0 and "undo" in P.ev("$('#cef').textContent"), f"S.ef={P.ev('S.ef')}")
    P.pg.click("#cef")
    check("pressing again restores the echo EF input", P.ev("S.ef") == 50 and abs(P.ev("RS.CAD.p") - r0) < 1e-12 and "Use this EF" in P.ev("$('#cef').textContent"))
    P.pg.click("#cct")
    check("Pick the LV centre arms the canvas and shows the hint", P.ev("CCEN") is True and "Click the middle" in P.ev("$('#cctn').textContent") and P.ev("$('#cct').getAttribute('aria-pressed')") == "true")
    P.ev("(()=>{const e=$('#csl');e.value=5;e.dispatchEvent(new Event('input',{bubbles:true}));return 1})()")
    cxy = P.ev("CM.res[5].centre")
    bx = P.pg.locator("#cc").bounding_box()
    P.pg.mouse.click(bx["x"] + (cxy[0] + 0.5) / 112 * bx["width"] + 6, bx["y"] + (cxy[1] + 0.5) / 112 * bx["height"] - 5)
    P.pg.wait_for_function("!CBUSY && !document.querySelector('#cb').hidden", timeout=150000)
    s2 = state(P)
    NUM["after_clicking_the_centre"] = {"ef": round(s2["ef"], 2), "edv": round(s2["edv"], 2), "esv": round(s2["esv"], 2), "slices": s2["keep"]}
    check("clicking the LV centre re-measures; EF within 4 points, centre mode switched off again", abs(s2["ef"] - base["ef"]) < 4 and P.ev("CCEN") is False and P.ev("$('#cct').getAttribute('aria-pressed')") == "false", f"EF {s2['ef']:.1f}")
    check("the cursor is back to normal", P.ev("$('#cc').style.cursor") in ("default", ""), P.ev("$('#cc').style.cursor"))
    P.clean("main session")
    P.close()


def s_pixels(b):
    """reduced motion = deterministic frames: compare the 3D view with the LV hidden / shown at ED / shown at ES, in Glass and in Solid."""
    print("3D pixels (reduced motion)")
    P = Page(b, reduced=True).ready()
    P.pg.add_style_tag(content=".vinfo,.hud,.atlas,.note,.tip,.chip{visibility:hidden!important}")
    load_sample(P)
    P.ev("V.setMode('glass');V.reset()")
    time.sleep(0.8)
    hid = view_img(P)
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===true")
    check("reduced motion: showing the LV does not start playback", P.ev("CPLAY") is False)
    P.ev("cnSetPhase(CV.ed)")
    time.sleep(0.8)
    ed = view_img(P)
    P.ev("cnSetPhase(CV.es)")
    time.sleep(0.8)
    es = view_img(P)
    a_ed, a_es = diff_count(ed, hid, 90), diff_count(es, hid, 90)
    NUM["glass_lv_pixels_ed_es_beat"] = {"surface_px_ed": a_ed, "surface_px_es": a_es, "ed_vs_es_changed_px": diff_count(ed, es, 60), "view": list(hid.size)}
    print(f"    LV surface pixels: ED {a_ed}, ES {a_es}; ED vs ES changed {diff_count(ed, es, 60)}")
    check("Glass: the LV is visible inside the heart (hundreds of pixels differ from the hidden frame)", a_ed > 800, str(a_ed))
    check("Glass: the LV beats (ED and ES frames differ, ES surface is smaller than ED)", diff_count(ed, es, 60) > 150 and a_es < a_ed, f"{a_ed} vs {a_es}")
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===false")
    time.sleep(0.8)
    back = view_img(P)
    check("Glass: hiding it restores the heart exactly", diff_count(back, hid, 30) < 40, str(diff_count(back, hid, 30)))
    # Solid: the LV sits inside opaque tissue, so showing it switches the heart to Glass
    P.ev("V.setMode('solid')")
    time.sleep(0.8)
    solid_hid = view_img(P)
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===true")
    time.sleep(0.8)
    solid_shown = view_img(P)
    mode_after = P.ev("V.mode()")
    seg = P.ev("[...document.querySelectorAll('.seg button')].map(b=>b.dataset.m+':'+b.getAttribute('aria-checked'))")
    NUM["solid_then_show"] = {"mode_after_show": mode_after, "seg": seg, "changed_px": diff_count(solid_shown, solid_hid, 90)}
    check("Solid: showing the LV switches the heart to Glass so the LV is visible (segmented control agrees)",
          mode_after == "glass" and "glass:true" in seg and "solid:false" in seg and diff_count(solid_shown, solid_hid, 90) > 800, f"{mode_after} {seg} {diff_count(solid_shown, solid_hid, 90)}")
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===false")
    # the user then picks Solid while the LV is shown
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===true")
    P.ev("document.querySelector('.seg button[data-m=solid]').click()")
    time.sleep(0.8)
    solid_with = view_img(P)
    P.ev("V.setMode('solid')")
    visible = diff_count(solid_with, solid_hid, 90)
    NUM["solid_selected_while_lv_shown_changed_px"] = visible
    print(f"    Solid selected while the LV is shown: {visible} px differ from the plain solid heart")
    check("Solid chosen by hand while the LV is shown: the opaque wall hides the LV (by design; only a sliver of the dilated apex pokes out)", visible < 0.1 * a_ed, f"{visible} px vs {a_ed} in Glass")
    P.ev("document.querySelector('.seg button[data-m=ghost]').click()")
    time.sleep(0.8)
    ghost_with = view_img(P)
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===false")
    time.sleep(0.8)
    ghost_hid = view_img(P)
    check("Vessels-only: the LV is visible there too", diff_count(ghost_with, ghost_hid, 90) > 800, str(diff_count(ghost_with, ghost_hid, 90)))
    P.clean("pixel session")
    P.close()


def s_theme(b, scheme):
    """cine panel + 3D view with the patient LV in one theme: screenshots 14_*, contrast audit."""
    print(f"screenshots + contrast ({scheme})")
    P = Page(b, scheme=scheme, reduced=True).ready()
    load_sample(P)
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===true")
    P.ev("cnSetPhase(CV.es)")
    P.ev("V.reset()")
    time.sleep(1.0)
    check(f"{scheme}: the data-theme / colour scheme in force is {scheme}", P.ev("matchMedia('(prefers-color-scheme: dark)').matches") == (scheme == "dark"))
    lvtok = P.ev("getComputedStyle(document.documentElement).getPropertyValue('--lv').trim()")
    NUM[f"lv_token_{scheme}"] = lvtok
    P.pg.locator("#cine").scroll_into_view_if_needed()
    time.sleep(0.5)
    P.shot(f"14_cine_panel_{scheme}", "#cine")
    P.shot(f"14_lv_in_3d_{scheme}", "#v")
    con = P.ev(CONTRAST_JS, CONTRAST_TEXT + CONTRAST_UI)
    NUM[f"contrast_{scheme}"] = {f"{s} {p}": v for s, p, v in con}
    low_t = [(s, p, v) for s, p, v in con[:len(CONTRAST_TEXT)] if v is not None and v < 4.5]
    low_u = [(s, p, v) for s, p, v in con[len(CONTRAST_TEXT):] if v is not None and v < 3]
    missing = [s for s, p, v in con if v is None]
    print(f"    contrast ({scheme}): text min {min(v for s, p, v in con[:len(CONTRAST_TEXT)] if v is not None):.2f}, graphics min {min(v for s, p, v in con[len(CONTRAST_TEXT):] if v is not None):.2f}; missing {missing}")
    check(f"{scheme}: all text in the panel and LV card reaches 4.5:1 contrast", not low_t, str(low_t))
    check(f"{scheme}: chart line, markers, gauge bar and selected chip reach 3:1 against the card", not low_u, str(low_u))
    a = P.ev(AUDIT_JS)
    NUM[f"audit_{scheme}"] = a
    check(f"{scheme}: no horizontal page scroll and nothing in the panel / 3D view outside the card or clipped", a["scrollWidth"] <= a["clientWidth"] and not a["issues"], str(a)[:300])
    if scheme == "dark":
        P.pg.screenshot(path=str(SHOTS / "14_page_overview_dark.png"), full_page=True)
    P.clean(f"{scheme} session")
    P.close()


def s_phone(b):
    print("phone 390 px")
    P = Page(b, w=390, h=844, scheme="dark", dpr=2).ready()
    a0 = P.ev(AUDIT_JS)
    check("phone: no horizontal scroll before loading the sample", a0["scrollWidth"] <= a0["clientWidth"], str(a0["scrollWidth"]))
    load_sample(P)
    P.ev("cnSetPhase(CV.es)")
    time.sleep(0.5)
    a1 = P.ev(AUDIT_JS)
    NUM["audit_phone"] = a1
    print(f"    chart font px (rendered): {a1['chart_font_px']}  scrollWidth {a1['scrollWidth']}/{a1['clientWidth']}  issues {a1['issues'][:4]}")
    check("phone: no horizontal scroll with the sample loaded and nothing outside the viewport or clipped", a1["scrollWidth"] <= a1["clientWidth"] and not a1["issues"], str(a1)[:400])
    check("phone: chart text is readable (smallest rendered font >= 9 px)", a1["chart_font_px"] and min(a1["chart_font_px"]) >= 9, str(a1["chart_font_px"]))
    cw = P.ev("[cnSvg.w,$('#cvc').clientWidth,$('#cvc svg').getBoundingClientRect().width]")
    check("phone: the chart is laid out at its real width (viewBox = container width, so text keeps its size)", abs(cw[0] - cw[1]) <= 1 and abs(cw[2] - cw[1]) <= 1, str(cw))
    P.shot("14_phone_390_cine", "#cine")
    P.pg.click("#clv")
    P.pg.wait_for_function("V.lvState().shown===true")
    P.ev("cnStopKeepLv();cnSetPhase(CV.es)")
    time.sleep(1.0)
    P.shot("14_phone_390_3d_lv", "#v")
    card = P.ev("(()=>{const c=$('#lvc').getBoundingClientRect(),v=$('#v').getBoundingClientRect();return{card_h:Math.round(c.height),view_h:Math.round(v.height),text:$('#lvc').innerText}})()")
    NUM["phone_lv_card"] = card
    check("phone: the LV card is short (under 20 % of the 3D view) and still says 'not an anatomical registration'",
          card["card_h"] < 0.2 * card["view_h"] and "not an anatomical registration" in card["text"].lower(), str(card))
    a2 = P.ev(AUDIT_JS)
    check("phone: no horizontal scroll with the LV shown", a2["scrollWidth"] <= a2["clientWidth"], str(a2["scrollWidth"]))
    P.pg.set_viewport_size({"width": 700, "height": 1000})
    time.sleep(0.8)
    cw2 = P.ev("[cnSvg.w,$('#cvc').clientWidth]")
    check("700 px wide (single column): the chart re-lays itself out when the container grows", abs(cw2[0] - cw2[1]) <= 6 and cw2[0] > cw[0] + 100, f"{cw} -> {cw2}")
    P.pg.set_viewport_size({"width": 390, "height": 844})
    time.sleep(0.8)
    check("back to 390 px: the chart shrinks again", abs(P.ev("cnSvg.w") - P.ev("$('#cvc').clientWidth")) <= 6)
    P.pg.locator("#cvc svg").scroll_into_view_if_needed()
    box = P.pg.locator("#cvc svg").bounding_box()
    P.pg.mouse.move(box["x"] + box["width"] - 4, box["y"] + box["height"] * 0.4)
    time.sleep(0.2)
    tipbox = P.ev("(()=>{const t=$('#cvt');const r=t.getBoundingClientRect();return{hidden:t.hidden,right:r.right,left:r.left,vw:document.documentElement.clientWidth,sw:document.documentElement.scrollWidth}})()")
    NUM["phone_tooltip_at_right_edge"] = tipbox
    check("phone: the chart tooltip at the right edge stays inside the screen (no horizontal scroll)", tipbox["sw"] <= tipbox["vw"] and (tipbox["hidden"] or tipbox["right"] <= tipbox["vw"] + 1), str(tipbox))
    P.clean("phone session")
    P.close()


def s_nowebgl(b):
    print("no WebGL")
    P = Page(b, no_webgl=True).ready(webgl=False)
    load_sample(P)
    s = state(P)
    check("without WebGL the MRI panel still measures (EF 41, EDV 122)", abs(s["ef"] - REF["ef"]) < 1e-6 and abs(s["edv"] - REF["edv"]) < 1e-6)
    P.pg.click("#clv")
    time.sleep(0.4)
    check("without WebGL the LV button does nothing harmful (LV not shown, label unchanged)", P.ev("CLVON") is False and P.ev("$('#clv').textContent") == "Show my LV in 3D")
    r = P.tool("show_lv_3d", {"on": True})
    check("without WebGL show_lv_3d says the 3D view is not available", r.get("isError") and "not available" in r["content"][0]["text"], r["content"][0]["text"][:100])
    h = P.tool("describe_heart_model")["structuredContent"]["patient_lv"]
    check("without WebGL describe_heart_model still reports the loaded LV (numbers)", h["loaded"] is True and h["shown"] is False and h["edv_ml"] == round(s["edv"], 1), str(h))
    check("status chip says 13 tools without WebGL", "13 tools" in P.ev("$('#wm').textContent"))
    P.clean("no-WebGL session", allow=("WebGL", "webgl", "Cannot read", "getContext", "3D view"))
    P.close()


def main():
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        try:
            s_nocine(b)
            s_main(b)
            s_pixels(b)
            s_theme(b, "dark")
            s_theme(b, "light")
            s_phone(b)
            s_nowebgl(b)
        finally:
            b.close()
    fails = [r for r in RESULTS if not r["ok"]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"page": PAGE.split("/")[-1], "checks": len(RESULTS), "failed": len(fails), "seconds": round(time.time() - t0, 1), "numbers": NUM,
                               "results": RESULTS}, indent=1, default=str))
    print(f"\nsmoke_mri: {len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed in {time.time() - t0:.0f} s -> {OUT.name}")
    for f in fails:
        print("  FAILED:", f["name"], "|", f["detail"][:200])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
