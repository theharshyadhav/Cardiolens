/* ===== CardioLens core: state, clinical dashboard, inputs, model card ===== */
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],E=CardioEngine,T=['CAD','LAD','LCX','RCA'],VK=['LAD','LCX','RCA'];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pc=p=>Math.round(p*100)+'%',f2=v=>v.toFixed(2),clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const NAME={CAD:'Coronary artery disease',LAD:'Left anterior descending',LCX:'Left circumflex',RCA:'Right coronary artery'};
const DESC={CAD:'At least 50% narrowing in one or more major coronary arteries.',LAD:'Supplies blood to the front of the heart.',LCX:'Supplies blood to the side and back of the heart.',RCA:'Supplies blood to the right side and bottom of the heart.'};
const WHAT={CAD:'coronary artery disease',LAD:'at least 50% narrowing of the LAD',LCX:'at least 50% narrowing of the LCX',RCA:'at least 50% narrowing of the RCA'};
const BI={High:'▲',Intermediate:'◆',Low:'●'};
/* ---- theme-aware risk colour (teal -> amber -> red), read from CSS tokens so DOM and WebGL agree ---- */
const cssv=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const h2r=h=>{h=String(h||'').replace('#','');if(!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h))return[136,136,136];if(h.length===3)h=h.replace(/./g,'$&$&');return[0,2,4].map(i=>parseInt(h.slice(i,i+2),16))};
let RAMP=null;const themeHooks=[];
const mixc=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*t));
/* Band-aligned ramp. The Low/Intermediate boundary (33%) is a short teal->amber transition (31-35%), and the Intermediate/High boundary (66%)
   falls inside the amber->red run (62-74%), so a probability's colour agrees with its band label. No green stop (it fails the
   colour-vision-deficiency separation check); every colour is also paired with text and an icon. */
function buildRamp(){const [a,b,c]=['--r0','--r1','--r2'].map(n=>h2r(cssv(n)));
  RAMP=[[0,a],[.312,mixc(a,b,.12)],[.348,b],[.62,mixc(b,c,.5)],[.74,mixc(b,c,.85)],[1,c]];
  document.documentElement.style.setProperty('--ramp','linear-gradient(90deg,'+RAMP.map(([p,c])=>`rgb(${c.join(',')}) ${(p*100).toFixed(1)}%`).join(',')+')')}
