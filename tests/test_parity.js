// Verifies that the browser engine reproduces the sklearn pipelines (independent code path) and that SHAP is additive.
const fs = require('fs'), path = require('path');
const { CardioEngine: E } = require(path.join(__dirname, '..', 'web', 'engine.js'));
const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'web_model.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'parity_cases.json'), 'utf8'));
let maxP = 0, maxAdd = 0;
for (const c of cases) {
  const r = E.predictAll(model, c.x);
  for (const t of model.meta.targets) {
    maxP = Math.max(maxP, Math.abs(r[t].p - c.expected[t]));
    const s = Object.values(r[t].phi).reduce((a, b) => a + b, 0);
    maxAdd = Math.max(maxAdd, Math.abs(r[t].base + s - r[t].z));
  }
  const q = E.coherent(r);
  for (const t of ['LAD', 'LCX', 'RCA']) if (q[t].p > q.CAD.p + 1e-12) throw new Error('coherence violated');
}
console.log(`cases=${cases.length}  max|p_js - p_sklearn|=${maxP.toExponential(2)}  max SHAP additivity error=${maxAdd.toExponential(2)}`);
if (maxP > 1e-9 || maxAdd > 1e-9) { console.error('PARITY FAILED'); process.exit(1); }
console.log('PARITY OK');
