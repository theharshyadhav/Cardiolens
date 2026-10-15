/* ===== Scan reading room + WebMCP tools. The volume never leaves this tab; every tool returns measurements or metadata only. ===== */
try{WebMCP.installPolyfill()}catch(e){}
let VOL=null,RG=null,epoch=0,loading=false,reading='',OPENTOK=0,OPMSG=null,foc=0,focL=0,pend=null,loadErr='',HB=null,HD=null;
const vw={ax:'axial',k:0,wl:[40,400]},asg={},TOOLS={},DOCS={},WL={'Soft tissue':[40,400],Calcium:[300,600],Lung:[-600,1500]};
const q=(()=>{let t=Promise.resolve();return f=>{const r=t.then(f);t=r.then(()=>{},()=>{});return r}})();
const fail=t=>({content:[{type:'text',text:t}],isError:true}),ok=(t,s)=>({content:[{type:'text',text:t}],structuredContent:s});
const needVol=()=>(loading||reading)?'A scan is loading. Wait for it to finish, then call describe_scan.':VOL?null:(loadErr?`No scan is loaded: the last file could not be opened (${loadErr.replace(/[.\s]+$/,'')}). `:'No scan is loaded. ')+'Ask the user to open a CT (NIfTI, DICOM files, a folder or a .zip) or load the phantom, then retry.';
const r1=(v,n=1)=>+v.toFixed(n),sleep=ms=>new Promise(r=>setTimeout(r,ms)),say=t=>$('#say').textContent=t;
const tot=()=>RG?RG.list.reduce((a,r)=>a+r.agatston,0):0;
function caTxt(k){let s=0;if(RG)for(const r of RG.list)if(asg[r.label]===k)s+=r.agatston;return s?' · Ca '+Math.round(s):''}
const descR=r=>({id:r.id,volume_mm3:r1(r.volume_mm3,2),peak_hu:Math.round(r.peak_hu),mean_hu:Math.round(r.mean_hu),max_extent_mm:r1(r.extent_mm),centroid_mm:r.centroid.map((v,i)=>r1(v*VOL.sp[i])),agatston:r1(r.agatston,2),vessel:asg[r.label]||'unassigned'});
/* boundary guard + live meter: every result passes through here, whoever called the tool (built-in demo agent or an external WebMCP agent) */
const MT={n:0,bytes:0,blocked:0};
function meter(){$('#pm1').textContent=MT.n;$('#pm2').textContent=MT.bytes<1024?MT.bytes+' B':(MT.bytes/1024).toFixed(1)+' KB';$('#pm3').textContent=MT.blocked}
const guard=r=>{const s=JSON.stringify(r);if(s.length>12000||/Float32Array|Int16Array|Uint8Array|ImageData|base64|data:image/.test(s)){MT.blocked++;meter();throw Error('boundary guard blocked payload')}MT.n++;MT.bytes+=s.length;meter();return r};
function reg(name,description,props,fn,ro){const run=a=>q(async()=>guard(await fn(a||{})));TOOLS[name]=run;DOCS[name]=description;
  try{Promise.resolve(document.modelContext.registerTool({name,description,inputSchema:{type:'object',properties:props||{}},annotations:ro?{readOnlyHint:true}:undefined,execute:run})).catch(()=>{})}catch(e){}}
/* ---- viewer ---- */
function dims2(){const d=VOL.dims,s=VOL.sp;return vw.ax==='axial'?{w:d[0],h:d[1],pw:d[0]*s[0],ph:d[1]*s[1],n:d[2]}:vw.ax==='coronal'?{w:d[0],h:d[2],pw:d[0]*s[0],ph:d[2]*s[2],n:d[1]}:{w:d[1],h:d[2],pw:d[1]*s[1],ph:d[2]*s[2],n:d[0]}}
function voxAt(i,j){const g=dims2(),k=vw.k;return vw.ax==='axial'?[i,j,k]:vw.ax==='coronal'?[i,k,g.h-1-j]:[k,i,g.h-1-j]}
function draw(){const c=$('#sc');if(!VOL){c.style.display='none';hbOverlay();renderRG();renderHb();return}c.style.display='block';
  const g=dims2(),nx=VOL.dims[0],ny=VOL.dims[1],lv=vw.wl[0],wd=vw.wl[1],lo=lv-wd/2,k=Math.min(vw.k,g.n-1),D=VOL.data;vw.k=k;
  c.width=g.w;c.height=g.h;const sc=Math.min(Math.min($('#room').clientWidth-30,760)/g.pw,420/g.ph);c.style.width=g.pw*sc+'px';c.style.height=g.ph*sc+'px';
  const ctx=c.getContext('2d'),im=ctx.createImageData(g.w,g.h);
  for(let j=0;j<g.h;j++)for(let i=0;i<g.w;i++){const x=vw.ax==='sagittal'?k:i,y=vw.ax==='axial'?j:vw.ax==='coronal'?k:i,z=vw.ax==='axial'?k:g.h-1-j,idx=x+y*nx+z*nx*ny,
    t=Math.max(0,Math.min(255,(D[idx]-lo)/wd*255)),o=(i+j*g.w)*4;let r=t,gg=t,b=t;
    if(RG){const lb=RG.L[idx],f=RG.map[lb];if(f){const on=f===foc;r=on?255:230;gg=on?220:60;b=on?40:60}else if(lb&&RG.out[lb]){r=Math.min(255,40+t*.4);gg=Math.min(255,90+t*.5);b=Math.min(255,170+t*.35)}}
    im.data[o]=r;im.data[o+1]=gg;im.data[o+2]=b;im.data[o+3]=255}
  ctx.putImageData(im,0,0);$('#sl').max=g.n-1;$('#sl').value=k;$('#sn').textContent=`${vw.ax} ${k+1}/${g.n}`;hbOverlay();renderRG();renderHb()}