function refreshTheme(){buildRamp();themeHooks.forEach(f=>f())}
const riskRgb=p=>{if(!RAMP)buildRamp();p=clamp(p,0,1);let i=0;while(i<RAMP.length-2&&p>RAMP[i+1][0])i++;const [p0,a]=RAMP[i],[p1,b]=RAMP[i+1];return mixc(a,b,(p-p0)/(p1-p0))};
const riskCss=p=>'rgb('+riskRgb(p).join(',')+')';
const lum=c=>{const[r,g,b]=c.map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*r+.7152*g+.0722*b};
const inkFor=c=>lum(c)>.179?'#0b1220':'#ffffff';
/* ---- state ---- */
const FEAT=Object.fromEntries(M.features.map(f=>[f.key,f])),def=()=>Object.fromEntries(M.features.map(f=>[f.key,f.default]));
let S=def(),sel='LAD',RS={},V=null,wfUser=false,lapse=null;
const fv=(f,v)=>f.kind==='bin'?(v?'Yes':'No'):(f.step<1?(+v).toFixed(1):String(Math.round(v*100)/100))+(f.unit?' '+f.unit:'');
function select(k){sel=k;if(V)V.clearRegion();update();if(V)V.fly(k)}
const bandPill=p=>{const b=E.band(M,p);return `<span class="band"><i style="color:${riskCss(p)}">${BI[b]}</i><span>${b}</span></span>`};
/* ---- dashboard ---- */
function update(){
  RS=E.coherent(E.predictAll(M,S));
  M.features.forEach(f=>{const o=$('#o_'+f.key);if(o)o.textContent=fv(f,S[f.key])});
  renderRisk();renderWhy();renderWhatIf();
  if(V)V.paint();backendCheck();
}
function renderRisk(){
  const c=RS.CAD,b=M.meta.risk_bands;
  const hero=`<div class="hb" role="radio" tabindex="0" aria-checked="${sel==='CAD'}" data-k="CAD" aria-label="${NAME.CAD} ${pc(c.p)} ${E.band(M,c.p)}"><div class="hero-top"><div><div class="t2">${NAME.CAD}</div><div class="sm mu">${DESC.CAD}</div><div style="margin-top:6px">${bandPill(c.p)}</div></div><div class="bigp" style="color:${riskCss(c.p)}">${pc(c.p)}</div></div>
    <div class="meter"><u style="left:${b.low*100}%"></u><u style="left:${b.high*100}%"></u><b style="left:${c.p*100}%"></b></div><div class="mlab"><span>Low &lt;${Math.round(b.low*100)}%</span><span>Intermediate</span><span>High ≥${Math.round(b.high*100)}%</span></div></div>`;
  const rows=VK.map(k=>{const r=RS[k];return `<div class="vr" role="radio" tabindex="0" aria-checked="${sel===k}" data-k="${k}" aria-label="${NAME[k]} ${pc(r.p)} ${E.band(M,r.p)}"><b>${k}</b><div class="nm"><div class="bar"><i style="width:${r.p*100}%;background:${riskCss(r.p)}"></i></div><span>${NAME[k]}</span></div><div class="pv">${pc(r.p)}${r.capped?'<sup title="capped at P(CAD): a narrowed vessel implies CAD">*</sup>':''}</div>${bandPill(r.p)}</div>`}).join('');
  $('#risk').innerHTML=hero+`<div class="vrows" style="margin-top:6px">${rows}</div>`;
  const p=RS[sel].p,n=Math.round(p*100),col=riskCss(p);let dots='';
  for(let i=0;i<100;i++)dots+=`<circle cx="${(i%10)*11+5.5}" cy="${Math.floor(i/10)*11+5.5}" r="4" ${i<n?`fill="${col}"`:'fill="none" stroke="var(--bd)" stroke-width="1.5"'}/>`;
  $('#ia').innerHTML=`<svg viewBox="0 0 110 110" role="img" aria-label="${n} of 100 patients filled">${dots}</svg><p><b class="mono">${n} of 100</b> patients with a profile like this are expected to have ${WHAT[sel]}. <span class="mu">An estimate from a referral cohort (${M.evidence?Math.round(M.evidence.targets[sel].prevalence*100):'–'}% had it), not a diagnosis.</span></p>`;
  const mt=M.targets[sel],m=mt.metrics;
  $('#mc').innerHTML=`${sel} model: ${mt.model} · cross-validated AUC <b>${f2(m.roc_auc[0])}</b> [${f2(mt.auc_ci95[0])}–${f2(mt.auc_ci95[1])}] · accuracy ${f2(m.accuracy[0])} · recall ${f2(m.recall[0])} · F1 ${f2(m.f1[0])}`+(Object.values(RS).some(r=>r.capped)?' · * vessel capped at P(CAD)':'')+` · <a href="#" id="mcl" style="color:var(--ac)">Model card</a>`;
  const oo=E.outOfRange(M,S);$('#oor').innerHTML=oo.length?`<div class="warn"><b>Outside the training data</b> (the model is extrapolating): ${oo.map(o=>esc(o.label)+' '+o.value).join(', ')}</div>`:'';
}
const dvBar=(v,mx)=>`<div class="dv"><i style="${v>0?'left':'right'}:50%;width:${Math.abs(v)/mx*50}%;background:var(--${v>0?'pos':'neg'})"></i></div><b>${v>0?'+':''}${v.toFixed(2)}</b>`;
function renderWhy(){
  const r=RS[sel],dr=E.drivers(M,S,RS,sel,9),mx=Math.max(.01,...dr.map(o=>Math.abs(o.phi)));
  $('#dt').textContent=`Why ${sel} = ${pc(r.p)}`;
  $('#dr').innerHTML=`<div class="sm mu" style="margin-bottom:6px">Starts from the cohort baseline <b class="mono">${pc(r.p0)}</b> and ends at <b class="mono">${pc(1/(1+Math.exp(-r.z)))}</b>${r.capped?` (shown as ${pc(r.p)}, capped at P(CAD))`:''}.</div>
    <div class="legend"><span><i style="background:var(--pos)"></i>raises risk</span><span><i style="background:var(--neg)"></i>lowers risk</span><span>log-odds units</span></div>`+
    dr.map(o=>`<div class="fr"><span title="${esc(o.label)}">${esc(o.label)}</span><em>${esc(fv(FEAT[o.key],o.value))}</em>${dvBar(o.phi,mx)}</div>`).join('');
  const g=E.groups(M,RS,sel),gm=Math.max(.01,...Object.values(g).map(Math.abs));
  $('#gp').innerHTML=Object.entries(g).map(([k,v])=>`<div class="fr"><span>${esc(k)}</span><em></em>${dvBar(v,gm)}</div>`).join('');
  const wi=E.sensitivity(M,S,sel).slice(0,3);
  $('#wi').innerHTML=wi.length?'Model sensitivity (association, not treatment advice): '+wi.map(w=>`${esc(w.label)} ${w.from}→${w.to} would change ${sel} by <b class="mono">${(w.dp*100).toFixed(1)} pp</b>`).join('; ')+'.':'No modifiable factor above its reference value in this profile.';
}
/* ---- inputs ---- */
const GR=[...new Set(M.features.map(f=>f.group))];
function buildInputs(){
  $('#in').innerHTML=GR.map((g,i)=>`<details ${i<2?'open':''}><summary>${esc(g)}<span class="mu">${M.features.filter(f=>f.group===g).length}</span></summary><div class="gr">${M.features.filter(f=>f.group===g).map(f=>f.kind==='bin'?`<label class="tg"><input type="checkbox" data-k="${f.key}"> ${esc(f.label)}</label>`:`<label class="sl" title="Training range ${f.train_min}–${f.train_max}">${esc(f.label)}<output id="o_${f.key}"></output><input type="range" data-k="${f.key}" min="${f.ui_min}" max="${f.ui_max}" step="${f.step}"></label>`).join('')}</div></details>`).join('');
  $('#ps').innerHTML=M.presets.map((p,i)=>`<button class="btn" type="button" data-p="${i}" title="${esc(p.description)}">${esc(p.name)} <span class="mu mono">n=${p.n}</span></button>`).join('')+'<button class="btn" type="button" data-p="-1">Reset</button>';
  $('#wf').innerHTML=GR.map(g=>`<optgroup label="${esc(g)}">${M.features.filter(f=>f.group===g).map(f=>`<option value="${f.key}">${esc(f.label)}</option>`).join('')}</optgroup>`).join('');
}
function sync(){$$('#in input').forEach(i=>{const v=S[i.dataset.k];if(i.type==='checkbox')i.checked=!!v;else i.value=v})}
function setProfile(p){stopLapse();S=p;sync();update()}
/* ---- illustrative age time-lapse (association with age alone, not a forecast) ---- */
function animateAge(to,done){
  if(lapse&&lapse.raf)cancelAnimationFrame(lapse.raf);
  const a=S.age,t0=performance.now(),dur=matchMedia('(prefers-reduced-motion: reduce)').matches?1:2400;lapse=lapse||{a0:a};
  const step=now=>{const t=clamp((now-t0)/dur,0,1),e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;S.age=Math.round(a+(to-a)*e);sync();update();
    if(t<1)lapse.raf=requestAnimationFrame(step);else{lapse.raf=0;if(done)done()}};
  lapse.raf=requestAnimationFrame(step);
}
function toggleLapse(){
  const b=$('#ta'),nt=$('#nt');
  if(lapse&&lapse.on){lapse.on=false;b.setAttribute('aria-pressed','false');b.textContent='Age +20 y';const a0=lapse.a0;animateAge(a0,()=>{lapse=null;nt.hidden=true});return}
  const a0=S.age,a1=Math.min(a0+20,FEAT.age.ui_max);lapse={a0,on:true};b.setAttribute('aria-pressed','true');b.textContent='Back to now';
  nt.hidden=false;nt.textContent=`Age ${a0} → ${a1} with every other input unchanged: illustrative, not a forecast`;animateAge(a1);
}
function stopLapse(){if(lapse){if(lapse.raf)cancelAnimationFrame(lapse.raf);lapse=null;$('#ta').setAttribute('aria-pressed','false');$('#ta').textContent='Age +20 y';$('#nt').hidden=true}}
/* ---- optional API cross-check: when served by backend/server.py the page proves the two engines agree ---- */
let backend=false,btimer=0;
const setApi=(t,tip)=>{const e=$('#api');e.textContent=t;if(tip)e.title=tip};
async function probeBackend(){
  if(!/^https?:$/.test(location.protocol))return;
  try{const r=await fetch('api/health',{cache:'no-store'});if(r.ok&&(await r.json()).status==='ok'){backend=true;setApi('Engine: in-browser + API','Predictions are recomputed by the FastAPI/scikit-learn backend after every change and compared.');backendCheck()}}catch(e){}
}
function backendCheck(){
  if(!backend)return;clearTimeout(btimer);
  btimer=setTimeout(async()=>{try{const r=await(await fetch('api/predict',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({features:S})})).json();
    let d=0;for(const t of T)d=Math.max(d,Math.abs(r.predictions[t].probability-RS[t].p));
    setApi(d<1e-3?`API ✓ matches (Δ ${d.toExponential(0)})`:`API mismatch Δ ${d.toFixed(3)}`,'Largest probability difference between the backend and the in-browser engine for the current inputs.')}catch(e){setApi('Engine: in-browser (API offline)')}},180);
}
/* ---- model card ---- */
function openModelCard(t0){
  const EV=M.evidence;if(!EV)return;let tgt=t0&&EV.targets[t0]?t0:(EV.targets[sel]?sel:'CAD');
  const card=$('#mcc'),colr={CAD:'var(--s1)',LAD:'var(--s2)',LCX:'var(--s3)',RCA:'var(--s4)'};
  const draw=()=>{const e=EV.targets[tgt],m=e.metrics,c=e.confusion;
    card.innerHTML=`<div style="display:flex;gap:10px;align-items:center"><div><div class="k" id="mct" style="margin:0">Model card</div><h2 class="t">What was trained, how it was tested, and what it cannot do</h2></div><button class="btn x" id="mcx" type="button">Close</button></div>
    <div class="mgrid" style="margin-top:12px">
    <div><div class="k">Data and inputs</div><p class="sm" style="margin:0 0 8px">Extension of the Z-Alizadeh Sani dataset (UCI #411): ${EV.n} patients from one referral centre, 43 demographic, examination, symptom, ECG, laboratory and echo features. The outcome columns LAD, LCX, RCA and Cath are never inputs (leakage guard, tested). A stenosis is at least 50% narrowing.</p>
      <div class="k">Validation</div><p class="sm" style="margin:0 0 8px">${esc(EV.protocol)}. All preprocessing sits inside the folds; hyper-parameters are tuned on log-loss in an inner 3-fold loop; the exported model per target is a logistic regression so the explanation is exact. Numbers below are pooled out-of-fold predictions.</p>
      <div class="k">Limits</div><ul class="sm" style="margin:0;padding-left:18px"><li>One centre, ${EV.n} patients, no external validation.</li><li>${Math.round(EV.targets.CAD.prevalence*100)}% of this cohort has CAD, so predicted probabilities describe a referral population.</li><li>LCX (AUC ${EV.targets.LCX.auc.toFixed(2)}) and RCA (${EV.targets.RCA.auc.toFixed(2)}) are only weakly predictable from clinical data.</li><li>The 3D heart is a generic adult atlas, not this patient. The CT module is a threshold demo, not a validated detector.</li></ul></div>
    <div><div class="k">Performance by target (threshold 0.5)</div><div class="scrollx"><table class="tbl"><thead><tr><th>Target</th><th>AUC (95% CI)</th><th>Acc</th><th>Prec</th><th>Rec</th><th>F1</th></tr></thead><tbody>${T.map(t=>{const q=EV.targets[t],mm=q.metrics;return `<tr${t===tgt?' style="background:color-mix(in srgb,var(--ac) 10%,transparent)"':''}><td>${t}</td><td>${q.auc.toFixed(2)}<div class="mu" style="font-size:10.5px;white-space:nowrap">${q.auc_ci95[0].toFixed(2)}–${q.auc_ci95[1].toFixed(2)}</div></td><td>${mm.accuracy[0].toFixed(2)}</td><td>${mm.precision[0].toFixed(2)}</td><td>${mm.recall[0].toFixed(2)}</td><td>${mm.f1[0].toFixed(2)}</td></tr>`}).join('')}</tbody></table></div>
      <p class="sm mu" style="margin:6px 0 10px">Mean over 5 CV repeats; ± across repeats is ≤0.05 for every metric. Prevalence: ${T.map(t=>t+' '+Math.round(EV.targets[t].prevalence*100)+'%').join(', ')}. LCX recall is low at 0.5; a lower threshold (Youden ${EV.targets.LCX.youden.threshold.toFixed(2)}) trades specificity for sensitivity.</p>
      <div class="k">Confusion matrix · ${tgt} (mean per ${EV.n} patients)</div><div class="scrollx"><table class="tbl"><thead><tr><th></th><th>Predicted positive</th><th>Predicted negative</th></tr></thead><tbody><tr><td>Has ${tgt}</td><td>${c.tp.toFixed(0)}</td><td>${c.fn.toFixed(0)}</td></tr><tr><td>No ${tgt}</td><td>${c.fp.toFixed(0)}</td><td>${c.tn.toFixed(0)}</td></tr></tbody></table></div></div>
    <div><div class="k">ROC curves (pooled out-of-fold)</div>${rocSvg(EV,colr)}</div>
    <div><div class="k">Calibration · ${tgt} <span class="mu" style="text-transform:none;letter-spacing:0">slope ${e.calibration_slope}</span></div>${relSvg(e)}<div class="ctl" style="margin-top:8px"><span class="sm mu">Show target:</span>${T.map(t=>`<button type="button" class="btn" data-mt="${t}" aria-pressed="${t===tgt}">${t}</button>`).join('')}</div></div>
    <div><div class="k">What drives ${tgt} overall (mean |SHAP|, log-odds)</div>${e.importance.map(([k,v])=>`<div class="imp"><span>${esc(FEAT[k]?FEAT[k].label:k)}</span><div class="bar"><i style="width:${v/e.importance[0][1]*100}%"></i></div><b class="mono sm">${v.toFixed(2)}</b></div>`).join('')}</div>
    </div>`;
    $('#mcx').onclick=closeModelCard;card.querySelectorAll('[data-mt]').forEach(b=>b.onclick=()=>{tgt=b.dataset.mt;draw()});$('#mcx').focus()};
  draw();$('#mcm').classList.add('on');
}
function closeModelCard(){$('#mcm').classList.remove('on');$('#mcb').focus()}
