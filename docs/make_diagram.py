"""System diagram for the documentation (docs/architecture.png).   python docs/make_diagram.py

Drawn at its final print size (7.0 x 4.75 in) so the 6-7 pt labels are the real text size in the PDF.
A fit check measures every label against its box and stops with an error if any text overflows.
"""
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

plt.rcParams["font.family"] = "DejaVu Sans"
INK, MUTED, LINE, GREY = "#0d1624", "#46546a", "#b3c1d5", "#eef2f8"
TEAL, BLUE, AMBER = "#0b7a5e", "#1b63b8", "#8f6200"
TEAL_BG, BLUE_BG, AMBER_BG = "#e3f4ee", "#e6effb", "#fdf1d6"

W, H = 100.0, 67.8
fig, ax = plt.subplots(figsize=(7.0, 4.75), dpi=260)
fig.subplots_adjust(0, 0, 1, 1)
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
FIT = []  # (text, x0, x1) for the overflow check


def box(x, y, w, h, title, sub="", fc="white", ec=LINE, lw=1.0, ls="-", tc=INK):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.0,rounding_size=1.1", fc=fc, ec=ec, lw=lw, ls=ls))
    n = sub.count("\n") + 1 if sub else 0
    ty = y + h - 2.5 if sub else y + h / 2
    FIT.append((ax.text(x + w / 2, ty, title, ha="center", va="center", fontsize=6.8, fontweight="bold", color=tc), x, x + w))
    if sub:
        FIT.append((ax.text(x + w / 2, ty - 1.9, sub, ha="center", va="top", fontsize=5.9, color=MUTED, linespacing=1.35), x, x + w))


def arrow(p, q, color=MUTED, ls="-", lw=1.0, both=False):
    ax.add_patch(FancyArrowPatch(p, q, arrowstyle="<|-|>" if both else "-|>", mutation_scale=6.5, color=color, lw=lw, ls=ls,
                                 shrinkA=0, shrinkB=0))


def elbow(pts, color, lw=1.0, ls="-"):
    xs, ys = zip(*pts[:-1])
    ax.plot(xs, ys, color=color, lw=lw, ls=ls, solid_capstyle="butt", dash_capstyle="butt")
    arrow(pts[-2], pts[-1], color=color, lw=lw, ls=ls)


def lane(y, h, label, color):
    ax.add_patch(FancyBboxPatch((0.4, y), W - 0.8, h, boxstyle="round,pad=0.0,rounding_size=1.4", fc=GREY, ec="none"))
    ax.text(1.9, y + h - 1.0, label, fontsize=6.2, fontweight="bold", color=color, va="top")


def note(x, y, s, color, ha="left", va="center"):
    ax.text(x, y, s, ha=ha, va=va, fontsize=5.9, color=color, style="italic")


# ---- lane 1: train once ---------------------------------------------------------------------------------------------
lane(53.6, 13.2, "TRAIN ONCE  ·  Python", TEAL)
Y1, H1 = 55.3, 7.8
box(2.5, Y1, 19, H1, "Z-Alizadeh Sani", "303 patients · UCI #411")
box(24.5, Y1, 24, H1, "Clean + leakage guard", "43 inputs · log1p on 5 labs")
box(51.5, Y1, 22, H1, "5×5 nested CV", "7 families · log-loss tuning")
box(76.5, Y1, 21, H1, "Export", "weights + exact SHAP", fc=TEAL_BG, ec=TEAL, lw=1.4)
for a, b in ((21.5, 24.5), (48.5, 51.5), (73.5, 76.5)):
    arrow((a, Y1 + H1 / 2), (b, Y1 + H1 / 2))