function renderRG(){
  const head=OPMSG?`<div class="${OPMSG.t==='warn'?'warn':'sm mu'}" style="margin:0 0 6px">${esc(OPMSG.s)}</div>`:'',wn=VOL&&VOL.warnings&&VOL.warnings.length?`<div class="sm mu" style="margin-bottom:4px">${VOL.warnings.map(esc).join(' ')}</div>`:'';
  $('#rg').innerHTML=head+(reading?`<span class="mu">${esc(reading)}</span>`:!VOL?(loadErr?`<div class="warn"><b>Could not open scan:</b> ${esc(loadErr.replace(/[.\s]+$/,''))}.${/Next step/.test(loadErr)?'':' Open a NIfTI-1 CT (.nii / .nii.gz), DICOM files, a folder or a .zip, or load the synthetic phantom.'}</div>`:'<span class="mu">Load a CT (NIfTI, DICOM files, a folder or a .zip) or the synthetic phantom to begin. The files are decoded in this tab and never uploaded.</span>'):wn+(!RG?'<span class="mu">Scan loaded. Click “Find calcifications” or let the agent call find_calcifications.</span>':
  `<div class="sm mu" style="margin-bottom:4px">Agatston-style total <b class="mono">${r1(tot())}</b> · simplified threshold method, unvalidated · assign each lesion to a vessel to mark the 3D heart</div>`+(RG.excluded?`<div class="sm mu" style="margin-bottom:4px">${RG.excluded} more candidate${RG.excluded===1?' lies':'s lie'} outside the heart box (blue in the image) and ${RG.excluded===1?'is':'are'} not counted.</div>`:'')+
  (RG.list.length?RG.list.slice(0,12).map(r=>`<div class="fr" style="grid-template-columns:.4fr 1.6fr 1fr 1fr"><b>#${r.id}</b><span>${r1(r.volume_mm3)} mm³ · ${Math.round(r.peak_hu)} HU</span><span class="mono">Ca ${r1(r.agatston)}</span><select data-r="${r.id}" aria-label="Vessel for region ${r.id}">${['none','LAD','LCX','RCA'].map(v=>`<option ${(asg[r.label]||'none')===v?'selected':''}>${v}</option>`).join('')}</select></div>`).join(''):'<div class="sm mu">No candidate lies inside the heart box. Widen the box or choose Whole scan.</div>')))}
function setView(a){vw.ax=a;if(VOL)vw.k=dims2().n>>1;draw()}
$$('[data-v]').forEach(b=>b.onclick=()=>setView(b.dataset.v));
$('#sl').oninput=e=>{vw.k=+e.target.value;draw()};
$('#wl').onchange=e=>{vw.wl=WL[e.target.value];draw()};
$('#rg').onchange=e=>{const s=e.target,r=s.dataset.r&&RG&&RG.list.find(x=>x.id===+s.dataset.r);if(r){asg[r.label]=s.value==='none'?undefined:s.value;renderRG();update()}};
$('#scw').onpointermove=e=>{if(!VOL||HD)return;const c=$('#sc'),r=c.getBoundingClientRect(),g=dims2(),i=Math.floor((e.clientX-r.left)/r.width*g.w),j=Math.floor((e.clientY-r.top)/r.height*g.h);
  if(i<0||j<0||i>=g.w||j>=g.h)return;const [x,y,z]=voxAt(i,j),v=VOL.data[x+y*VOL.dims[0]+z*VOL.dims[0]*VOL.dims[1]];$('#sn').textContent=`${vw.ax} ${vw.k+1}/${g.n} · voxel ${x},${y},${z} · ${Math.round(v)} HU`};
$('#scw').onwheel=e=>{if(!VOL)return;e.preventDefault();const g=dims2();vw.k=clamp(vw.k+(e.deltaY>0?1:-1),0,g.n-1);draw()};
/* ---- heart box: a box in millimetres in the scan's own frame (voxel index x spacing, first voxel = 0 mm; the frame of centroid_mm).
   find_calcifications counts a candidate only when its centre lies inside the box. The suggestion is a labelled guess, not a segmentation. ---- */
const HBMIN=10,R0=v=>Math.round(v),hbFov=()=>ScanLib.fovMm(VOL),hbIsWhole=b=>{const f=hbFov();return b.min.every(v=>v<=1e-6)&&b.max.every((v,i)=>v>=f[i]-1e-6)};
const hbWhole=()=>({min:[0,0,0],max:hbFov(),src:'whole',basis:null,why:''});
const hbView=()=>vw.ax==='axial'?{u:0,v:1,t:2,up:false}:vw.ax==='coronal'?{u:0,v:2,t:1,up:true}:{u:1,v:2,t:0,up:true};   // horizontal axis, vertical axis, through-plane axis, does the vertical axis grow upward on screen
function hbFit(b){   // order the corners, clamp to the scan, keep every side at least HBMIN mm (or the whole axis when the scan is thinner)
  const f=hbFov(),mn=[],mx=[];
  for(let i=0;i<3;i++){let a=clamp(Math.min(b.min[i],b.max[i]),0,f[i]),c=clamp(Math.max(b.min[i],b.max[i]),0,f[i]);const m=Math.min(HBMIN,f[i]);if(c-a<m){a=clamp((a+c)/2-m/2,0,f[i]-m);c=a+m}mn[i]=a;mx[i]=c}
  return {...b,min:mn,max:mx}}
