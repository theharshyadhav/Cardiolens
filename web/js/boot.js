/* ===== boot: wire the page, then start the 3D scene ===== */
refreshTheme();buildInputs();sync();
const root=document.documentElement;
try{const t=localStorage.getItem('cl-theme');if(t==='light'||t==='dark')root.dataset.theme=t}catch(e){}
$('#thm').onclick=()=>{const dark=root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches,n=dark?'light':'dark';root.dataset.theme=n;try{localStorage.setItem('cl-theme',n)}catch(e){}};
new MutationObserver(()=>{refreshTheme();update()}).observe(root,{attributes:true,attributeFilter:['data-theme']});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{refreshTheme();update()});
$('#in').addEventListener('input',e=>{const i=e.target;if(!i.dataset.k)return;stopLapse();S[i.dataset.k]=i.type==='checkbox'?+i.checked:+i.value;update()});
$('#ps').onclick=e=>{const b=e.target.closest('[data-p]');if(b){const n=+b.dataset.p;setProfile(n<0?def():{...def(),...M.presets[n].profile})}};
$('#risk').onclick=e=>{const r=e.target.closest('[data-k]');if(r)select(r.dataset.k)};
$('#risk').onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target.dataset&&e.target.dataset.k){e.preventDefault();select(e.target.dataset.k)}};
$('#mc').onclick=e=>{if(e.target.id==='mcl'){e.preventDefault();openModelCard(sel)}};
$('#mcb').onclick=()=>openModelCard(sel);
$('#mcm').onclick=e=>{if(e.target.id==='mcm')closeModelCard()};
$('#wf').onchange=()=>{wfUser=true;renderWhatIf()};
$('#wc').onpointermove=whatIfHover;$('#wc').onpointerleave=()=>{const g=$('#wch');if(g)g.style.display='none'};
$('#ta').onclick=toggleLapse;
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;
  if($('#md').classList.contains('on'))$('#no').click();else if($('#mcm').classList.contains('on'))closeModelCard();else if($('#lyr')&&!$('#lyr').hidden){$('#lyr').hidden=true;$('#lyb').setAttribute('aria-expanded','false')}});
function fallback3d(msg){$('#v').insertAdjacentHTML('afterbegin',`<div class="fallback">${esc(msg)}</div>`)}
update();probeBackend();
if(window.THREE)loadAnat().then(A=>{V=init3d(A);if(CM)$('#lvb').hidden=false;update()}).catch(err=>{console.error(err);fallback3d('The 3D view could not start ('+err.message+'). The dashboard still works.')});
else fallback3d('three.js could not be loaded (offline?). The dashboard still works.');
toolsUi();
