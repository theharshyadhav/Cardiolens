/* ===== 3D scene: BodyParts3D atlas heart + risk-coloured coronary arteries (three.js r128, no dedicated GPU needed) ===== */
const ANAT_B64="/*ANATOMY*/";
const GROUP_ORDER=['LV','RV','atria','septa','valves','aorta','conduction','veins','LM','LAD','LCX','RCA'];
const TISSUE=['LV','RV','atria','septa','valves','aorta'],GHOST_HIDE=['septa','valves','conduction','veins'];
const REGION={
  LV:['Left ventricle','Main pumping chamber: free, septal, inferior, anterior and lateral walls with the papillary muscles.'],
  RV:['Right ventricle','Pumps blood to the lungs: inflow and outflow parts, trabeculae, supraventricular crest.'],
  atria:['Atria and auricles','Receiving chambers: right and left atrium with their auricles, crista terminalis and pectinate muscles.'],
  septa:['Septa','Walls between chambers: muscular and membranous interventricular, interatrial and atrioventricular septum.'],
  valves:['Valves and fibrous rings','Mitral, tricuspid, aortic and pulmonary valve apparatus with fibrous rings and trigones.'],
  aorta:['Aorta and pulmonary trunk','Aortic bulb and ascending aorta (where both coronary arteries originate) and the pulmonary trunk.'],
  conduction:['Conduction system','Sinoatrial node region, internodal tracts, atrioventricular node and bundle branches.'],
  veins:['Cardiac veins','Great, middle, anterior and posterior cardiac veins and the coronary sinus draining the heart muscle.'],
  LM:['Left main stem','Short trunk that divides into the LAD and the LCX.']};