function hbSuggest(){const g=ScanLib.suggestHeartBox(VOL);return hbFit({min:g.min,max:g.max,src:'suggested',basis:g.basis,why:g.why})}
const hbD=()=>{if(!VOL||!HB)return null;const o={x:[r1(HB.min[0]),r1(HB.max[0])],y:[r1(HB.min[1]),r1(HB.max[1])],z:[r1(HB.min[2]),r1(HB.max[2])],size:HB.max.map((v,i)=>r1(v-HB.min[i])),whole_scan:hbIsWhole(HB),source:HB.src};if(HB.basis)o.basis=HB.basis;return o};
const hbTxt=()=>!VOL||!HB?'':`${hbIsWhole(HB)?'whole scan · ':''}x ${R0(HB.min[0])}–${R0(HB.max[0])} · y ${R0(HB.min[1])}–${R0(HB.max[1])} · z ${R0(HB.min[2])}–${R0(HB.max[2])} mm · ${HB.max.map((v,i)=>R0(v-HB.min[i])).join(' × ')} mm`;
const hbSay=()=>{if(!VOL||!HB)return '';if(hbIsWhole(HB))return 'Heart box: whole scan (no region limit, so bone, valves and contrast also count as candidates).';
  return `Heart box (${HB.src==='suggested'?(HB.basis==='lungs'?'suggested from the lungs':'suggested: the central part of the scan')+', a rough guess, not a segmentation':HB.src==='agent'?'set by an agent':'set by the user'}): x ${R0(HB.min[0])}-${R0(HB.max[0])}, y ${R0(HB.min[1])}-${R0(HB.max[1])}, z ${R0(HB.min[2])}-${R0(HB.max[2])} mm; a candidate counts when its centre lies inside.`};
function hbNote(){
  if(!VOL||!HB)return '';
  if(hbIsWhole(HB))return 'Whole scan: nothing is excluded, so bone, valves and contrast also count as calcium candidates. Use “Suggest heart box” or drag the box to limit the search.';
  const t=HB.src==='suggested'?(HB.basis==='lungs'?`Suggested from the lungs (${HB.why}). A rough guess, not a segmentation: drag it onto the heart.`:`No heart outline could be estimated (${HB.why}), so this is the central part of the scan (${ScanLib.HEART_MM.join(' × ')} mm, clipped to the scan). A rough guess, not a segmentation: drag it onto the heart.`):HB.src==='agent'?'Set by an agent with set_heart_region. You can still drag it.':'Set by you.';
  return t+(RG?` ${RG.list.length} candidate${RG.list.length===1?'':'s'} inside, ${RG.excluded} outside (blue, not counted).`:'')+' A candidate counts when its centre lies inside the box.'}
function renderHb(){const on=!!(VOL&&HB);$('#hxa').disabled=!on;$('#hxw').disabled=!on;$('#hxt').textContent=hbTxt();$('#hxn').textContent=hbNote()}
/* the overlay: the box projected on the current view, drawn in CSS pixels over the canvas; persistent elements, only attributes change (so a drag keeps its pointer capture) */
const SVGNS='http://www.w3.org/2000/svg',hx=$('#hxs'),HXE={h:{},e:{}};
(function(){const mk=(tag,at,par)=>{const e=document.createElementNS(SVGNS,tag);for(const k in at)e.setAttribute(k,at[k]);(par||hx).appendChild(e);return e};
  HXE.dim=mk('path',{class:'hxd','fill-rule':'evenodd'});HXE.halo=mk('rect',{class:'hxo'});HXE.body=mk('rect',{class:'hxr',tabindex:'0',role:'group','data-h':'move'});
  for(const k of ['n','s','e','w'])HXE.e[k]=mk('rect',{class:'hxe','data-h':k,'data-edge':k});
  for(const k of ['nw','n','ne','e','se','s','sw','w']){const g=mk('g',{class:'hxg','data-h':k});mk('rect',{class:'t',x:-11,y:-11,width:22,height:22},g);mk('rect',{class:'v',x:-4.5,y:-4.5,width:9,height:9},g);HXE.h[k]=g}})();
