#!/usr/bin/env python3
"""Build docs/CardioLens_documentation.pdf (A4, <= 6 pages) with reportlab.

    python docs/make_pdf.py

Every number in the PDF is read from a file in results/ (RESULTS.md, metrics.json, perf.json, test_summary.json,
cine_reference.json, anatomy_report.json, feature_audit.csv, smoke_mri.json) when the script runs; nothing is typed in by
hand. Figures and screenshots are the PNGs in results/figures and results/screens (some are cropped, never redrawn).
The architecture diagram is docs/architecture.png (python docs/make_diagram.py). Fonts: DejaVu Sans (embedded, taken from
matplotlib's bundled copy, so no system font is needed). Each page is laid out inside a KeepInFrame(mode="error"), so
content that does not fit a page stops the build instead of spilling onto a 7th page.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
from pathlib import Path

import matplotlib
from PIL import Image as PILImage
from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Flowable, Frame, Image, KeepInFrame, KeepTogether, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "results"
OUT = ROOT / "docs" / "CardioLens_documentation.pdf"
MAX_PAGES = 6

# ------------------------------------------------------------------------------------------------ fonts
_ttf = Path(matplotlib.get_data_path()) / "fonts" / "ttf"
for name, fn in (("DV", "DejaVuSans.ttf"), ("DV-B", "DejaVuSans-Bold.ttf"), ("DV-I", "DejaVuSans-Oblique.ttf"),
                 ("DV-BI", "DejaVuSans-BoldOblique.ttf"), ("DVM", "DejaVuSansMono.ttf")):
    pdfmetrics.registerFont(TTFont(name, str(_ttf / fn)))
pdfmetrics.registerFontFamily("DV", normal="DV", bold="DV-B", italic="DV-I", boldItalic="DV-BI")

# ------------------------------------------------------------------------------------------------ palette (same as docs/make_diagram.py)
INK, MUTED, LINE, GREY = "#0d1624", "#46546a", "#b3c1d5", "#eef2f8"
TEAL, BLUE, AMBER = "#0b7a5e", "#1b63b8", "#8f6200"
TEAL_BG, BLUE_BG, AMBER_BG = "#e3f4ee", "#e6effb", "#fdf1d6"
R0, R1, R2 = "#119b78", "#d99a10", "#c52a38"  # risk ramp tokens --r0/--r1/--r2 (light theme) from web/app.template.html
C = colors.HexColor

# ------------------------------------------------------------------------------------------------ data from results/
RESULTS_MD = (RES / "RESULTS.md").read_text(encoding="utf-8")
M = json.loads((RES / "metrics.json").read_text())
PERF = json.loads((RES / "perf.json").read_text())
TS = json.loads((RES / "test_summary.json").read_text())
CINE = json.loads((RES / "cine_reference.json").read_text())
ANAT = json.loads((RES / "anatomy_report.json").read_text())
SMOKE = json.loads((RES / "smoke_mri.json").read_text())
AUDIT = list(csv.DictReader((RES / "feature_audit.csv").open(encoding="utf-8")))
assert 'SwiftShader' in PERF['gpu']
TG = ["CAD", "LAD", "LCX", "RCA"]
FULL = {"CAD": "Coronary artery disease", "LAD": "Left anterior descending", "LCX": "Left circumflex", "RCA": "Right coronary artery"}


def md_sections() -> dict[str, list[list[str]]]:
    """RESULTS.md -> {section number: rows of its (first) table, header included}."""
    out, key, rows = {}, None, []
    for line in RESULTS_MD.splitlines() + ["## END"]:
        if line.startswith("## "):
            if key and rows:
                out[key] = rows
            key, rows = line[3:].split(" ")[0].rstrip("."), []
        elif line.startswith("|") and key and key not in out:
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if not set("".join(cells)) <= set("-: "):
                rows.append(cells)
    return out


SEC = md_sections()
T1, T2, T3, T3B, T4 = SEC["1"], SEC["2"], SEC["3"], SEC["3b"], SEC["4"]
PREV = dict(re.findall(r"(CAD|LAD|LCX|RCA) ([\d.]+)%", RESULTS_MD.split("Prevalence:")[1].split("Accuracy for a majority")[0]))
MAJ = dict(re.findall(r"(CAD|LAD|LCX|RCA) ([\d.]+)%", RESULTS_MD.split("majority-class predictor")[1].split("\n")[0]))
assert all(abs(float(PREV[t]) - M[t]["prevalence"] * 100) < 0.05 for t in ["CAD", "LAD", "LCX", "RCA"]), PREV
Y_TRAIN = {t: (M[t]["n_positive"], PREV[t]) for t in TG}


def f3(x):  # same rounding RESULTS.md uses
    return f"{x:.3f}"


# consistency checks between RESULTS.md and metrics.json (the PDF must not drift from either)
for row in T1[1:]:
    t = row[0]
    lo, hi = M[t]["roc_auc_ci95_bootstrap"]
    assert row[7] == f"{f3(M[t]['headline_pooled_oof']['roc_auc'][0])} ({f3(lo)}-{f3(hi)})", (row[7], t)
    assert row[1] == M[t]["model"]
AUC = {t: f3(M[t]["headline_pooled_oof"]["roc_auc"][0]) for t in TG}
CI = {t: f"{f3(M[t]['roc_auc_ci95_bootstrap'][0])}–{f3(M[t]['roc_auc_ci95_bootstrap'][1])}" for t in TG}
SUITE = {s["suite"]: s for s in TS["suites"]}
N_RAW = len(set(r["source_column"] for r in AUDIT))
KEPT = [r for r in AUDIT if r["kept"] == "True"]
DROPPED = [r for r in AUDIT if r["kept"] == "False" and r["group"] != "target"]
GROUPS = ["Demographics", "Risk factors", "Examination", "Symptoms", "ECG", "Laboratory", "Echo"]
N_INPUTS = len(KEPT)
assert N_INPUTS == 43 and N_RAW == 59 and len(DROPPED) == 12
N_LOG = sum("log1p" in r["reason"] for r in KEPT)
LOG_LABS = [r["source_column"] for r in KEPT if "log1p" in r["reason"]]
N_PATIENTS = 303  # RESULTS.md header line: "n = 303"
assert "n = 303" in RESULTS_MD
N_TRI = sum(g["tris"] for g in ANAT["groups"].values())
N_GROUPS = len(ANAT["groups"])
N_PARTS = sum(g["parts"] for g in ANAT["groups"].values())
MM_UNIT = ANAT["mm_per_unit"]
assert N_TRI == PERF["runs"][0]["triangles"]
CAP = {r[0]: r for r in T4[1:]}
SEL = {r[0]: r for r in T3B[1:]}
CAL = {r[0]: r for r in T3[1:]}
COH = M["coherence"]
SP = CINE["spread"]
tools_n = 13  # number of WebMCP tools: browser check "13 WebMCP tools registered" in results/browser_tests.json
BT = json.loads((RES / "browser_tests.json").read_text())
assert any(c["check"] == "13 WebMCP tools registered" and c["pass"] for c in BT)
assert TS["total_passed"] == TS["total_checks"] == sum(s["passed"] for s in TS["suites"]) and TS["all_passed"]
assert SUITE["browser"]["passed"] == len(BT) == sum(c["pass"] for c in BT)

# ------------------------------------------------------------------------------------------------ styles
CONTENT_W = A4[0] - 2 * 14 * mm
ST = {
    "body": ParagraphStyle("body", fontName="DV", fontSize=8.0, leading=11.2, textColor=C(INK), alignment=TA_LEFT, spaceAfter=3.5),
    "small": ParagraphStyle("small", fontName="DV", fontSize=7.0, leading=9.4, textColor=C(MUTED), spaceAfter=2),
    "cap": ParagraphStyle("cap", fontName="DV", fontSize=6.8, leading=9.0, textColor=C(MUTED), spaceBefore=2, spaceAfter=4),
    "h1": ParagraphStyle("h1", fontName="DV-B", fontSize=15, leading=18, textColor=C(INK), spaceAfter=1),
    "kick": ParagraphStyle("kick", fontName="DV-B", fontSize=7.0, leading=9, textColor=C(TEAL), spaceAfter=1),
    "h2": ParagraphStyle("h2", fontName="DV-B", fontSize=9.2, leading=12, textColor=C(BLUE), spaceBefore=6, spaceAfter=2.5),
    "bul": ParagraphStyle("bul", fontName="DV", bulletFontName="DV-B", bulletFontSize=8.0, fontSize=8.0, leading=10.8, textColor=C(INK), leftIndent=9, bulletIndent=0, spaceAfter=2),
    "cell": ParagraphStyle("cell", fontName="DV", fontSize=7.0, leading=8.9, textColor=C(INK)),
    "cellb": ParagraphStyle("cellb", fontName="DV-B", fontSize=7.0, leading=8.9, textColor=C(INK)),
    "cells": ParagraphStyle("cells", fontName="DV", fontSize=6.5, leading=8.0, textColor=C(INK)),
    "cellh": ParagraphStyle("cellh", fontName="DV-B", fontSize=6.9, leading=8.6, textColor=C(INK)),
    "mono": ParagraphStyle("mono", fontName="DVM", fontSize=7.0, leading=9.4, textColor=C(INK)),
    "tile": ParagraphStyle("tile", fontName="DV-B", fontSize=17, leading=20, textColor=C(TEAL), alignment=1),
    "tilel": ParagraphStyle("tilel", fontName="DV", fontSize=6.8, leading=8.8, textColor=C(MUTED), alignment=1),
    "title": ParagraphStyle("title", fontName="DV-B", fontSize=26, leading=30, textColor=C(INK)),
    "sub": ParagraphStyle("sub", fontName="DV", fontSize=11, leading=14, textColor=C(MUTED), spaceAfter=4),
}


def P(t, s="body"):
    return Paragraph(t, ST[s])


def bullets(items, style="bul"):
    return [Paragraph(t, ST[style], bulletText="•") for t in items]


def H(num, title, kick):
    return [P(kick.upper(), "kick"), P(f"{num} · {title}" if num else title, "h1"), Spacer(1, 3)]


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def tbl(data, widths, head=1, zebra=True, extra=None, pad=2.2, align_right_from=None):
    rows = []
    for i, r in enumerate(data):
        rows.append([c if not isinstance(c, str) else Paragraph(c, ST["cellh"] if i < head else ST["cell"]) for c in r])
    t = Table(rows, colWidths=widths, repeatRows=head)
    st = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
          ("LEFTPADDING", (0, 0), (-1, -1), 3.5), ("RIGHTPADDING", (0, 0), (-1, -1), 3.5),
          ("BACKGROUND", (0, 0), (-1, head - 1), C(GREY)), ("LINEBELOW", (0, head - 1), (-1, head - 1), 0.8, C(MUTED)),
          ("LINEBELOW", (0, head), (-1, -1), 0.3, C(LINE)), ("LINEBELOW", (0, -1), (-1, -1), 0.8, C(LINE))]
    if extra:
        st += extra
    t.setStyle(TableStyle(st))
    return t


def box(flow, bg, border, width=CONTENT_W, pad=6, lw=1.0, left_bar=True):
    t = Table([[flow]], colWidths=[width])
    st = [("BACKGROUND", (0, 0), (-1, -1), C(bg)), ("BOX", (0, 0), (-1, -1), lw, C(border)),
          ("LEFTPADDING", (0, 0), (-1, -1), pad + 2), ("RIGHTPADDING", (0, 0), (-1, -1), pad),
          ("TOPPADDING", (0, 0), (-1, -1), pad - 1), ("BOTTOMPADDING", (0, 0), (-1, -1), pad - 1)]
    if left_bar:
        st.append(("LINEBEFORE", (0, 0), (0, -1), 4, C(border)))
    t.setStyle(TableStyle(st))
    return t


# ------------------------------------------------------------------------------------------------ images
def img_path(p):
    return str(ROOT / p)


def crop_png(path, box_=None, scale_to=None) -> io.BytesIO:
    im = PILImage.open(ROOT / path).convert("RGB")
    if box_:
        im = im.crop(box_)
    if scale_to and im.width > scale_to:
        im = im.resize((scale_to, round(im.height * scale_to / im.width)), PILImage.LANCZOS)
    b = io.BytesIO()
    im.save(b, "PNG", optimize=True)
    b.seek(0)
    b.size = im.size  # type: ignore[attr-defined]
    return b


def pic(src, width, box_=None, scale_to=1500):
    """Image flowable of the given width (pt). src: path relative to ROOT; box_: optional crop in source pixels."""
    b = crop_png(src, box_, scale_to)
    w, h = b.size
    return Image(b, width=width, height=width * h / w)


def fig(src, width, caption, box_=None):
    i = pic(src, width, box_)
    t = Table([[i], [P(caption, "cap")]], colWidths=[width])
    t.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                           ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    t.hAlign = "LEFT"
    return t


# ------------------------------------------------------------------------------------------------ mini diagrams
def flow_drawing(items, width, height=44, colors_=None, gap=14, title_fs=7.0, sub_fs=6.2):
    """Row of boxes joined by arrows. items: (title, sub, kind) with kind in {'', 'teal', 'blue', 'amber'}."""
    d = Drawing(width, height)
    n = len(items)
    bw = (width - gap * (n - 1)) / n
    pal = {"": ("#ffffff", LINE, INK), "teal": (TEAL_BG, TEAL, INK), "blue": (BLUE_BG, BLUE, INK), "amber": (AMBER_BG, AMBER, INK)}
    for i, (t, sub, kind) in enumerate(items):
        x = i * (bw + gap)
        fc, ec, tc = pal[kind]
        d.add(Rect(x, 0, bw, height, rx=4, ry=4, fillColor=C(fc), strokeColor=C(ec), strokeWidth=1.2 if kind else 0.9))
        d.add(String(x + bw / 2, height - 13, t, fontName="DV-B", fontSize=title_fs, fillColor=C(tc), textAnchor="middle"))
        for j, line in enumerate(sub.split("\n")):
            d.add(String(x + bw / 2, height - 24 - j * (sub_fs + 2.2), line, fontName="DV", fontSize=sub_fs, fillColor=C(MUTED), textAnchor="middle"))
        if i < n - 1:
            ax, ay = x + bw + 2, height / 2
            d.add(Line(ax, ay, ax + gap - 6, ay, strokeColor=C(MUTED), strokeWidth=1))
            d.add(Polygon([ax + gap - 3, ay, ax + gap - 7.5, ay + 2.4, ax + gap - 7.5, ay - 2.4], fillColor=C(MUTED), strokeColor=C(MUTED), strokeWidth=0.3))
    return d


RAMP = [(0, R0), (.312, None), (.348, R1), (.62, None), (.74, None), (1, R2)]


def _mix(a, b, t):
    a, b = C(a), C(b)
    return colors.Color(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t)


def risk_colour(p):  # same stops as buildRamp() in web/js/core.js
    stops = [(0, C(R0)), (.312, _mix(R0, R1, .12)), (.348, C(R1)), (.62, _mix(R1, R2, .5)), (.74, _mix(R1, R2, .85)), (1, C(R2))]
    for (p0, a), (p1, b) in zip(stops, stops[1:]):
        if p <= p1:
            t = (p - p0) / (p1 - p0)
            return colors.Color(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t)
    return C(R2)


def ramp_drawing(width, height=44):
    d = Drawing(width, height)
    x0, w, y0, hb = 6, width - 12, 14, 12
    n = 160
    for i in range(n):
        d.add(Rect(x0 + w * i / n, y0, w / n + 0.6, hb, fillColor=risk_colour((i + .5) / n), strokeColor=None))
    d.add(Rect(x0, y0, w, hb, fillColor=None, strokeColor=C(MUTED), strokeWidth=0.6))
    for p, lab in ((0, "0 %"), (.33, "33 %"), (.66, "66 %"), (1, "100 %")):
        x = x0 + w * p
        d.add(Line(x, y0 - 2, x, y0 + hb + 2, strokeColor=C(INK), strokeWidth=0.8))
        d.add(String(x, y0 - 10, lab, fontName="DV", fontSize=6.6, fillColor=C(MUTED), textAnchor="middle" if 0 < p < 1 else ("start" if p == 0 else "end")))
    for p, lab in ((.165, "● Low  < 33 %"), (.495, "◆ Intermediate"), (.83, "▲ High  ≥ 66 %")):
        d.add(String(x0 + w * p, y0 + hb + 5, lab, fontName="DV-B", fontSize=7.0, fillColor=C(INK), textAnchor="middle"))
    return d


# ------------------------------------------------------------------------------------------------ pages
FW = CONTENT_W


def page1():
    s = []
    s.append(P("MULTIMODAL AI HACKATHON 2026 · TRACK A · PROJECT DOCUMENTATION", "kick"))
    s.append(P("CardioLens 3D", "title"))
    s.append(P("Coronary-artery risk prediction on an interactive 3D heart", "sub"))
    s.append(Spacer(1, 3))
    s.append(box(P(
        "<b>Clinical-safety notice.</b> CardioLens is <b>educational decision support only</b>. It is not a substitute for formal "
        "diagnostic imaging or clinical judgement and must not be used to diagnose or to decide treatment. It is a research prototype "
        f"trained on {N_PATIENTS} patients from one referral centre and has <b>no external validation</b>. The 3D heart is a generic adult "
        "atlas, not the patient’s own anatomy. The same notice is a permanent banner at the top of the application.", "body"),
        AMBER_BG, AMBER, lw=1.2))
    s.append(Spacer(1, 6))
    s.append(P(
        "<b>Summary.</b> CardioLens 3D predicts overall coronary artery disease (CAD) and significant stenosis (at least 50 % narrowing) "
        f"of the three main coronary arteries (LAD, LCX, RCA) from {N_INPUTS} clinical inputs, and shows the result on an interactive 3D heart "
        "whose three coronary arteries are coloured by the predicted probability. Training uses the Extension of the Z-Alizadeh Sani "
        f"data set (UCI #411, n = {N_PATIENTS}) with a leakage guard and 5×5 nested cross-validation across seven model families. The exported models are four "
        "logistic regressions, so the explanation is exact SHAP and the whole predictor runs inside one self-contained web page: "
        "predictions, explanations and the 3D view update live, with no server and no dedicated GPU. A scan reading room reads a CT (NIfTI or DICOM) "
        "and a cardiac cine MRI in the browser tab; the MRI yields left-ventricle volumes and ejection fraction and a beating patient "
        f"ventricle inside the 3D heart. An optional agent layer (WebMCP, {tools_n} tools) lets an AI assistant operate the page but never "
        "receive the scan; the only way out is an export that a human must approve."))
    s.append(Spacer(1, 4))
    s.append(fig("docs/architecture.png", FW,
                 "Figure 1 · System architecture. The model is trained once in Python and exported; everything the user sees runs in the browser tab. "
                 "The optional FastAPI backend repeats the same maths and lets the page show a parity badge. Agents reach the page only through "
                 "the WebMCP guard."))
    tiles = []
    for t in TG:
        tiles.append([P(AUC[t], "tile"), P(f"{t} · ROC-AUC<br/>95 % CI {CI[t]}", "tilel")])
    tiles.append([P(f"{TS['total_passed']}/{TS['total_checks']}", "tile"), P("automated checks pass<br/>7 suites", "tilel")])
    tt = Table([[x[0] for x in tiles], [x[1] for x in tiles]], colWidths=[FW / 5] * 5)
    tt.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), C(GREY)), ("LINEAFTER", (0, 0), (-3, -1), 0.6, colors.white),
                            ("TOPPADDING", (0, 0), (-1, 0), 6), ("BOTTOMPADDING", (0, 1), (-1, 1), 6),
                            ("TOPPADDING", (0, 1), (-1, 1), 0), ("BOTTOMPADDING", (0, 0), (-1, 0), 1), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    s.append(tt)
    s.append(P("Pooled out-of-fold ROC-AUC of the exported models (5×5 nested CV, bootstrap 95 % CI). Details and limits on pages 3 and 6.", "cap"))
    s.append(Spacer(1, 6))
    s.append(P("Data and credits", "h2"))
    s.append(P("Clinical model: Extension of the Z-Alizadeh Sani data set (UCI #411, 303 patients). 3D anatomy: BodyParts3D, © Life Science Integrated Database Center, "
               "licensed CC BY-SA 2.1 Japan, via the Interactive-3D-Human-Heart-Visualization repository. Rendering: three.js r128 (MIT). Agent plumbing: WebMCP core (MIT). "
               "Cardiac-MRI sample: Sunnybrook Cardiac Data (public domain, CC0 1.0; Radau et al., Evaluation Framework for Algorithms Segmenting Short Axis Cardiac MRI, "
               "The MIDAS Journal, 2009; hdl:10380/3070).", "small"))
    return s


def page2():
    s = H("1", "Data and preprocessing", "Dataset · cleaning · leakage guard · supplied extras")
    s.append(P(
        f"<b>Primary data.</b> Extension of the Z-Alizadeh Sani data set (UCI Machine Learning Repository #411): {N_PATIENTS} patients "
        f"referred for angiography, {N_RAW} raw columns, no missing values. Targets are CAD (angiographic “Cath” label) and stenosis of "
        "≥ 50 % in the LAD, LCX and RCA. The positive rate of every target is below:"))
    rows = [["Target", "Positive patients", "Prevalence", "Accuracy of always predicting the larger class"]]
    for t in TG:
        rows.append([f"<b>{t}</b> · {FULL[t]}", f"{Y_TRAIN[t][0]} of {N_PATIENTS}", f"{PREV[t]} %", f"{MAJ[t]} %"])
    s.append(tbl(rows, [150, 90, 80, FW - 320]))
    s.append(P("Prevalence and baseline accuracy: results/RESULTS.md and results/metrics.json. Any model must beat the last column to be useful.", "cap"))

    s.append(P("Cleaning steps", "h2"))
    s += bullets([
        f"<b>Leakage guard.</b> The four outcome columns <b>Cath, LAD, LCX and RCA are never inputs</b> for any target. The feature schema is checked "
        "when the code is imported (it stops if an outcome column appears in the input keys), the application rejects unknown or outcome keys, and all "
        "pre-processing is fitted inside the cross-validation folds. In the data, Cath = CAD coincides with “at least one stenotic vessel” for "
        f"{float(COH['label_check_cad_equals_any_vessel']) * 100:.1f} % of patients, so a leaked vessel label would give a CAD model an almost perfect, meaningless score.",
        f"<b>Columns removed ({len(DROPPED)}).</b> Weight and Length (BMI is an exact function of them), Obesity (equals BMI > 25 in 99.7 % of rows), "
        "Exertional CP (constant), and eight findings with fewer than 10 positive rows that cannot be learned reliably: "
        + ", ".join(r["source_column"] for r in DROPPED[4:]) + ".",
        f"<b>Encoding.</b> Yes/No findings are 0/1 (male sex = 1); valvular heart disease N / mild / moderate / severe = 0–3; any bundle-branch block = 1; "
        "functional class and wall-motion abnormality keep their ordinal 0–3 and 0–4 scales.",
        f"<b>Transform.</b> {N_LOG} skewed laboratory values ({', '.join(LOG_LABS)}) get log(1 + x). It has no fitted parameter, so it cannot leak between "
        "folds. Standardisation (mean 0, standard deviation 1) is the first step of each model pipeline, fitted on training folds only.",
    ])
    s.append(P(f"The {N_INPUTS} model inputs", "h2"))
    drows = [["Clinical domain", "Inputs", "Source columns († = log-transformed)"]]
    for g in GROUPS:
        cols = [r["source_column"] + ("†" if "log1p" in r["reason"] else "") for r in KEPT if r["group"] == g]
        drows.append([f"<b>{g}</b>", str(len(cols)), ", ".join(cols)])
    drows.append(["<b>Total</b>", f"<b>{sum(int(r[1]) for r in drows[1:])}</b>", f"{N_INPUTS} inputs + 4 outcome columns + {len(DROPPED)} removed = {N_RAW} raw columns"])
    s.append(tbl(drows, [82, 34, FW - 116]))

    s.append(P("The three supplied extra data sets", "h2"))
    ex = [["Data set", "What it is", "How it was used"],
          ["<b>Cardiac cine MRI</b><br/>(Sunnybrook Cardiac Data, CC0)",
           "Short-axis cine DICOM of a 27-year-old man with non-ischaemic heart failure. The built-in sample is one subject: "
           f"{len(CINE['area_mm2'])} slices × {len(CINE['V'])} cardiac phases, {CINE['px_mm']:.3f} mm pixels, {CINE['dz_mm']:.1f} mm slice spacing.",
           "<b>Used by the left-ventricle (LV) module</b>, not by the risk model’s training: LV volumes, ejection fraction and the beating patient LV "
           "in the 3D heart (page 4). The reader is checked against a Python reference (results/cine_reference.json). Its age is outside the model’s "
           "training ages, so the coronary-risk numbers do not apply to him."],
          ["<b>CT archive</b>",
           "One DICOM slice with true Hounsfield units plus 50 windowed 8-bit PNG images (HANDOFF.md §4).",
           "<b>Not usable for calcium scoring</b>: scoring needs a calibrated HU volume and the PNGs have lost the HU scale. The CT reading room is "
           "built and tested on a synthetic phantom, synthetic DICOM and NIfTI, and a 16-slice real CT excerpt; it has not been validated on a real chest CT series."],
          ["<b>Echocardiogram CSV</b>",
           "UCI echocardiogram table: a different cohort (survival after myocardial infarction, other variables, no coronary labels).",
           "<b>Context only.</b> Not merged with, or used to train, the stenosis models; no analysis of it is implemented."]]
    s.append(tbl(ex, [92, 190, FW - 282], pad=3))
    s.append(P("The CT and echo descriptions come from the project hand-off notes: those archives are not part of the repository, so they were not re-opened for this document.", "cap"))
    return s


def page3():
    s = H("2", "Model architecture and training", "Seven families · nested CV · exported logistic regressions · exact SHAP")
    s.append(P(
        "<b>Task.</b> Four independent binary classifiers: CAD, LAD, LCX, RCA. <b>Model families (7):</b> logistic regression with L2 penalty, logistic regression "
        "with L1 penalty, RBF-kernel SVM, Extra-Trees, Random Forest, histogram gradient boosting, and a prior-only baseline. "
        "<b>Protocol:</b> 5×5 repeated stratified cross-validation (5 repeats × 5 outer folds = 25 outer folds, identical splits for every model); hyper-parameters are "
        "tuned in a 3-fold inner loop that minimises log-loss; all pre-processing sits inside the folds. Out-of-fold predictions are pooled for the headline "
        "metrics (threshold 0.5) and bootstrapped for the AUC confidence interval."))
    s.append(Spacer(1, 2))
    s.append(flow_drawing([
        (f"{N_INPUTS} inputs", "clean · log(1+x)\non 5 labs", ""),
        ("Standardise", "fit on training\nfold only", ""),
        ("Logistic regression", "L2 (CAD, LAD, LCX)\nL1 (RCA) · C by inner CV", "teal"),
        ("Log-odds z → P", "P = 1 / (1 + e^−z)", ""),
        ("Cap at P(CAD)", "P(vessel) ≤ P(CAD)\nflag when active", "blue"),
    ], FW, height=46, gap=13))
    s.append(P("Figure 2 · The exported predictor for one target. The page contains the standardisation constants, weights and intercept of the four models.", "cap"))

    s.append(P("Exported models and the check that linear is enough", "h2"))
    rows = [["Target", "Exported model", "C", "Non-zero weights", "Best other model (by log-loss)", "ΔAUC", "ΔLog-loss", "Folds where other is better"]]
    for t in TG:
        r = SEL[t]
        rows.append([f"<b>{t}</b>", M[t]["model"], f"{M[t]['best_C']:g}", f"{M[t]['n_nonzero_coef']} of {N_INPUTS}", r[2], r[3], r[4], r[5]])
    s.append(tbl(rows, [38, 58, 26, 48, 86, 84, 84, FW - 424]))
    s.append(P(
        "ΔAUC and Δlog-loss are other − exported (paired, 25 folds, from results/RESULTS.md §3b). The differences are small next to fold-to-fold variability, and "
        "folds from repeated CV are correlated, so no p-values are claimed.", "cap"))

    s.append(P("Why the exported models are linear", "h2"))
    s += bullets([
        "<b>Exact explanation.</b> For a logistic regression, interventional SHAP has a closed form in log-odds units (below, t is the log transform where one applies). "
        "The contributions plus the base value add up exactly to the model’s log-odds; the export step asserts that this closed form equals the shap library’s "
        "LinearExplainer. The dashboard shows these values directly.",
        f"<b>Runs in the page.</b> A slim copy of the weights is embedded in the HTML; the JavaScript engine is tested against scikit-learn on "
        f"{SUITE['parity']['passed']} cases ({SUITE['parity']['passed']}/{SUITE['parity']['total']} parity checks pass), so no server is needed.",
        "<b>No evidence that complexity pays off here.</b> With 303 patients, trees, boosting and the SVM were not reliably better than the linear models (table on page 6), "
        "so the model that can be explained exactly was kept for every target. For RCA the L1 penalty keeps "
        f"{M['RCA']['n_nonzero_coef']} of {N_INPUTS} inputs.",
    ])
    s.insert(len(s) - 2, Paragraph("φ<sub>j</sub> = w<sub>j</sub> · ( t(x<sub>j</sub>) − μ<sub>j</sub> ) / σ<sub>j</sub>"
                                   "&nbsp;&nbsp;&nbsp;<font size='6.8' color='%s'>(w = weight, μ and σ = training mean and standard deviation of input j)</font>" % MUTED,
                                   ParagraphStyle("fm", parent=ST["body"], fontSize=8.6, leading=16, alignment=1, spaceBefore=2, spaceAfter=3)))
    s.append(P("Coherent vessel and CAD outputs", "h2"))
    s.append(P(
        f"Independent models can predict a vessel as more likely than CAD itself, which is clinically inconsistent; this happens for "
        f"{COH['frac_vessel_prob_exceeds_cad_prob'] * 100:.0f} % of patients. The page therefore <b>caps each vessel probability at P(CAD)</b> "
        "and says when the cap is active. The cap slightly improves, not harms, the vessel metrics:"))
    crow = [["Vessel", "Share of patients capped", "AUC uncapped → capped", "Brier uncapped → capped"]]
    for v in ("LAD", "LCX", "RCA"):
        crow.append([f"<b>{v}</b>", CAP[v][1], CAP[v][2].replace("->", "→"), CAP[v][3].replace("->", "→")])
    s.append(tbl(crow, [50, 120, 160, FW - 330]))

    s.append(Spacer(1, 5))
    fw2 = (FW - 10) / 2
    left = [pic("results/figures/fig5_shap_CAD.png", fw2), P("Figure 3 · Global SHAP for CAD: each dot is a patient, position = effect on the log-odds, colour = feature value.", "cap")]
    right = [pic("results/figures/fig6_group_importance.png", fw2 * 0.98), P("Figure 4 · Mean absolute SHAP by clinical domain. A bar of zero for RCA (Examination, ECG, Echo) is the L1 penalty removing those inputs.", "cap")]
    t = Table([[left, right]], colWidths=[fw2 + 5, fw2 + 5])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 5)]))
    s.append(t)
    return s


def page4():
    s = H("3", "The 3D pipeline", "BodyParts3D → build → three.js · probability-to-colour · no-GPU rendering · patient LV · agent boundary")
    s.append(flow_drawing([
        ("BodyParts3D", f"{N_PARTS} heart meshes\nCC BY-SA 2.1 Japan", ""),
        ("tools/prep_anatomy.py", f"group · weld · decimate\nint16 quantise", "teal"),
        ("web/anatomy.b64", f"{N_GROUPS} named groups\n{N_TRI:,} triangles", ""),
        ("build.py", "inlines blob, model,\nlibraries", ""),
        ("one HTML + three.js", "no install,\nruns offline", "blue"),
    ], FW, height=46, gap=13, title_fs=6.4))
    s.append(P(f"Figure 5 · Anatomy pipeline. The heart is scaled to {MM_UNIT:.2f} mm per scene unit so MRI-derived volumes can be drawn at true size.", "cap"))
    s.append(P(
        f"<b>Anatomy.</b> {N_PARTS} BodyParts3D parts (Database Center for Life Science) are sorted by their FMA names into {N_GROUPS} named, peelable groups: "
        + ", ".join(ANAT["groups"].keys()) + ". LAD, LCX and RCA are separate groups, so <b>every coloured vessel belongs to exactly one model output</b> and the "
        "displayed probability is always the one the model produced. To add a structure, add a rule in prep_anatomy.py (or another OBJ) and re-run: the viewer and the layers "
        "panel iterate over whatever groups the blob holds."))
    s.append(P("Probability → colour", "h2"))
    lw = FW * 0.56
    left = [ramp_drawing(lw, 46)]
    right = P("The teal → amber → red ramp is reserved for probability and aligned with the risk bands, so colour agrees with the label. Colour is never the only signal: "
              "every vessel also carries its percentage, a band word and an icon (● ◆ ▲). Model inputs and SHAP values are <b>not</b> drawn as anatomical coordinates.", "small")
    t = Table([[left, right]], colWidths=[lw + 6, FW - lw - 6])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 2)]))
    s.append(t)
    s.append(Spacer(1, 3))
    w3 = (FW - 30) / 3
    shots = [
        ([pic("results/screens/02_fly_to_rca.png", w3, (0, 10, 870, 745)), P("RCA selected (click-to-fly): low band, teal.", "cap")]),
        ([pic("results/screens/06_age_plus_20.png", w3, (0, 10, 870, 745)), P("“Age +20 y”: the LAD moves into the amber band and gets a ◆ icon.", "cap")]),
        ([pic("results/screens/14_lv_in_3d_light.png", w3, None), P("“My LV”: the cine-MRI ventricle beating inside the atlas (light theme).", "cap")]),
    ]
    t = Table([shots], colWidths=[w3 + 10] * 3)
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]))
    s.append(t)
    s.append(P("Figures 6–8 · Interaction: rotate, zoom, pan; click a vessel or its row; Solid / Glass / Vessels; Layers; heartbeat at the entered pulse rate.", "cap"))

    colw = (FW - 14) / 2
    left = [P("Rendering without a dedicated GPU", "h2"),
            P("The renderer detects a software WebGL stack and switches to a cheaper mode: vertex-lit tissue, a time-based resolution governor "
              "(low resolution only while the view moves, a sharp still frame at rest) and <b>no rendering at all while idle</b>. Measured results are in the table on page 6. "
              "If WebGL or three.js is missing, the dashboard and the agent tools still work."),
            P("Patient left ventricle from cine MRI", "h2"),
            P("A classical image-processing tracer finds the LV centre, then the cavity boundary on every slice and phase; volumes follow from a modified Simpson sum over the "
              f"counted slices (basal valve-plane slices are left out: {len(CINE['keep'])} of {len(CINE['area_mm2'])} counted). On the built-in sample: "
              f"<b>EF {CINE['ef']:.1f} %</b> ({SP['ef'][0]:.1f}–{SP['ef'][1]:.1f} over five settings), <b>EDV {CINE['edv']:.1f} mL</b> ({SP['edv'][0]:.1f}–{SP['edv'][1]:.1f}), "
              f"<b>ESV {CINE['esv']:.1f} mL</b> ({SP['esv'][0]:.1f}–{SP['esv'][1]:.1f}), SV {CINE['sv']:.1f} mL, heart rate {CINE['hr_bpm']:.1f} bpm, cardiac output "
              f"{CINE['co_l_min']:.2f} L/min. The 20 phases become morph targets played at the real heart rate; the mesh is placed at the atlas LV centre and long axis at 1:1 scale. "
              "<b>It is not an anatomical registration</b>, and the numbers are an unvalidated automatic estimate; the range is a sensitivity range over five settings, "
              "not a confidence interval.")]
    right = [P("Agent tools and the privacy boundary", "h2"),
             P(f"{tools_n} WebMCP tools are registered on the page (<font name='DVM'>document.modelContext</font>). Their results are <b>measurements and metadata only</b>: sizes, "
               "millilitres, window hints, probabilities. A guard checks every result and blocks anything over 12,000 characters or containing typed arrays, base64 or image data; a live "
               "meter on the page shows the bytes returned and the payloads blocked."),
             P("The one tool that can move anything off the page, <font name='DVM'>export_findings</font>, <b>blocks until a human approves</b>. The dialog shows the exact JSON that "
               "would leave; Deny and Escape cancel, and the request is cancelled automatically if the CT or cine study changes while it waits. The agent never receives the scan, mesh or contours."),
             pic("results/screens/10_approval_dialog.png", colw * 0.80, (450, 243, 990, 657)),
             P("Figure 9 · Approval dialog with the exact export JSON.", "cap")]
    t = Table([[left, right]], colWidths=[colw + 7, colw + 7])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 7)]))
    s.append(t)
    return s


TOOLS = [
    ("describe_heart_model", "atlas source, size in mm, group names, per-vessel probability and band; states that the heart is a generic atlas"),
    ("focus_vessel", "moves the 3D view to CAD / LAD / LCX / RCA and returns its probability"),
    ("predict_risk", "CAD / LAD / LCX / RCA probabilities and top drivers (unknown or outcome keys are rejected)"),
    ("focus_region · set_view · assign_vessel", "confirmations and region facts; they only change the viewer or the lesion assignment"),
    ("describe_scan", "grid, spacing in mm, HU range, suggested calcium window (no voxels)"),
    ("set_heart_region", "sets the heart box (auto / whole / box in mm); returns the box and how many candidates it excludes"),
    ("find_calcifications", "candidate regions: mm³, peak / mean HU, centroid mm, simplified Agatston-style score"),
    ("describe_cine", "cine MRI size, heart rate, whether it is measured (no pixels)"),
    ("measure_lv", "EDV / ESV / SV / EF / cardiac output, sensitivity ranges, slices used (no contours or arrays)"),
    ("show_lv_3d", "shows or hides the beating patient LV in the 3D heart; returns its state"),
    ("export_findings", "JSON report (schema cardiolens.room.v2) only after the user approves"),
]


def page5():
    s = H("4", "Usage", "Run · enter a patient · read, explore, explain · scan room · agent")
    colw = (FW - 14) / 2
    steps = [
        "<b>Open the app.</b> Open <font name='DVM'>web/index.html</font> (or <font name='DVM'>index.offline.html</font> with no network). Nothing to install. "
        "Optional: <font name='DVM'>uvicorn backend.server:app</font> serves the same page plus an API; the header then shows a parity badge.",
        "<b>Enter the patient.</b> Choose a preset (Normal coronaries, Single-, Two- or Three-vessel disease) or set the sliders and toggles in the seven clinical domains. "
        "Values outside the training range are flagged.",
        "<b>Read the prediction.</b> The CAD gauge and the LAD / LCX / RCA rows show the probability, a band (Low < 33 %, Intermediate, High ≥ 66 %) and “n of 100 patients like this”.",
        "<b>Explore in 3D.</b> Drag to rotate, wheel to zoom, right-drag to pan, click a vessel or a row to fly to it. Solid / Glass / Vessels, Layers and “Age +20 y” change what you see.",
        "<b>Ask why.</b> SHAP bars per input and per clinical domain, what-if curves (the hatched part lies outside the training range), and the Model card (ROC, calibration, confusion matrix, limits).",
        "<b>Scan reading room (optional).</b> Open a CT as NIfTI, DICOM files, a folder or a .zip, or load the phantom; set the heart box; find calcium candidates and assign each to a vessel.",
        "<b>Cardiac MRI (optional).</b> “Load sample” or open your own short-axis cine DICOM. Tick slices on or off, optionally use the EF in the risk model, and show “My LV” in 3D.",
        "<b>Agent (optional).</b> “Run demo agent” runs the same tool path an external WebMCP client uses; exports wait for “Approve”.",
    ]
    bn = ParagraphStyle("bn", parent=ST["bul"], leftIndent=13, bulletIndent=0, fontSize=7.8, leading=10.4, spaceAfter=2.6, bulletFontName="DV-B", bulletFontSize=7.8)
    left = [Paragraph(t, bn, bulletText=f"{i + 1}.") for i, t in enumerate(steps)]
    right = [pic("results/screens/01_overview_dark.png", colw, (880, 105, 1425, 620)),
             P("Figure 10 · Prediction panel (dark theme): CAD gauge, vessel rows, “n of 100”. The SHAP explanation sits below it.", "cap")]
    t = Table([[left, right]], colWidths=[colw + 14, colw], style=[("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                                                    ("RIGHTPADDING", (0, 0), (0, 0), 14), ("RIGHTPADDING", (1, 0), (1, 0), 0)])
    s.append(t)
    s.append(Spacer(1, 2))
    two = Table([[
        [pic("results/screens/14_cine_panel_light.png", colw, (450, 120, 1400, 588)),
         P("Figure 11 · Cardiac-MRI card (detail): EF, EDV, ESV, SV, heart rate and output, the sensitivity range and the volume curve.", "cap")],
        [pic("results/screens/08_model_card.png", colw, (560, 60, 1205, 398)),
         P("Figure 12 · Model card (detail): per-target metrics and out-of-fold ROC curves, inside the app.", "cap")]]],
        colWidths=[colw + 14, colw], style=[("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (0, 0), 14), ("RIGHTPADDING", (1, 0), (1, 0), 0)])
    s.append(two)
    s.append(P("Agent tools (WebMCP)", "h2"))
    rows = [["Tool", "Returns (never voxels, pixels, mesh or contours)"]] + [[f"<font name='DVM' size='6.4'>{n}</font>", d] for n, d in TOOLS]
    s.append(tbl(rows, [150, FW - 150], pad=1.7))
    s.append(P(f"{tools_n} tools in total (the row “focus_region · set_view · assign_vessel” is three). Rebuild and test: "
               "<font name='DVM'>python build.py</font> · <font name='DVM'>python3 tests/run_all.py</font> · retrain from the raw sheet: <font name='DVM'>./run_all.sh</font>.", "cap"))
    return s


def page6():
    s = H("5", "Evaluation results", "Pooled out-of-fold metrics · comparison · calibration · performance · tests · limits")
    hdr = ["Target", "Model", "Acc.", "Prec.", "Recall", "Spec.", "F1", "ROC-AUC (95 % CI)", "PR-AUC", "Brier", "Log-loss", "Prev.", "Base acc."]
    rows = [hdr]
    for r in T1[1:]:
        t = r[0]
        rows.append([f"<b>{t}</b>", r[1], r[2].split(" ±")[0], r[3].split(" ±")[0], r[4].split(" ±")[0], r[5].split(" ±")[0], r[6].split(" ±")[0],
                     f"<b>{r[7]}</b>", r[8], r[9], r[10], f"{PREV[t]}%", f"{MAJ[t]}%"])
    maxsd = max(float(c.split("± ")[1]) for r in T1[1:] for c in r[2:7])
    s.append(tbl(rows, [36, 46, 28, 28, 34, 30, 28, 96, 38, 34, 42, 34, FW - 474], pad=1.7))
    s.append(P(f"Pooled out-of-fold predictions at threshold 0.5; mean over 5 CV repeats (sd ≤ {maxsd:.2f} for every metric, see results/RESULTS.md §1). AUC interval: bootstrap. "
               "Brier and log-loss: lower is better; Prev. = prevalence, Base acc. = accuracy of always predicting the larger class. At 0.5, LCX recall is low (" + T1[3][4].split(" ±")[0] + "); a lower threshold would trade specificity for sensitivity "
               f"(Youden point for LCX: {M['LCX']['youden_operating_point']['threshold']:.2f}).", "cap"))
    s.append(P("Comparison with the other model families (nested CV, 25 outer folds)", "h2"))
    FAM = ["LogReg-L2", "LogReg-L1", "SVM-RBF", "ExtraTrees", "RandomForest", "HistGB", "Prior (baseline)"]
    cmp_ = {}
    for r in T2[1:]:
        cmp_[(r[0], r[1].replace(" ★", ""))] = (r[2].replace(" ± ", "±"), r[4].replace(" ± ", "±"), "★" in r[1])
    h1 = ["Model family"] + [t for t in TG for _ in (0, 1)]
    h2 = [""] + ["ROC-AUC", "Log-loss"] * 4
    body, shade = [], []
    for fam in FAM:
        row = [fam]
        for t in TG:
            a, l, star = cmp_[(t, fam)]
            row += [("<b>" + a + "</b>") if star else a, ("<b>" + l + "</b>") if star else l]
            if star:
                shade += [(1 + 2 * TG.index(t), 2 + len(body)), (2 + 2 * TG.index(t), 2 + len(body))]
        body.append(row)
    ct = Table([[Paragraph(f"<b>{c}</b>" if c else "", ST["cellh"]) for c in h1], [Paragraph(c, ST["cellh"]) for c in h2]] +
               [[Paragraph(c, ST["cells"]) for c in r] for r in body], colWidths=[84] + [(FW - 84) / 8] * 8)
    ct.setStyle(TableStyle([("TOPPADDING", (0, 0), (-1, -1), 1.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5), ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
                            ("BACKGROUND", (0, 0), (-1, 1), C(GREY)), ("LINEBELOW", (0, 1), (-1, 1), 0.8, C(MUTED)), ("LINEBELOW", (0, 2), (-1, -1), 0.3, C(LINE)),
                            ("LINEBELOW", (0, -1), (-1, -1), 0.8, C(LINE)), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")] +
                           [("SPAN", (1 + 2 * k, 0), (2 + 2 * k, 0)) for k in range(4)] + [("LINEBEFORE", (1 + 2 * k, 0), (1 + 2 * k, -1), 0.5, C(LINE)) for k in range(1, 4)] +
                           [("BACKGROUND", c, c, C(TEAL_BG)) for c in shade]))
    s.append(ct)
    s.append(P("Mean ± sd over the 25 outer folds (results/RESULTS.md §2); green shading = exported model. Tree ensembles, boosting and the SVM are within fold noise of the linear models; "
               "every model beats the prior-only baseline (ROC-AUC 0.500).", "cap"))
    s.append(P("Calibration (out-of-fold)", "h2"))
    crow = [["Target", "Calibration slope", "Platt scaling applied", "Brier raw → cross-fitted", "Log-loss raw → cross-fitted"]]
    for t in TG:
        crow.append([f"<b>{t}</b>", CAL[t][1], CAL[t][2], CAL[t][3].replace("->", "→"), CAL[t][4].replace("->", "→")])
    s.append(tbl(crow, [40, 90, 100, 130, FW - 360], pad=1.6))
    s.append(P("A slope of 1 is perfect. No recalibration is used: cross-fitted Platt scaling made Brier and log-loss slightly worse for every target (results/RESULTS.md §3); "
               "reliability curves are in the in-app Model card.", "cap"))

    colw = (FW - 12) / 2
    prow = [["Run", "Orbit renders/s", "Canvas moving → at rest", "Idle renders (2 s)"]]
    for r in PERF["runs"]:
        prow.append([r["viewport"], f"{r['orbit_renders_per_s']}", f"{r['canvas_while_moving'][0]}×{r['canvas_while_moving'][1]} → {r['canvas_at_rest'][0]}×{r['canvas_at_rest'][1]}", str(r["idle_renders_in_2s"])])
    left = [P("3D performance without a GPU", "h2"), tbl(prow, [60, 50, 86, colw - 196], pad=1.4),
            P(f"{PERF['runs'][0]['triangles']:,} triangles. Headless Chromium {PERF['chromium']}, software WebGL (SwiftShader), "
              f"{PERF['cores']} CPU cores (results/perf.json). Only headless Chromium with software WebGL was tested (no real GPU, Safari or Firefox).", "cap")]
    trow = [["Suite", "Checks"]]
    for k, lab in (("parity", "JS engine = scikit-learn"), ("api", "FastAPI backend"), ("scan", "CT / calcium finder"), ("room", "agent tools, approval gate, privacy"),
                   ("dicom", "DICOM reader (synthetic files)"), ("cine", "cine-MRI engine vs Python reference"), ("browser", "whole page in Chromium")):
        trow.append([lab, f"{SUITE[k]['passed']}/{SUITE[k]['total']}"])
    trow.append(["<b>All suites</b>", f"<b>{TS['total_passed']}/{TS['total_checks']}</b>"])
    right = [P("Automated tests", "h2"), tbl(trow, [colw - 46, 46], pad=1.1),
             P(f"results/test_summary.json (run {TS['generated'][:10]}). The longer MRI page test adds {SMOKE['checks']} checks, {SMOKE['failed']} failed (results/smoke_mri.json).", "cap")]
    t = Table([[left, right]], colWidths=[colw + 12, colw], style=[("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (0, 0), 12), ("RIGHTPADDING", (1, 0), (1, 0), 0)])
    s.append(t)

    s.append(box([P("Honest limits", "h2")] + bullets([
        f"<b>Small, single-centre data.</b> {N_PATIENTS} patients, CAD prevalence {PREV['CAD']} %, <b>no external validation</b>. Probabilities describe a referral population, not the general public.",
        f"<b>LCX ({AUC['LCX']}, CI {CI['LCX']}) and RCA ({AUC['RCA']}, CI {CI['RCA']})</b> are only weakly predictable from clinical data. The interval for LCX is wide.",
        "<b>Generic atlas.</b> The 3D heart is not the patient’s anatomy; a patient-specific heart would need a whole-heart segmentation model and training data. "
        "Explanations (SHAP, what-if) are statistical associations, not causal effects, and are not mapped onto anatomy.",
        "<b>MRI estimate unvalidated.</b> Classical contour tracing with no manual contours to compare against; the five-setting range is a sensitivity range, <b>not a confidence interval</b>. "
        "Valve-plane slices are left out and papillary muscles count as cavity, so volumes may be underestimated. MRI EF stands in for the echo EF the risk model was trained on.",
        "<b>CT module is a demonstration.</b> Threshold-based, simplified Agatston-style score, no segmentation or stenosis measurement; the heart box is a user-adjusted rectangle. "
        "Scan findings sit beside the clinical model and are not fed into it. DICOM was tested with synthetic files only.",
    ], "bul"), AMBER_BG, AMBER, pad=5, lw=0.8))
    return s


# ------------------------------------------------------------------------------------------------ document
TOTAL = [MAX_PAGES]


def decorate(canv, doc):
    canv.saveState()
    w, h = A4
    m = 14 * mm
    canv.setFont("DV-B", 7)
    canv.setFillColor(C(TEAL))
    canv.drawString(m, h - 10 * mm, "CardioLens 3D")
    canv.setFont("DV", 7)
    canv.setFillColor(C(MUTED))
    canv.drawRightString(w - m, h - 10 * mm, "Multimodal AI Hackathon 2026 · Track A · Documentation")
    canv.setStrokeColor(C(LINE))
    canv.setLineWidth(0.6)
    canv.line(m, h - 11.8 * mm, w - m, h - 11.8 * mm)
    canv.line(m, 12.5 * mm, w - m, 12.5 * mm)
    canv.setFont("DV-B", 6.6)
    canv.setFillColor(C(AMBER))
    canv.drawString(m, 8.6 * mm, "Educational decision support only. Not a substitute for formal diagnostic imaging or clinical judgement.")
    canv.setFont("DV", 7)
    canv.setFillColor(C(MUTED))
    canv.drawRightString(w - m, 8.6 * mm, f"{doc.page} / {TOTAL[0]}")
    canv.restoreState()


def build(path: Path) -> int:
    doc = BaseDocTemplate(str(path), pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=16 * mm, bottomMargin=15 * mm,
                          title="CardioLens 3D – Documentation", author="CardioLens team", subject="Multimodal AI Hackathon 2026, Track A")
    fh = A4[1] - 16 * mm - 15 * mm
    doc.addPageTemplates([PageTemplate(id="p", frames=[Frame(14 * mm, 15 * mm, CONTENT_W, fh, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)], onPage=decorate)])
    story = []
    for i, fn in enumerate((page1, page2, page3, page4, page5, page6)):
        if i:
            story.append(PageBreak())
        story.append(KeepInFrame(CONTENT_W, fh - 2, fn(), mode="error", hAlign="LEFT", vAlign="TOP", fakeWidth=False))
    doc.build(story)
    return doc.page


if __name__ == "__main__":
    n = build(OUT)
    TOTAL[0] = n
    n = build(OUT)  # second pass so the footer carries the real page count
    print(f"wrote {OUT} ({n} pages)")
    if n > MAX_PAGES:
        sys.exit(f"too many pages: {n} > {MAX_PAGES}")
