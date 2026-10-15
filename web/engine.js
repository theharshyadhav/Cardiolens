/* CardioLens inference engine - dependency free, runs in the browser and in Node.
 * Mirrors cardiolens/final.py exactly:
 *   z = base + sum_j w_j * (t(x_j) - mu_j) / sd_j        t = log1p for skewed labs, identity otherwise
 *   p = sigmoid(z)
 *   SHAP (interventional, exact for linear models, log-odds units):  phi_j = w_j * (t(x_j) - mu_j) / sd_j
 * Calibration (Platt a, b) is already folded into base / w by the exporter.
 */
(function (root) {
  'use strict';
  var sigmoid = function (z) { return 1 / (1 + Math.exp(-z)); };
  var tf = function (f, v) { return f.log ? Math.log1p(v) : v; };

  /** Predict every target. x = {featureKey: rawValue}. Returns {T: {z, p, base, phi:{key:contribution}}} */
  function predictAll(model, x) {
    var out = {};
    Object.keys(model.targets).forEach(function (t) {
      var T = model.targets[t], z = T.base, phi = {};
      model.features.forEach(function (f) {
        var v = x[f.key];
        if (typeof v !== 'number' || !isFinite(v)) throw new Error('missing/invalid feature: ' + f.key);
        var c = T.w[f.key] * (tf(f, v) - f.mu) / f.sd;
        phi[f.key] = c; z += c;
      });
      out[t] = { z: z, p: sigmoid(z), base: T.base, p0: sigmoid(T.base), phi: phi };
    });
    return out;
  }

  /** Vessel stenosis implies CAD, so a vessel probability can never exceed P(CAD). */
  function coherent(res) {
    var out = {}, cad = res.CAD.p;
    Object.keys(res).forEach(function (t) {
      var r = res[t], cap = t !== 'CAD' && r.p > cad;
      out[t] = Object.assign({}, r, { p_raw: r.p, p: cap ? cad : r.p, capped: cap });
    });
    return out;
  }

  /** Contributions sorted by |phi|, with display value, for one target. */
  function drivers(model, x, res, t, n) {
    return model.features.map(function (f) { return { key: f.key, label: f.label, group: f.group, value: x[f.key], unit: f.unit, phi: res[t].phi[f.key] }; })
      .sort(function (a, b) { return Math.abs(b.phi) - Math.abs(a.phi); }).slice(0, n || 10);
  }

  /** Net contribution per clinical group (Demographics, Symptoms, ECG, ...). */
  function groups(model, res, t) {
    var g = {};
    model.features.forEach(function (f) { g[f.group] = (g[f.group] || 0) + res[t].phi[f.key]; });
    return g;
  }

  /** Inputs outside the training range -> the model is extrapolating; the UI must warn. */
  function outOfRange(model, x) {
    return model.features.filter(function (f) { return f.kind === 'num' && (x[f.key] < f.train_min || x[f.key] > f.train_max); })
      .map(function (f) { return { key: f.key, label: f.label, value: x[f.key], min: f.train_min, max: f.train_max }; });
  }

  /** Exploratory model sensitivity: P(target) if one modifiable factor were at a reference value.
   *  Association learned from 303 patients, NOT a causal treatment effect. */
  var REFERENCE = { ldl: 100, hdl: 50, sbp: 120, fbs: 90, bmi: 24, tg: 130, smoker: 0 };
  function sensitivity(model, x, t) {
    var base = predictAll(model, x)[t].p, out = [];
    Object.keys(REFERENCE).forEach(function (k) {
      if (x[k] === REFERENCE[k]) return;
      var y = Object.assign({}, x); y[k] = REFERENCE[k];
      var d = predictAll(model, y)[t].p - base;
      var f = model.features.filter(function (q) { return q.key === k; })[0];
      if (d < -0.0005) out.push({ key: k, label: f.label, from: x[k], to: REFERENCE[k], dp: d });
    });
    return out.sort(function (a, b) { return a.dp - b.dp; });
  }

  var band = function (model, p) { var b = model.meta.risk_bands; return p >= b.high ? 'High' : p >= b.low ? 'Intermediate' : 'Low'; };

  root.CardioEngine = { predictAll: predictAll, coherent: coherent, drivers: drivers, groups: groups, outOfRange: outOfRange,
                        sensitivity: sensitivity, band: band, sigmoid: sigmoid, REFERENCE: REFERENCE };
})(typeof module !== 'undefined' ? module.exports : window);