function hbOverlay(){
  if(!VOL||!HB){hx.style.display='none';return}
  const r=$('#sc').getBoundingClientRect(),W=r.width,H=r.height;if(!(W>0&&H>0)){hx.style.display='none';return}
  hx.style.display='block';hx.setAttribute('width',W);hx.setAttribute('height',H);hx.setAttribute('viewBox',`0 0 ${W} ${H}`);
  const V=hbView(),f=ax=>(mm=>(mm/VOL.sp[ax]+.5)/VOL.dims[ax]),fu=f(V.u),fv=f(V.v),x0=fu(HB.min[V.u])*W,x1=fu(HB.max[V.u])*W,
    y0=(V.up?1-fv(HB.max[V.v]):fv(HB.min[V.v]))*H,y1=(V.up?1-fv(HB.min[V.v]):fv(HB.max[V.v]))*H,kmm=vw.k*VOL.sp[V.t],inr=kmm>=HB.min[V.t]-1e-6&&kmm<=HB.max[V.t]+1e-6,w=x1-x0,h=y1-y0;
  HXE.dim.setAttribute('d',`M0 0H${W}V${H}H0Z`+(inr?`M${x0} ${y0}V${y1}H${x1}V${y0}Z`:''));
  for(const e of [HXE.halo,HXE.body]){e.setAttribute('x',x0);e.setAttribute('y',y0);e.setAttribute('width',w);e.setAttribute('height',h)}
  HXE.body.setAttribute('class','hxr'+(inr?'':' out'));
  HXE.body.setAttribute('aria-label',`Heart box in the ${vw.ax} view, ${hbTxt()}${inr?'':'. This slice lies outside the box'}. Drag to move, drag the handles to resize. Arrow keys nudge by 5 mm, Control for 1 mm, Shift resizes, Page Up and Page Down move it through the slices.`);
  const E=HXE.e;[['n',x0,y0-4,w,8],['s',x0,y1-4,w,8],['w',x0-4,y0,8,h],['e',x1-4,y0,8,h]].forEach(([k,x,y,ww,hh])=>{E[k].setAttribute('x',x);E[k].setAttribute('y',y);E[k].setAttribute('width',Math.max(0,ww));E[k].setAttribute('height',Math.max(0,hh))});
  const P={nw:[x0,y0],n:[(x0+x1)/2,y0],ne:[x1,y0],e:[x1,(y0+y1)/2],se:[x1,y1],s:[(x0+x1)/2,y1],sw:[x0,y1],w:[x0,(y0+y1)/2]};for(const k in P)HXE.h[k].setAttribute('transform',`translate(${P[k][0]} ${P[k][1]})`)}
let hbRaf=0,hbT=0;
function hbApply(done){   // re-filter the calcium list by the box (no re-labelling), then refresh the viewer, the read-out and (when done) the 3D chips
  if(RG){RG=ScanLib.restrict(RG,VOL,hbIsWhole(HB)?null:HB);foc=focL&&RG.map[focL]||0;draw()}else{hbOverlay();renderHb()}
  if(done&&RG)update()}
function hbLive(){hbOverlay();$('#hxt').textContent=hbTxt();if(!hbRaf)hbRaf=requestAnimationFrame(()=>{hbRaf=0;if(VOL&&HB)hbApply(false)})}
function hbDrag(dx,dy){
  const {h,b,V,kx,ky}=HD,f=hbFov(),mn=[...b.min],mx=[...b.max],du=dx*kx,dv=dy*ky*(V.up?-1:1);
  const mv=(ax,d)=>{const w=b.max[ax]-b.min[ax],a=clamp(b.min[ax]+d,0,f[ax]-w);mn[ax]=a;mx[ax]=a+w},lo=(ax,d)=>{mn[ax]=clamp(b.min[ax]+d,0,b.max[ax]-Math.min(HBMIN,f[ax]))},hi=(ax,d)=>{mx[ax]=clamp(b.max[ax]+d,b.min[ax]+Math.min(HBMIN,f[ax]),f[ax])};
  if(h==='move'){mv(V.u,du);mv(V.v,dv)}
  else{if(h.includes('w'))lo(V.u,du);if(h.includes('e'))hi(V.u,du);if(h.includes('n')){V.up?hi(V.v,dv):lo(V.v,dv)}if(h.includes('s')){V.up?lo(V.v,dv):hi(V.v,dv)}}   // screen top = axial y-min, but coronal / sagittal z-max
  HB={...HB,min:mn,max:mx,src:'user',basis:null,why:''};hbLive()}
hx.addEventListener('pointerdown',e=>{const t=e.target.closest&&e.target.closest('[data-h]');if(!t||!VOL||!HB||e.button>0)return;e.preventDefault();
  const g=dims2(),r=$('#sc').getBoundingClientRect();HD={h:t.dataset.h,id:e.pointerId,x:e.clientX,y:e.clientY,b:{min:[...HB.min],max:[...HB.max]},V:hbView(),kx:g.pw/r.width,ky:g.ph/r.height};
  try{t.setPointerCapture(e.pointerId)}catch(_){}try{HXE.body.focus({preventScroll:true})}catch(_){}hx.classList.add('drag')});
hx.addEventListener('pointermove',e=>{if(HD&&e.pointerId===HD.id)hbDrag(e.clientX-HD.x,e.clientY-HD.y)});
const hbEnd=e=>{if(!HD||e.pointerId!==HD.id)return;HD=null;hx.classList.remove('drag');hbApply(true)};hx.addEventListener('pointerup',hbEnd);hx.addEventListener('pointercancel',hbEnd);
hx.addEventListener('keydown',e=>{
  if(!VOL||!HB||!e.target.classList||!e.target.classList.contains('hxr'))return;
  const V=hbView(),f=hbFov(),k=e.key,st=(e.ctrlKey||e.metaKey)?1:5;let ax,d;
  if(k==='ArrowLeft'||k==='ArrowRight'){ax=V.u;d=k==='ArrowRight'?st:-st}else if(k==='ArrowUp'||k==='ArrowDown'){ax=V.v;d=(k==='ArrowUp')===V.up?st:-st}else if(k==='PageUp'||k==='PageDown'){ax=V.t;d=k==='PageUp'?st:-st}else return;
  e.preventDefault();const mn=[...HB.min],mx=[...HB.max],m=Math.min(HBMIN,f[ax]);
  if(e.shiftKey){const gs=(k==='ArrowRight'||k==='ArrowUp'||k==='PageUp')?1:-1,a=HB.min[ax]-gs*st,c=HB.max[ax]+gs*st;if(c-a<m)return;mn[ax]=Math.max(0,a);mx[ax]=Math.min(f[ax],c)}   // Shift: grow / shrink on both sides
  else{const w=HB.max[ax]-HB.min[ax],a=clamp(HB.min[ax]+d,0,f[ax]-w);mn[ax]=a;mx[ax]=a+w}
  HB={...HB,min:mn,max:mx,src:'user',basis:null,why:''};hbLive();clearTimeout(hbT);hbT=setTimeout(()=>{if(VOL&&HB)hbApply(true)},250)});
