/* ===== Cardiac MRI panel: short-axis cine (DICOM) -> LV volumes and ejection fraction -> beating patient LV in 3D. Pixels never leave this tab. ===== */
let CN=null,CM=null,CV=null,CKP=[],CPH=0,CSL=0,CPLAY=false,CBUSY=false,CERR='',CEP=0,CLVON=false,CGH=true,CCEN=false,CMESH=null,CEF0=null,CRAF=0,CLASTD=0,CWIN=255,CPROG=0,CMSG='',CMAN=null;
const cnOff=document.createElement('canvas'),cnF=(v,n=1)=>(+v).toFixed(n);
const cnAreaCm=(s,t)=>CM.areas[s][t]/100;
const cnBump=()=>{const e=++CEP;if(pend)pend(false);return e};   // a new / changed cine cancels a pending export approval (same pattern as the CT epoch)
/* ---- loading ---- */
function cnStatus(t,p){CMSG=t;CPROG=p||0;const m=$('#cmsg');if(m&&CBUSY)m.innerHTML=`${esc(t)} <span class="cprog"><i style="width:${Math.round(100*(p||0))}%"></i></span>`}
async function cnFiles(files,rd){   // files: File[] to read; rd: files already read (by the CT drop zone). Names of files and folders are never used as labels: they often carry patient names or ids.
  files=[...(files||[])];if(!files.length&&!rd)return;
  const ep=cnBump();CBUSY=true;CERR='';cnStop();cnStatus(rd?'Preparing the cine…':'Reading '+files.length+' file'+(files.length>1?'s':'')+'…',0);cnRender();
  try{
    rd=rd||await DicomLib.readFiles(files,p=>cnStatus('Reading files…',p*.3));
    if(ep!==CEP)return;
    const c=DicomLib.classify(rd);
    if(c.kind==='none')throw Error(c.message);
    if(c.kind==='ct'){CBUSY=false;cnRender();$('#cmsg').textContent='These are CT images, so they were opened in the CT reading room.';openCtSeries(c);bring($('#room'));return}
    const cine=DicomLib.buildCine(c.instances);cine.name='MRI cine (DICOM)';cine.skipped=rd.stats.skipped;if(c.notes.length)cine.warnings=(cine.warnings||[]).concat(c.notes);
    await cnStart(cine,ep,null);
  }catch(e){if(ep===CEP){CN=null;CM=null;CV=null;CERR=DicomLib.explain(e.message||'The files could not be read.')}}
  if(ep===CEP){CBUSY=false;cnRender()}
}
async function cnSample(){
  const ep=cnBump();CBUSY=true;CERR='';cnStop();cnStatus('Unpacking the sample…',0);cnRender();
  try{const cine=await CineLib.fromSample(CINE_SAMPLE);await cnStart(cine,ep,null)}catch(e){if(ep===CEP){CN=null;CM=null;CV=null;CERR=e.message}}
  if(ep===CEP){CBUSY=false;cnRender()}
}
/* display brightness: 99.7th percentile of every 11th pixel of the middle slice at four phases (white level of the 8-bit preview) */
function cnWindow(c){const f=c.frames[c.S>>1],n=c.H*c.W,px=[];for(let t=0;t<c.T;t+=Math.max(1,c.T>>2))for(let i=0;i<n;i+=11)px.push(f[t][i]);px.sort((a,b)=>a-b);return Math.max(1,px[Math.floor(px.length*.997)]||1)}
async function cnStart(cine,ep,centre){
  CN=cine;CM=null;CV=null;CMESH=null;CMAN=centre;cnLv(false);
  CWIN=cnWindow(cine);
  cnStatus('Finding the left ventricle…',.3);cnRender();
  const M=await CineLib.measure(cine,{centre,onProgress:p=>{if(ep===CEP)cnStatus('Tracing the heart wall…',.3+.7*p)}});
  if(ep!==CEP)return;
  CM=M;CKP=M.keep.slice();CV=CineLib.volumes(M,CKP);CSL=M.s0;CPH=CV.ed;
}
function cnStop(){CPLAY=false;cancelAnimationFrame(CRAF);CRAF=0;const b=$('#cpl');if(b){b.textContent='Play';b.setAttribute('aria-pressed','false')}}
/* ---- numbers ---- */
function cnRecalc(){CV=CineLib.volumes(CM,CKP);CMESH=null;if(CLVON){cnLv(true,true)}cnRender()}
function cnEfClass(ef){return ef>=55?'within the 55–75% usually seen in healthy adults':ef>=41?'below the 55–75% usually seen in healthy adults':'well below the 55–75% usually seen in healthy adults'}
function cnTime(t){const a=CN.trigger_ms.map(r=>r[t]).filter(v=>v!==null&&v!==undefined);return a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null}
function cnReport(){
  if(!CM||!CV)return null;const sp=CV.spread,r=(v,n=1)=>+(+v).toFixed(n);
  return{source:CN.sample?'built-in sample (Sunnybrook Cardiac Data, public domain)':'user DICOM series',slices_total:CN.S,slices_used:CKP.map(s=>s+1),slices_switched_by_user:CKP.length!==CM.keep.length||CKP.some((s,i)=>s!==CM.keep[i]),phases:CN.T,
    edv_ml:r(CV.edv),esv_ml:r(CV.esv),sv_ml:r(CV.sv),ef_pct:r(CV.ef),ef_range_pct:sp.ef.map(v=>r(v)),edv_range_ml:sp.edv.map(v=>r(v)),esv_range_ml:sp.esv.map(v=>r(v)),ed_phase:CV.ed+1,es_phase:CV.es+1,
    heart_rate_bpm:CN.hr_bpm,cardiac_output_l_min:CN.hr_bpm?r(CV.sv*CN.hr_bpm/1000,2):null,pixel_spacing_mm:r(CN.px[0],3),slice_spacing_mm:r(CN.dz,2),
    method:'classical contour tracing (no learned model) + modified Simpson; automatic estimate, not validated; range = sensitivity to 5 segmentation settings, not a confidence interval',warnings:CM.warnings.slice(0,6),ef_used_in_risk_model:CEF0!==null}
}
/* ---- drawing ---- */
function cnFrame(s,t){
  const H=CN.H,W=CN.W,f=CN.frames[s][t];cnOff.width=W;cnOff.height=H;const c=cnOff.getContext('2d'),im=c.createImageData(W,H),k=255/CWIN;
  for(let i=0;i<W*H;i++){const v=Math.max(0,Math.min(255,f[i]*k)),o=i*4;im.data[o]=im.data[o+1]=im.data[o+2]=v;im.data[o+3]=255}
  c.putImageData(im,0,0);return cnOff;
}
function cnPath(ctx,s,t,sx,sy){
  const R=CM.res[s],cx=R.centre[0],cy=R.centre[1],NA=CineLib.NA,C=CineLib.ANG;ctx.beginPath();
  for(let j=0;j<NA;j++){const r=R.Rr[t*NA+j],x=(cx+r*C.cos[j]+.5)*sx,y=(cy+r*C.sin[j]+.5)*sy;j?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.closePath();
}
function cnDraw(){
  const c=$('#cc');if(!c||!CN||!CM)return;const st=c.parentElement,dpr=Math.min(window.devicePixelRatio||1,2),w=Math.round(st.clientWidth*dpr),h=Math.round(st.clientHeight*dpr);
  if(!w||!h)return;if(c.width!==w||c.height!==h){c.width=w;c.height=h}
  const ctx=c.getContext('2d'),t=((Math.floor(CPH)%CN.T)+CN.T)%CN.T,s=CSL,sx=w/CN.W,sy=h/CN.H,inc=CKP.includes(s);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(cnFrame(s,t),0,0,w,h);
  ctx.lineJoin='round';
  if(CGH&&CV&&inc){
    ctx.lineWidth=1.4*dpr;ctx.setLineDash([5*dpr,4*dpr]);ctx.strokeStyle='rgba(255,255,255,.62)';cnPath(ctx,s,CV.ed,sx,sy);ctx.stroke();
    ctx.setLineDash([2*dpr,3*dpr]);ctx.strokeStyle='rgba(159,180,214,.9)';cnPath(ctx,s,CV.es,sx,sy);ctx.stroke();ctx.setLineDash([]);
  }
  ctx.lineWidth=2*dpr;ctx.strokeStyle=inc?'#19c8ff':'rgba(255,170,60,.9)';if(!inc)ctx.setLineDash([3*dpr,3*dpr]);cnPath(ctx,s,t,sx,sy);ctx.stroke();ctx.setLineDash([]);
  const cc=CM.res[s].centre;ctx.strokeStyle='rgba(255,255,255,.55)';ctx.lineWidth=1*dpr;ctx.beginPath();ctx.moveTo((cc[0]+.5)*sx-5*dpr,(cc[1]+.5)*sy);ctx.lineTo((cc[0]+.5)*sx+5*dpr,(cc[1]+.5)*sy);ctx.moveTo((cc[0]+.5)*sx,(cc[1]+.5)*sy-5*dpr);ctx.lineTo((cc[0]+.5)*sx,(cc[1]+.5)*sy+5*dpr);ctx.stroke();
  const tag=t===CV.ed?' · end-diastole':t===CV.es?' · end-systole':'',ms=cnTime(t);
  $('#ccl').textContent=`slice ${s+1}/${CN.S} · phase ${t+1}/${CN.T}${ms!==null?' · '+ms+' ms':''}${tag}`;
  $('#cinfo').innerHTML=`${inc?'Counted in the volume':'<b>Not counted</b> (switched off)'} · cavity area ${cnF(cnAreaCm(s,t),1)} cm² at this phase · ED ${cnF(cnAreaCm(s,CV.ed),1)} / ES ${cnF(cnAreaCm(s,CV.es),1)} cm²`;
  const ph=$('#cph');if(ph&&+ph.value!==t)ph.value=t;
  cnPlayhead();
}
const cnSvg={w:560,h:200,l:46,r:12,t:16,b:40},cnChartW=el=>Math.round(clamp(el&&el.clientWidth||560,300,720));
let cnSc={y0:0,y1:1};   // y-axis range of the volume chart, set by cnChart and read by cnPlayhead on every animation frame
function cnChart(){
  const el=$('#cvc');if(!el||!CV)return;const T=CN.T,sp=CV.spread,G=cnSvg;G.w=cnChartW(el);G.h=Math.round(clamp(G.w*.34,190,240));   // viewBox = real width: labels keep their size on a phone
  const lo=Math.min(...sp.curves.map(c=>Math.min(...c)),...CV.Vs),hi=Math.max(...sp.curves.map(c=>Math.max(...c)),...CV.Vs);
  const step=hi-lo>120?40:hi-lo>60?20:10,y0=Math.max(0,Math.floor((lo-5)/step)*step),y1=Math.ceil((hi+8)/step)*step,X=i=>G.l+(G.w-G.l-G.r)*i/(T-1),Y=v=>G.h-G.b-(G.h-G.b-G.t)*(v-y0)/(y1-y0);
  cnSc={y0,y1};
  const bandHi=[],bandLo=[];for(let i=0;i<T;i++){bandHi.push(Math.max(...sp.curves.map(c=>c[i])));bandLo.push(Math.min(...sp.curves.map(c=>c[i])))}
  const band=`M${[...bandHi.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`),...bandLo.map((v,i)=>`${X(T-1-i).toFixed(1)},${Y(bandLo[T-1-i]).toFixed(1)}`)].join('L')}Z`,
    line='M'+Array.from(CV.Vs,(v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('L');
  let g='';for(let v=y0;v<=y1;v+=step)g+=`<line x1="${G.l}" x2="${G.w-G.r}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="${G.l-6}" y="${Y(v)+3.5}" text-anchor="end">${v}</text>`;
  const xt=[0,4,9,14,T-1].filter((v,i,a)=>a.indexOf(v)===i&&v<T);
  g+=xt.map(i=>`<text x="${X(i)}" y="${G.h-G.b+14}" text-anchor="middle">${i+1}</text><text x="${X(i)}" y="${G.h-G.b+25}" text-anchor="middle" class="ms">${cnTime(i)!==null?cnTime(i)+' ms':''}</text>`).join('');
  const mk=(i,lab,up)=>`<circle cx="${X(i)}" cy="${Y(CV.Vs[i])}" r="4.5" class="mk"/><text x="${X(i)}" y="${Y(CV.Vs[i])+(up?-9:17)}" text-anchor="middle" class="lb">${lab} ${cnF(CV.Vs[i],0)} mL</text>`;
  el.innerHTML=`<svg viewBox="0 0 ${G.w} ${G.h}" class="chart" role="img" aria-label="Left-ventricle volume over the cardiac cycle: ${cnF(CV.edv,0)} mL at end-diastole (phase ${CV.ed+1}), ${cnF(CV.esv,0)} mL at end-systole (phase ${CV.es+1}); shaded range across five segmentation settings.">
    ${g}<path d="${band}" class="band2"/><path d="${line}" class="ln"/>${Array.from(CV.Vs,(v,i)=>`<circle cx="${X(i)}" cy="${Y(v)}" r="2.2" class="pt"/>`).join('')}${mk(CV.ed,'ED',CV.ed!==CV.es&&CV.Vs[CV.ed]>=CV.Vs[CV.es])}${mk(CV.es,'ES',false)}
    <g id="cph-g"><line id="cph-l" y1="${G.t}" y2="${G.h-G.b}" class="ph"/><circle id="cph-c" r="4" class="phc"/></g>
    <text x="${G.l}" y="10" class="ax">LV volume, mL</text><text x="${(G.l+G.w-G.r)/2}" y="${G.h-2}" text-anchor="middle" class="ax">cardiac phase (time after the R wave)</text></svg><div class="tip2" id="cvt" hidden></div>`;
  cnPlayhead();
}
function cnPlayhead(){
  const l=$('#cph-l'),c=$('#cph-c');if(!l||!CV)return;const T=CN.T,G=cnSvg,p=((CPH%T)+T)%T,i0=Math.floor(p),i1=(i0+1)%T,f=p-i0,v=CV.Vs[i0]+(CV.Vs[i1]-CV.Vs[i0])*f,
    x=G.l+(G.w-G.l-G.r)*Math.min(p,T-1)/(T-1),y=G.h-G.b-(G.h-G.b-G.t)*(v-cnSc.y0)/(cnSc.y1-cnSc.y0);
  l.setAttribute('x1',x);l.setAttribute('x2',x);c.setAttribute('cx',x);c.setAttribute('cy',y);
}
function cnRender(){
  const has=!!(CN&&CM&&CV),b=$('#cb');if(!b)return;
  $('#cmsg').innerHTML=CBUSY?`${esc(CMSG)} <span class="cprog"><i style="width:${Math.round(100*CPROG)}%"></i></span>`:CERR?`<span class="warn" style="display:block;margin:0;text-align:left"><b>Could not measure:</b> ${esc(CERR)}</span>`:has?`<span class="mu">${esc(CN.sample?'Built-in sample: '+CN.source:(CN.name||'Series')+' · '+CN.S+' slices × '+CN.T+' phases · '+(CN.scanner||'scanner unknown')+(CN.field_strength_t?' · '+CN.field_strength_t+' T':''))}. Drop other files here to replace it.</span>`:'Drop a folder, DICOM files or a .zip of one short-axis cine series here (bright-blood images, 1 image per slice and cardiac phase). Nothing is uploaded.';
  b.hidden=!has;const lb=$('#lvb');if(lb)lb.hidden=!has;if(!has)return;
  const sp=CV.spread,r0=v=>cnF(v,0),ef=CV.ef,co=CN.hr_bpm?CV.sv*CN.hr_bpm/1000:null,low=Math.min(...CV.Vs);
  const tile=(v,u,l,rg)=>`<div class="tile"><b>${v}<small>${u}</small></b><span>${l}</span>${rg?`<em>${rg}</em>`:''}</div>`;
  const gp=v=>Math.max(0,Math.min(100,v/80*100));
  $('#cres').innerHTML=`
    <div class="tiles">${tile(r0(ef),'%','Ejection fraction',`range ${r0(sp.ef[0])}–${r0(sp.ef[1])}`)}${tile(r0(CV.edv),' mL','End-diastolic volume',`range ${r0(sp.edv[0])}–${r0(sp.edv[1])}`)}${tile(r0(CV.esv),' mL','End-systolic volume',`range ${r0(sp.esv[0])}–${r0(sp.esv[1])}`)}${tile(r0(CV.sv),' mL','Stroke volume','')}${tile(CN.hr_bpm?cnF(CN.hr_bpm,0):'–',' bpm','Heart rate during scan','')}${tile(co===null?'–':cnF(co,1),' L/min','Cardiac output (SV × HR)','')}</div>
    <div class="gauge" role="img" aria-label="Ejection fraction ${r0(ef)} percent, range ${r0(sp.ef[0])} to ${r0(sp.ef[1])}; healthy adults typically 55 to 75 percent"><i class="gn" style="left:${gp(55)}%;width:${gp(75)-gp(55)}%"></i><i class="gr" style="left:${gp(sp.ef[0])}%;width:${Math.max(.8,gp(sp.ef[1])-gp(sp.ef[0]))}%"></i><b style="left:${gp(ef)}%"></b></div>
    <div class="gl2"><span>0</span><span>20</span><span>40</span><span>60</span><span>80 %</span></div>
    <p class="sm" style="margin:4px 0 8px">EF ${r0(ef)}% is ${cnEfClass(ef)} (shaded band; adult cardiac-MRI reference). The thin bar is the range over five segmentation settings, not a confidence interval.</p>
    <div class="k" style="margin-top:6px">Volume over one heartbeat</div><div id="cvc"></div>
    <div class="sm mu" style="margin:-2px 0 4px"><i class="lgd ln"></i>base settings <i class="lgd bd"></i>range over 5 settings · click the curve to jump to a phase</div>
    <details><summary>Volume table <span class="mu">${CN.T} phases</span></summary><div class="scrollx"><table class="tbl"><thead><tr><th>Phase</th><th>ms</th><th>Volume mL</th><th>Range mL</th></tr></thead><tbody>${Array.from(CV.Vs,(v,i)=>`<tr><td>${i+1}${i===CV.ed?' ED':i===CV.es?' ES':''}</td><td>${cnTime(i)??'–'}</td><td>${cnF(v,1)}</td><td>${cnF(Math.min(...sp.curves.map(c=>c[i])),0)}–${cnF(Math.max(...sp.curves.map(c=>c[i])),0)}</td></tr>`).join('')}</tbody></table></div></details>
    <div class="bar-row" style="margin-top:10px"><button class="btn pri" id="cef" type="button">${CEF0===null?'Use this EF in the risk model':'EF in the risk model: '+S.ef+'% · undo'}</button><button class="btn" id="clv" type="button" aria-pressed="${CLVON}">${CLVON?'Hide my LV in 3D':'Show my LV in 3D'}</button></div>
    <div class="sm mu" id="cnote" style="margin-top:4px">${CEF0===null?'The risk model was trained on echocardiographic EF; MRI EF can differ by several points. This only moves the “Ejection fraction (echo)” input.':'Changed the “Ejection fraction (echo)” input from '+CEF0+'% to '+S.ef+'%. Press again to restore it.'}</div>
    ${CM.warnings.length?`<div class="warn"><b>Check this</b><ul style="margin:4px 0 0;padding-left:18px">${CM.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`:''}
    <p class="sm mu" style="margin:8px 0 0">Automatic estimate from classical image processing, no learned model and no manual contours; basal slices at the valve plane are left out and papillary muscles count as cavity, so volumes may be underestimated. Not validated: not a diagnosis. The demo subject is a 27-year-old, outside the clinical model's training ages (30–86), so the coronary risk numbers do not apply to this person.</p>`;
  $('#csl').max=CN.S-1;$('#csl').value=CSL;$('#cph').max=CN.T-1;$('#cph').value=Math.floor(CPH)%CN.T;
  const base=CM.medArea[CM.keep[0]]>=CM.medArea[CM.keep[CM.keep.length-1]]?0:CN.S-1;
  $('#cch').innerHTML=Array.from({length:CN.S},(_,s)=>{const inc=CKP.includes(s),auto=CM.keep.includes(s);
    return `<div class="cc1${s===CSL?' cur':''}"><button type="button" data-v="${s}" aria-label="View slice ${s+1}" aria-current="${s===CSL}" title="View slice ${s+1}${s===base?' (base)':s===CN.S-1-base?' (apex)':''}">${s+1}</button><input type="checkbox" data-i="${s}" ${inc?'checked':''} aria-label="Count slice ${s+1} in the volume" title="${auto?'Counted by the automatic selection':'Left out by the automatic selection (it looked like atrium / outflow tract or too small)'}${inc!==auto?' · changed by you':''}"></div>`}).join('');
  cnCentreUi();$('#cgh').checked=CGH;
  cnDraw();cnChart();
}
/* ---- actions ---- */
function cnUseEf(){
  if(!CV)return;
  if(CEF0!==null){S.ef=CEF0;CEF0=null;sync();update();cnRender();return}
  const f=FEAT.ef;CEF0=S.ef;S.ef=Math.round(clamp(CV.ef,f.ui_min,f.ui_max));sync();update();cnRender();
}
function cnLv(on,rebuild){
  if(on&&!CM)return false;
  if(on){
    if(!CMESH||rebuild){CMESH=CineLib.buildMesh(CM,CN,CKP);if(CMESH)CMESH.hr=CN.hr_bpm}
    if(!CMESH||!V){CLVON=false;return false}
    V.lvSet(CMESH);V.lvShow(true);CLVON=true;V.lvPhase(CPH);
    $('#lvb').hidden=false;$('#lvb').setAttribute('aria-pressed','true');cnLvCard();
  }else{
    CLVON=false;if(V){V.lvShow(false);if(!CM)V.lvClear()}
    const b=$('#lvb');if(b){b.setAttribute('aria-pressed','false');b.hidden=!CM}
    $('#lvc').hidden=true;
  }
  const c=$('#clv');if(c){c.textContent=CLVON?'Hide my LV in 3D':'Show my LV in 3D';c.setAttribute('aria-pressed',String(CLVON))}
  return CLVON;
}
function cnLvCard(){
  const k=$('#lvc');k.hidden=false;
  k.innerHTML=`<div class="nm">Your left ventricle (cine MRI)</div><div class="ds" style="display:block">ED ${cnF(CV.edv,0)} mL → ES ${cnF(CV.esv,0)} mL, EF ${cnF(CV.ef,0)}%, beating at ${CN.hr_bpm?cnF(CN.hr_bpm,0)+' bpm':'the scanned rate'}. <span class="lvx">Cavity surface traced from your images; faint outline = end-diastole. Placed in the generic atlas by centre and long axis, at true size. </span>Not an anatomical registration.</div>`;
}
function cnPlay(on){
  CPLAY=on;const b=$('#cpl');if(b){b.textContent=on?'Pause':'Play';b.setAttribute('aria-pressed',String(on))}
  cancelAnimationFrame(CRAF);if(!on)return;
  const T=CN.T,rr=(CN.rr_ms?CN.rr_ms.reduce((a,x)=>a+x,0)/CN.rr_ms.length:1000)/1000;let last=performance.now();
  const step=now=>{if(!CPLAY)return;CRAF=requestAnimationFrame(step);const dt=Math.min(.2,(now-last)/1000);last=now;CPH=(CPH+dt/rr*T*(+$('#cspd').value||1))%T;
    if(CLVON&&V)V.lvPhase(CPH);if(now-CLASTD>33){CLASTD=now;cnDraw()}};
  CRAF=requestAnimationFrame(step);
}
function cnSetPhase(p){CPH=p;cnStopKeepLv();if(CLVON&&V)V.lvPhase(CPH);cnDraw()}
function cnStopKeepLv(){CPLAY=false;cancelAnimationFrame(CRAF);const b=$('#cpl');if(b){b.textContent='Play';b.setAttribute('aria-pressed','false')}}
async function cnRemeasure(centre){
  if(!CN)return;const ep=cnBump();CBUSY=true;CERR='';cnStop();cnStatus('Re-measuring from the point you clicked…',.3);$('#cb').hidden=true;
  try{await cnStart(CN,ep,centre)}catch(e){if(ep===CEP){CM=null;CV=null;CERR=e.message}}
  if(ep===CEP){CBUSY=false;CCEN=false;cnRender()}
}
/* ---- wiring ---- */
$('#cf').onchange=e=>{const f=[...e.target.files];e.target.value='';cnFiles(f)};
$('#cd').onchange=e=>{const f=[...e.target.files];e.target.value='';cnFiles(f)};
$('#cs').onclick=cnSample;
const cz=$('#cz');['dragenter','dragover'].forEach(n=>cz.addEventListener(n,e=>{e.preventDefault();cz.classList.add('on')}));['dragleave','drop'].forEach(n=>cz.addEventListener(n,e=>{e.preventDefault();cz.classList.remove('on')}));
cz.addEventListener('drop',async e=>{const f=await dropFiles(e.dataTransfer);cnFiles(f)});
$('#cpl').onclick=()=>{if(!CM)return;if(CPLAY)cnStopKeepLv();else cnPlay(true)};
$('#csl').oninput=e=>{CSL=+e.target.value;cnRenderChips();cnDraw()};
$('#cph').oninput=e=>cnSetPhase(+e.target.value);
function cnRenderChips(){$$('#cch .cc1').forEach((d,i)=>{d.classList.toggle('cur',i===CSL);d.querySelector('button').setAttribute('aria-current',String(i===CSL))})}
$('#cch').onclick=e=>{const b=e.target.closest('button[data-v]');if(b){CSL=+b.dataset.v;$('#csl').value=CSL;cnRenderChips();cnDraw()}};
$('#cch').onchange=e=>{const i=e.target.dataset.i;if(i===undefined||!CM)return;const s=+i,k=new Set(CKP);e.target.checked?k.add(s):k.delete(s);if(!k.size){e.target.checked=true;return}CKP=[...k].sort((a,b)=>a-b);cnRecalc()};
$('#cgh').onchange=e=>{CGH=e.target.checked;cnDraw()};
function cnCentreUi(){$('#cct').setAttribute('aria-pressed',String(CCEN));$('#cc').style.cursor=CCEN?'crosshair':'default';$('#cctn').textContent=CCEN?'Click the middle of the left-ventricle blood pool on this image.':''}   // button, cursor and hint always follow CCEN (also after a re-measure ends)
$('#cct').onclick=()=>{CCEN=!CCEN;cnCentreUi()};
$('#cc').onpointerdown=e=>{if(!CCEN||!CN)return;const r=e.currentTarget.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*CN.W-.5,y=(e.clientY-r.top)/r.height*CN.H-.5;cnRemeasure([CSL,x,y])};
$('#cres').onclick=e=>{
  if(e.target.closest('#cef'))cnUseEf();
  else if(e.target.closest('#clv')){if(CLVON)cnLv(false);else if(cnLv(true))cnPlayAuto()}
  const c=e.target.closest('#cvc svg');if(c&&CN){const r=c.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*cnSvg.w,i=Math.round((x-cnSvg.l)/(cnSvg.w-cnSvg.l-cnSvg.r)*(CN.T-1));cnSetPhase(clamp(i,0,CN.T-1))}};
$('#cres').onpointermove=e=>{
  const svg=e.target.closest('#cvc svg'),tp=$('#cvt');if(!tp)return;if(!svg||!CV){tp.hidden=true;return}
  const r=svg.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*cnSvg.w,i=clamp(Math.round((x-cnSvg.l)/(cnSvg.w-cnSvg.l-cnSvg.r)*(CN.T-1)),0,CN.T-1),sp=CV.spread,ms=cnTime(i);
  tp.hidden=false;tp.style.top='6px';
  tp.textContent=`phase ${i+1}${ms!==null?' · '+ms+' ms':''} · ${cnF(CV.Vs[i],1)} mL (${cnF(Math.min(...sp.curves.map(c=>c[i])),0)}–${cnF(Math.max(...sp.curves.map(c=>c[i])),0)})`;
  tp.style.left=clamp(e.clientX-r.left+12,0,Math.max(0,r.width-tp.offsetWidth-2))+'px'};
$('#cres').onpointerleave=()=>{const t=$('#cvt');if(t)t.hidden=true};
function cnPlayAuto(){if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&!CPLAY)cnPlay(true);$('#v').scrollIntoView({behavior:'smooth',block:'nearest'})}
$('#lvb').onclick=()=>{if(CLVON)cnLv(false);else if(cnLv(true))cnPlayAuto()};
new ResizeObserver(()=>{if(CM)cnDraw()}).observe($('#cc').parentElement);
new ResizeObserver(()=>{const el=$('#cvc');if(CV&&el&&el.clientWidth&&Math.abs(cnChartW(el)-cnSvg.w)>6)cnChart()}).observe($('#cres'));
/* folders dropped onto a drop zone: walk the directory tree */
async function dropFiles(dt){
  const out=[],walk=async en=>{if(en.isFile)out.push(await new Promise((res,rej)=>en.file(res,rej)));else if(en.isDirectory){const rd=en.createReader();for(;;){const b=await new Promise((res,rej)=>rd.readEntries(res,rej));if(!b.length)break;for(const c of b)await walk(c)}}};
  const items=dt.items?[...dt.items].map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()):[];
  if(items.length&&items.every(Boolean)){for(const it of items)await walk(it);return out}
  return [...dt.files];
}
/* ---- agent tools: metadata and measurements only, never pixels or mesh ---- */
const needCine=()=>CBUSY?'A cine series is still being measured. Wait a moment, then call describe_cine.':CM?null:(CERR?`No cine MRI is loaded: the last selection could not be measured (${CERR}). `:'No cine MRI is loaded. ')+'Ask the user to open a short-axis cine series (DICOM files, a folder or a .zip) or press “Load sample” in the Cardiac MRI panel, then retry.';
const cnNum=v=>+(+v).toFixed(1);
reg('describe_cine','Describe the loaded short-axis cine MRI: slices, phases, pixel size, slice spacing, heart rate, scanner, whether the built-in sample is loaded and whether the LV has been measured. Pixels never leave the tab.',{},()=>{
  const e=needCine();if(e&&!CN)return fail(e);if(CBUSY)return fail(e);
  return ok(`"${CN.name||'series'}"${CN.sample?' (public-domain sample)':''}: ${CN.S} slices × ${CN.T} phases, ${CN.W}×${CN.H} px at ${cnNum(CN.px[0]*100)/100} mm, slice spacing ${cnNum(CN.dz)} mm${CN.hr_bpm?`, ${cnNum(CN.hr_bpm)} bpm`:''}. ${CM?'The left ventricle has been measured: call measure_lv for the numbers.':'Call measure_lv to measure the left ventricle.'}`,
    {name:CN.name||null,sample:!!CN.sample,slices:CN.S,phases:CN.T,pixels:[CN.W,CN.H],pixel_spacing_mm:+CN.px[0].toFixed(3),slice_spacing_mm:+CN.dz.toFixed(2),heart_rate_bpm:CN.hr_bpm,scanner:CN.scanner||null,field_strength_t:CN.field_strength_t||null,measured:!!CM,study_epoch:CEP,warnings:(CN.warnings||[]).slice(0,5)})},true);
