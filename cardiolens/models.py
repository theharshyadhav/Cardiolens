"""Model zoo + small inner-CV grids. Every model is a Pipeline so scaling happens *inside* each fold."""
from __future__ import annotations

import warnings

from sklearn.dummy import DummyClassifier
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

EXPORTABLE = {"LogReg-L2", "LogReg-L1"}  # exact SHAP + trivially portable to the browser


def model_zoo(seed: int = 0) -> dict[str, tuple[Pipeline, dict]]:
    sc = lambda: ("sc", StandardScaler())
    return {
        "Prior (baseline)": (Pipeline([("clf", DummyClassifier(strategy="prior"))]), {}),
        "LogReg-L2": (
            Pipeline([sc(), ("clf", LogisticRegression(solver="lbfgs", max_iter=5000))]),
            {"clf__C": [0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1.0]},
        ),
        "LogReg-L1": (
            Pipeline([sc(), ("clf", LogisticRegression(penalty="l1", solver="liblinear", max_iter=5000, random_state=seed))]),
            {"clf__C": [0.01, 0.02, 0.03, 0.05, 0.1, 0.3, 1.0]},
        ),
        "SVM-RBF": (
            Pipeline([sc(), ("clf", SVC(kernel="rbf", probability=True, random_state=seed))]),
            {"clf__C": [0.3, 1.0, 3.0], "clf__gamma": ["scale", 0.005]},
        ),
        "RandomForest": (
            Pipeline([("clf", RandomForestClassifier(n_estimators=200, random_state=seed, n_jobs=1))]),
            {"clf__max_features": ["sqrt", 0.3], "clf__min_samples_leaf": [1, 3]},
        ),
        "ExtraTrees": (
            Pipeline([("clf", ExtraTreesClassifier(n_estimators=200, random_state=seed, n_jobs=1))]),
            {"clf__max_features": ["sqrt", 0.3], "clf__min_samples_leaf": [1, 3]},
        ),
        "HistGB": (
            Pipeline([("clf", HistGradientBoostingClassifier(random_state=seed, early_stopping=False, max_iter=120))]),
            {"clf__max_depth": [2, 3], "clf__learning_rate": [0.03, 0.08], "clf__l2_regularization": [1.0]},
        ),
    }