$('#hxa').onclick=()=>{if(!VOL)return;HB=hbSuggest();hbApply(true)};
$('#hxw').onclick=()=>{if(!VOL)return;HB=hbWhole();hbApply(true)};
async function loadVol(p,name){const g=++epoch;OPENTOK++;if(pend)pend(false);loading=true;loadErr='';RG=null;foc=0;focL=0;HB=null;for(const k in asg)delete asg[k];draw();
  try{const v=await p;if(g!==epoch)return;v.name=typeof name==='function'?name(v):name;let a=1e9,b=-1e9;for(const x of v.data){if(x<a)a=x;if(x>b)b=x}v.st={min:a,max:b};VOL=v;HB=hbWhole();vw.ax='axial';vw.k=v.dims[2]>>1}
  catch(e){if(g===epoch){VOL=null;loadErr=e.message||'unknown format'}}
  if(g===epoch){loading=false;draw();update()}}
/* ---- opening files: a NIfTI CT, or DICOM files / a folder / a .zip -> the CT room or the Cardiac MRI panel. File and folder names are never used as labels (they often carry patient names or ids). ---- */
const isNii=f=>/\.nii(\.gz)?$/i.test(f&&f.name||''),NAME_NII='CT volume (NIfTI)',bring=el=>{try{el.scrollIntoView({behavior:'smooth',block:'nearest'})}catch(e){}};
function openFiles(fs){
  fs=[...fs||[]];if(!fs.length)return Promise.resolve();
  if(fs.length===1&&isNii(fs[0])){OPMSG=null;return loadVol(fs[0].arrayBuffer().then(ScanLib.parseNifti),NAME_NII)}
  return openDicom(fs)}
function openFail(msg){if(VOL){OPMSG={t:'warn',s:'Could not open the selection: '+msg+' The scan that was already open is still loaded.'}}else{loadErr=msg;OPMSG=null}renderRG()}
function openCtSeries(c){
  OPMSG=c.notes&&c.notes.length?{t:'info',s:c.notes.join(' ')}:null;
  return loadVol(Promise.resolve().then(()=>DicomLib.buildCT(c.instances)).catch(e=>{throw Error(DicomLib.explain(e.message))}),v=>`CT (DICOM series, ${v.dims[2]} image${v.dims[2]>1?'s':''})`)}
async function openDicom(fs){
  const tk=++OPENTOK,n=fs.length,lab=`Reading ${n} file${n>1?'s':''}…`;OPMSG=null;reading=lab;renderRG();let rd;
  try{rd=await DicomLib.readFiles(fs,p=>{if(tk===OPENTOK){reading=lab+' '+Math.round(p*100)+'%';renderRG()}})}
  catch(e){if(tk===OPENTOK){reading='';openFail(DicomLib.explain(e.message))}return}
  if(tk!==OPENTOK)return;reading='';const c=DicomLib.classify(rd);
  if(c.kind==='none')return openFail(c.message);
  if(c.kind==='mr'){OPMSG={t:'info',s:'These are cardiac MR images, so they were opened in the Cardiac MRI panel.'};renderRG();bring($('#cine'));return cnFiles(null,rd)}
  return openCtSeries(c)}
$('#fl').onchange=e=>{const f=[...e.target.files];e.target.value='';openFiles(f)};
$('#fd').onchange=e=>{const f=[...e.target.files];e.target.value='';openFiles(f)};
$('#dm').onclick=()=>{OPMSG=null;loadVol(Promise.resolve(ScanLib.phantom()),'synthetic phantom (not patient data)')};
$('#fc').onclick=()=>TOOLS.find_calcifications({}).then(r=>{if(r.isError)$('#rg').textContent=r.content[0].text});
const dz=$('#dz');['dragenter','dragover'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.classList.add('on')}));
['dragleave','drop'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.classList.remove('on')}));dz.addEventListener('drop',async e=>{const f=await dropFiles(e.dataTransfer);openFiles(f)});
/* ---- tools ---- */
reg('describe_heart_model','Describe the 3D heart shown to the user: atlas source, size in mm, anatomical groups, the current model probability per coronary artery and whether the patient\'s own left ventricle (from a cine MRI) is loaded and shown. Geometry is never returned.',{},()=>{
  const d=V?V.dims():null,lv=CM&&CV?{loaded:true,shown:CLVON,edv_ml:r1(CV.edv),ef_pct:r1(CV.ef)}:{loaded:false,shown:false};
  return ok(`Generic adult atlas heart (BodyParts3D), not patient-specific${d?`, about ${d.lr_mm} x ${d.height_mm} x ${d.ap_mm} mm`:''}. LAD ${pc(RS.LAD.p)}, LCX ${pc(RS.LCX.p)}, RCA ${pc(RS.RCA.p)}; selected: ${sel}.${lv.loaded?` Patient left ventricle from the cine MRI: ${lv.shown?'shown':'loaded, hidden'} (EDV ${lv.edv_ml} mL, EF ${lv.ef_pct}%; placed in the atlas by centre and long axis, not an anatomical registration).`:''}`,
  {source:'BodyParts3D (CC BY-SA 2.1 JP), generic adult atlas',patient_specific:false,patient_lv:lv,dims_mm:d,groups:GROUP_ORDER,vessels:Object.fromEntries(VK.map(k=>[k,{probability:r1(RS[k].p,3),band:E.band(M,RS[k].p),territory:DESC[k]}])),selected:sel,geometry_withheld:true})},true);