const LAYER_NAME={LV:'Left ventricle',RV:'Right ventricle',atria:'Atria and auricles',septa:'Septa',valves:'Valves and rings',aorta:'Aorta, pulmonary trunk',conduction:'Conduction system',veins:'Cardiac veins',LM:'Left main stem',LAD:'LAD',LCX:'LCX',RCA:'RCA'};
const SWATCH={LV:'--t-tissue',RV:'--t-tissue',atria:'--t-tissue',septa:'--t-tissue',aorta:'--t-tissue',valves:'--t-valve',conduction:'--t-cond',veins:'--t-vein',LM:'--t-lm'};
async function loadAnat(){
  const bin=Uint8Array.from(atob(ANAT_B64),c=>c.charCodeAt(0));
  const txt=await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const A=JSON.parse(txt),u8=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  for(const k in A.g){const g=A.g[k],pb=u8(g.p),ib=u8(g.i),q=new Int16Array(pb.buffer,0,pb.length>>1),p=new Float32Array(q.length);
    for(let j=0;j<q.length;j++)p[j]=q[j]/A.q;g.p=p;g.i=new Uint16Array(ib.buffer,0,ib.length>>1)}
  return A;
}
function softGL(){try{const c=document.createElement('canvas'),g=c.getContext('webgl');if(!g)return false;const e=g.getExtension('WEBGL_debug_renderer_info'),r=e?String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)):'',l=g.getExtension('WEBGL_lose_context');if(l)l.loseContext();return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(r)}catch(e){return false}}
function init3d(A){
  const box=$('#v'),calm=matchMedia('(prefers-reduced-motion: reduce)').matches,coarse=matchMedia('(pointer:coarse)').matches;
  /* Responsiveness without a dedicated GPU: detect a software rasteriser (SwiftShader, llvmpipe, Basic Render) and then skip MSAA and
     backdrop blur; tissue is vertex-lit; and a time-based governor lowers the render resolution whenever frames take longer than ~40 ms. */
  const soft=softGL();if(soft)document.documentElement.classList.add('soft');
  const R=new THREE.WebGLRenderer({antialias:!soft,alpha:true,powerPreference:'low-power'}),cv=R.domElement;
  const dprMax=Math.min(window.devicePixelRatio||1,2);let dpr=dprMax,qs=1,ceil=1,w=1,h=1;R.autoClear=false;
  /* qs = governed scale used while things move; applyScale() sets the real drawing-buffer ratio (a still frame on a slow machine is drawn at 1.0) */
  const applyScale=s=>{const d=dprMax*clamp(s,.3,1);if(Math.abs(d-dpr)>.005){dpr=d;R.setPixelRatio(dpr);R.setSize(w,h,false)}};
  let dirty=true,hot=0,degraded=soft,onScreen=true,wasMoving=false;
  const wake=ms=>{dirty=true;if(ms)hot=Math.max(hot,performance.now()+ms)};
  function setQ(s){qs=clamp(s,.3,1);applyScale(qs);wake();return qs}
  if(soft){qs=ceil=.6;dpr=dprMax*qs}R.setPixelRatio(dpr);
  cv.tabIndex=0;cv.setAttribute('role','img');cv.setAttribute('aria-label','Interactive 3D heart. Arrow keys rotate, plus and minus zoom, zero resets the view. The vessel buttons select LAD, LCX or RCA.');
  box.prepend(cv);
  const sc=new THREE.Scene(),cam=new THREE.PerspectiveCamera(38,1,.05,60);
  sc.add(new THREE.HemisphereLight(0xffffff,0x56627a,.5));
  const key=new THREE.DirectionalLight(0xffffff,.7);key.position.set(2.5,3.5,5);sc.add(key);
  const rim=new THREE.DirectionalLight(0xa8c8ff,.42);rim.position.set(-4,1.5,-4);sc.add(rim);
  const H=new THREE.Group();sc.add(H);
  const col=n=>new THREE.Color(cssv(n)||'#888888');
  const meshes={},vess={},lv={};let mode='glass',regionSel=null,hoverG=null;
  /* ---- geometry: one mesh per anatomical group; the three coronary groups are the model-driven ones ---- */
  for(const k of GROUP_ORDER){
    const g=A.g[k];if(!g)continue;lv[k]=true;
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(g.p,3));geo.setIndex(new THREE.BufferAttribute(g.i,1));geo.computeVertexNormals();geo.computeBoundingSphere();
    let m;
    if(VK.includes(k))m=new THREE.MeshPhongMaterial({color:0x22c55e,shininess:70,specular:0x3a3a3a,side:THREE.DoubleSide});
    else if(TISSUE.includes(k))m=new THREE.MeshLambertMaterial({color:col(k==='valves'?'--t-valve':'--t-tissue'),side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});
    else if(k==='conduction'){const c=col('--t-cond');m=new THREE.MeshLambertMaterial({color:c,emissive:c,emissiveIntensity:.45,side:THREE.DoubleSide})}
    else m=new THREE.MeshLambertMaterial({color:col(k==='veins'?'--t-vein':'--t-lm'),side:THREE.DoubleSide});
    const me=new THREE.Mesh(geo,m);me.userData.g=k;H.add(me);meshes[k]=me;
  }
  const bb=new THREE.Box3();TISSUE.forEach(k=>meshes[k]&&bb.expandByObject(meshes[k]));const bs=bb.getSize(new THREE.Vector3());
  /* ---- vessel extras: selection halo (shell pushed out along normals), chip button, outward direction ---- */
  for(const k of VK){
    const me=meshes[k],pos=me.geometry.attributes.position.array,nor=me.geometry.attributes.normal.array,hp=new Float32Array(pos.length);
    for(let i=0;i<hp.length;i++)hp[i]=pos[i]+nor[i]*.024;
    const hg=new THREE.BufferGeometry();hg.setAttribute('position',new THREE.BufferAttribute(hp,3));hg.setIndex(me.geometry.index);
    const halo=new THREE.Mesh(hg,new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.35,side:THREE.BackSide,depthWrite:false,blending:THREE.AdditiveBlending}));halo.visible=false;H.add(halo);
    const a=new THREE.Vector3(...A.a[k]),chip=document.createElement('button');chip.type='button';chip.className='chip';chip.onclick=()=>select(k);box.appendChild(chip);
    vess[k]={mesh:me,mat:me.material,halo,anchor:a,out:a.clone().normalize(),chip,px:0,py:0};
  }
  /* ---- display modes and layers ---- */
  function applyLayers(){for(const k in meshes)meshes[k].visible=lv[k]&&!(mode==='ghost'&&GHOST_HIDE.includes(k));wake()}
  function applyMode(){
    const glass=mode!=='solid',op=mode==='ghost'?.09:(+cssv('--t-glass')||.35);
    for(const k of TISSUE){const m=meshes[k].material;m.transparent=glass;m.opacity=glass?op:1;m.depthWrite=!glass;m.side=glass?THREE.FrontSide:THREE.DoubleSide;m.needsUpdate=true}
    $$('.seg button').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.m===mode)));applyLayers();
  }
  function applyTheme(){
    for(const k of TISSUE)meshes[k].material.color.copy(col(k==='valves'?'--t-valve':'--t-tissue'));
    if(meshes.veins)meshes.veins.material.color.copy(col('--t-vein'));if(meshes.LM)meshes.LM.material.color.copy(col('--t-lm'));
    if(meshes.conduction){const c=col('--t-cond');meshes.conduction.material.color.copy(c);meshes.conduction.material.emissive.copy(c)}
    if(lvMesh){lvMesh.material.color.copy(lvCol());lvMesh.material.emissive.copy(lvCol())}
    applyMode();gizmoLabels();paint();
  }
  const lyr=$('#lyr');
  lyr.innerHTML='<div class="k" style="margin:0 0 3px">Layers</div>'+GROUP_ORDER.filter(k=>A.g[k]).map(k=>`<label><input type="checkbox" data-g="${k}" checked><i data-sw="${k}" style="--c:var(${SWATCH[k]||'--ac'})"></i>${LAYER_NAME[k]}</label>`).join('')+'<button class="btn" id="lya" type="button" style="margin-top:4px">Show all</button>';
  lyr.onchange=e=>{const g=e.target.dataset.g;if(g){lv[g]=e.target.checked;applyLayers()}};
  $('#lya').onclick=()=>{GROUP_ORDER.forEach(k=>lv[k]=true);lyr.querySelectorAll('input').forEach(i=>i.checked=true);applyLayers()};
  $('#lyb').onclick=()=>{const o=lyr.hidden;lyr.hidden=!o;$('#lyb').setAttribute('aria-expanded',String(o))};
  $$('.seg button').forEach(b=>b.onclick=()=>{mode=b.dataset.m;applyMode()});
  /* ---- orientation gizmo (patient axes) ---- */
  const gs=new THREE.Scene(),gc=new THREE.PerspectiveCamera(30,1,.1,20),gsp=[];
  gs.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]].map(a=>new THREE.Vector3(...a))),new THREE.LineBasicMaterial({color:0x8b98ad,transparent:true,opacity:.8})));
  function gizmoLabels(){
    gsp.splice(0).forEach(s=>{gs.remove(s);s.material.map.dispose();s.material.dispose()});
    const fg=cssv('--tx')||'#fff',bg=cssv('--pn')||'#000',bd=cssv('--bd')||'#888';
    [['L',1,0,0],['R',-1,0,0],['S',0,1,0],['I',0,-1,0],['A',0,0,1],['P',0,0,-1]].forEach(([t,x,y,z])=>{
      const c=document.createElement('canvas');c.width=c.height=96;const g=c.getContext('2d');if(!g)return;
      g.beginPath();g.arc(48,48,40,0,6.2832);g.fillStyle=bg;g.fill();g.lineWidth=4;g.strokeStyle=bd;g.stroke();
      g.font='700 46px system-ui,sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillStyle=fg;g.fillText(t,48,52);
      const s=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),depthTest:false,transparent:true}));
      s.position.set(x*1.25,y*1.25,z*1.25);s.scale.set(.62,.62,.62);s.userData.d=new THREE.Vector3(x,y,z);gs.add(s);gsp.push(s)});
  }
  /* ---- camera: orbit around a movable target; damped chase for fly-to ---- */
  let az=.45,el=.14,D=6,tx=0,ty=0,tz=0,azBase=.45,autoT=0,auto=!calm,chase=null,userMoved=false,fitD=6;
  const wrap=(a,b)=>a+(((b-a+Math.PI)%(2*Math.PI))+2*Math.PI)%(2*Math.PI)-Math.PI;
  function go(c){wake();if(calm){az=c.az;el=c.el;D=c.D;tx=c.t[0];ty=c.t[1];tz=c.t[2];if(c.after)c.after();return}c.az=wrap(az,c.az);chase=c;auto=false}
  function reset(){userMoved=false;azBase=.45;autoT=0;go({az:azBase,el:.14,D:fitD,t:[0,0,0],after:()=>{auto=!calm}})}
  function fly(k){
    if(!vess[k]){reset();return}
    /* view the vessel from the side it lies on, but never from below the heart and never from straight behind: the anchor's outward
       direction sets the azimuth (limited to -1.5..2.0 rad), a small positive elevation keeps the view upright and readable */
    const a=vess[k].anchor,u=vess[k].out;userMoved=true;
    go({az:clamp(Math.atan2(u.x,u.z),-1.5,2.0),el:clamp(Math.asin(u.y),.1,.9),D:fitD*.82,t:[a.x*.45,a.y*.3,a.z*.45]});
  }
  new ResizeObserver(()=>{w=box.clientWidth||1;h=box.clientHeight||1;R.setSize(w,h,false);cam.aspect=w/h;cam.updateProjectionMatrix();
    fitD=Math.max(5.2,4.5/Math.min(1.25,w/h));if(!userMoved&&!chase)D=fitD;wake()}).observe(box);
  if('IntersectionObserver' in window)new IntersectionObserver(es=>{onScreen=es[es.length-1].isIntersecting;if(onScreen)wake()},{threshold:0}).observe(box);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)wake()});
  /* ---- input: orbit, pan, zoom, pinch, keyboard, hover, pick ---- */
  const ptrs=new Map(),rc=new THREE.Raycaster(),mp=new THREE.Vector2(),tip=$('#tip');let moved=0,pinch0=0,lastHover=0,panning=false;
  const dist=()=>{const p=[...ptrs.values()];return Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)||1};
  function pickAt(cx,cy){
    const r=cv.getBoundingClientRect();mp.set((cx-r.left)/r.width*2-1,-(cy-r.top)/r.height*2+1);rc.setFromCamera(mp,cam);
    const vm=VK.map(k=>meshes[k]).filter(m=>m&&m.visible),hv=rc.intersectObjects(vm,false)[0],
      hb=rc.intersectObjects(Object.values(meshes).filter(m=>m.visible&&!VK.includes(m.userData.g)),false)[0];
    if(hv&&(mode!=='solid'||!hb||hv.distance<=hb.distance+.02))return{g:hv.object.userData.g,vessel:true};
    return hb?{g:hb.object.userData.g,vessel:false}:null;
  }
  function setHover(hit,e){
    const g=hit?hit.g:null;box.classList.toggle('hov',!!(hit&&hit.vessel));
    if(hoverG&&hoverG!==g&&TISSUE.includes(hoverG)&&hoverG!==regionSel)meshes[hoverG].material.emissive.setHex(0);
    hoverG=g;wake();
    if(g&&TISSUE.includes(g))meshes[g].material.emissive.setHex(0x1b2740);
    if(!hit){tip.hidden=true;return}
    const r=box.getBoundingClientRect();tip.hidden=false;tip.style.left=(e.clientX-r.left)+'px';tip.style.top=(e.clientY-r.top)+'px';
    tip.textContent=hit.vessel?`${g} · ${pc(RS[g].p)} · click to inspect`:(REGION[g]?REGION[g][0]:g);
  }
  function showRegion(g){
    if(regionSel&&TISSUE.includes(regionSel))meshes[regionSel].material.emissive.setHex(0);
    regionSel=g;if(g&&TISSUE.includes(g))meshes[g].material.emissive.setHex(0x24385f);paint();wake();
  }
  cv.addEventListener('pointerdown',e=>{wake(300);cv.setPointerCapture(e.pointerId);ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});moved=0;chase=null;auto=false;panning=e.shiftKey||e.button===2;box.classList.add('drag');tip.hidden=true;if(ptrs.size===2)pinch0=dist()});
  cv.addEventListener('contextmenu',e=>e.preventDefault());
  cv.addEventListener('pointermove',e=>{
    const p=ptrs.get(e.pointerId);
    if(!p){const n=performance.now();if(n-lastHover>70&&!coarse){lastHover=n;setHover(pickAt(e.clientX,e.clientY),e)}return}
    const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;moved+=Math.abs(dx)+Math.abs(dy);wake(300);
    if(ptrs.size===1){
      if(panning){const s=D*.0019,rt=new THREE.Vector3().setFromMatrixColumn(cam.matrix,0),up=new THREE.Vector3().setFromMatrixColumn(cam.matrix,1);
        tx=clamp(tx-(rt.x*dx-up.x*dy)*s,-1.6,1.6);ty=clamp(ty-(rt.y*dx-up.y*dy)*s,-1.6,1.6);tz=clamp(tz-(rt.z*dx-up.z*dy)*s,-1.6,1.6)}
      else{az-=dx*.0075;el=clamp(el+dy*.0075,-1.35,1.35)}
      userMoved=true;
    }else if(ptrs.size===2){const d=dist();if(pinch0)D=clamp(D*pinch0/d,1.8,12);pinch0=d;userMoved=true}
  });
  const up=e=>{wake(300);const was=ptrs.has(e.pointerId);ptrs.delete(e.pointerId);if(ptrs.size<2)pinch0=0;if(!ptrs.size)box.classList.remove('drag');
    if(was&&!ptrs.size&&moved<6&&e.type==='pointerup'){const hit=pickAt(e.clientX,e.clientY);if(hit&&hit.vessel){showRegion(null);select(hit.g)}else showRegion(hit?hit.g:null)}};
  cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);cv.addEventListener('pointerleave',e=>{if(!ptrs.size)setHover(null,e)});
  cv.addEventListener('wheel',e=>{e.preventDefault();wake(300);chase=null;auto=false;userMoved=true;D=clamp(D*(1+e.deltaY*.0012),1.8,12)},{passive:false});
  cv.addEventListener('dblclick',reset);
  cv.addEventListener('keydown',e=>{wake(300);const s=.12;let used=true;
    if(e.key==='ArrowLeft')az+=s;else if(e.key==='ArrowRight')az-=s;else if(e.key==='ArrowUp')el=clamp(el-s,-1.35,1.35);else if(e.key==='ArrowDown')el=clamp(el+s,-1.35,1.35);
    else if(e.key==='+'||e.key==='=')D=clamp(D*.9,1.8,12);else if(e.key==='-')D=clamp(D*1.1,1.8,12);else if(e.key==='0'||e.key==='Home'){reset();e.preventDefault();return}else used=false;
    if(used){e.preventDefault();chase=null;auto=false;userMoved=true}});
  $('#rs').onclick=reset;
  if(coarse)document.querySelector('.hint').textContent='Drag rotate · pinch zoom · tap a vessel';
  cv.addEventListener('webglcontextlost',e=>{e.preventDefault();box.insertAdjacentHTML('beforeend','<div class="fallback">The browser released the 3D context. Reload the page to restore the view; the dashboard still works.</div>')});
  /* ---- paint: model output -> colour, chips, legend, info card ---- */
  function paint(){
    if(!RS.CAD)return;wake();
    for(const k of VK){
      const p=RS[k].p,c=riskRgb(p),css='rgb('+c.join(',')+')',v=vess[k];
      v.mat.color.setRGB(c[0]/255,c[1]/255,c[2]/255);v.mat.emissive.copy(v.mat.color);v.halo.material.color.copy(v.mat.color);
      v.chip.style.setProperty('--c',css);v.chip.style.setProperty('--ink',inkFor(c));v.chip.classList.toggle('on',k===sel);
      v.chip.setAttribute('aria-label',`${NAME[k]}, ${pc(p)}, ${E.band(M,p)}. Select to inspect.`);
      v.chip.innerHTML=`<i>${BI[E.band(M,p)]}</i>${k} ${pc(p)}`+(caTxt(k)?`<span class="ca">${esc(caTxt(k))}</span>`:'');
      const sw=lyr.querySelector(`[data-sw="${k}"]`);if(sw)sw.style.setProperty('--c',css);
    }
    const p=RS[sel].p;
    $('#rp').innerHTML=`<s style="left:${p*100}%"><em>${sel} ${pc(p)}</em></s>`;
    $('#vi').innerHTML=regionSel&&REGION[regionSel]?`<div class="nm">${REGION[regionSel][0]}</div><div class="ds" style="display:block">${REGION[regionSel][1]}</div><div class="ds" style="display:block">Anatomy for orientation only. The model has no output for this structure.</div>`:
      `<div class="nm">${sel} · ${NAME[sel]}</div><div class="pv"><b style="color:${riskCss(p)}">${pc(p)}</b>${bandPill(p)}</div><div class="ds">${DESC[sel]}</div>`;
  }
  /* ---- the patient's own left ventricle (cine MRI): a beating cavity surface, placed in the atlas by its centre and long axis ---- */
  let lvD=null,lvMesh=null,lvEdge=null,lvOn=false,lvPh=0,lvPos=null,lvInf={};
  const lvg=new THREE.Group();lvg.visible=false;H.add(lvg);
  const atlasLV=(()=>{
    const cen=g=>{const p=g.p,n=p.length/3,c=[0,0,0];for(let i=0;i<n;i++){c[0]+=p[3*i];c[1]+=p[3*i+1];c[2]+=p[3*i+2]}return c.map(v=>v/n)};
    const L=A.g.LV,c=cen(L),p=L.p,n=p.length/3,m=[0,0,0,0,0,0];
    for(let i=0;i<n;i++){const x=p[3*i]-c[0],y=p[3*i+1]-c[1],z=p[3*i+2]-c[2];m[0]+=x*x;m[1]+=x*y;m[2]+=x*z;m[3]+=y*y;m[4]+=y*z;m[5]+=z*z}
    let e=[0,-1,.2];for(let k=0;k<60;k++){const a=[m[0]*e[0]+m[1]*e[1]+m[2]*e[2],m[1]*e[0]+m[3]*e[1]+m[4]*e[2],m[2]*e[0]+m[4]*e[1]+m[5]*e[2]],l=Math.hypot(...a)||1;e=a.map(v=>v/l)}
    const b=cen(A.g.valves||A.g.aorta||L),u=[c[0]-b[0],c[1]-b[1],c[2]-b[2]],ul=Math.hypot(...u)||1,un=u.map(v=>v/ul),d=e[0]*un[0]+e[1]*un[1]+e[2]*un[2];
    return{c,u:Math.abs(d)>.8?(d<0?e.map(v=>-v):e):un};
  })();
  const lvCol=()=>col('--lv');
  function lvClear(){
    lvOn=false;lvg.visible=false;
    for(const o of [lvMesh,lvEdge])if(o){lvg.remove(o);o.geometry.dispose();o.material.dispose()}
    lvMesh=lvEdge=lvD=lvPos=null;lvInf={};wake();
  }
  /* patient LPS (x left, y posterior, z superior, mm) -> scene (x left, y up, z anterior); rotate the patient's base->apex axis onto the atlas LV axis about
     the cavity centroid, then move the centroid to the atlas LV centre. Scale stays 1:1 in millimetres, so a dilated ventricle looks dilated. */
  function lvSet(d){
    lvClear();if(!d)return;lvD=d;
    const ts=v=>[v[0],v[2],-v[1]],a=ts(d.axis),b=atlasLV.u,cr=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],sn=Math.hypot(...cr),cs=a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
      k=sn<1e-9?0:(1-cs)/(sn*sn),vx=[[0,-cr[2],cr[1]],[cr[2],0,-cr[0]],[-cr[1],cr[0],0]],
      Rm=[0,1,2].map(i=>[0,1,2].map(j=>(i===j?1:0)+vx[i][j]+k*(vx[i][0]*vx[0][j]+vx[i][1]*vx[1][j]+vx[i][2]*vx[2][j]))),c0=ts(d.centroid);
    const tf=(P,o,i)=>{const q=ts([P[3*i],P[3*i+1],P[3*i+2]]),x=q[0]-c0[0],y=q[1]-c0[1],z=q[2]-c0[2];
      for(let r=0;r<3;r++)o[3*i+r]=atlasLV.c[r]+(Rm[r][0]*x+Rm[r][1]*y+Rm[r][2]*z)/A.mm};
    lvPos=d.phases.map(P=>{const o=new Float32Array(P.length);for(let i=0;i<P.length/3;i++)tf(P,o,i);return o});
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(lvPos[d.ed]),3));geo.setIndex(new THREE.BufferAttribute(d.index,1));geo.computeVertexNormals();geo.computeBoundingSphere();
    lvMesh=new THREE.Mesh(geo,new THREE.MeshPhongMaterial({color:lvCol(),emissive:lvCol(),emissiveIntensity:.18,shininess:55,specular:0x445566,side:THREE.DoubleSide,transparent:true,opacity:.92}));lvMesh.renderOrder=3;lvg.add(lvMesh);
    /* end-diastole outline: slice rings + a few meridians, drawn once, so the contraction is visible against where the wall was */
    const E=lvPos[d.ed],NA=d.NA,seg=[],pt=i=>seg.push(E[3*i],E[3*i+1],E[3*i+2]);
    for(let m=1;m<=d.keep.length;m++)for(let j=0;j<NA;j++){pt(m*NA+j);pt(m*NA+(j+1)%NA)}
    for(let j=0;j<NA;j+=6)for(let m=1;m<d.keep.length;m++){pt(m*NA+j);pt((m+1)*NA+j)}
    const eg=new THREE.BufferGeometry();eg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(seg),3));
    lvEdge=new THREE.LineSegments(eg,new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.3,depthWrite:false}));lvEdge.renderOrder=2;lvg.add(lvEdge);
    lvInf={axis_deg:+(Math.acos(clamp(a[0]*b[0]+a[1]*b[1]+a[2]*b[2],-1,1))*180/Math.PI).toFixed(1),atlas_axis:atlasLV.u.map(v=>+v.toFixed(3))};
    lvPh=d.ed;wake();
  }
  function lvShow(on){
    on=!!(on&&lvD);lvOn=on;lvg.visible=on;
    if(on&&mode==='solid'){mode='glass';applyMode()}
    wake();return lvOn;
  }
  function lvPhase(ph){
    if(!lvD||!lvMesh)return;
    const T=lvD.T,f0=Math.floor(ph),i=((f0%T)+T)%T,j=(i+1)%T,f=ph-f0,a=lvPos[i],b=lvPos[j],pa=lvMesh.geometry.attributes.position.array;
    for(let k=0;k<pa.length;k++)pa[k]=a[k]+(b[k]-a[k])*f;
    const g=lvMesh.geometry;g.attributes.position.needsUpdate=true;g.computeVertexNormals();g.computeBoundingSphere();lvPh=ph;if(lvOn)wake();
  }
  /* ---- render loop ---- */
  let last=performance.now(),ph=0,fps=60;const tmp=new THREE.Vector3(),cdir=new THREE.Vector3();
  function render(){
    R.setScissorTest(false);R.setViewport(0,0,w,h);R.clear();R.render(sc,cam);
    const s=Math.round(clamp(Math.min(w,h)*.22,70,116));
    gc.position.copy(cam.position).sub(tmp.set(tx,ty,tz)).normalize().multiplyScalar(7.2);gc.up.copy(cam.up);gc.lookAt(0,0,0);
    cdir.copy(gc.position).normalize();for(const q of gsp){const d=q.userData.d.dot(cdir);q.material.opacity=.4+.6*clamp((d+.35)/.7,0,1);q.renderOrder=Math.round(d*100)}
    R.setViewport(w-s-8,52,s,s);R.setScissor(w-s-8,52,s,s);R.setScissorTest(true);R.clearDepth();R.render(gs,gc);
  }
  function loop(now){
    requestAnimationFrame(loop);
    const dt=Math.min(.1,(now-last)/1000);last=now;
    if(!onScreen){gLast=now;return}
    const moving=!!chase||auto||ptrs.size>0||now<hot,live=!degraded&&!calm;
    if(wasMoving&&!moving)dirty=true;wasMoving=moving;   /* motion just stopped: draw one still frame at full resolution */
    /* nothing moving and nothing changed: keep the last frame on screen and spend no GPU time */
    if(!moving&&!live&&!dirty){gLast=now;return}
    if(chase){const k=1-Math.exp(-dt*6.5);az+=(chase.az-az)*k;el+=(chase.el-el)*k;D+=(chase.D-D)*k;tx+=(chase.t[0]-tx)*k;ty+=(chase.t[1]-ty)*k;tz+=(chase.t[2]-tz)*k;
      if(Math.abs(chase.az-az)+Math.abs(chase.el-el)+Math.abs(chase.D-D)<.004){const a=chase.after;chase=null;dirty=true;if(a)a()}}
    else if(auto){autoT+=dt*.3;az=azBase+.8*Math.sin(autoT)}
    cam.position.set(tx+D*Math.sin(az)*Math.cos(el),ty+D*Math.sin(el),tz+D*Math.cos(az)*Math.cos(el));cam.lookAt(tx,ty,tz);
    const bpm=clamp(S.pr||70,40,160),amp=live&&!lvOn?.012+.032*clamp((S.ef||55)/65,.25,1.2):0;
    ph+=dt*bpm/60;H.scale.setScalar(1+amp*Math.pow(Math.max(0,Math.sin(ph*6.2832)),6));
    const tt=now/1000,hiB=M.meta.risk_bands.high;
    for(const k of VK){const v=vess[k],p=RS[k]?RS[k].p:0,on=k===sel;
      v.mat.emissiveIntensity=live?.1+(p>=hiB?.08*Math.sin(tt*4.2)+.1:0)+(on?.12:0):(on?.3:.14)+(p>=hiB?.08:0);
      v.halo.visible=on&&v.mesh.visible;if(on)v.halo.material.opacity=.42+(live?.12*Math.sin(tt*5):0)}
    H.updateMatrixWorld();
    cdir.copy(cam.position).sub(tmp.set(tx,ty,tz)).normalize();
    const pos=[];
    for(const k of VK){const v=vess[k];tmp.copy(v.anchor);H.localToWorld(tmp);tmp.project(cam);
      v.px=clamp((tmp.x*.5+.5)*w,46,w-46);v.py=clamp((-tmp.y*.5+.5)*h,34,h-70);pos.push(v)}
    pos.sort((a,b)=>a.py-b.py);for(let i=1;i<pos.length;i++){const a=pos[i-1],b=pos[i];if(Math.abs(a.px-b.px)<96&&b.py-a.py<28)b.py=a.py+28}
    for(const k of VK){const v=vess[k],front=mode==='ghost'||v.out.dot(cdir)>-.12;
      v.chip.style.transform=`translate(${v.px.toFixed(0)}px,${v.py.toFixed(0)}px) translate(-50%,-50%)`;v.chip.classList.toggle('back',!front);v.chip.style.display=v.mesh.visible?'':'none'}
    applyScale(!moving&&degraded?1:qs);
    render();dirty=false;
    if(moving||live)govern(now);else gLast=now;
  }
  /* frame-time governor: 0.7 s windows; slower than 40 ms/frame lowers the render scale (never below 0.3x), a long run faster than 20 ms
     raises it again, capped just under the last scale that was too slow so the picture does not oscillate */
  let gAcc=0,gN=0,gGood=0,gLast=performance.now(),gT=0;
  function govern(now){
    const raw=(now-gLast)/1000;gLast=now;if(raw>.5||raw<=0)return;gAcc+=raw;gN++;gT+=raw;
    if(gT>20){gT=0;ceil=Math.min(1,ceil*1.15)}
    if(gAcc>=.7){const avg=gAcc/gN;fps=1/avg;
      if(avg>.04&&qs>.3){ceil=Math.min(ceil,qs*.95);setQ(qs*(avg>.1?.6:.8));gGood=0;if(qs<=.5&&!degraded){degraded=true;document.documentElement.classList.add('soft')}}
      else if(avg<.02&&qs<ceil){gGood+=gAcc;if(gGood>2.5){setQ(Math.min(ceil,qs*1.2));gGood=0}}else gGood=0;
      gAcc=0;gN=0}
  }
  fitD=6;applyTheme();applyMode();
  themeHooks.push(applyTheme);
  requestAnimationFrame(t=>{last=t;loop(t)});
  return{paint,fly,reset,quality:q=>setQ(q),wake,clearRegion:()=>{if(regionSel)showRegion(null)},view:c=>{userMoved=true;go({az:c.az,el:c.el,D:c.D,t:c.t||[0,0,0]})},setMode:m=>{mode=m;applyMode()},layers:lv,
    dims:()=>({lr_mm:Math.round(bs.x*A.mm),height_mm:Math.round(bs.y*A.mm),ap_mm:Math.round(bs.z*A.mm)}),
    stats:()=>({fps:Math.round(fps),pixel_ratio:+dpr.toFixed(2),quality:+qs.toFixed(2),software_renderer:soft,degraded,triangles:Object.values(meshes).reduce((n,m)=>n+m.geometry.index.count/3,0)}),
    camera:()=>({az,el,D,t:[tx,ty,tz]}),region:()=>regionSel,mode:()=>mode,
    lvSet,lvShow,lvPhase,lvClear,lvState:()=>({loaded:!!lvD,shown:lvOn,phase:lvPh,...lvInf,vertices:lvD?lvD.nVert:0}),
    pick:(cx,cy)=>pickAt(cx,cy),chipPos:k=>({x:vess[k].px,y:vess[k].py})};
}
