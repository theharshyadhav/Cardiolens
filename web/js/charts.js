/* ===== SVG charts: colours come from CSS tokens only, so both themes work; every chart has a text/table equivalent ===== */
const HATCH='<defs><pattern id="hz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--mu)" stroke-opacity=".38" stroke-width="2"/></pattern></defs>';
const axisY=(L,W,R,Y,ticks)=>ticks.map(p=>`<line x1="${L}" x2="${W-R}" y1="${Y(p)}" y2="${Y(p)}" stroke="var(--bd)" stroke-width="1"/><text x="${L-6}" y="${Y(p)+3}" text-anchor="end">${Math.round(p*100)}%</text>`).join('');
/* What-if / partial-dependence curve: P(selected target) as ONE measurement varies, everything else fixed */
let WFD=null;
function renderWhatIf(){
  if(!wfUser){const d=E.drivers(M,S,RS,sel,M.features.length).find(o=>FEAT[o.key].kind!=='bin');if(d)$('#wf').value=d.key}
  const key=$('#wf').value,f=FEAT[key],W=360,H=210,L=38,R=12,Tp=12,B=38,iw=W-L-R,ih=H-Tp-B,bin=f.kind==='bin';
  const x0=bin?-.6:f.ui_min,x1=bin?1.6:f.ui_max,X=v=>L+(v-x0)/(x1-x0)*iw,Y=p=>Tp+(1-p)*ih;
  let xs=[];if(bin)xs=[0,1];else if(f.kind==='ord'){for(let v=f.ui_min;v<=f.ui_max;v++)xs.push(v)}else for(let i=0;i<64;i++)xs.push(f.ui_min+(f.ui_max-f.ui_min)*i/63);
  const pts=xs.map(x=>({x,p:E.coherent(E.predictAll(M,{...S,[key]:x}))[sel].p})),cur=clamp(S[key],f.ui_min,f.ui_max),now=RS[sel].p;
  WFD={key,f,pts,W,L,iw,x0,x1,X,Y};
  let g=HATCH+axisY(L,W,R,Y,[0,.25,.5,.75,1]);
  if(!bin){
    if(f.train_min>f.ui_min)g+=`<rect x="${X(f.ui_min)}" y="${Tp}" width="${X(f.train_min)-X(f.ui_min)}" height="${ih}" fill="url(#hz)"/>`;
    if(f.train_max<f.ui_max)g+=`<rect x="${X(f.train_max)}" y="${Tp}" width="${X(f.ui_max)-X(f.train_max)}" height="${ih}" fill="url(#hz)"/>`;
    const tk=f.kind==='ord'?xs:[0,1,2,3,4].map(i=>f.ui_min+(f.ui_max-f.ui_min)*i/4);
    g+=tk.map(v=>`<text x="${X(v)}" y="${Tp+ih+14}" text-anchor="middle">${f.kind==='ord'?v:(f.step<1?v.toFixed(1):Math.round(v))}</text>`).join('');
    g+=`<path d="M${pts.map(q=>X(q.x).toFixed(1)+','+Y(q.p).toFixed(1)).join('L')}L${X(x1)},${Y(0)}L${X(x0)},${Y(0)}Z" fill="var(--ac)" fill-opacity=".1"/>`;
    g+=`<path d="M${pts.map(q=>X(q.x).toFixed(1)+','+Y(q.p).toFixed(1)).join('L')}" fill="none" stroke="var(--ac)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if(f.kind==='ord')g+=pts.map(q=>`<circle cx="${X(q.x)}" cy="${Y(q.p)}" r="3.5" fill="var(--ac)" stroke="var(--pn)" stroke-width="2"/>`).join('');
  }else{
    g+=pts.map(q=>`<rect x="${X(q.x)-34}" y="${Y(q.p)}" width="68" height="${Y(0)-Y(q.p)}" rx="4" fill="var(--ac)" fill-opacity="${S[key]===q.x?.9:.35}"/><text x="${X(q.x)}" y="${Y(q.p)-5}" text-anchor="middle" style="fill:var(--tx)">${pc(q.p)}</text><text x="${X(q.x)}" y="${Tp+ih+14}" text-anchor="middle">${q.x?'Yes':'No'}</text>`).join('');
  }
  g+=`<text x="${L+iw/2}" y="${H-5}" text-anchor="middle">${esc(f.label)}${f.unit?' ('+esc(f.unit)+')':''}</text>`;
  g+=`<g><circle cx="${X(cur)}" cy="${Y(now)}" r="5.5" fill="${riskCss(now)}" stroke="var(--pn)" stroke-width="2.5"/><text x="${clamp(X(cur),L+22,W-R-22)}" y="${Y(now)-10}" text-anchor="middle" style="fill:var(--tx);font-weight:600">now ${pc(now)}</text></g>`;
  g+=`<g id="wch" style="display:none"><line id="wcl" y1="${Tp}" y2="${Tp+ih}" stroke="var(--mu)" stroke-dasharray="3 3"/><circle id="wcd" r="4" fill="var(--ac)" stroke="var(--pn)" stroke-width="2"/><text id="wct" style="fill:var(--tx);font-weight:600" text-anchor="middle"></text></g>`;
  const rows=bin?pts:xs.length>9?pts.filter((_,i)=>i%Math.ceil(pts.length/9)===0):pts;
  $('#wc').innerHTML=`<svg class="chart" id="wcs" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sel)} probability as ${esc(f.label)} varies; currently ${pc(now)}">${g}</svg>
    ${!bin&&(f.train_min>f.ui_min||f.train_max<f.ui_max)?'<div class="sm mu">Hatched = outside the range seen in training; the curve there is extrapolation.</div>':''}
    <details><summary>Values table</summary><div class="scrollx"><table class="tbl"><thead><tr><th>${esc(f.label)}</th><th>P(${sel})</th></tr></thead><tbody>${rows.map(q=>`<tr><td>${bin?(q.x?'Yes':'No'):(f.step<1?q.x.toFixed(1):Math.round(q.x))}</td><td>${pc(q.p)}</td></tr>`).join('')}</tbody></table></div></details>`;
}
function whatIfHover(e){
  const s=$('#wcs');if(!s||!WFD)return;const {f,pts,W,L,iw,x0,x1,X,Y}=WFD,r=s.getBoundingClientRect(),vx=(e.clientX-r.left)/r.width*W;
  if(vx<L||vx>L+iw){$('#wch').style.display='none';return}
  const v=x0+(vx-L)/iw*(x1-x0);let q=pts[0];for(const o of pts)if(Math.abs(o.x-v)<Math.abs(q.x-v))q=o;
  $('#wch').style.display='';$('#wcl').setAttribute('x1',X(q.x));$('#wcl').setAttribute('x2',X(q.x));$('#wcd').setAttribute('cx',X(q.x));$('#wcd').setAttribute('cy',Y(q.p));
  const t=$('#wct');t.setAttribute('x',clamp(X(q.x),L+40,W-50));t.setAttribute('y',Y(q.p)<40?Y(q.p)+20:Y(q.p)-10);
  t.textContent=`${f.kind==='bin'?(q.x?'Yes':'No'):(f.step<1?q.x.toFixed(1):Math.round(q.x))} → ${pc(q.p)}`;
}
/* ROC curves for the four exported models (pooled out-of-fold) */
function rocSvg(EV,colr){
  const W=340,H=340,L=38,R=10,Tp=10,B=38,iw=W-L-R,ih=H-Tp-B,X=v=>L+v*iw,Y=v=>Tp+(1-v)*ih,tk=[0,.25,.5,.75,1];
  let g=tk.map(v=>`<line x1="${L}" x2="${W-R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--bd)"/><line x1="${X(v)}" x2="${X(v)}" y1="${Tp}" y2="${Tp+ih}" stroke="var(--bd)"/><text x="${L-6}" y="${Y(v)+3}" text-anchor="end">${v}</text><text x="${X(v)}" y="${Tp+ih+14}" text-anchor="middle">${v}</text>`).join('');
  g+=`<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="var(--mu)" stroke-dasharray="4 4"/>`;
  T.forEach(t=>{g+=`<path d="M${EV.targets[t].roc.map(([a,b])=>X(a).toFixed(1)+','+Y(b).toFixed(1)).join('L')}" fill="none" stroke="${colr[t]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`});
  T.forEach((t,i)=>{const y=Y(.3)+i*15+6;g+=`<line x1="${X(.5)}" x2="${X(.5)+16}" y1="${y-3}" y2="${y-3}" stroke="${colr[t]}" stroke-width="2.5" stroke-linecap="round"/><text x="${X(.5)+22}" y="${y}" style="fill:var(--tx)">${t}  AUC ${EV.targets[t].auc.toFixed(2)}</text>`});
  g+=`<text x="${L+iw/2}" y="${H-4}" text-anchor="middle">False-positive rate</text><text transform="translate(10 ${Tp+ih/2}) rotate(-90)" text-anchor="middle">True-positive rate</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="ROC curves: ${T.map(t=>t+' AUC '+EV.targets[t].auc.toFixed(2)).join(', ')}">${g}</svg>`;
}
/* Reliability diagram: observed frequency vs predicted probability in 8 equal-count bins, Wilson 95% intervals */
function relSvg(e){
  const W=340,H=300,L=38,R=10,Tp=10,B=38,iw=W-L-R,ih=H-Tp-B,X=v=>L+v*iw,Y=v=>Tp+(1-v)*ih,tk=[0,.25,.5,.75,1];
  let g=tk.map(v=>`<line x1="${L}" x2="${W-R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--bd)"/><text x="${L-6}" y="${Y(v)+3}" text-anchor="end">${Math.round(v*100)}%</text><text x="${X(v)}" y="${Tp+ih+14}" text-anchor="middle">${Math.round(v*100)}%</text>`).join('');
  g+=`<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="var(--mu)" stroke-dasharray="4 4"/>`;
  g+=`<path d="M${e.reliability.map(b=>X(b[0]).toFixed(1)+','+Y(b[1]).toFixed(1)).join('L')}" fill="none" stroke="var(--ac)" stroke-width="2"/>`;
  g+=e.reliability.map(b=>`<line x1="${X(b[0])}" x2="${X(b[0])}" y1="${Y(b[2])}" y2="${Y(b[3])}" stroke="var(--ac)" stroke-width="1.5"/><circle cx="${X(b[0])}" cy="${Y(b[1])}" r="4.5" fill="var(--ac)" stroke="var(--pn)" stroke-width="2"><title>predicted ${Math.round(b[0]*100)}% · observed ${Math.round(b[1]*100)}% (n=${b[4]})</title></circle>`).join('');
  g+=`<text x="${L+iw/2}" y="${H-4}" text-anchor="middle">Predicted probability</text><text transform="translate(10 ${Tp+ih/2}) rotate(-90)" text-anchor="middle">Observed frequency</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calibration: points near the diagonal mean the predicted probabilities match observed frequencies">${g}</svg>`;
}