reg('focus_vessel','Select a vessel in the 3D heart and fly the camera to it so the user can see it. Moves the view only.',{vessel:{type:'string',enum:['CAD','LAD','LCX','RCA']}},a=>{
  if(!T.includes(a.vessel))return fail('vessel must be CAD, LAD, LCX or RCA. Call describe_heart_model to see current probabilities.');select(a.vessel);
  return ok(`Showing ${a.vessel}: ${pc(RS[a.vessel].p)} (${E.band(M,RS[a.vessel].p)}).`,{vessel:a.vessel,probability:r1(RS[a.vessel].p,3),band:E.band(M,RS[a.vessel].p),territory:DESC[a.vessel]})});
reg('describe_scan','Report grid size, voxel spacing (mm), field of view (mm), HU range, the current heart box (mm) and a suggested calcium window. Call first once a scan is loaded. Voxels never leave the tab.',{},()=>{const e=needVol();if(e)return fail(e);const s=VOL.st,f=hbFov();
  return ok(`"${VOL.name}": ${VOL.dims.join(' × ')} voxels at ${VOL.sp.map(v=>r1(v,2)).join(' × ')} mm (field of view ${f.map(v=>Math.round(v)).join(' × ')} mm). Range ${Math.round(s.min)} to ${Math.round(s.max)} HU (assumes CT). Suggested calcium window: 130 to ${Math.round(s.max)}. ${hbSay()}`,
  {name:VOL.name,dims:VOL.dims,spacing_mm:VOL.sp.map(v=>r1(v,3)),fov_mm:f.map(v=>r1(v)),hu_min:Math.round(s.min),hu_max:Math.round(s.max),suggested_window:{min:130,max:Math.round(s.max)},heart_box_mm:hbD(),view:vw.ax,study_epoch:epoch,warnings:(VOL.warnings||[]).slice(0,5)})},true);
reg('find_calcifications','Find 3D-connected high-density (calcium-candidate) regions inside the heart box (see set_heart_region; the default is the whole scan) and measure each: mm³, peak HU, Agatston-style score, centroid. Reports how many candidates were excluded as outside the box. Threshold method, not a detector. Voxels are never returned.',
  {min_hu:{type:'number'},max_hu:{type:'number'},min_volume_mm3:{type:'number'},limit:{type:'integer'}},a=>{const e=needVol();if(e)return fail(e);const g=epoch,n=v=>Number.isFinite(+v)&&v!==null&&v!==undefined&&v!=='',
  mn=n(a.min_hu)?+a.min_hu:130,mx=n(a.max_hu)?+a.max_hu:4000,m3=n(a.min_volume_mm3)?+a.min_volume_mm3:1;if(mn>mx)return fail(`Empty window: min_hu ${mn} is above max_hu ${mx}. Swap them and retry.`);
  const key=[mn,mx,m3].join('|');let base=RG&&RG.all&&RG.all.key===key?RG.all:null;   // the same window on the same scan reuses the components (and the vessel assignments)
  if(!base){base=ScanLib.regions(VOL,{min:mn,max:mx,minMm3:m3});base.key=key;for(const k in asg)delete asg[k]}
  if(g!==epoch)return fail('The study changed while measuring. Call describe_scan again.');
  RG=ScanLib.restrict(base,VOL,hbIsWhole(HB)?null:HB);foc=0;focL=0;draw();update();const rg=RG,sh=rg.list.slice(0,Math.max(1,+a.limit||8)).map(descR);
  return ok(`Found ${rg.list.length} candidate(s) at ${mn} HU or more${rg.excluded?` inside the heart box (${rg.excluded} more excluded as outside it)`:''}; showing ${sh.length}. Agatston-style total ${r1(tot())} (simplified, unvalidated). max_extent_mm is an axis-aligned box side, not a caliper diameter. ${hbSay()}`,
  {study_epoch:g,total:rg.list.length,agatston_total:r1(tot()),excluded_outside_box:rg.excluded,heart_box_mm:hbD(),regions:sh})});
reg('focus_region','Scroll the viewer to a region from find_calcifications and highlight it so the user can see it.',{region_id:{type:'integer'}},a=>{const e=needVol();if(e)return fail(e);if(!RG)return fail('No regions yet. Call find_calcifications first.');
  const r=RG.list.find(x=>x.id===+a.region_id);if(!r)return fail(`No region #${a.region_id}. Available ids: ${RG.list.map(x=>x.id).join(', ')}.`);
  foc=r.id;focL=r.label;vw.k=Math.round(r.centroid[vw.ax==='axial'?2:vw.ax==='coronal'?1:0]);draw();return ok(`Focused region #${r.id}.`,descR(r))});
reg('set_view','Switch the viewer plane.',{view:{type:'string',enum:['axial','coronal','sagittal']}},a=>{const e=needVol();if(e)return fail(e);
  if(!['axial','coronal','sagittal'].includes(a.view))return fail('view must be axial, coronal or sagittal.');setView(a.view);return ok(`View set to ${a.view}.`,{view:a.view})});
