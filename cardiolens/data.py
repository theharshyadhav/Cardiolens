"""Load + clean the *extended* Z-Alizadeh Sani dataset and define the model feature schema.

Design rules (documented in the project write-up):
  * LAD / LCX / RCA / Cath are targets only and can never appear as inputs (leakage guard).
  * Redundant features are dropped (Weight, Length -> BMI exactly; Obesity == BMI>25 in 99.7% of rows).
  * Features with fewer than MIN_EVENTS minority-class rows are dropped (cannot be learned reliably).
  * Skewed labs get a deterministic log1p transform (parameter-free, so no CV leakage).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW_XLSX = ROOT / "data" / "ext" / "extention of Z-Alizadeh sani dataset.xlsx"
SHEET = "Sheet 1 - Table 1"

TARGETS = {"CAD": "Cath", "LAD": "LAD", "LCX": "LCX", "RCA": "RCA"}  # model name -> source column
LEAKAGE_COLS = ("Cath", "LAD", "LCX", "RCA")
MIN_EVENTS = 10


@dataclass(frozen=True)
class Feature:
    src: str          # column in the raw sheet
    key: str          # short machine key
    label: str        # UI label
    group: str        # clinical group for the dashboard
    kind: str         # 'num' | 'bin' | 'ord'
    unit: str = ""
    log: bool = False  # apply log1p
    step: float = 1.0


FEATURES: list[Feature] = [
    Feature("Age", "age", "Age", "Demographics", "num", "years"),
    Feature("Sex", "male", "Male sex", "Demographics", "bin"),
    Feature("BMI", "bmi", "Body-mass index", "Demographics", "num", "kg/m²", step=0.1),
    Feature("DM", "dm", "Diabetes mellitus", "Risk factors", "bin"),
    Feature("HTN", "htn", "Hypertension", "Risk factors", "bin"),
    Feature("Current Smoker", "smoker", "Current smoker", "Risk factors", "bin"),
    Feature("EX-Smoker", "exsmoker", "Ex-smoker", "Risk factors", "bin"),
    Feature("FH", "fh", "Family history of CAD", "Risk factors", "bin"),
    Feature("DLP", "dlp", "Dyslipidaemia", "Risk factors", "bin"),
    Feature("Airway disease", "airway", "Airway disease", "Risk factors", "bin"),
    Feature("BP", "sbp", "Blood pressure", "Examination", "num", "mmHg"),
    Feature("PR", "pr", "Pulse rate", "Examination", "num", "bpm"),
    Feature("Edema", "edema", "Oedema", "Examination", "bin"),
    Feature("Lung rales", "rales", "Lung rales", "Examination", "bin"),
    Feature("Systolic Murmur", "sysmurmur", "Systolic murmur", "Examination", "bin"),
    Feature("Typical Chest Pain", "typ_cp", "Typical chest pain", "Symptoms", "bin"),
    Feature("Atypical", "atyp_cp", "Atypical chest pain", "Symptoms", "bin"),
    Feature("Nonanginal", "nonang_cp", "Non-anginal chest pain", "Symptoms", "bin"),
    Feature("Dyspnea", "dyspnea", "Dyspnoea", "Symptoms", "bin"),
    Feature("Function Class", "fclass", "Functional class (0-3)", "Symptoms", "ord"),
    Feature("Q Wave", "qwave", "Q wave", "ECG", "bin"),
    Feature("St Elevation", "stelev", "ST elevation", "ECG", "bin"),
    Feature("St Depression", "stdep", "ST depression", "ECG", "bin"),
    Feature("Tinversion", "tinv", "T-wave inversion", "ECG", "bin"),
    Feature("LVH", "lvh", "Left-ventricular hypertrophy", "ECG", "bin"),
    Feature("BBB", "bbb", "Bundle-branch block (any)", "ECG", "bin"),
    Feature("FBS", "fbs", "Fasting blood sugar", "Laboratory", "num", "mg/dL", log=True),
    Feature("CR", "cr", "Creatinine", "Laboratory", "num", "mg/dL", step=0.1),
    Feature("TG", "tg", "Triglycerides", "Laboratory", "num", "mg/dL", log=True),
    Feature("LDL", "ldl", "LDL cholesterol", "Laboratory", "num", "mg/dL"),
    Feature("HDL", "hdl", "HDL cholesterol", "Laboratory", "num", "mg/dL"),
    Feature("BUN", "bun", "Blood urea nitrogen", "Laboratory", "num", "mg/dL", log=True),
    Feature("ESR", "esr", "Erythrocyte sedimentation rate", "Laboratory", "num", "mm/h", log=True),
    Feature("HB", "hb", "Haemoglobin", "Laboratory", "num", "g/dL", step=0.1),
    Feature("K", "k", "Potassium", "Laboratory", "num", "mEq/L", step=0.1),
    Feature("Na", "na", "Sodium", "Laboratory", "num", "mEq/L"),
    Feature("WBC", "wbc", "White-cell count", "Laboratory", "num", "cells/µL", step=100),
    Feature("Lymph", "lymph", "Lymphocytes", "Laboratory", "num", "%"),
    Feature("Neut", "neut", "Neutrophils", "Laboratory", "num", "%"),
    Feature("PLT", "plt", "Platelets", "Laboratory", "num", "10³/µL", log=True),
    Feature("EF-TTE", "ef", "Ejection fraction (echo)", "Echo", "num", "%"),
    Feature("Region RWMA", "rwma", "Regional wall-motion abnormality (0-4)", "Echo", "ord"),
    Feature("VHD", "vhd", "Valvular heart disease (0-3)", "Echo", "ord"),
]
KEYS = [f.key for f in FEATURES]
assert not set(KEYS) & {c.lower() for c in LEAKAGE_COLS}, "leakage column leaked into feature keys"

_DROPPED = {  # source columns we deliberately do not use, with the reason
    "Weight": "redundant: BMI is an exact function of Weight and Length (r = 1.0)",
    "Length": "redundant: BMI is an exact function of Weight and Length (r = 1.0)",
    "Obesity": "redundant: equals BMI>25 in 99.7% of rows",
    "Exertional CP": "constant (all 'N')",
    "CHF": "1 positive row - cannot be learned", "LowTH Ang": "2 positive rows - cannot be learned",
    "CVA": "5 positive rows", "Weak Peripheral Pulse": "5 positive rows", "CRF": "6 positive rows",
    "Thyroid Disease": "7 positive rows", "Diastolic Murmur": "9 positive rows",
    "Poor R Progression": "9 positive rows",
}


def load_raw() -> pd.DataFrame:
    df = pd.read_excel(RAW_XLSX, sheet_name=SHEET)
    assert df.shape == (303, 59), f"unexpected shape {df.shape}"
    assert df.isna().sum().sum() == 0
    return df


_YN = {"y": 1, "n": 0, "male": 1, "fmale": 0, "female": 0}
_VHD = {"n": 0, "mild": 1, "moderate": 2, "severe": 3}


def build_features(df: pd.DataFrame, apply_log: bool = True) -> pd.DataFrame:
    out = {}
    for f in FEATURES:
        s = df[f.src]
        if f.key == "bbb":
            v = (s.astype(str).str.upper() != "N").astype(int)
        elif f.key == "vhd":
            v = s.astype(str).str.lower().map(_VHD)
        elif f.kind == "bin":
            v = s.astype(str).str.lower().map(_YN) if s.dtype == object or str(s.dtype) == "str" else s.astype(int)
            if v.isna().any():  # numeric 0/1 stored as text
                v = s.astype(int)
        else:
            v = s.astype(float)
            if f.log and apply_log:
                v = np.log1p(v)
        out[f.key] = v.astype(float)
    X = pd.DataFrame(out, index=df.index)
    assert X.notna().all().all()
    return X


def build_targets(df: pd.DataFrame) -> pd.DataFrame:
    pos = {"Cath": "cad", "LAD": "stenotic", "LCX": "stenotic", "RCA": "stenotic"}
    return pd.DataFrame(
        {name: (df[src].astype(str).str.lower() == pos[src]).astype(int) for name, src in TARGETS.items()}
    )


def feature_audit(df: pd.DataFrame) -> pd.DataFrame:
    rows = [{"source_column": f.src, "key": f.key, "group": f.group, "kept": True, "reason": f"kind={f.kind}" + (", log1p" if f.log else "")} for f in FEATURES]
    rows += [{"source_column": k, "key": "", "group": "", "kept": False, "reason": r} for k, r in _DROPPED.items()]
    rows += [{"source_column": c, "key": "", "group": "target", "kept": False, "reason": "TARGET / leakage guard (never an input)"} for c in LEAKAGE_COLS]
    a = pd.DataFrame(rows)
    used = set(a.source_column)
    assert used == set(df.columns), f"unaccounted columns: {set(df.columns) ^ used}"
    return a


def load_xy():
    df = load_raw()
    return build_features(df), build_targets(df)