reg('measure_lv','Measure the left ventricle from the loaded cine MRI: end-diastolic / end-systolic volume (mL), stroke volume, ejection fraction (%), cardiac output, which slices were counted, and the range over five segmentation settings. Automatic classical estimate, not validated. Optional centre (1-based slice and pixel x, y) re-runs the tracing from a point inside the LV blood pool. Returns numbers only.',
  {centre_slice:{type:'integer'},centre_x:{type:'number'},centre_y:{type:'number'}},async a=>{
  if(!CN)return fail(needCine());const n=v=>Number.isFinite(+v)&&v!==null&&v!==undefined&&v!=='';
  if(n(a.centre_slice)||n(a.centre_x)||n(a.centre_y)){
    if(!(n(a.centre_slice)&&n(a.centre_x)&&n(a.centre_y)))return fail('Give centre_slice, centre_x and centre_y together (slice 1-based, x and y in image pixels).');
    const s=Math.round(+a.centre_slice)-1;if(s<0||s>=CN.S||+a.centre_x<0||+a.centre_x>=CN.W||+a.centre_y<0||+a.centre_y>=CN.H)return fail(`centre must lie inside the image: slice 1-${CN.S}, x 0-${CN.W-1}, y 0-${CN.H-1}.`);
    await cnRemeasure([s,+a.centre_x,+a.centre_y]);
  }else if(!CM){if(CBUSY)return fail(needCine());await cnRemeasure(null)}
  if(!CM)return fail(needCine());
  const r=cnReport();return ok(`Left ventricle (cine MRI, automatic estimate): EDV ${r.edv_ml} mL, ESV ${r.esv_ml} mL, SV ${r.sv_ml} mL, EF ${r.ef_pct}% (range ${r.ef_range_pct[0]}-${r.ef_range_pct[1]}% over five segmentation settings)${r.cardiac_output_l_min?`, cardiac output ${r.cardiac_output_l_min} L/min at ${r.heart_rate_bpm} bpm`:''}. Counted slices ${r.slices_used.join(', ')} of ${r.slices_total}. Not validated; not a diagnosis.${r.warnings.length?' Warnings: '+r.warnings.join(' '):''}`,{...r,study_epoch:CEP})},true);
reg('show_lv_3d','Show or hide the patient\'s own beating left-ventricle cavity (from the cine MRI) inside the 3D heart. Moves the view only; no geometry is returned.',{on:{type:'boolean'}},a=>{
  const e=needCine();if(e)return fail(e);if(!V)return fail('The 3D view is not available (WebGL missing or still loading).');const on=a.on===undefined?true:!!a.on;
  const res=cnLv(on);if(on&&res)cnPlayAuto();return ok(res?`Showing the patient's left ventricle beating at ${CN.hr_bpm?cnNum(CN.hr_bpm)+' bpm':'the scanned rate'} in the 3D heart (EDV ${cnNum(CV.edv)} mL, EF ${cnNum(CV.ef)}%).`:'Patient left ventricle hidden.',{shown:res,end_diastolic_volume_ml:cnNum(CV.edv),ejection_fraction_pct:cnNum(CV.ef)})});
cnRender();