reg('assign_vessel','Suggest which coronary vessel a region lies on (LAD, LCX, RCA or none). The user can change it in the list; this marks the 3D heart.',{region_id:{type:'integer'},vessel:{type:'string',enum:['LAD','LCX','RCA','none']}},a=>{
  const e=needVol();if(e)return fail(e);if(!RG)return fail('No regions yet. Call find_calcifications first.');const r=RG.list.find(x=>x.id===+a.region_id);if(!r)return fail(`No region #${a.region_id}. Available ids: ${RG.list.map(x=>x.id).join(', ')}.`);
  if(!['LAD','LCX','RCA','none'].includes(a.vessel))return fail('vessel must be LAD, LCX, RCA or none.');asg[r.label]=a.vessel==='none'?undefined:a.vessel;renderRG();update();return ok(`Region #${r.id} marked ${a.vessel}.`,descR(r))});
reg('set_heart_region','Set the heart box that limits find_calcifications to a region, so bone, valves and contrast outside the heart are not counted. Millimetres in the scan frame that describe_scan reports (voxel index × spacing, first voxel = 0). Give region "auto" for the built-in guess (from the lungs, else the central part of the scan; a guess, not a segmentation), region "whole" for no limit, or box_mm {x:[min,max], y:[min,max], z:[min,max]}. A candidate counts when its centre lies inside the box. Existing findings are refreshed. Returns numbers only.',
  {region:{type:'string',enum:['auto','whole']},box_mm:{type:'object',properties:{x:{type:'array',items:{type:'number'},minItems:2,maxItems:2},y:{type:'array',items:{type:'number'},minItems:2,maxItems:2},z:{type:'array',items:{type:'number'},minItems:2,maxItems:2}}}},a=>{
  const e=needVol();if(e)return fail(e);const has=v=>v!==undefined&&v!==null&&v!=='',hr=has(a.region),hb=has(a.box_mm);
  if(hr===hb)return fail('Give exactly one of region ("auto" or "whole") or box_mm {x:[min,max], y:[min,max], z:[min,max]} in mm. describe_scan reports the field of view in mm.');
  const g=epoch;let b;
  if(hr){if(a.region==='whole')b=hbWhole();else if(a.region==='auto')b=hbSuggest();else return fail('region must be "auto" or "whole". For your own box give box_mm instead.')}
  else{const q=a.box_mm,ax=['x','y','z'];
    if(typeof q!=='object'||ax.some(k=>!Array.isArray(q[k])||q[k].length!==2||q[k].some(v=>v===null||v===''||!Number.isFinite(+v))))return fail('box_mm needs x, y and z, each as [min, max] in mm, for example {"x":[60,200],"y":[60,190],"z":[0,120]}. describe_scan reports the field of view in mm.');
    const mn=ax.map(k=>Math.min(+q[k][0],+q[k][1])),mx=ax.map(k=>Math.max(+q[k][0],+q[k][1])),f=hbFov(),bad=ax.findIndex((k,i)=>mx[i]<0||mn[i]>f[i]);
    if(bad>=0)return fail(`box_mm ${ax[bad]} range ${r1(mn[bad])} to ${r1(mx[bad])} mm lies outside the scan (0 to ${r1(f[bad])} mm). Call describe_scan for the field of view.`);
    b=hbFit({min:mn,max:mx,src:'agent',basis:null,why:''})}
  HB=b;hbApply(true);
  const n=RG?RG.list.length:null,x=RG?RG.excluded:null;
  return ok(`${hbSay()}${RG?` ${n} candidate(s) inside, ${x} excluded as outside; Agatston-style total ${r1(tot())} (simplified, unvalidated).`:' Call find_calcifications to search inside it.'}${HB.basis==='central_fov'?` Why the central part: ${HB.why}.`:HB.basis==='lungs'?` Basis: ${HB.why}.`:''}`,
  {study_epoch:g,heart_box_mm:hbD(),fov_mm:hbFov().map(v=>r1(v)),candidates_inside:n,excluded_outside_box:x,agatston_total:RG?r1(tot()):null})});
reg('predict_risk','Predict CAD and LAD/LCX/RCA stenosis probabilities from the current clinical inputs, optionally overridden. Returns probabilities and top drivers only.',{features:{type:'object',description:'Optional overrides: feature key to number.'}},a=>{
  const f=a.features||{},bad=Object.keys(f).filter(k=>!(k in S));if(bad.length)return fail(`Unknown feature(s): ${bad.join(', ')}. Valid keys: ${Object.keys(S).join(', ')}.`);if(Object.values(f).some(v=>!Number.isFinite(+v)))return fail('Feature values must be numbers.');
  const x={...S};for(const k in f)x[k]=+f[k];const r=E.coherent(E.predictAll(M,x)),p=Object.fromEntries(T.map(t=>[t,r1(r[t].p,3)]));
  return ok(`Clinical model: CAD ${pc(p.CAD)} (${E.band(M,p.CAD)}), LAD ${pc(p.LAD)}, LCX ${pc(p.LCX)}, RCA ${pc(p.RCA)}. Cross-validated AUC: CAD ${f2(M.targets.CAD.metrics.roc_auc[0])}, LCX ${f2(M.targets.LCX.metrics.roc_auc[0])}.`,
  {probabilities:p,band:E.band(M,p.CAD),top_drivers:E.drivers(M,x,r,'CAD',5).map(o=>({feature:o.label,log_odds:r1(o.phi,2)})),out_of_range:E.outOfRange(M,x).map(o=>o.label)})},true);