# ---- lane 2: browser tab --------------------------------------------------------------------------------------------
lane(18.6, 32.0, "IN THE BROWSER TAB  ·  no server needed", BLUE)
YA, HA = 38.6, 8.6
box(2.5, YA, 15.5, HA, "Clinical inputs", "sliders · presets")
box(20.8, YA, 25, HA, "JS engine", "P(CAD) P(LAD) P(LCX) P(RCA)\nvessel ≤ CAD · parity-tested vs sklearn", fc=TEAL_BG, ec=TEAL, lw=1.4)
box(48.6, YA, 28, HA, "3D heart  (three.js)", "vessel colour = probability\nfly-to · layers · heartbeat", fc=BLUE_BG, ec=BLUE, lw=1.4)
box(79.5, YA, 18, HA, "Explain", "SHAP · what-if\nn of 100 · Model card")
arrow((18.0, YA + HA / 2), (20.8, YA + HA / 2))
arrow((45.8, YA + HA / 2), (48.6, YA + HA / 2))
arrow((76.6, YA + HA / 2), (79.5, YA + HA / 2), ls=(0, (2.5, 1.8)))

YB, HB = 22.0, 8.0
box(2.5, YB, 23.5, HB, "FastAPI  (optional)", "same maths in Python\nbadge: API ✓ matches", ls=(0, (3, 2)))
box(44, YB, 22, HB, "BodyParts3D atlas", "12 named layers\n54k triangles")
box(70, YB, 27.5, HB, "CT + cine-MRI reader", "NIfTI · DICOM, decoded in the tab\nnever uploaded")
elbow([(87, Y1), (87, 52.1), (39, 52.1), (39, YA + HA)], TEAL)
note(63, 52.45, "slim model embedded in the page", TEAL, ha="center", va="bottom")
arrow((24, YB + HB), (24, YA), color=MUTED, ls=(0, (2.5, 1.8)), both=True)
note(25.2, 34.3, "parity check", MUTED)
arrow((55, YB + HB), (55, YA), color=BLUE)
note(56.2, 34.3, "geometry", BLUE)
arrow((73, YB + HB), (73, YA), color=BLUE)
note(74.2, 34.3, "Ca score · patient LV", BLUE)

# ---- lane 3: agent boundary -----------------------------------------------------------------------------------------
lane(1.0, 14.6, "AGENT BOUNDARY  ·  WebMCP", AMBER)
Y3, H3 = 2.9, 8.6
box(2.5, Y3, 16, H3, "AI agent", "any WebMCP client")
box(21.5, Y3, 33, H3, "13 tools  →  guard + live meter", "measurements & metadata only\n> 12,000 chars, arrays, images: blocked")
box(57.5, Y3, 19, H3, "export_findings", "the only tool\nthat exports")
box(79.5, Y3, 18, H3, "Human approves", "dialog shows the JSON", fc=AMBER_BG, ec=AMBER, lw=1.6)
arrow((18.5, Y3 + H3 / 2), (21.5, Y3 + H3 / 2))
arrow((54.5, Y3 + H3 / 2), (57.5, Y3 + H3 / 2), color=AMBER)
arrow((76.5, Y3 + H3 / 2), (79.5, Y3 + H3 / 2), color=AMBER)
arrow((34, Y3 + H3), (34, YA), color=AMBER, ls=(0, (2.5, 1.8)))
note(35.2, 34.3, "reads / drives the page", AMBER)

# ---- overflow check -------------------------------------------------------------------------------------------------
fig.canvas.draw()
rend = fig.canvas.get_renderer()
inv = ax.transData.inverted()
bad = []
for t, x0, x1 in FIT:
    bb = t.get_window_extent(rend)
    (a, _), (b, _) = inv.transform([[bb.x0, bb.y0], [bb.x1, bb.y1]])
    if a < x0 + 0.9 or b > x1 - 0.9:
        bad.append((t.get_text().split("\n")[0], round(a - x0, 2), round(x1 - b, 2)))
if bad:
    raise SystemExit(f"text overflows its box: {bad}")

out = Path(__file__).with_name("architecture.png")
fig.savefig(out, facecolor="white")
print("wrote", out, "- all labels fit")
