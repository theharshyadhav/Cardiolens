# CardioLens 3D — coronary risk studio (Multimodal AI Hackathon 2026, Track A)

Predict **CAD and LAD / LCX / RCA stenosis probability** from clinical data, see it on an **interactive 3D heart**, understand **why**, and let an
**AI agent drive the whole thing without ever receiving a scan**.
Research prototype for education and decision support. **Not a diagnostic device.**

Open `web/index.html` (or the no-network `web/index.offline.html`) in a browser. Nothing to install.

## What is in the box

| | |
|---|---|
| **Prediction** | Extension of the Z-Alizadeh Sani data set (UCI #411, 303 patients, 43 inputs). 7 model families, 5×5 repeated stratified **nested CV**, log-loss inner tuning. Exported models are logistic regressions, so SHAP is exact and the model runs in the browser. Outcome columns are never inputs (leakage guard, tested). |
| **3D heart** | Real BodyParts3D anatomy (12 named, peelable layers, 54k triangles). The three coronary arteries are the model outputs: colour = predicted probability (teal → amber → red), with text and icon so colour is never the only signal. Click a vessel to fly to it; Solid / Glass / Vessels-only; Layers panel; orientation gizmo; heartbeat at the entered pulse rate; illustrative **Age +20 y** time-lapse. |
| **Interpretability** | Exact SHAP bars per patient, by clinical domain, what-if curves with the out-of-training-range region hatched, "n of 100 patients like this", out-of-range warnings, and an in-app **Model card** (ROC, calibration with Wilson intervals, confusion matrix, limits). |
| **Scan reading room** | Open a CT as NIfTI (`.nii` / `.nii.gz`), as DICOM files / a folder / a `.zip`, or load the synthetic phantom. Decoded **in the tab**, never uploaded; patient tags are never read and file names are never shown. Axial / coronal / sagittal viewer, window presets, HU probe, an adjustable **heart box**, calcium-candidate finder (threshold + 3-D connected components, simplified Agatston-style score), assign each lesion to LAD / LCX / RCA and the 3D chip shows its Ca score. |
| **Cardiac MRI (cine)** | Built-in sample (one Sunnybrook subject, CC0) or your own short-axis cine DICOM files. Traces the left ventricle on every slice and phase and reports **EDV, ESV, SV, EF, heart rate and cardiac output** (sample: EF 41.0 %, EDV 122.3 mL). Tick slices on or off: the numbers update without re-tracing. "My LV" shows the beating ventricle inside the 3D heart (true size, "not an anatomical registration"). It is an **automatic estimate, not validated**; the EF range is a sensitivity range over 5 settings, **not a confidence interval**. |
| **Agent-native (WebMCP)** | 13 tools registered through `document.modelContext` (native if the browser has it, otherwise the bundled polyfill). Tool results are **measurements and metadata only**. A guard checks every result and a live meter on the page shows how many bytes crossed and how many payloads were blocked. `export_findings` is the only tool that moves anything off the page and **blocks until a human approves**. |
| **Works without a GPU** | Software-renderer detection, vertex-lit tissue, time-based resolution governor, a sharp still frame when you stop moving, and zero rendering while idle. Falls back gracefully without WebGL or three.js (the dashboard and the agent tools keep working). |

## Agent tools (`document.modelContext`)

| Tool | Returns (never voxels, never the mesh) |
|---|---|
| `describe_heart_model` | atlas source, size in mm, group names, per-vessel probability and band. States the heart is a generic atlas, not patient-specific |
| `focus_vessel` | moves the 3D view to CAD / LAD / LCX / RCA and returns its probability |
| `describe_scan` | grid, spacing mm, HU range, suggested calcium window |
| `find_calcifications` | regions: mm³, peak / mean HU, extent, centroid mm, Agatston-style score |
| `focus_region`, `set_view`, `assign_vessel` | confirmation + region facts; they only change the viewer |
| `set_heart_region` | sets the heart box (`region: auto / whole` or `box_mm`); returns the box in mm and how many candidates it excludes |
| `describe_cine` | cine MRI size (slices, phases, pixels), heart rate, whether it is measured. No pixels |
| `measure_lv` | EDV / ESV / SV / EF / cardiac output in mL and %, sensitivity ranges, slices used, method sentence ("automatic estimate, not validated"). Optional LV centre re-traces. No contours, no arrays |
| `show_lv_3d` | shows or hides the beating patient LV in the 3D heart; returns its state |
| `predict_risk` | CAD / LAD / LCX / RCA probabilities, top drivers (unknown or outcome keys rejected) |
| `export_findings` | JSON report (schema `cardiolens.room.v2`, with a `cine_mri` block of numbers) **only after the user approves**; cancelled by Deny, by Escape, and automatically if the CT or the cine changes while pending |

Plumbing: one-at-a-time queue, study epoch (stale results dropped), payload guard on every result, error messages that name the next call to make.
Test it from the console: `await navigator.modelContextTesting.executeTool('predict_risk', '{"features":{"age":70}}')`.

## Run, rebuild, test

    pip install -r requirements.txt && npm install      # once
    ./run_all.sh                                        # everything below, in order (~15 min)

    python cardiolens/benchmark.py     # nested CV, 7 families x 4 targets -> results/
    python cardiolens/final.py         # final models, calibration check, exact SHAP, figures, web/web_model.json
    python -m cardiolens.evidence      # web/evidence.json for the Model card
    python build.py                    # web/index.html, web/artifact.html, web/index.offline.html
    uvicorn backend.server:app         # optional API + app at http://127.0.0.1:8000 (page shows an "API ✓ matches" badge)

    node tests/test_parity.js          # JS engine == scikit-learn pipelines (1e-9), SHAP additivity
    python tests/test_api.py           # backend contract + leakage guard
    node tests/test_scan.js            # NIfTI parser + calcium finder vs phantom ground truth
    node tests/test_room.js            # WebMCP tools, approval gate, epoch cancel, privacy sweep (jsdom)
    node tests/test_dicom.js           # DICOM reader + classifier (CARDIOLENS_DICOM_DIR / CARDIOLENS_DICOM_REF add the real-file part)
    node tests/test_cine.js            # cine LV tracer + volumes equal the Python reference to 1e-6; mesh watertight
    python tests/test_browser.py       # real Chromium: 3D, hover, fly-to, scan flow, CT / DICOM, MRI, agent gate, layout, no-WebGL, API parity
                                       # (pip install playwright && playwright install chromium; screenshots land in results/screens/)
    python tests/run_all.py            # every suite above: one line per suite, results/test_summary.json, exit 1 on any failure
                                       # (needs fastapi for the API suite; without it the browser suite skips its API section and run_all reports it)

Latest run (2026-10-12): parity 60/60 · api 18/18 · scan 24/24 · room 53/53 · dicom 72/72 · cine 55/55 · browser 180/180 · **462/462 checks** (`results/test_summary.json`).
A from-scratch re-run of the benchmark reproduced the committed
metrics to 4 decimals and the exported weights exactly.

## Layout

    cardiolens/   data cleaning + leakage guard, model zoo, nested-CV benchmark, final fit / SHAP / export, evidence for the Model card
    web/          app.template.html + js/{core,charts,scene,room,cineui,boot}.js + engine.js + scan.js + dicom.js + cine.js + anatomy.b64  ->  build.py  ->  index.html
    tools/        prep_anatomy.py  (BodyParts3D OBJ -> anatomy.b64: grouping, welding, decimation, int16 quantisation)
    backend/      FastAPI /api/health /api/schema /api/predict (same math, cross-checked against the sklearn pipelines at start-up)
    vendor/       WebMCP core (MIT) + a patch for two bugs in the upstream localhost bridge
    results/      RESULTS.md, metrics.json, figures, feature audit, screens/ (browser-test screenshots)
    tests/        parity, API, scan, room (jsdom), dicom, cine, browser (Chromium), run_all.py; smoke_mri.py is a longer MRI-only Chromium check

### Adding a structure or a model
* New anatomical structure: add a rule to `RULES` in `tools/prep_anatomy.py` (or drop in another OBJ) and re-run; the viewer iterates over whatever groups the blob contains and the Layers panel lists them automatically.
* New model output on an existing vessel: export it in the same JSON schema; the colour, chip, info card and agent tools read `RS[k].p`.
* New model family: add it to `cardiolens/models.py`; it enters the same nested CV. Only linear models are exported (exact SHAP, runs in the browser).

## Honest limits

* **The heart is a generic adult atlas** (BodyParts3D), not the patient's anatomy. A patient-specific heart needs a segmentation model and a whole-heart CT/MRI training set; this prototype does not do that and says so on screen.
* Single-centre data (303 patients, 71% with CAD), **no external validation**. LCX (AUC 0.70) and RCA (0.73) are only weakly predictable from clinical data; probabilities describe a referral population.
* Tree models are slightly better on some targets (e.g. RandomForest on LCX by +0.014 AUC, within fold-to-fold noise). Linear models were exported for exact SHAP, portability and transparency (`results/RESULTS.md` §3b).
* SHAP and what-if curves are statistical **associations**, not causal effects, and are not mapped onto anatomy (the brief: features are not anatomical coordinates).
* The CT module is a threshold demo: bone, valves and contrast also exceed 130 HU; the Agatston-style score is simplified and **unvalidated**; the heart box is a user-adjusted rectangle (its suggestion is a guess, validated only on synthetic chests), no segmentation, no stenosis measurement. Scan findings are shown beside the clinical model, not fed into it.
* The MRI module is classical contour tracing, an **unvalidated automatic estimate** with no manual contours to compare against; basal slices are left out and papillary muscles count as cavity, so volumes may be underestimated. Short-axis bright-blood cine only. The MRI EF stands in for the echo EF the risk model was trained on. The sample subject is a 27-year-old, outside the model's training ages, so his coronary-risk numbers do not apply.
* Tested in headless Chromium with software WebGL. Not yet tested on Safari, Firefox or a physical GPU.

## Credits and licences

Clinical data: Extension of Z-Alizadeh Sani (UCI #411). 3D anatomy: **BodyParts3D © Life Science Integrated Database Center (DBCLS), CC BY-SA 2.1 Japan**, via simonreisinger/Interactive-3D-Human-Heart-Visualization
(the derived `web/anatomy.b64` is therefore distributed under the same licence). Agent plumbing: WebMCP core (MIT). Reading-room design inspired by Faraday (MIT). Rendering: three.js r128 (MIT).
`real_ct_slab_16x2.5mm.nii.gz` is a 16-slice excerpt from the user-supplied Heart CT & MRI data set, kept for demonstration; check that data set's licence before redistributing it.