const approve=rep=>new Promise(res=>{const j=JSON.stringify(rep,null,1);$('#mj').textContent=j;$('#md').classList.add('on');$('#ok').focus();
  const done=v=>{$('#md').classList.remove('on');pend=null;if(v)try{navigator.clipboard.writeText(j).catch(()=>{})}catch(e){}res(v)};pend=done;$('#ok').onclick=()=>done(true);$('#no').onclick=()=>done(false)});
reg('export_findings','Export measured findings plus clinical risk as JSON: CT calcium candidates and, if a cine MRI was measured, the left-ventricle volumes. Only numbers leave the page, never voxels or pixels. Needs the user to approve; cancelled automatically if the scan or the cine MRI changes while approval is pending.',{note:{type:'string'}},async a=>{
  if(loading||reading)return fail(needVol());if(CBUSY)return fail(needCine());if(VOL&&!RG)return fail('Nothing to export yet. Call find_calcifications first.');const g=epoch,ge=CEP,pv={};
  if(RG)for(const r of RG.list){const v=asg[r.label]||'unassigned';pv[v]=r1((pv[v]||0)+r.agatston)}
  const R=E.coherent(E.predictAll(M,S)),rep={schema:'cardiolens.room.v2',scan:VOL?{name:VOL.name,dims:VOL.dims,spacing_mm:VOL.sp.map(v=>r1(v,3)),epoch:g}:null,heart_box_mm:VOL?hbD():null,candidates_excluded_outside_box:RG?RG.excluded:0,cine_mri:cnReport(),note:typeof a.note==='string'?a.note.slice(0,300):undefined,
  agatston_style_total:r1(tot()),agatston_by_vessel:pv,regions:RG?RG.list.slice(0,20).map(descR):[],clinical_risk:Object.fromEntries(T.map(t=>[t,r1(R[t].p,3)])),heart_model:{source:'BodyParts3D generic atlas',patient_specific:false},method:'threshold + connected components; simplified, unvalidated',disclaimer:M.meta.disclaimer};
  const yes=await approve(rep);if(g!==epoch)return fail('The scan changed during approval; export cancelled. Re-run find_calcifications.');if(ge!==CEP)return fail('The cine MRI changed during approval; export cancelled. Re-run measure_lv.');
  return yes?ok(`Exported ${rep.regions.length} measured region(s)${rep.cine_mri?', the cine-MRI left-ventricle measurements':''} and the clinical risk. Voxel data, pixels and mesh geometry were not included.`,rep):fail('User declined the export.')},false);
/* ---- agent panel: the built-in demo agent uses exactly the tool path an external WebMCP agent uses ---- */
function log(n,a,r,c){const d=document.createElement('div');d.className='lg';d.innerHTML=`<b>${esc(n)}</b>(${esc(a)}) <span class="tag">${esc(c)}</span><code>${esc(r)}</code>`;$('#lg').prepend(d)}
async function tool(n,a){if(n==='export_findings')log(n,'note','awaiting human approval…','blocked');let r;try{r=await TOOLS[n](a)}catch(e){log(n,'',e.message,'blocked');throw e}
  log(n,a?Object.keys(a).join(','):'',r.content[0].text.slice(0,300),r.isError?'error':n==='export_findings'?'human-approved':'metadata only');return r}
$('#run').onclick=async()=>{const b=$('#run');b.disabled=true;try{say('Planning…');const out=[];
  let r=await tool('describe_heart_model');await sleep(250);
  r=await tool('predict_risk');out.push(r.content[0].text);const pr=r.structuredContent.probabilities,top=VK.slice().sort((a,b)=>pr[b]-pr[a])[0];say(out.join(' '));await sleep(250);
  await tool('focus_vessel',{vessel:top});out.push(`Highest-risk vessel: ${top}.`);say(out.join(' '));await sleep(700);
  if(VOL){await tool('describe_scan');await sleep(200);r=await tool('find_calcifications',{limit:5});out.push(r.content[0].text);say(out.join(' '));await sleep(250)}else out.push('No CT loaded, so the scan tools were skipped.');
  if(CN&&!CBUSY){await tool('describe_cine');await sleep(200);r=await tool('measure_lv');out.push(r.content[0].text);say(out.join(' '));await sleep(250);r=await tool('show_lv_3d',{on:true});out.push(r.content[0].text);say(out.join(' '));await sleep(500)}
  say(out.join(' '));r=await tool('export_findings',{note:'demo agent brief'});if(r.isError){say(out.join(' ')+' '+r.content[0].text)}else say(out.join(' ')+' Export approved by the clinician.')}catch(e){say('Agent stopped: '+e.message)}b.disabled=false};
renderRG();renderHb();meter();
/* status chip + tool list: called from boot.js once every module (including cineui.js) has registered its tools */
function toolsUi(){
  $('#wm').textContent=document.modelContext?`WebMCP · ${Object.keys(TOOLS).length} tools`:'WebMCP unavailable';
  $('#tc').textContent=Object.keys(TOOLS).length+' tools';
  $('#tl').innerHTML=Object.keys(TOOLS).map(n=>`<div style="padding:3px 0;border-top:1px solid var(--bd)"><b class="mono">${n}</b><div class="mu">${esc(DOCS[n])}</div></div>`).join('');
}
