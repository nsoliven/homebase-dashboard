/* Homebase case view: a 3D model of prox's Tower 500 with fan curves and airflow (three.js r128, vendored). */
// ?embed hides the page header so the overview panel can frame it, and reports the page height to the parent
const EMBED=new URLSearchParams(location.search).has('embed');
if(EMBED){document.documentElement.classList.add('embed');addEventListener('message',e=>{if(e.origin===location.origin&&e.source===parent&&e.data?.type==='homebase-viewport'&&e.data.height>200&&e.data.height<5000)document.documentElement.style.setProperty('--host-vh',Math.round(e.data.height)+'px')});const post=()=>parent.postMessage({type:'homebase-case-height',height:Math.ceil(document.querySelector('.wrap').getBoundingClientRect().height)},location.origin);new ResizeObserver(post).observe(document.querySelector('.wrap')||document.body);addEventListener('load',post)}
(()=>{
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const isDark=()=>{const t=document.documentElement.dataset.theme;return t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches};
const small=matchMedia('(max-width: 640px)').matches;

/* Real readings from prox at 19:00 on 2026-10-15; the header → group mapping still needs confirming. */
const HEADERS=[
 {id:'CPU_FAN',rpm:1118,group:'rad',guess:true},
 {id:'PUMP_FAN',rpm:3200,group:'pump',guess:false},
 {id:'SYS_FAN1',rpm:0,group:null},
 {id:'SYS_FAN2',rpm:813,group:'floor',guess:true},
 {id:'SYS_FAN3',rpm:1101,group:'top',guess:true},
 {id:'SYS_FAN4',rpm:1143,group:'rear',guess:true},
 {id:'SYS_FAN5',rpm:1032,group:'rear',guess:true},
 {id:'SYS_FAN6',rpm:0,group:null},
];
const GROUPS={
 rad:{name:'Radiator',count:'3 × 120 mm',dir:'Exhaust · right grille',color:'#4a5fd6',src:'tctl',temp:61,duty:38,curve:[[50,20],[80,45],[95,60],[100,100]]},
 top:{name:'Top',count:'2 × 120 mm',dir:'Exhaust · up',color:'#e0832f',src:'system',temp:39,duty:42,curve:[[50,40],[60,55],[65,70],[68,100]]},
 floor:{name:'Floor intake',count:'2 × 140 mm',dir:'Intake · from below',color:'#2f9a62',src:'system',temp:39,duty:32,curve:[[50,40],[60,55],[65,80],[68,100]]},
 rear:{name:'Rear',count:'2 × 120 mm',dir:'',flow:'in',color:'#9b59c9',src:'system',temp:39,duty:40,curve:[[50,40],[60,55],[65,70],[68,100]]},
 pump:{name:'AIO pump',count:'Galahad II',dir:'Coolant loop',color:'#3f8fd8',src:'tctl',temp:61,duty:100,curve:[[30,100],[100,100]],fixed:true},
 gpu:{name:'GPU fans',count:'3 × 80 mm · driver',dir:'Read-only',color:'#8d95a7',src:'gpu',temp:41,duty:0,curve:[[50,0],[60,30],[75,55],[85,80]],readonly:true},
};
const rearDir=()=>GROUPS.rear.flow==='in'?'Intake · from the back':'Exhaust · out the back';
GROUPS.rear.dir=rearDir();
const liveRpm={};   // filled from prox when fan control is connected
const rpmOf=g=>{if(liveRpm[g]!=null)return liveRpm[g];const h=HEADERS.filter(h=>h.group===g);return h.length?Math.round(h.reduce((a,b)=>a+b.rpm,0)/h.length):0};
// rough fan airflow: ~60 CFM for a 120 mm fan at 1,500 rpm, scaling with rpm and diameter³; radiators restrict ~35%
const cfm=(rpm,size)=>60*(rpm/1500)*Math.pow(size/1.2,3);
let sel='rad';

/* seeded randomness so the board's traces and the smoke look the same on every load */
let _s=0x2f6e2b1;const rnd=()=>{_s|=0;_s=_s+0x6D2B79F5|0;let t=Math.imul(_s^_s>>>15,1|_s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};

/* ---------- renderer, camera, environment (units: decimetres, 1 = 100 mm) ---------- */
const canvas=document.getElementById('view');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
const DPR=Math.min(devicePixelRatio,small?1.5:2);renderer.setPixelRatio(DPR);
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;   // studio only: roll highlights off instead of clipping whites
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene();
const cam=new THREE.PerspectiveCamera(34,1,0.3,60);   // the camera never gets closer than ~1.5 to a surface; a tiny near plane starves depth precision
const controls=new THREE.OrbitControls(cam,canvas);
controls.enableDamping=true;controls.target.set(0,3.0,0);controls.minDistance=3.5;controls.maxDistance=20;controls.enablePan=false;controls.autoRotateSpeed=0.55;
/* The stage stays passive until it is pressed, so scrolling the page past it never zooms the case.
   Pressing it (drag or click) takes control; leaving it hands scroll back. Idle for a few seconds, it spins. */
let stageActive=false,lastInput=-1e9;
const stageHint=document.getElementById('stage-hint');
function setStage(on){stageActive=on;controls.enabled=on;canvas.style.touchAction=on?'none':'pan-y';stageHint.hidden=on}
const touched=()=>{lastInput=performance.now()};
canvas.addEventListener('pointerdown',e=>{touched();if(!stageActive)setStage(true)},{capture:true});   // capture: runs before the controls' own handler, so the first drag works
canvas.addEventListener('wheel',()=>{if(stageActive)touched()},{passive:true});
canvas.addEventListener('pointerleave',e=>{if(!e.buttons)setStage(false)});
addEventListener('blur',()=>setStage(false));
setStage(false);

function makeEnv(stops,boxes){
  const c=document.createElement('canvas');c.width=8;c.height=256;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,0,256);stops.forEach(([o,col])=>gr.addColorStop(o,col));g.fillStyle=gr;g.fillRect(0,0,8,256);
  const es=new THREE.Scene();es.add(new THREE.Mesh(new THREE.SphereGeometry(20,32,16),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(c),side:THREE.BackSide})));
  boxes.forEach(([x,y,z,w,h,col])=>{const p=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({color:col,side:THREE.DoubleSide}));p.position.set(x,y,z);p.lookAt(0,0,0);es.add(p)});
  const pm=new THREE.PMREMGenerator(renderer);const tex=pm.fromScene(es,0.035).texture;pm.dispose();return tex;
}
const ENV_STUDIO=makeEnv([[0,'#ffffff'],[.5,'#d6dbe4'],[1,'#6f788b']],[[9,8,6,8,5,0xffffff],[-9,6,5,6,4,0xf0f4ff],[0,12,-8,10,4,0xffffff]]);
const ENV_ROOM=makeEnv([[0,'#121830'],[.6,'#06080f'],[1,'#020305']],[[6,6,6,4,3,0x2a3bff],[-6,3,4,3,2,0x1b2240]]);
scene.environment=ENV_STUDIO;
const hemi=new THREE.HemisphereLight(0xffffff,0x6f7890,0.2);scene.add(hemi);
const key=new THREE.DirectionalLight(0xffffff,1.15);key.position.set(6,11,8);scene.add(key);
// one soft shadow from the key light, sized to the case
key.castShadow=true;key.target.position.set(0,3,0);scene.add(key.target);
{const c=key.shadow.camera;c.left=-4.4;c.right=4.4;c.top=4.6;c.bottom=-4.6;c.near=7;c.far=19;const ms=small?1024:2048;key.shadow.mapSize.set(ms,ms);key.shadow.bias=-0.0005;key.shadow.normalBias=0.025;key.shadow.radius=3}
const fillL=new THREE.DirectionalLight(0xdfe6ff,0.22);fillL.position.set(-9,5,6);scene.add(fillL);
const rim=new THREE.DirectionalLight(0xffffff,0.35);rim.position.set(-3,6,-9);scene.add(rim);
const rgbIn=new THREE.PointLight(0x2f5bff,0,6.5,1.4);rgbIn.position.set(0.3,3.6,0.4);scene.add(rgbIn);
const rgbTop=new THREE.PointLight(0x2f5bff,0,4.5,1.5);rgbTop.position.set(0,5.3,0.3);scene.add(rgbTop);
const rgbBase=new THREE.PointLight(0x2f5bff,0,4,1.6);rgbBase.position.set(0,0.45,0.8);scene.add(rgbBase);

/* bloom only switches on in RGB mode, where the room goes dark */
let composer=null,bloom=null,bloomOn=false;
// the default composer target has 16-bit depth, which made close surfaces (the front I/O, the floor) flicker as the camera moved
try{const ms=renderer.capabilities.isWebGL2&&!!THREE.WebGLMultisampleRenderTarget;const o={minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,stencilBuffer:!ms};
  composer=new THREE.EffectComposer(renderer,ms?new THREE.WebGLMultisampleRenderTarget(2,2,o):new THREE.WebGLRenderTarget(2,2,o));composer.setPixelRatio(DPR);composer.addPass(new THREE.RenderPass(scene,cam));bloom=new THREE.UnrealBloomPass(new THREE.Vector2(512,512),1.0,0.55,0.6);composer.addPass(bloom)}catch(e){composer=null}

/* ---------- shared textures and materials ---------- */
function canvasTex(w,h,draw,rep){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.anisotropy=8;if(rep){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(rep[0],rep[1])}return t}
const GLOW=canvasTex(128,128,(g)=>{const gr=g.createRadialGradient(64,64,0,64,64,64);gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(.35,'rgba(255,255,255,.5)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.fillRect(0,0,128,128)});
const FANFILL=canvasTex(128,128,(g)=>{const gr=g.createRadialGradient(64,64,0,64,64,64);gr.addColorStop(0,'rgba(255,255,255,.95)');gr.addColorStop(.42,'rgba(255,255,255,.75)');gr.addColorStop(.8,'rgba(255,255,255,.28)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.fillRect(0,0,128,128)});
const FIN=(rx,ry)=>canvasTex(32,32,(g,w,h)=>{g.fillStyle='#7e838c';g.fillRect(0,0,w,h);for(let y=0;y<h;y+=4){g.fillStyle='#eceef2';g.fillRect(0,y,w,2);g.fillStyle='#4f535a';g.fillRect(0,y+3,w,1)}},[rx,ry]);
const GROOVE=(rx,ry)=>canvasTex(32,32,(g,w,h)=>{g.fillStyle='#41454e';g.fillRect(0,0,w,h);for(let x=0;x<w;x+=8){g.fillStyle='#202329';g.fillRect(x,0,3,h);g.fillStyle='#646a75';g.fillRect(x+3,0,1,h)}},[rx,ry]);
const PCB_TEX=canvasTex(1024,1024,(g,w,h)=>{g.fillStyle='#16181d';g.fillRect(0,0,w,h);g.lineCap='round';
  for(let i=0;i<420;i++){g.strokeStyle=`rgba(${110+rnd()*40|0},${120+rnd()*40|0},${140+rnd()*40|0},${0.05+rnd()*0.07})`;g.lineWidth=1+rnd()*2;g.beginPath();let x=rnd()*w,y=rnd()*h;g.moveTo(x,y);for(let k=0;k<5;k++){if(rnd()<.5)x+=(rnd()-.5)*220;else y+=(rnd()-.5)*220;g.lineTo(x,y)}g.stroke()}
  for(let i=0;i<260;i++){g.fillStyle=`rgba(200,205,215,${0.08+rnd()*0.1})`;g.fillRect(rnd()*w,rnd()*h,2+rnd()*6,2+rnd()*3)}});
const BRAID=canvasTex(64,64,(g,w,h)=>{g.fillStyle='#eef0f4';g.fillRect(0,0,w,h);g.strokeStyle='rgba(150,158,172,.35)';g.lineWidth=2;for(let i=-64;i<128;i+=8){g.beginPath();g.moveTo(i,0);g.lineTo(i+64,64);g.stroke();g.beginPath();g.moveTo(i+64,0);g.lineTo(i,64);g.stroke()}},[2,30]);
const LEDS=canvasTex(512,32,(g,w,h)=>{g.fillStyle='#000';g.fillRect(0,0,w,h);for(let i=0;i<10;i++){const x=(i+0.5)*w/10;const gr=g.createRadialGradient(x,h/2,0,x,h/2,40);gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(1,'rgba(255,255,255,.25)');g.fillStyle=gr;g.fillRect(x-40,0,80,h)}});
const INFINITY=canvasTex(256,256,(g,w,h)=>{g.fillStyle='#000';g.fillRect(0,0,w,h);for(let r=118,k=0;r>30;r-=13,k++){g.strokeStyle=`rgba(255,255,255,${0.9*Math.pow(0.72,k)})`;g.lineWidth=5;g.beginPath();g.arc(128,128,r,0,Math.PI*2);g.stroke()}});
function textTex(text,{w=1024,h=128,color='#ffffff',bg=null,font='800 74px Inter, system-ui, sans-serif',spacing='12px'}={}){return canvasTex(w,h,(g)=>{if(bg){g.fillStyle=bg;g.fillRect(0,0,w,h)}g.fillStyle=color;g.font=font;g.textAlign='center';g.textBaseline='middle';try{g.letterSpacing=spacing}catch(e){}g.fillText(text,w/2,h/2+4)})}
const std=o=>new THREE.MeshStandardMaterial(o);
const MAT={
  pcb:std({color:0xffffff,map:PCB_TEX,roughness:.85,metalness:.1}),
  gun:std({color:0x3a3e46,roughness:.36,metalness:.8}),
  gunDark:std({color:0x23262c,roughness:.4,metalness:.7}),
  silver:std({color:0xdfe2e8,roughness:.22,metalness:.9}),
  nickel:std({color:0xd7dbe2,roughness:.16,metalness:1}),
  copper:std({color:0xc0784a,roughness:.25,metalness:1}),
  black:std({color:0x111215,roughness:.55,metalness:.2}),
  plastic:std({color:0x26282e,roughness:.5,metalness:.1}),
  white:std({color:0xe3e5ea,roughness:.5}),
  slot:std({color:0x2a2c32,roughness:.55}),
  steel:std({color:0xc3c7ce,roughness:.26,metalness:.95}),
  port:std({color:0x0b0c0e,roughness:.7}),
  sleeve:std({color:0xffffff,map:BRAID,roughness:.85}),
};
function rrShape(w,h,r){const s=new THREE.Shape(),x=-w/2,y=-h/2;s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s}
function box(w,h,d,mat,x,y,z,parent=scene){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);parent.add(m);return m}
function cyl(r,len,mat,x,y,z,axis='z',parent=scene,seg=32){const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,len,seg),mat);if(axis==='z')m.rotation.x=Math.PI/2;else if(axis==='x')m.rotation.z=Math.PI/2;m.position.set(x,y,z);parent.add(m);return m}
function label(tex,w,h,x,y,z,parent=scene,{rx=0,ry=0,rz=0,opacity=1,mat=null}={}){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat||new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity,depthWrite:false}));m.position.set(x,y,z);m.rotation.set(rx,ry,rz);parent.add(m);return m}

/* ---------- case geometry: The Tower 500 (Snow), 388 × 608 × 398 mm ---------- */
const W=3.88,H=6.08,D=3.98,BASE=0.85,HB=H-0.45;
const SIDE_MESH=1.24;                              // each side panel's perforated strip; the right one sits exactly over the radiator
const PANEL=0xe2e4e9,FRAME=0xd8dbe1;   // Snow is a satin white, not paper white
const panelMats=[];
const caseGroup=new THREE.Group();scene.add(caseGroup);
function rr(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();ctx.fill()}
function perfTexture(kind){
  const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');
  x.fillStyle='#fff';x.fillRect(0,0,256,256);x.globalCompositeOperation='destination-out';x.fillStyle='#000';
  if(kind==='hex'){const r=11,dx=r*1.8,dy=r*1.56;for(let row=-1;row*dy<272;row++)for(let col=-1;col*dx<272;col++){const cx=col*dx+(row%2?dx/2:0),cy=row*dy;x.beginPath();for(let k=0;k<6;k++){const a=Math.PI/6+k*Math.PI/3;x.lineTo(cx+r*0.8*Math.cos(a),cy+r*0.8*Math.sin(a))}x.closePath();x.fill()}}
  else{const cols=4,rows=12,sw=256/cols,sh=256/rows;for(let r=0;r<rows;r++)for(let c2=-1;c2<=cols;c2++){const ox=c2*sw+(r%2?sw/2:0);rr(x,ox+sw*0.1,r*sh+sh*0.28,sw*0.8,sh*0.44,sh*0.22)}}
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;return t;
}
const SLOT=perfTexture('slot'),HEX=perfTexture('hex');
function track(mat,base){mat.userData.base=base;mat.userData.test=mat.alphaTest;panelMats.push(mat);return mat}
function panel(w,h,kind,{x=0,y=0,z=0,ry=0,rx=0,tile=0.8,keep=false}={}){
  let mat;
  if(kind==='glass')mat=std({color:0xd6e3ff,transparent:true,opacity:0.1,roughness:.04,metalness:.2,depthWrite:false,side:THREE.DoubleSide});
  else if(kind==='solid')mat=std({color:PANEL,roughness:.55,side:THREE.DoubleSide,transparent:true,opacity:1});
  else{const t=(kind==='hex'?HEX:SLOT).clone();t.needsUpdate=true;t.repeat.set(w/tile,h/tile);mat=std({color:PANEL,map:t,transparent:true,alphaTest:0.5,roughness:.55,side:THREE.DoubleSide})}
  if(!keep)track(mat,mat.opacity);
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);m.position.set(x,y,z);m.rotation.set(rx,ry,0);m.userData.keep=keep;caseGroup.add(m);return m;
}
function bar(w,h,d,x,y,z,color=FRAME){const mat=track(std({color,roughness:.45,transparent:true,opacity:1}),1);const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);caseGroup.add(m);return m}
// the white printed border on each glass pane
function frit(w,h,t,place){const mat=track(std({color:0xe6e8ec,roughness:.4,transparent:true,opacity:1,side:THREE.DoubleSide}),1);const grp=new THREE.Group();[[0,h/2-t/2,w,t],[0,-h/2+t/2,w,t],[w/2-t/2,0,t,h],[-w/2+t/2,0,t,h]].forEach(([x,y,ww,hh])=>{const m=new THREE.Mesh(new THREE.PlaneGeometry(ww,hh),mat);m.position.set(x,y,0);grp.add(m)});place(grp);caseGroup.add(grp)}
let ioRing,floorShadow;
{
  const bodyH=HB-BASE,midY=(HB+BASE)/2,t=0.08;
  panel(W,BASE,'slot',{y:BASE/2,z:D/2});
  panel(D,BASE,'slot',{x:-W/2,y:BASE/2,ry:-Math.PI/2});
  panel(D,BASE,'slot',{x:W/2,y:BASE/2,ry:Math.PI/2});
  panel(W,BASE,'solid',{y:BASE/2,z:-D/2,ry:Math.PI});
  const psuHole=new THREE.Mesh(new THREE.PlaneGeometry(1.4,0.66),new THREE.MeshBasicMaterial({color:0x1d2026}));psuHole.position.set(-0.85,0.44,-D/2-0.01);psuHole.rotation.y=Math.PI;caseGroup.add(psuHole);
  [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([a,b])=>bar(t,bodyH,t,a*(W/2-t/2),midY,b*(D/2-t/2)));
  [BASE,HB].forEach(y=>{bar(W,t,t,0,y,D/2-t/2);bar(W,t,t,0,y,-D/2+t/2);bar(t,t,D,-W/2+t/2,y,0);bar(t,t,D,W/2-t/2,y,0)});
  panel(W-t*2,bodyH-t,'glass',{y:midY,z:D/2-0.02});
  frit(W-t*2,bodyH-t,0.09,g=>{g.position.set(0,midY,D/2-0.025)});
  panel(SIDE_MESH,bodyH-t,'slot',{x:-W/2+0.01,y:midY,z:-D/2+SIDE_MESH/2,ry:-Math.PI/2});
  panel(D-SIDE_MESH,bodyH-t,'glass',{x:-W/2+0.02,y:midY,z:-D/2+SIDE_MESH+(D-SIDE_MESH)/2,ry:-Math.PI/2});
  frit(D-SIDE_MESH,bodyH-t,0.08,g=>{g.position.set(-W/2+0.025,midY,-D/2+SIDE_MESH+(D-SIDE_MESH)/2);g.rotation.y=-Math.PI/2});
  bar(t,bodyH,t,-W/2+t/2,midY,-D/2+SIDE_MESH);
  panel(SIDE_MESH,bodyH-t,'slot',{x:W/2-0.01,y:midY,z:D/2-SIDE_MESH/2,ry:Math.PI/2});
  panel(D-SIDE_MESH,bodyH-t,'glass',{x:W/2-0.02,y:midY,z:-D/2+(D-SIDE_MESH)/2,ry:Math.PI/2});
  frit(D-SIDE_MESH,bodyH-t,0.08,g=>{g.position.set(W/2-0.025,midY,-D/2+(D-SIDE_MESH)/2);g.rotation.y=Math.PI/2});
  bar(t,bodyH,t,W/2-t/2,midY,D/2-SIDE_MESH);
  const hexY0=1.95,hexY1=5.1,hexW=W-0.56;
  panel(hexW,hexY1-hexY0,'hex',{y:(hexY0+hexY1)/2,z:-D/2+0.01,ry:Math.PI});
  panel(W,hexY0-BASE,'solid',{y:(hexY0+BASE)/2,z:-D/2+0.01,ry:Math.PI});
  panel(W,HB-hexY1,'solid',{y:(HB+hexY1)/2,z:-D/2+0.01,ry:Math.PI});
  [-1,1].forEach(s=>panel((W-hexW)/2,hexY1-hexY0,'solid',{x:s*(hexW/2+(W-hexW)/4),y:(hexY0+hexY1)/2,z:-D/2+0.01,ry:Math.PI}));
  const Sb=W+0.04,St=W-0.62,hh=H-HB;
  const hoodMat=track(std({color:PANEL,roughness:.5,side:THREE.DoubleSide,transparent:true,opacity:1,flatShading:true}),1);
  const hood=new THREE.Mesh(new THREE.CylinderGeometry(St/Math.SQRT2,Sb/Math.SQRT2,hh,4,1,true),hoodMat);hood.rotation.y=Math.PI/4;
  const hoodWrap=new THREE.Group();hoodWrap.add(hood);hoodWrap.scale.z=(D+0.04)/(W+0.04);hoodWrap.position.y=HB+hh/2;caseGroup.add(hoodWrap);
  panel(St,St*(D/W),'slot',{y:H,rx:-Math.PI/2});
  // front I/O on the hood's sloped face (the hood is scaled in z, so use the scaled inset)
  const inset=(Sb-St)/2*hoodWrap.scale.z,io=new THREE.Group();io.position.set(0,HB+hh/2,(D+0.04)/2-inset/2);io.rotation.x=-Math.atan2(inset,hh);caseGroup.add(io);
  const portMat=MAT.port.clone();portMat.polygonOffset=true;portMat.polygonOffsetFactor=-2;portMat.polygonOffsetUnits=-4;
  const port=(w,h,x)=>{const p=new THREE.Mesh(new THREE.BoxGeometry(w,h,0.012),portMat);p.position.set(x,0,0.004);io.add(p)};
  [-0.92,-0.74].forEach(x=>port(0.12,0.045,x));port(0.08,0.032,-0.55);[0.55,0.68].forEach(x=>port(0.045,0.045,x));[0.84,1.02].forEach(x=>port(0.12,0.045,x));
  ioRing=new THREE.Mesh(new THREE.TorusGeometry(0.075,0.015,10,36),std({color:0xe6e9f2,emissive:0x2f5bff,emissiveIntensity:.15}));ioRing.position.z=0.012;io.add(ioRing);
  [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([a,b])=>bar(0.36,0.14,0.36,a*(W/2-0.38),-0.07,b*(D/2-0.38)));
  const sc=document.createElement('canvas');sc.width=sc.height=128;const g2=sc.getContext('2d');const gr=g2.createRadialGradient(64,64,8,64,64,64);gr.addColorStop(0,'rgba(0,0,0,.32)');gr.addColorStop(1,'rgba(0,0,0,0)');g2.fillStyle=gr;g2.fillRect(0,0,128,128);
  floorShadow=new THREE.Mesh(new THREE.PlaneGeometry(W*2,D*2),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(sc),transparent:true,depthWrite:false}));floorShadow.rotation.x=-Math.PI/2;floorShadow.position.y=-0.139;scene.add(floorShadow);
  panel(W-0.16,D-0.16,'slot',{y:BASE,rx:-Math.PI/2,keep:true});
  // the Thermaltake mark on the floor cover, just behind the front glass
  label(textTex('TT  thermaltake',{w:1024,h:160,color:'#23262d',font:'700 84px Inter, system-ui, sans-serif',spacing:'4px'}),0.9,0.14,0,BASE+0.11,D/2-0.12,caseGroup).userData.keep=true;
  const shroud=box(W-0.16,0.2,0.04,MAT.white,0,BASE+0.1,D/2-0.1,caseGroup);shroud.userData.keep=true;
}

/* ---------- motherboard: MSI MAG X870E Tomahawk WiFi (ATX 305 × 244 mm), rotated so its I/O edge faces up ---------- */
const MB={x0:-1.72,x1:1.33,y0:2.84,y1:5.28,z:-1.10};
const BZ=MB.z+0.008;                                   // front face of the board
const PUMP={x:0.42,y:4.30};
const GPU={x:-0.62,y:3.85,h:1.15,len:2.86};            // PCB plane, card centre; 286 × 115 × 51 mm
{
  const w=MB.x1-MB.x0,h=MB.y1-MB.y0,cx=(MB.x0+MB.x1)/2,cy=(MB.y0+MB.y1)/2;
  box(w,h,0.016,MAT.pcb,cx,cy,MB.z);
  [[MB.x0+0.08,MB.y0+0.08],[MB.x1-0.08,MB.y0+0.08],[MB.x0+0.08,MB.y1-0.08],[MB.x1-0.08,MB.y1-0.08],[PUMP.x-0.9,PUMP.y],[0.1,MB.y0+0.08]].forEach(([x,y])=>cyl(0.03,0.02,MAT.steel,x,y,BZ+0.01));
  box(0.78,0.78,0.04,MAT.steel,PUMP.x,PUMP.y,BZ+0.02);                                   // socket retention frame
  const vrm=std({color:0xffffff,map:GROOVE(6,1),roughness:.38,metalness:.8});
  const vrmV=std({color:0xffffff,map:GROOVE(1,6),roughness:.38,metalness:.8});vrmV.map.rotation=Math.PI/2;
  box(1.3,0.24,0.34,vrm,PUMP.x+0.02,PUMP.y+0.63,BZ+0.17);                                 // VRM heatsink above the socket
  box(0.24,1.02,0.34,vrmV,PUMP.x+0.64,PUMP.y-0.06,BZ+0.17);                              // VRM heatsink to the right
  box(1.3,0.03,0.36,MAT.gun,PUMP.x+0.02,PUMP.y+0.76,BZ+0.18);box(0.03,1.02,0.36,MAT.gun,PUMP.x+0.77,PUMP.y-0.06,BZ+0.18);
  for(let i=0;i<9;i++)box(0.09,0.09,0.06,MAT.black,PUMP.x-0.55+i*0.13,PUMP.y+0.47,BZ+0.03);  // chokes peeking out
  const ioShroud=box(1.02,0.26,0.44,MAT.plastic,MB.x1-0.53,MB.y1-0.15,BZ+0.22);
  label(textTex('MAG',{w:512,h:128,color:'#d9dde6',font:'800 92px Inter, system-ui, sans-serif',spacing:'18px'}),0.36,0.09,MB.x1-0.53,MB.y1-0.15,BZ+0.445);
  box(0.06,0.9,0.1,MAT.steel,GPU.x,MB.y1-0.52,BZ+0.05);                                    // armoured PCIe x16 slot
  box(0.05,0.9,0.08,MAT.slot,-1.38,MB.y1-0.52,BZ+0.04);                                   // second x16-length slot
  box(0.36,1.18,0.05,vrm,-1.08,4.15,BZ+0.03);                                              // M.2 shield between the slots
  box(0.78,0.44,0.09,vrm,0.05,MB.y0+0.34,BZ+0.05);                                         // chipset heatsink
  box(0.06,0.44,0.1,MAT.gun,0.05,MB.y0+0.34,BZ+0.1);
  box(0.56,0.15,0.2,MAT.black,1.0,MB.y0+0.1,BZ+0.1);                                       // 24-pin
  for(let k=0;k<4;k++)box(1.38,0.05,0.08,MAT.slot,0.45,PUMP.y-0.6-k*0.095,BZ+0.04);           // DIMM slots
}
/* Corsair Vengeance RGB DDR5 (2 × 48 GB) in slots 2 and 4, light bars facing the front glass */
const ramDiffusers=[];
[PUMP.y-0.6-0.095,PUMP.y-0.6-0.285].forEach(y=>{
  box(1.33,0.075,0.5,std({color:0x1b1c20,roughness:.38,metalness:.55}),0.45,y,BZ+0.08+0.25);
  box(1.33,0.08,0.03,MAT.gun,0.45,y,BZ+0.56);
  const tex=LEDS.clone();tex.needsUpdate=true;
  const dm=std({color:0xe9edf6,roughness:.35,emissive:0x000000,emissiveMap:tex,emissiveIntensity:0});
  ramDiffusers.push(box(1.26,0.062,0.07,dm,0.45,y,BZ+0.61));
});

/* ---------- Gigabyte RTX 3070 Gaming OC (286 × 115 × 51 mm): WINDFORCE 3X, fans toward the left glass ---------- */
// card frame: x = 0 is the PCB, the cooler grows toward −x (fans), the backplate sits at +x; y runs the card's length; z = 0 at the slot edge, z = 1.15 at the top edge facing the front glass
let gpuLogoMat;
{
  const g=new THREE.Group();g.position.set(GPU.x,GPU.y,BZ);scene.add(g);
  const L=GPU.len,Hc=GPU.h,h=Hc/2,l=L/2,FANS=[-0.93,0,0.93];
  const shell=std({color:0x1d1f23,roughness:.55,metalness:.25});
  const trim=std({color:0x3c4048,roughness:.3,metalness:.85});
  const brushed=std({color:0x2a2d33,roughness:.32,metalness:.9});
  const accent=std({color:0x9aa0aa,roughness:.25,metalness:.95});
  // extrude a shape drawn in (height, length) onto the fan face, growing toward −x from x0
  const onFace=(shape,depth,mat,x0,bevel=0.006)=>{const geo=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:bevel>0,bevelThickness:bevel,bevelSize:bevel,bevelSegments:2,curveSegments:56});geo.rotateY(-Math.PI/2);const m=new THREE.Mesh(geo,mat);m.position.set(x0,0,h);g.add(m);return m};
  const outline=(inset=0)=>{const c=0.17-inset*0.4,hh=h-inset,ll=l-inset,s=new THREE.Shape();
    s.moveTo(-hh+c,-ll);s.lineTo(hh-c,-ll);s.lineTo(hh,-ll+c);s.lineTo(hh,ll-c);s.lineTo(hh-c,ll);s.lineTo(-hh+c,ll);s.lineTo(-hh,ll-c);s.lineTo(-hh,-ll+c);s.closePath();return s};
  // PCB, shorter than the cooler so air flows straight through the far end
  box(0.016,2.6,1.0,MAT.pcb,0,0.13,0.52,g);
  // fin stack with heatpipes lying in the open top edge
  box(0.3,L-0.08,Hc-0.12,std({color:0xffffff,map:FIN(1,80),roughness:.48,metalness:.6}),-0.19,0,h-0.01,g);
  for(let i=0;i<5;i++)cyl(0.017,L-0.5,MAT.nickel,-0.055-i*0.034,0.1,Hc-0.055,'y',g,14);
  // shroud: chamfered fan plate, raised metal frame, a bevelled ring round each fan, flush chevrons between them
  const plate=outline();FANS.forEach(y=>{const p=new THREE.Path();p.absarc(0,y,0.405,0,Math.PI*2,true);plate.holes.push(p)});
  onFace(plate,0.045,shell,-0.40);
  const band=outline();band.holes.push(new THREE.Path(outline(0.05).getPoints()));onFace(band,0.016,trim,-0.445,0.004);
  FANS.forEach(y=>{const ring=new THREE.Shape();ring.absarc(0,y,0.44,0,Math.PI*2,false);const hole=new THREE.Path();hole.absarc(0,y,0.405,0,Math.PI*2,true);ring.holes.push(hole);onFace(ring,0.024,trim,-0.445,0.004)});
  [-0.465,0.465].forEach(y=>{[-1,1].forEach(side=>{const c=new THREE.Shape();c.moveTo(side*0.13,y+0.012);c.lineTo(side*0.47,y-0.035);c.lineTo(side*0.47,y-0.005);c.lineTo(side*0.13,y+0.042);c.closePath();onFace(c,0.012,accent,-0.445,0)})});
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([su,sv])=>{const c=new THREE.Shape(),u0=su*(h-0.06),v0=sv*(l-0.06);c.moveTo(u0,v0-sv*0.2);c.lineTo(u0,v0);c.lineTo(u0-su*0.2,v0);c.lineTo(u0-su*0.2,v0-sv*0.03);c.lineTo(u0-su*0.03,v0-sv*0.03);c.lineTo(u0-su*0.03,v0-sv*0.2);c.closePath();onFace(c,0.012,accent,-0.445,0)});
  // top-edge lip carrying the RGB logo; bottom lip; end cap
  box(0.24,L-0.1,0.03,shell,-0.34,0,Hc+0.002,g);
  box(0.24,L-0.1,0.03,shell,-0.34,0,0.0,g);
  box(0.47,0.035,Hc,shell,-0.215,-l+0.01,h,g);
  gpuLogoMat=std({color:0x15161a,emissive:0x000000,emissiveMap:textTex('GIGABYTE',{color:'#ffffff'}),emissiveIntensity:0,roughness:.4});
  label(null,0.86,0.105,-0.34,0.62,Hc+0.019,g,{rz:Math.PI/2,mat:gpuLogoMat});
  label(textTex('GEFORCE RTX',{color:'#c5cad3',font:'800 70px Inter, system-ui, sans-serif',spacing:'10px'}),0.78,0.095,-0.34,-0.62,Hc+0.019,g,{rz:Math.PI/2});
  // brushed backplate with the flow-through window over the fins
  const bp=new THREE.Shape();{const w=h-0.015,ll=l-0.01,r=0.03;bp.moveTo(-w+r,-ll);bp.lineTo(w-r,-ll);bp.quadraticCurveTo(w,-ll,w,-ll+r);bp.lineTo(w,ll-r);bp.quadraticCurveTo(w,ll,w-r,ll);bp.lineTo(-w+r,ll);bp.quadraticCurveTo(-w,ll,-w,ll-r);bp.lineTo(-w,-ll+r);bp.quadraticCurveTo(-w,-ll,-w+r,-ll)}
  const win=new THREE.Path();win.moveTo(-0.34,-l+0.14);win.lineTo(0.34,-l+0.14);win.lineTo(0.34,-l+0.72);win.lineTo(-0.34,-l+0.72);win.closePath();bp.holes.push(win);
  {const geo=new THREE.ExtrudeGeometry(bp,{depth:0.022,bevelEnabled:true,bevelThickness:0.004,bevelSize:0.004,bevelSegments:1});geo.rotateY(-Math.PI/2);const m=new THREE.Mesh(geo,brushed);m.position.set(0.062,0,h);g.add(m)}
  // I/O bracket at the top of the vertical card: 3 × DisplayPort, 1 × HDMI
  box(0.5,0.016,1.22,MAT.steel,-0.2,l+0.012,0.56,g);
  [0.18,0.4,0.62].forEach(z=>box(0.06,0.022,0.13,MAT.port,-0.12,l+0.026,z,g));box(0.06,0.022,0.1,MAT.port,-0.12,l+0.026,0.84,g);
  // 8-pin + 6-pin power on the top edge near the far end
  box(0.075,0.17,0.07,MAT.black,-0.06,-0.98,Hc+0.03,g);box(0.075,0.13,0.07,MAT.black,-0.06,-0.76,Hc+0.03,g);
}

/* ---------- Lian Li Galahad II Trinity 360: pump head and radiator ---------- */
const RAD={x:W/2-0.08-0.135,y:3.24,z:D/2-0.08-0.596};  // 397.5 × 119.2 × 27 mm, pressed against the right grille
let pumpRingMat,pumpInfMat;
{
  const g=new THREE.Group();g.position.set(PUMP.x,PUMP.y,BZ);scene.add(g);
  cyl(0.39,0.05,MAT.steel,0,0,0.04,'z',g,64);                                            // cold plate
  const body=cyl(0.37,0.58,std({color:0xe9ebef,roughness:.32,metalness:.15}),0,0,0.35,'z',g,72);
  const lip=new THREE.Mesh(new THREE.TorusGeometry(0.36,0.022,12,72),std({color:0xe2e5eb,roughness:.2,metalness:.6}));lip.position.z=0.64;g.add(lip);
  const face=new THREE.Mesh(new THREE.CircleGeometry(0.355,72),std({color:0x07080b,roughness:.08,metalness:.9}));face.position.z=0.645;g.add(face);
  pumpInfMat=std({color:0x000000,emissive:0x000000,emissiveMap:INFINITY,emissiveIntensity:0,transparent:true,opacity:.95,roughness:.1,metalness:.5});
  const inf=new THREE.Mesh(new THREE.CircleGeometry(0.31,72),pumpInfMat);inf.position.z=0.648;g.add(inf);
  pumpRingMat=std({color:0xeef1ff,emissive:0x000000,emissiveIntensity:0,roughness:.3});
  [0.315,0.215].forEach(r=>{const m=new THREE.Mesh(new THREE.TorusGeometry(r,0.016,10,72),pumpRingMat);m.position.z=0.652;g.add(m)});
  label(textTex('LIAN LI',{color:'#e9ecf3',font:'800 80px Inter, system-ui, sans-serif',spacing:'14px'}),0.2,0.03,0,0,0.655,g);
  [0.13,-0.05].forEach(y=>cyl(0.055,0.18,std({color:0xe6e9ef,roughness:.3,metalness:.4}),0.43,y,0.42,'x',g,24));  // fittings toward the radiator
}
{
  const g=new THREE.Group();g.position.set(RAD.x,RAD.y,RAD.z);scene.add(g);
  box(0.27,3.62,1.06,std({color:0xffffff,map:FIN(1,90),roughness:.42,metalness:.55}),0,0,0,g);
  [-0.565,0.565].forEach(z=>box(0.27,3.62,0.065,MAT.white,0,0,z,g));
  [-1,1].forEach(s=>box(0.3,0.18,1.19,std({color:0xe6e8ec,roughness:.35,metalness:.1}),0,s*1.9,0,g));
  [-0.2,0.2].forEach(z=>cyl(0.055,0.16,MAT.white,-0.2,1.88,z,'x',g,24));
  label(textTex('LIAN LI',{color:'#9aa1ad',font:'800 80px Inter, system-ui, sans-serif',spacing:'14px'}),0.5,0.07,-0.151,-1.9,0,g,{ry:-Math.PI/2,rz:Math.PI/2});
}
// sleeved white tubes: pump fittings → top tank of the radiator
[[0.13,-0.2],[-0.05,0.2]].forEach(([fy,rz])=>{
  const a=new THREE.Vector3(PUMP.x+0.52,PUMP.y+fy,BZ+0.42),b=new THREE.Vector3(RAD.x-0.28,RAD.y+1.88,RAD.z+rz);
  const c=new THREE.CatmullRomCurve3([a,new THREE.Vector3(a.x+0.35,a.y+0.25,a.z+0.15),new THREE.Vector3(a.x+0.6,a.y+0.75,a.z+0.75),new THREE.Vector3(b.x-0.45,b.y+0.05,b.z-0.35),new THREE.Vector3(b.x-0.12,b.y,b.z)]);
  scene.add(new THREE.Mesh(new THREE.TubeGeometry(c,64,0.07,14,false),MAT.sleeve));
});
/* Thermaltake Toughpower GF3 850W in the base, at the back */
{
  box(1.5,0.86,1.6,std({color:0x16171a,roughness:.45,metalness:.4}),-0.85,0.45,-1.05);
  const grille=new THREE.Mesh(new THREE.TorusGeometry(0.52,0.02,8,64),MAT.gun);grille.rotation.x=Math.PI/2;grille.position.set(-0.85,0.885,-1.05);scene.add(grille);
  label(textTex('TOUGHPOWER  GF3',{color:'#c9cdd6',font:'700 64px Inter, system-ui, sans-serif',spacing:'6px'}),0.9,0.1,-0.85,0.45,-0.245);
}

/* heat glows */
const glows=[];
function glow(x,y,z,s,color){const m=new THREE.Sprite(new THREE.SpriteMaterial({map:GLOW,color,transparent:true,opacity:0,depthWrite:false}));m.position.set(x,y,z);m.scale.set(s,s,1);scene.add(m);glows.push(m);return m}
const gpuGlow=glow(GPU.x-0.2,GPU.y,BZ+0.57,2.7,0xff8a3d);
const radGlow=glow(RAD.x,RAD.y,RAD.z,2.9,0xff7a2a);
const cpuGlow=glow(PUMP.x,PUMP.y,BZ+0.5,1.4,0xffa060);

/* ---------- the fan component: extruded frame, curved clear blades, LED rings that fill the blades ---------- */
const FAN_GEO={};
function bladeGeometry(s,count){
  const R0=s*0.19,R1=s*0.452,gap=2*Math.PI/count,span0=gap*0.6,span1=gap*0.8,sweep=0.42,N=16,pts=[];
  const mid=r=>{const u=(r-R0)/(R1-R0);return sweep*u*u},half=r=>{const u=(r-R0)/(R1-R0);return(span0+(span1-span0)*u)/2};
  for(let i=0;i<=N;i++){const r=R0+(R1-R0)*i/N,a=mid(r)+half(r);pts.push(new THREE.Vector2(r*Math.cos(a),r*Math.sin(a)))}
  const aL=mid(R1)+half(R1),aT=mid(R1)-half(R1);for(let i=1;i<8;i++){const a=aL+(aT-aL)*i/8;pts.push(new THREE.Vector2(R1*Math.cos(a),R1*Math.sin(a)))}
  for(let i=N;i>=0;i--){const r=R0+(R1-R0)*i/N,a=mid(r)-half(r);pts.push(new THREE.Vector2(r*Math.cos(a),r*Math.sin(a)))}
  const g=new THREE.ShapeGeometry(new THREE.Shape(pts),1),p=g.attributes.position;
  for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),r=Math.hypot(x,y),th=Math.atan2(y,x)-mid(r);p.setZ(i,-th*r*0.62)}  // helical pitch
  g.computeVertexNormals();return g;
}
function fanGeo(s,blades,frame){
  const k=s+'|'+blades+'|'+frame;if(FAN_GEO[k])return FAN_GEO[k];const o={};
  if(frame){const sh=rrShape(s,s,s*0.075);const bore=new THREE.Path();bore.absarc(0,0,s*0.477,0,Math.PI*2,true);sh.holes.push(bore);
    [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([a,b])=>{const hp=new THREE.Path();hp.absarc(a*s*0.405,b*s*0.405,0.022,0,Math.PI*2,true);sh.holes.push(hp)});
    o.frame=new THREE.ExtrudeGeometry(sh,{depth:0.23,bevelEnabled:true,bevelThickness:0.01,bevelSize:0.01,bevelSegments:2,curveSegments:48});o.frame.translate(0,0,-0.115);
    o.arm=new THREE.BoxGeometry(s*0.3,0.028,0.045);o.ring=new THREE.TorusGeometry(s*0.477,0.012,8,72)}
  o.blade=bladeGeometry(s,blades);
  o.hub=new THREE.CylinderGeometry(s*0.185,s*0.185,0.17,40);o.hub.rotateX(Math.PI/2);
  o.cap=new THREE.CircleGeometry(s*0.16,40);o.disc=new THREE.CircleGeometry(s*0.455,48);
  o.hubRing=new THREE.TorusGeometry(s*0.186,0.009,8,48);o.sel=new THREE.RingGeometry(s*0.56,s*0.6,64);
  return FAN_GEO[k]=o;
}
function buildFan({size:s,blades=9,frame=true,clear=true,rgb=true,bladeColor=0xf4f6fb,hubColor=0xf3f4f7,capColor=0xe3e6ec}){
  const G=fanGeo(s,blades,frame),root=new THREE.Group(),rotor=new THREE.Group();
  const frameMat=std({color:0xe6e8ec,roughness:.45,metalness:.05});
  if(frame){root.add(new THREE.Mesh(G.frame,frameMat));for(let k=0;k<4;k++){const a=new THREE.Mesh(G.arm,frameMat),ang=k*Math.PI/2+Math.PI/4;a.position.set(Math.cos(ang)*s*0.33,Math.sin(ang)*s*0.33,0.095);a.rotation.z=ang;root.add(a)}}
  const bladeMat=std({color:bladeColor,roughness:clear?.25:.45,metalness:clear?0:.2,transparent:clear,opacity:clear?.58:1,side:THREE.DoubleSide,depthWrite:!clear,emissive:0x000000});
  for(let i=0;i<blades;i++){const b=new THREE.Mesh(G.blade,bladeMat);b.rotation.z=i/blades*Math.PI*2;rotor.add(b)}
  const hubMat=std({color:hubColor,roughness:.4,emissive:0x000000});rotor.add(new THREE.Mesh(G.hub,hubMat));
  const cap=new THREE.Mesh(G.cap,std({color:capColor,roughness:.25,metalness:.35}));cap.position.z=-0.088;cap.rotation.y=Math.PI;rotor.add(cap);
  root.add(rotor);
  const glowMat=new THREE.MeshBasicMaterial({map:FANFILL,color:0x2f5bff,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide});
  root.add(new THREE.Mesh(G.disc,glowMat));
  const ringMat=std({color:0xf7f8fb,roughness:.3,emissive:0x000000,emissiveIntensity:0});
  if(frame&&rgb)[-0.104,0.104].forEach(z=>{const r=new THREE.Mesh(G.ring,ringMat);r.position.z=z;root.add(r)});
  if(rgb){const hr=new THREE.Mesh(G.hubRing,ringMat);hr.position.z=-0.088;rotor.add(hr)}
  const blurMat=new THREE.MeshBasicMaterial({color:clear?0xffffff:0x2a2c31,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide});
  const blur=new THREE.Mesh(G.disc,blurMat);blur.position.z=0.003;root.add(blur);
  const selMat=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false});
  const selRing=new THREE.Mesh(G.sel,selMat);selRing.position.z=-0.13;root.add(selRing);
  return {root,rotor,bladeMat,frameMat,ringMat,glowMat,blurMat,selMat,hubMat,rgb,clear,size:s};
}
const fans=[],hitboxes=[];const ZAX=new THREE.Vector3(0,0,1);
function orient(f,n){f.normal=n.clone().normalize();f.root.quaternion.setFromUnitVectors(ZAX,f.normal);f.hit.quaternion.copy(f.root.quaternion)}
function makeFan(group,size,pos,normal,opt={}){
  const f=buildFan(Object.assign({size},opt));f.root.position.copy(pos);scene.add(f.root);
  f.hit=new THREE.Mesh(new THREE.BoxGeometry(size*1.05,size*1.05,0.6),new THREE.MeshBasicMaterial({visible:false}));f.hit.position.copy(pos);scene.add(f.hit);
  Object.assign(f,{group,pos:pos.clone(),phase:Math.random()*6,dirSign:opt.dirSign||1,idx:fans.length});orient(f,normal);
  f.selMat.color.set(GROUPS[group].color);f.hit.userData.fan=f;hitboxes.push(f.hit);fans.push(f);return f;
}
const V=(x,y,z)=>new THREE.Vector3(x,y,z);
[RAD.y+1.2,RAD.y,RAD.y-1.2].forEach(y=>makeFan('rad',1.2,V(RAD.x-0.26,y,RAD.z),V(1,0,0)));                 // push through the radiator, out the grille
[-0.64,0.6].forEach(x=>makeFan('top',1.2,V(x,HB+0.06,0.3),V(0,1,0)));                                     // exhaust up through the top
[-0.75,0.75].forEach(x=>makeFan('floor',1.4,V(x,BASE-0.17,0.62),V(0,1,0)));                               // 140 mm intakes under the floor plate
[[0.62,2.62],[-0.62,4.42]].forEach(([x,y])=>makeFan('rear',1.2,V(x,y,-D/2+0.2),V(0,0,1)));                // diagonal: bottom-left and top-right from the back
[-0.93,0,0.93].forEach((dy,i)=>makeFan('gpu',0.8,V(GPU.x-0.37,GPU.y+dy,BZ+GPU.h/2),V(1,0,0),{frame:false,clear:false,rgb:false,blades:11,bladeColor:0x1c1d21,hubColor:0x1c1d21,capColor:0x8f959f,dirSign:i===1?-1:1}));

/* ---------- airflow: smoke and wind streaks share one flow model ---------- */
let SOURCES=[],SINKS=[],simT=0;
function fanSpeed(group){return 0.7+rpmOf(group)/1500*1.9}
function buildFlow(){
  SOURCES=[];SINKS=[];
  const add=(list,f,n,extra={})=>list.push(Object.assign({p:f.pos.clone(),n,r:f.size*0.42,group:f.group,w:cfm(rpmOf(f.group),f.size)},extra));
  fans.forEach(f=>{
    if(f.group==='floor')add(SOURCES,f,V(0,1,0));
    if(f.group==='top')add(SINKS,f,V(0,1,0));
    if(f.group==='rad')add(SINKS,f,V(1,0,0),{w:cfm(rpmOf('rad'),1.2)*0.65,rad:true});
    if(f.group==='rear'){const n=GROUPS.rear.flow==='in'?V(0,0,1):V(0,0,-1);orient(f,n);(GROUPS.rear.flow==='in'?SOURCES:SINKS).push({p:f.pos.clone(),n,r:f.size*0.42,group:'rear',w:cfm(rpmOf('rear'),1.2)})}
  });
}
const pickW=list=>{const tot=list.reduce((a,b)=>a+b.w,0);let r=Math.random()*tot;for(let i=0;i<list.length;i++){r-=list[i].w;if(r<=0)return i}return list.length-1};
function makeFlow(n,noise,fade){return{n,noise,fade,pos:new Float32Array(n*3),vel:new Float32Array(n*3),tmp:new Float32Array(n),age:new Float32Array(n),exitT:new Float32Array(n),seed:new Float32Array(n),stage:new Int8Array(n),sink:new Int16Array(n),src:new Int16Array(n),born:new Uint8Array(n),base:new Float32Array(n),wp:new Float32Array(n*3),hasWp:new Uint8Array(n)}}
/* solid parts the air has to go around (axis-aligned boxes: x0,x1,y0,y1,z0,z1) */
const OBST=[
  {id:'board',b:[MB.x0-0.02,MB.x1+0.02,MB.y0-0.02,MB.y1+0.02,MB.z-0.04,BZ+0.05]},
  {id:'gpu',b:[GPU.x-0.5,GPU.x+0.06,GPU.y-GPU.len/2,GPU.y+GPU.len/2+0.04,BZ,BZ+GPU.h+0.05]},
  {id:'pump',b:[PUMP.x-0.4,PUMP.x+0.62,PUMP.y-0.4,PUMP.y+0.4,BZ,BZ+0.68]},
  {id:'ram',b:[-0.24,1.14,PUMP.y-0.95,PUMP.y-0.62,BZ,BZ+0.64]},
  {id:'vrm',b:[PUMP.x-0.64,PUMP.x+0.78,PUMP.y-0.6,PUMP.y+0.78,BZ,BZ+0.36]},
  {id:'psu',b:[-1.62,-0.08,0,0.9,-1.87,-0.23]},
  {id:'rad',b:[RAD.x-0.15,RAD.x+0.15,RAD.y-1.99,RAD.y+1.99,RAD.z-0.6,RAD.z+0.6]},
];
function pushOut(F,k,skipRad){
  let x=F.pos[k],y=F.pos[k+1],z=F.pos[k+2];
  for(const o of OBST){if(skipRad&&o.id==='rad')continue;const b=o.b;
    if(x>b[0]&&x<b[1]&&y>b[2]&&y<b[3]&&z>b[4]&&z<b[5]){
      const d=[x-b[0],b[1]-x,y-b[2],b[3]-y,z-b[4],b[5]-z];let m=0;for(let q=1;q<6;q++)if(d[q]<d[m])m=q;
      const ax=m>>1,sgn=m%2?1:-1,e=0.012;
      if(ax===0){x=sgn>0?b[1]+e:b[0]-e;F.vel[k]*=-0.15}else if(ax===1){y=sgn>0?b[3]+e:b[2]-e;F.vel[k+1]*=-0.15}else{z=sgn>0?b[5]+e:b[4]-e;F.vel[k+2]*=-0.15}
    }}
  F.pos[k]=x;F.pos[k+1]=y;F.pos[k+2]=z;
}
/* if the straight path to the target crosses the motherboard, detour around its nearest sensible edge */
function planRoute(F,i,x,y,z,tx,ty,tz){
  F.hasWp[i]=0;const zp=MB.z,behind=z<zp-0.02,tBehind=tz<zp-0.02;if(behind===tBehind)return;
  const u=(zp-z)/((tz-z)||1e-3),cx=x+(tx-x)*u,cy=y+(ty-y)*u,m=0.25;
  if(cx<MB.x0-m||cx>MB.x1+m||cy<MB.y0-m||cy>MB.y1+m)return;
  const cl=(v,a,b)=>Math.max(a,Math.min(b,v)),j=(Math.random()-0.5)*0.4;
  const opts=[[MB.x0-0.22,cl(cy+j,MB.y0,MB.y1)],[MB.x1+0.2,cl(cy+j,MB.y0,MB.y1)],[cl(cx+j,MB.x0,MB.x1),Math.min(MB.y1+0.18,HB-0.12)],[cl(cx+j,MB.x0,MB.x1),MB.y0-0.28]];
  let best=null,bd=1e9;for(const[ex,ey]of opts){const ex2=cl(ex,-W/2+0.14,W/2-0.14);const d=Math.hypot(ex2-x,ey-y)+Math.hypot(tx-ex2,ty-ey)*0.6;if(d<bd){bd=d;best=[ex2,ey]}}
  F.wp[i*3]=best[0];F.wp[i*3+1]=best[1];F.wp[i*3+2]=zp;F.hasWp[i]=1;
}
const _a=V(0,0,0),_b=V(0,0,0),_c=V(0,0,0);
function spawnP(F,i,scatter){
  const si=pickW(SOURCES),s=SOURCES[si];F.src[i]=si;F.sink[i]=pickW(SINKS);
  if(Math.random()<0.09){   // warm air pushed out of the GPU's fin stack, along its front edge and top end; sparse on purpose
    const k=i*3,top=Math.random()<0.3,x=GPU.x-0.22+(Math.random()-0.5)*0.4,y=top?GPU.y+GPU.len/2+0.08:GPU.y+(Math.random()-0.5)*GPU.len*0.9,z=top?BZ+0.2+Math.random()*0.8:BZ+GPU.h+0.08;
    F.pos[k]=x;F.pos[k+1]=y;F.pos[k+2]=z;F.vel[k]=0;F.vel[k+1]=top?0.6:0.25;F.vel[k+2]=top?0.05:0.55;
    F.stage[i]=1;F.exitT[i]=0;F.tmp[i]=0.6+Math.random()*0.25;F.age[i]=scatter?-Math.random()*7:0;F.seed[i]=Math.random()*100;F.born[i]=1;
    const sk=SINKS[F.sink[i]];planRoute(F,i,x,y,z,sk.p.x,sk.p.y,sk.p.z);return;
  }
  let x,y,z;
  if(s.group==='floor'){const side=Math.random(),out=0.25+Math.random()*0.9;y=0.08+Math.random()*0.62;
    if(side<0.5){x=(Math.random()-0.5)*W;z=D/2+out}else{x=(side<0.75?-1:1)*(W/2+out);z=0.05+Math.random()*1.75}}   // front half of the base only, clear of the PSU
  else{_a.set(1,0,0);_b.crossVectors(s.n,_a).normalize();_c.crossVectors(s.n,_b).normalize();const ang=Math.random()*Math.PI*2,rad=Math.sqrt(Math.random())*s.r,back=0.35+Math.random()*1.2;
    x=s.p.x+_b.x*Math.cos(ang)*rad+_c.x*Math.sin(ang)*rad-s.n.x*back;y=s.p.y+_b.y*Math.cos(ang)*rad+_c.y*Math.sin(ang)*rad-s.n.y*back;z=s.p.z+_b.z*Math.cos(ang)*rad+_c.z*Math.sin(ang)*rad-s.n.z*back}
  const k=i*3;F.pos[k]=x;F.pos[k+1]=y;F.pos[k+2]=z;F.stage[i]=0;F.exitT[i]=0;
  const sp=fanSpeed(s.group)*0.5,dl=Math.hypot(s.p.x-x,s.p.y-y,s.p.z-z)||1;F.vel[k]=(s.p.x-x)/dl*sp;F.vel[k+1]=(s.p.y-y)/dl*sp;F.vel[k+2]=(s.p.z-z)/dl*sp;
  F.tmp[i]=Math.random()*0.04;F.age[i]=scatter?-Math.random()*7:0;F.seed[i]=Math.random()*100;F.born[i]=1;F.hasWp[i]=0;
}
/* the shell: air only crosses it where there is mesh (side strips, top panel, rear hex, the base); glass and solid panels bounce it back */
const HEX_HW=(W-0.56)/2,TOP_HX=(W-0.62)/2,TOP_HZ=(W-0.62)*D/W/2;
function meshAt(axis,side,x,y,z){
  if(axis===1)return side>0&&Math.abs(x)<TOP_HX&&Math.abs(z)<TOP_HZ;      // top panel; nothing through the floor
  if(y<BASE)return !(axis===2&&side<0);                                  // base: slots front and sides, solid back
  if(y>HB)return false;                                                  // hood sides are solid
  if(axis===0)return side>0?z>D/2-SIDE_MESH:z<-D/2+SIDE_MESH;            // each side is glass except its perforated strip
  return side<0&&y>1.95&&y<5.1&&Math.abs(x)<HEX_HW;                      // rear hex mesh; the front is all glass
}
const inShell=(x,y,z)=>Math.abs(x)<W/2&&Math.abs(z)<D/2&&y>0&&y<H;
function contain(F,k,px,py,pz){
  const x=F.pos[k],y=F.pos[k+1],z=F.pos[k+2],was=inShell(px,py,pz);if(was===inShell(x,y,z))return;
  const ox=was?x:px,oy=was?y:py,oz=was?z:pz;let axis,side,t;
  if(Math.abs(ox)>=W/2){axis=0;side=Math.sign(ox);t=(side*W/2-px)/((x-px)||1e-6)}
  else if(Math.abs(oz)>=D/2){axis=2;side=Math.sign(oz);t=(side*D/2-pz)/((z-pz)||1e-6)}
  else{axis=1;side=oy>=H?1:-1;t=((side>0?H:0)-py)/((y-py)||1e-6)}
  t=Math.max(0,Math.min(1,t));if(meshAt(axis,side,px+(x-px)*t,py+(y-py)*t,pz+(z-pz)*t))return;
  const back=was?-1:1,e=0.02;
  if(axis===0){F.pos[k]=side*(W/2+back*e);F.vel[k]*=-0.3}
  else if(axis===2){F.pos[k+2]=side*(D/2+back*e);F.vel[k+2]*=-0.3}
  else{F.pos[k+1]=(side>0?H:0)+side*back*e;F.vel[k+1]*=-0.3}
}
function heatAt(x,y,z){
  const gpuP=Math.max(0,(GROUPS.gpu.temp-28)/50),cpuP=Math.max(0,(GROUPS.rad.temp-35)/60);let h=0.012;
  const dg=Math.hypot(x-(GPU.x-0.2),(y-GPU.y)*0.55,z-(BZ+0.57));if(dg<1.2)h+=gpuP*1.15*(1-dg/1.2);
  const dc=Math.hypot(x-PUMP.x,y-(PUMP.y+0.4),z-(BZ+0.3));if(dc<0.9)h+=cpuP*0.35*(1-dc/0.9);
  return h;
}
function stepFlow(F,dt){
  const radHeat=0.3+0.65*Math.max(0,Math.min(1,(GROUPS.rad.temp-35)/45)),nz=F.noise,t=simT;
  for(let i=0;i<F.n;i++){
    F.age[i]+=dt;if(F.age[i]<0)continue;
    const k=i*3;let x=F.pos[k],y=F.pos[k+1],z=F.pos[k+2],vx=F.vel[k],vy=F.vel[k+1],vz=F.vel[k+2];const px=x,py=y,pz=z;
    const s=SINKS[F.sink[i]],src=SOURCES[F.src[i]];if(!s||!src){spawnP(F,i);continue}
    const sd=F.seed[i];
    if(F.stage[i]===0){            // drawn in toward its intake fan
      const ex=src.p.x-x,ey=src.p.y-y,ez=src.p.z-z,ed=Math.hypot(ex,ey,ez)||1e-3,isp=fanSpeed(src.group)*(0.45+Math.min(1,0.8/ed)*0.95),st=Math.min(1,2.4*dt);
      vx+=(ex/ed*isp-vx)*st;vy+=(ey/ed*isp-vy)*st;vz+=(ez/ed*isp-vz)*st;
      vx+=Math.sin(y*2.3+t+sd)*0.3*nz*dt;vz+=Math.cos(x*2.1-t*0.8+sd)*0.3*nz*dt;
      if(ed<src.r*0.75){F.stage[i]=1;const sp=fanSpeed(src.group);vx=src.n.x*sp;vy=src.n.y*sp;vz=src.n.z*sp;
        planRoute(F,i,x+src.n.x*0.4,y+src.n.y*0.4,z+src.n.z*0.4,s.p.x,s.p.y,s.p.z)}
    }else if(F.stage[i]===1){      // through the case, picking up heat, toward an exhaust (around the board if needed)
      let tx=s.p.x,ty=s.p.y,tz=s.p.z;
      if(F.hasWp[i]){tx=F.wp[i*3];ty=F.wp[i*3+1];tz=F.wp[i*3+2];if(Math.hypot(tx-x,ty-y,tz-z)<0.32){F.hasWp[i]=0;planRoute(F,i,x,y,z,s.p.x,s.p.y,s.p.z)}}
      const dx=tx-x,dy=ty-y,dz=tz-z,dist=Math.hypot(dx,dy,dz)||1e-3;
      const sDist=F.hasWp[i]?9:dist;
      const sp=fanSpeed(s.group)*(0.75+Math.min(1,1.6/dist)*0.5),st=Math.min(1,(F.hasWp[i]?1.8:0.9)*dt);
      vx+=(dx/dist*sp-vx)*st;vy+=(dy/dist*sp-vy)*st;vz+=(dz/dist*sp-vz)*st;
      vy+=F.tmp[i]*0.9*dt;
      vx+=Math.sin(y*1.9+t*0.9+sd)*0.6*nz*dt;vz+=Math.cos(x*1.7-t*0.7+sd*1.3)*0.6*nz*dt;vy+=Math.sin(z*2.1+t*1.1+sd*0.7)*0.28*nz*dt;
      if(y>BASE&&y<HB&&Math.abs(x)<W/2&&Math.abs(z)<D/2){F.tmp[i]=Math.min(1,F.tmp[i]+heatAt(x,y,z)*dt*1.6);
        const lim=W/2-0.1;if(Math.abs(x)>lim&&!s.rad){x=Math.sign(x)*lim;vx*=-0.3}if(Math.abs(z)>D/2-0.1&&s.n.z===0){z=Math.sign(z)*(D/2-0.1);vz*=-0.3}}
      if(sDist<s.r*0.9){F.stage[i]=2;F.exitT[i]=0;F.tmp[i]=Math.max(F.tmp[i],s.rad?Math.max(0.55,radHeat)*(0.85+Math.random()*0.3):0.4+Math.random()*0.2)}   // exhaust always leaves warmer
    }else{                          // pushed out of the exhaust and spreading
      F.exitT[i]+=dt;const sp=fanSpeed(s.group)*1.35,e=Math.min(1,2.5*dt);
      vx+=(s.n.x*sp-vx)*e;vy+=(s.n.y*sp-vy)*e;vz+=(s.n.z*sp-vz)*e;
      const spread=inShell(x,y,z)?0.15:1;
      vx+=Math.sin(sd+t*2)*0.9*nz*spread*dt;vz+=Math.cos(sd*1.7+t*1.6)*0.9*nz*spread*dt;vy+=Math.sin(sd*0.5+t*1.3)*0.5*nz*spread*dt;
      if(F.exitT[i]>F.fade){spawnP(F,i);continue}
    }
    x+=vx*dt;y+=vy*dt;z+=vz*dt;
    if(F.age[i]>18){spawnP(F,i);continue}
    F.pos[k]=x;F.pos[k+1]=y;F.pos[k+2]=z;F.vel[k]=vx;F.vel[k+1]=vy;F.vel[k+2]=vz;
    contain(F,k,px,py,pz);
    if(F.stage[i]===1||(F.stage[i]===2&&!s.rad))pushOut(F,k,F.stage[i]===2&&s.rad);   // slide around solid parts instead of passing through
  }
}
const SMOKE_N=small?70:120,TRACE_N=small?70:110,TRAIL=28;   // sparse on purpose: wisps and streaks, not fog
const smokeF=makeFlow(SMOKE_N,0.9,2.0),traceF=makeFlow(TRACE_N,0.5,1.3);
for(let i=0;i<SMOKE_N;i++)smokeF.base[i]=0.75+Math.random()*0.55;
// smoke: soft, rotating puffs from a procedural cloud texture
const SMOKE_TEX=canvasTex(128,128,(g)=>{for(let i=0;i<70;i++){const r=8+rnd()*26,a=rnd()*Math.PI*2,d=rnd()*36,x=64+Math.cos(a)*d,y=64+Math.sin(a)*d;const gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,'rgba(255,255,255,.2)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill()}
  g.globalCompositeOperation='destination-in';const m=g.createRadialGradient(64,64,6,64,64,64);m.addColorStop(0,'rgba(0,0,0,1)');m.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=m;g.fillRect(0,0,128,128)});
const sGeo=new THREE.BufferGeometry();
const sCol=new Float32Array(SMOKE_N*3),sAlp=new Float32Array(SMOKE_N),sSiz=new Float32Array(SMOKE_N),sRot=new Float32Array(SMOKE_N);
sGeo.setAttribute('position',new THREE.BufferAttribute(smokeF.pos,3));sGeo.setAttribute('pcolor',new THREE.BufferAttribute(sCol,3));
sGeo.setAttribute('alpha',new THREE.BufferAttribute(sAlp,1));sGeo.setAttribute('psize',new THREE.BufferAttribute(sSiz,1));sGeo.setAttribute('prot',new THREE.BufferAttribute(sRot,1));
const sMat=new THREE.ShaderMaterial({uniforms:{uScale:{value:600},uTex:{value:SMOKE_TEX}},transparent:true,depthWrite:false,
  vertexShader:`attribute vec3 pcolor;attribute float alpha;attribute float psize;attribute float prot;varying vec3 vC;varying float vA;varying float vR;uniform float uScale;
    void main(){vC=pcolor;vA=alpha;vR=prot;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=min(psize*uScale/-mv.z,480.0);gl_Position=projectionMatrix*mv;}`,
  fragmentShader:`uniform sampler2D uTex;varying vec3 vC;varying float vA;varying float vR;
    void main(){vec2 p=gl_PointCoord-0.5;float c=cos(vR),s=sin(vR);p=mat2(c,-s,s,c)*p;vec4 t=texture2D(uTex,p+0.5);float a=t.a*vA;if(a<0.003)discard;gl_FragColor=vec4(vC,a);}`});
const smoke=new THREE.Points(sGeo,sMat);smoke.frustumCulled=false;scene.add(smoke);
// wind streaks: tapered ribbons with soft edges trailing each tracer, so they read as motion blur
const trailHist=new Float32Array(TRACE_N*TRAIL*3);let trailClock=0;
const SEG=TRAIL-1,QV=TRACE_N*SEG*4;
const rPos=new Float32Array(QV*3),rOth=new Float32Array(QV*3),rSide=new Float32Array(QV),rAcr=new Float32Array(QV),rT=new Float32Array(QV),rA=new Float32Array(QV),rCol=new Float32Array(QV*3),rIdx=new Uint32Array(TRACE_N*SEG*6);
for(let q=0;q<TRACE_N*SEG;q++){const v=q*4,o=q*6;rIdx.set([v,v+1,v+2,v+1,v+3,v+2],o);rSide.set([-1,1,1,-1],v);rAcr.set([-1,1,-1,1],v)}
const lGeo=new THREE.BufferGeometry();
lGeo.setAttribute('position',new THREE.BufferAttribute(rPos,3));lGeo.setAttribute('aOther',new THREE.BufferAttribute(rOth,3));lGeo.setAttribute('aSide',new THREE.BufferAttribute(rSide,1));
lGeo.setAttribute('aAcross',new THREE.BufferAttribute(rAcr,1));lGeo.setAttribute('aT',new THREE.BufferAttribute(rT,1));lGeo.setAttribute('aA',new THREE.BufferAttribute(rA,1));lGeo.setAttribute('aCol',new THREE.BufferAttribute(rCol,3));
lGeo.setIndex(new THREE.BufferAttribute(rIdx,1));
const lMat=new THREE.ShaderMaterial({uniforms:{uRes:{value:new THREE.Vector2(800,600)},uW:{value:3.2*DPR}},transparent:true,depthWrite:false,side:THREE.DoubleSide,
  vertexShader:`attribute vec3 aOther;attribute float aSide;attribute float aAcross;attribute float aT;attribute float aA;attribute vec3 aCol;uniform vec2 uRes;uniform float uW;varying vec3 vC;varying float vA;varying float vX;
    void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vec4 p=projectionMatrix*mv;vec4 o=projectionMatrix*modelViewMatrix*vec4(aOther,1.0);
      vec2 d=(o.xy/o.w-p.xy/p.w)*uRes;float l=length(d);vec2 dir=l>1e-4?d/l:vec2(1.0,0.0);vec2 n=vec2(-dir.y,dir.x);
      float w=uW*(1.0-aT*0.82)*clamp(9.0/-mv.z,0.55,1.8);p.xy+=n*aSide*w*2.0/uRes*p.w;
      vC=aCol;vA=aA*pow(1.0-aT,1.25);vX=aAcross;gl_Position=p;}`,
  fragmentShader:`varying vec3 vC;varying float vA;varying float vX;void main(){float e=1.0-abs(vX);float a=vA*e*e*(3.0-2.0*e);if(a<0.003)discard;gl_FragColor=vec4(vC,a);}`});
const streaks=new THREE.Mesh(lGeo,lMat);streaks.frustumCulled=false;scene.add(streaks);
const cool=new THREE.Color(),warm=new THREE.Color(),mid=new THREE.Color(),neutral=new THREE.Color(),tc=new THREE.Color();
let tintOn=true,airMode='smoke',rgbMode='off';
const showcase=()=>rgbMode!=='off';
function themeColors(){const dk=true;cool.set(dk?'#5fb0ff':'#2f86e0');warm.set(dk?'#ff9a4a':'#e8792b');mid.set(dk?'#e3ecff':'#7aa6d6');neutral.set(dk?'#e8edf6':'#76819a')}
function tempColor(T,out){if(!tintOn)return out.copy(neutral);if(T<0.5)return out.copy(cool).lerp(mid,T*2);return out.copy(mid).lerp(warm,(T-0.5)*2)}
function drawSmoke(){
  const F=smokeF,dk=true,aBase=(dk?0.1:0.14)*(airMode==='both'?0.7:1);
  for(let i=0;i<F.n;i++){
    if(F.age[i]<0){sAlp[i]=0;continue}
    const fin=Math.min(1,F.age[i]/0.9),fout=F.stage[i]===2?Math.max(0,1-F.exitT[i]/F.fade):1;
    sAlp[i]=aBase*fin*fout;sSiz[i]=F.base[i]*(1+F.age[i]*0.05+(F.stage[i]===2?F.exitT[i]*0.9:0));
    sRot[i]=F.seed[i]+F.age[i]*(F.seed[i]%2<1?0.35:-0.35);
    tempColor(F.stage[i]===0?0:F.tmp[i],tc);sCol[i*3]=tc.r;sCol[i*3+1]=tc.g;sCol[i*3+2]=tc.b;
  }
  sGeo.attributes.position.needsUpdate=sGeo.attributes.pcolor.needsUpdate=sGeo.attributes.alpha.needsUpdate=sGeo.attributes.psize.needsUpdate=sGeo.attributes.prot.needsUpdate=true;
}
function drawStreaks(dt){
  const F=traceF,dk=true,aBase=dk?0.7:0.55;trailClock+=dt;const sample=trailClock>=1/60;if(sample)trailClock=0;
  for(let i=0;i<F.n;i++){
    const hb=i*TRAIL*3,k=i*3;
    if(F.born[i]){for(let j=0;j<TRAIL;j++){trailHist[hb+j*3]=F.pos[k];trailHist[hb+j*3+1]=F.pos[k+1];trailHist[hb+j*3+2]=F.pos[k+2]}F.born[i]=0}
    else if(sample){trailHist.copyWithin(hb+3,hb,hb+(TRAIL-1)*3);trailHist[hb]=F.pos[k];trailHist[hb+1]=F.pos[k+1];trailHist[hb+2]=F.pos[k+2]}
    const fin=F.age[i]<0?0:Math.min(1,F.age[i]/0.6),fout=F.stage[i]===2?Math.max(0,1-F.exitT[i]/F.fade):1,a=aBase*fin*fout;
    tempColor(F.stage[i]===0?0:F.tmp[i],tc);
    for(let j=0;j<SEG;j++){
      const q=(i*SEG+j)*4;
      const ax=j===0?F.pos[k]:trailHist[hb+j*3],ay=j===0?F.pos[k+1]:trailHist[hb+j*3+1],az=j===0?F.pos[k+2]:trailHist[hb+j*3+2];
      const bx=trailHist[hb+(j+1)*3],by=trailHist[hb+(j+1)*3+1],bz=trailHist[hb+(j+1)*3+2];
      for(let c=0;c<4;c++){const v=(q+c)*3,isA=c<2;
        rPos[v]=isA?ax:bx;rPos[v+1]=isA?ay:by;rPos[v+2]=isA?az:bz;
        rOth[v]=isA?bx:ax;rOth[v+1]=isA?by:ay;rOth[v+2]=isA?bz:az;
        rT[q+c]=(isA?j:j+1)/SEG;rA[q+c]=a;rCol[v]=tc.r;rCol[v+1]=tc.g;rCol[v+2]=tc.b}
    }
  }
  const at=lGeo.attributes;at.position.needsUpdate=at.aOther.needsUpdate=at.aT.needsUpdate=at.aA.needsUpdate=at.aCol.needsUpdate=true;
}
function resetAir(){buildFlow();for(let i=0;i<SMOKE_N;i++)spawnP(smokeF,i,true);for(let i=0;i<TRACE_N;i++)spawnP(traceF,i,true);
  if(reduce){for(let n=0;n<320;n++){simT+=1/30;stepFlow(smokeF,1/30);stepFlow(traceF,1/30);drawStreaks(1/30)}drawSmoke()}}
function setAir(m){airMode=m;['smoke','streaks','both','off'].forEach(k=>document.getElementById('air-'+k).setAttribute('aria-pressed',k===m));smoke.visible=m==='smoke'||m==='both';streaks.visible=m==='streaks'||m==='both'}
['smoke','streaks','both','off'].forEach(k=>document.getElementById('air-'+k).onclick=()=>setAir(k));

/* ---------- RGB: off, or on in one color; RGB on turns the room lights down ---------- */
const BLUE=new THREE.Color(0x2f5bff),BLACK=new THREE.Color(0);
function applyLighting(){   // the 3D stage is always dark; RGB on dims it further into a dark room
  const show=showcase();
  scene.background=new THREE.Color(show?'#04060a':'#0b0e15');scene.environment=show?ENV_ROOM:ENV_STUDIO;
  hemi.intensity=show?0.08:0.2;key.intensity=show?0.1:1.15;fillL.intensity=show?0.05:0.22;rim.intensity=show?0.08:0.35;
  scene.traverse(o=>{const m=o.material;if(m&&m.isMeshStandardMaterial)m.envMapIntensity=show?1.0:0.32});   // studio reflections were flooding every white surface
  const tm=show?THREE.NoToneMapping:THREE.ACESFilmicToneMapping;
  if(renderer.toneMapping!==tm){renderer.toneMapping=tm;key.castShadow=!show;scene.traverse(o=>{if(o.material)[].concat(o.material).forEach(m=>m.needsUpdate=true)})}
  rgbIn.intensity=show?1.7:0;rgbTop.intensity=show?1.3:0;rgbBase.intensity=show?2.4:0;
  floorShadow.material.opacity=show?0.4:1;bloomOn=show&&!!composer;
  const add=true;lMat.blending=add?THREE.AdditiveBlending:THREE.NormalBlending;lMat.needsUpdate=true;
  glows.forEach(g=>{g.material.blending=add?THREE.AdditiveBlending:THREE.NormalBlending;g.material.needsUpdate=true});
  themeColors();
}
// one color for everything, the way OpenRGB will set it
const rgbColor=new THREE.Color(0x2f5bff);
const SWATCHES=[['#2f5bff','Blue'],['#00c2ff','Cyan'],['#7a3cff','Purple'],['#ff2fa8','Pink'],['#ff3b30','Red'],['#ff8a1f','Amber'],['#2bd96b','Green'],['#ffffff','White']];
function paintRgb(){
  const on=showcase(),c=rgbColor;
  fans.forEach(f=>{
    f.blurMat.color.set(on&&f.rgb?c:(f.clear?0xffffff:0x2a2c31));
    if(!f.rgb)return;
    f.ringMat.emissive.copy(on?c:BLACK);f.ringMat.emissiveIntensity=on?2.6:0;
    f.bladeMat.emissive.copy(on?c:BLACK);f.bladeMat.emissiveIntensity=on?0.8:0;
    f.hubMat.emissive.copy(on?c:BLACK);f.hubMat.emissiveIntensity=on?0.35:0;
    f.glowMat.color.copy(c);f.glowMat.opacity=on?0.62:0;
  });
  pumpRingMat.emissive.copy(on?c:BLACK);pumpRingMat.emissiveIntensity=on?2.4:0;
  pumpInfMat.emissive.copy(on?c:BLACK);pumpInfMat.emissiveIntensity=on?1.6:0;
  gpuLogoMat.emissive.copy(on?c:BLACK);gpuLogoMat.emissiveIntensity=on?1.8:0;
  ioRing.material.emissive.copy(on?c:BLUE);ioRing.material.emissiveIntensity=on?2:0.15;
  ramDiffusers.forEach(d=>{d.material.emissive.copy(on?c:BLACK);d.material.emissiveIntensity=on?1.7:0});
  [rgbIn,rgbTop,rgbBase].forEach(l=>l.color.copy(c));
}
const swEl=document.getElementById('rgb-sw'),colorEl=document.getElementById('rgb-color');
swEl.innerHTML=SWATCHES.map(([hex,name])=>`<button data-c="${hex}" title="${name}" aria-label="${name}" aria-pressed="false" style="background:${hex}"></button>`).join('');
function markSwatch(){const hex='#'+rgbColor.getHexString();swEl.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.c.toLowerCase()===hex));colorEl.value=hex}
function setColor(hex){rgbColor.set(hex);markSwatch();if(!showcase())setRgb(true);else paintRgb()}
swEl.querySelectorAll('button').forEach(b=>b.onclick=()=>setColor(b.dataset.c));
colorEl.addEventListener('input',e=>setColor(e.target.value));
function setRgb(on){rgbMode=on?'on':'off';document.getElementById('rgb-off').setAttribute('aria-pressed',!on);document.getElementById('rgb-on').setAttribute('aria-pressed',on);applyLighting();paintRgb();markSwatch()}
document.getElementById('rgb-off').onclick=()=>setRgb(false);document.getElementById('rgb-on').onclick=()=>setRgb(true);
document.getElementById('tog-tint').onclick=e=>{tintOn=!tintOn;e.currentTarget.setAttribute('aria-pressed',tintOn);if(reduce)drawSmoke()};

/* ---------- camera, layers, panels ---------- */
const VIEWS={iso:[-7.52,5.4,9.28],front:[0,3.0,12.2],right:[11.4,3.2,1.9],back:[0.35,3.2,-12.2],gpu:[-7.2,4.6,2.6],top:[0.01,15,0.6]};
// a tall, narrow stage (phones) needs the camera further out to fit the whole case
function setView(k){touched();const r=canvas.getBoundingClientRect(),far=k==='top'?1:Math.max(1,Math.min(1.7,1.15/Math.max(0.4,r.width/Math.max(1,r.height))));const v=VIEWS[k];cam.position.set(v[0]*far,3+(v[1]-3)*far,v[2]*far);controls.update();Object.keys(VIEWS).forEach(v=>document.getElementById('cam-'+v).setAttribute('aria-pressed',v===k))}
Object.keys(VIEWS).forEach(k=>document.getElementById('cam-'+k).onclick=()=>setView(k));
setView('iso');
let showHeat=true,showLabels=false;   // labels off by default: the clean view
const tog=(id,fn)=>{const b=document.getElementById(id);b.onclick=()=>{const on=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',on);fn(on)}};
tog('tog-heat',on=>{showHeat=on;glows.forEach(g=>g.visible=on)});
tog('tog-lbl',on=>{showLabels=on;labelsEl.hidden=!on});
function setPanels(mode){
  panelMats.forEach(m=>{m.visible=mode!=='off';
    if(mode==='ghost'){m.opacity=m.userData.base*(m.map?0.3:0.14);m.alphaTest=m.map?0.08:0;m.depthWrite=false}
    else{m.opacity=m.userData.base;m.alphaTest=m.userData.test;m.depthWrite=m.userData.base>=1}
    m.needsUpdate=true});
  caseGroup.children.forEach(c=>{if(!c.userData.keep)c.visible=mode!=='off'});
  ['on','ghost','off'].forEach(k=>document.getElementById('pan-'+k).setAttribute('aria-pressed',k===mode));
}
['on','ghost','off'].forEach(k=>document.getElementById('pan-'+k).onclick=()=>setPanels(k));

/* floating labels anchored in 3D, one per group */
const ANCHOR={rad:[W/2+0.1,RAD.y+2.25,RAD.z],top:[0,H+0.35,0.3],floor:[0,0.2,D/2+0.15],rear:[0,4.95,-D/2-0.2],gpu:[GPU.x-0.55,GPU.y-1.75,BZ+0.57],pump:[PUMP.x,PUMP.y+0.55,BZ+0.75]};
const labelsEl=document.getElementById('labels');
labelsEl.innerHTML=Object.keys(ANCHOR).map(k=>{const g=GROUPS[k];return `<button class="l3" data-g="${k}" aria-pressed="false"><span class="dot" style="background:${g.color}"></span>${g.name}<b>${g.readonly?'auto':rpmOf(k).toLocaleString()+' rpm'}</b></button>`}).join('');
const labelEls=[...labelsEl.querySelectorAll('.l3')];
labelEls.forEach(b=>b.onclick=()=>select(b.dataset.g));
const lv=V(0,0,0);
function placeLabels(){if(!showLabels)return;const r=canvas.getBoundingClientRect();
  labelEls.forEach(b=>{const a=ANCHOR[b.dataset.g];lv.set(a[0],a[1],a[2]).project(cam);const vis=lv.z<1&&Math.abs(lv.x)<1.05&&Math.abs(lv.y)<1.05;b.style.opacity=vis?1:0;b.style.pointerEvents=vis?'auto':'none';
    b.style.transform=`translate(${(lv.x*.5+.5)*r.width}px,${(-lv.y*.5+.5)*r.height}px) translate(-50%,-50%)`})}

/* picking: fans select their group; the GPU and the CPU open their live view in Homebase */
const PARTS={gpu:['GeForce RTX 3070','live GPU view'],cpu:['Ryzen 9 7900X','live CPU view']};
const partHits=[['gpu',OBST.find(o=>o.id==='gpu').b],['cpu',OBST.find(o=>o.id==='pump').b]].map(([part,b])=>{
  const m=new THREE.Mesh(new THREE.BoxGeometry(b[1]-b[0],b[3]-b[2],b[5]-b[4]),new THREE.MeshBasicMaterial({visible:false}));
  m.position.set((b[0]+b[1])/2,(b[2]+b[3])/2,(b[4]+b[5])/2);m.userData.part=part;scene.add(m);return m});
function openPart(part){if(EMBED)parent.postMessage({type:'homebase-case-open',part},location.origin);else location.href='/#part/'+part}
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();const tip=document.getElementById('tip');let hover=null,down=null;
function pick(e){const r=canvas.getBoundingClientRect();mouse.set(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1);ray.setFromCamera(mouse,cam);const hit=ray.intersectObjects([...hitboxes,...partHits],false)[0];return hit?hit.object.userData:null}
canvas.addEventListener('pointermove',e=>{const u=pick(e),f=u?.fan||null,part=u?.part||(f?.group==='gpu'?'gpu':null);hover=f;canvas.style.cursor=u?'pointer':'grab';
  if(!u){tip.hidden=true;return}
  const r=canvas.getBoundingClientRect();tip.hidden=false;tip.style.left=(e.clientX-r.left)+'px';tip.style.top=(e.clientY-r.top)+'px';
  if(part){tip.innerHTML=`<b>${PARTS[part][0]}</b><span>click for the ${PARTS[part][1]}</span>`;return}
  const g=GROUPS[f.group];tip.innerHTML=`<b>${g.name}</b><span>${rpmOf(f.group).toLocaleString()} rpm · ${g.count}</span>`});
canvas.addEventListener('pointerleave',()=>{tip.hidden=true;hover=null});
canvas.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY]});
canvas.addEventListener('pointerup',e=>{if(down&&Math.hypot(e.clientX-down[0],e.clientY-down[1])<5){const u=pick(e);if(u?.fan)select(u.fan.group);const part=u?.part||(u?.fan?.group==='gpu'?'gpu':null);if(part)openPart(part)}down=null});

/* ---------- frame loop ---------- */
let last=performance.now();
function frame(now){
  const dt=Math.min(0.05,(now-last)/1000);last=now;const t=now/1000;
  controls.autoRotate=!reduce&&performance.now()-lastInput>5000;
  controls.update();
  const selGlow=selT<0?0:t-selT<1.2?1:0.55;   // nothing ringed until you pick a group; then a bright flash that settles to a steady ring
  fans.forEach(f=>{
    const g=GROUPS[f.group];const rpm=g.readonly?0:rpmOf(f.group);
    const speed=reduce?0:Math.min(rpm/60,2.2)*Math.PI*2*0.55;   // capped well below the strobe point
    f.phase+=speed*dt*f.dirSign;f.rotor.rotation.z=f.phase;
    const b=Math.min(1,rpm/2400);f.blurMat.opacity=(f.clear?0.05:0.12)+b*(f.clear?0.3:0.45);if(!f.clear)f.bladeMat.opacity=1;
    f.selMat.opacity=(f.group===sel?0.95*selGlow:0)+(hover&&hover.group===f.group&&f.group!==sel?0.5:0);
  });
  if(showHeat){const cpuP=Math.max(0,(GROUPS.rad.temp-35)/45),gpuP=Math.max(0,(GROUPS.gpu.temp-28)/50),pulse=reduce?1:1+Math.sin(t*1.1)*0.06,k=true?0.9:0.65;
    radGlow.material.opacity=(0.12+cpuP*0.4)*k;radGlow.scale.setScalar(2.9*pulse);gpuGlow.material.opacity=(0.08+gpuP*0.45)*k;cpuGlow.material.opacity=(0.06+cpuP*0.25)*k}
  if(!reduce&&airMode!=='off'){simT+=dt;
    if(smoke.visible){stepFlow(smokeF,dt);drawSmoke()}
    if(streaks.visible){stepFlow(traceF,dt);drawStreaks(dt)}}
  if(bloomOn)composer.render();else renderer.render(scene,cam);
  placeLabels();requestAnimationFrame(frame);
}
function resize(){const r=canvas.getBoundingClientRect();renderer.setSize(r.width,r.height,false);cam.aspect=r.width/r.height;cam.updateProjectionMatrix();
  sMat.uniforms.uScale.value=r.height*DPR/(2*Math.tan(cam.fov*Math.PI/360));lMat.uniforms.uRes.value.set(r.width*DPR,r.height*DPR);if(composer)composer.setSize(r.width,r.height)}
new ResizeObserver(resize).observe(canvas);resize();
const onTheme=()=>applyLighting();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',onTheme);
new MutationObserver(onTheme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
/* shadows: parts inside the case cast and receive; the case shell only receives, so the key light still reaches the interior */
scene.traverse(o=>{
  if(!o.isMesh||!o.material||!o.material.isMeshStandardMaterial)return;   // labels, glows, smoke and streaks stay out of the shadow pass
  let inCase=false;for(let p=o.parent;p;p=p.parent)if(p===caseGroup)inCase=true;
  const m=o.material;o.receiveShadow=!(m.transparent&&m.opacity<0.5);
  o.castShadow=!inCase&&!(m.transparent&&m.opacity<1)&&m.depthWrite!==false;
});
resetAir();setAir('both');setRgb(true);   // default: RGB on in blue, smoke and streaks
requestAnimationFrame(frame);

/* fan group list: one row per group; details live in the hover title */
const groupsEl=document.getElementById('groups');
const rowTitle=k=>{const g=GROUPS[k],hs=HEADERS.filter(h=>h.group===k).map(h=>h.id);return [g.count,g.dir,g.readonly?'Set by the NVIDIA driver':hs.length?'Header '+hs.join(' + '):''].filter(Boolean).join(' · ')};
groupsEl.innerHTML=Object.entries(GROUPS).map(([k,g])=>`<button class="grp" role="option" data-g="${k}" aria-selected="false"><i style="background:${g.color}"></i><span class="name">${g.name}</span><span class="rpm">${g.readonly?'auto':rpmOf(k).toLocaleString()}</span><span class="duty" aria-hidden="true"><b style="width:${g.duty}%;background:${g.color}"></b><em style="left:${g.duty}%" hidden></em></span></button>`).join('');
const groupEls=[...groupsEl.querySelectorAll('.grp')];
groupEls.forEach(b=>b.onclick=()=>select(b.dataset.g));

/* ---------- airflow balance ---------- */
function balance(){
  const inC=cfm(rpmOf('floor'),1.4)*2+(GROUPS.rear.flow==='in'?cfm(rpmOf('rear'),1.2)*2:0);
  const outC=cfm(rpmOf('top'),1.2)*2+cfm(rpmOf('rad'),1.2)*3*0.65+(GROUPS.rear.flow==='out'?cfm(rpmOf('rear'),1.2)*2:0);
  const mx=Math.max(inC,outC,1);
  document.getElementById('bal-in').style.width=(inC/mx*100)+'%';document.getElementById('bal-out').style.width=(outC/mx*100)+'%';
  document.getElementById('cfm-in').textContent='≈'+Math.round(inC)+' CFM';document.getElementById('cfm-out').textContent='≈'+Math.round(outC)+' CFM';
  const ratio=inC/outC,p=document.getElementById('press');
  p.className='tag '+(ratio>1.05?'good':ratio<0.95?'bad':'');
  p.textContent=ratio>1.05?'Positive · less dust':ratio<0.95?'Negative · dust gets in':'Balanced';
}
function setRear(flow){GROUPS.rear.flow=flow;GROUPS.rear.dir=rearDir();document.getElementById('dir-in').setAttribute('aria-pressed',flow==='in');document.getElementById('dir-out').setAttribute('aria-pressed',flow==='out');resetAir();balance();select(sel)}
document.getElementById('dir-in').onclick=()=>setRear('in');document.getElementById('dir-out').onclick=()=>setRear('out');

/* ---------- curve editor ---------- */
const svg=document.getElementById('curve');const X0=38,X1=344,Y0=190,Y1=14;const TMIN=20,TMAX=100;
const sx=t=>X0+(t-TMIN)/(TMAX-TMIN)*(X1-X0), sy=d=>Y0-d/100*(Y0-Y1), it=x=>TMIN+(x-X0)/(X1-X0)*(TMAX-TMIN), id_=y=>(Y0-y)/(Y0-Y1)*100;
// the curves saved in the BIOS on 2026-10-11 (same as the fan service's defaults)
const BIOS_CURVES={rad:[[50,20],[80,45],[95,60],[100,100]],floor:[[50,40],[60,55],[65,80],[68,100]],top:[[50,40],[60,55],[65,70],[68,100]],rear:[[50,40],[60,55],[65,70],[68,100]]};
const PRESETS={silent:[[40,20],[65,30],[85,45],[95,60]],cool:[[30,35],[50,45],[70,55],[85,60]]};
function drawCurve(){
  const g=GROUPS[sel];const pts=g.curve;const ro=g.readonly||g.fixed;
  let s=`<rect x="${X0}" y="${Y1}" width="${X1-X0}" height="${Y0-Y1}" fill="var(--glass)" rx="6"></rect>`;
  for(let t=30;t<=100;t+=10)s+=`<line x1="${sx(t)}" x2="${sx(t)}" y1="${Y1}" y2="${Y0}" stroke="var(--line)" stroke-width="1"></line><text x="${sx(t)}" y="${Y0+16}" fill="var(--muted)" font-size="10" text-anchor="middle" font-family="JetBrains Mono, monospace">${t}°</text>`;
  for(let d=0;d<=100;d+=25)s+=`<line x1="${X0}" x2="${X1}" y1="${sy(d)}" y2="${sy(d)}" stroke="var(--line)" stroke-width="1"></line><text x="${X0-6}" y="${sy(d)+3}" fill="var(--muted)" font-size="10" text-anchor="end" font-family="JetBrains Mono, monospace">${d}%</text>`;
  const poly=[[TMIN,pts[0][1]],...pts,[TMAX,pts[pts.length-1][1]]];
  s+=`<path d="M${poly.map(p=>sx(p[0])+','+sy(p[1])).join(' L')} L${X1},${Y0} L${X0},${Y0} Z" fill="${g.color}" opacity=".12"></path>`;
  s+=`<polyline points="${poly.map(p=>sx(p[0])+','+sy(p[1])).join(' ')}" fill="none" stroke="${g.color}" stroke-width="2.5" stroke-linejoin="round"></polyline>`;
  const now=Math.max(TMIN,Math.min(TMAX,g.temp));
  s+=`<line x1="${sx(now)}" x2="${sx(now)}" y1="${Y1}" y2="${Y0}" stroke="var(--fg)" stroke-dasharray="3 3" opacity=".5"></line><circle cx="${sx(now)}" cy="${sy(g.duty)}" r="5" fill="${g.color}" stroke="var(--fg)" stroke-width="1.5"></circle><text x="${sx(now)+8}" y="${sy(g.duty)-8}" fill="var(--fg)" font-size="11" font-family="JetBrains Mono, monospace">${g.held?'held':'target'} ${g.duty}% · ${g.temp}°</text>`;
  if(g.actual!=null&&!g.readonly)s+=`<circle cx="${sx(now)}" cy="${sy(g.actual)}" r="5" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="2 2"></circle><text x="${sx(now)-8}" y="${sy(g.actual)+(g.actual<g.duty?14:-8)}" text-anchor="end" fill="var(--muted)" font-size="11" font-family="JetBrains Mono, monospace">actual ${g.actual}%</text>`;   // left of the line, so it never collides with the target label
  if(!ro)pts.forEach((p,i)=>{s+=`<circle class="pt" data-i="${i}" cx="${sx(p[0])}" cy="${sy(p[1])}" r="7" fill="var(--surface)" stroke="${g.color}" stroke-width="2.5" tabindex="0" aria-label="Point ${i+1}: ${p[0]} degrees, ${p[1]} percent"></circle>`});
  if(ro)s+=`<text x="${(X0+X1)/2}" y="${Y1+22}" fill="var(--muted)" font-size="12" text-anchor="middle">${g.readonly?'Set by the NVIDIA driver; shown for reference':'Pump runs flat out; leave it'}</text>`;
  svg.innerHTML=s;
}
let drag=null;
svg.addEventListener('pointerdown',e=>{const c=e.target.closest('.pt');if(!c)return;drag=+c.dataset.i;svg.setPointerCapture(e.pointerId)});
svg.addEventListener('pointermove',e=>{if(drag===null)return;const r=svg.getBoundingClientRect();const x=(e.clientX-r.left)/r.width*360,y=(e.clientY-r.top)/r.height*220;const pts=GROUPS[sel].curve;
  const lo=drag?pts[drag-1][0]+2:TMIN,hi=drag<pts.length-1?pts[drag+1][0]-2:TMAX;
  pts[drag]=[Math.round(Math.max(lo,Math.min(hi,it(x)))),Math.round(Math.max(0,Math.min(100,id_(y))))];
  document.querySelectorAll('[data-preset]').forEach(b=>b.setAttribute('aria-pressed','false'));drawCurve()});
svg.addEventListener('pointerup',()=>{if(drag!==null)markDirty(sel);drag=null});
let keyTimer=0;
svg.addEventListener('keydown',e=>{const c=e.target.closest('.pt');if(!c)return;clearTimeout(keyTimer);keyTimer=setTimeout(()=>markDirty(sel),0);const i=+c.dataset.i,p=GROUPS[sel].curve[i];const k={ArrowUp:[0,2],ArrowDown:[0,-2],ArrowLeft:[-1,0],ArrowRight:[1,0]}[e.key];if(!k)return;e.preventDefault();p[0]+=k[0];p[1]=Math.max(0,Math.min(100,p[1]+k[1]));drawCurve();svg.querySelector(`.pt[data-i="${i}"]`)?.focus()});
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{const g=GROUPS[sel];if(g.readonly||g.fixed)return;const p=b.dataset.preset;g.curve=(p==='bios'?BIOS_CURVES[sel]:PRESETS[p]).map(x=>[...x]);document.querySelectorAll('[data-preset]').forEach(c=>c.setAttribute('aria-pressed',c===b));drawCurve();markDirty(sel)});

/* ---------- side panel ---------- */
let selT=-1;
function select(k,quiet){sel=k;const g=GROUPS[k];if(!quiet){selT=performance.now()/1000;touched()}
  document.getElementById('g-name').textContent=g.name;
  document.getElementById('g-meta').textContent=g.readonly?`auto · ${g.temp}°C`:g.actual!=null?`${g.held?'held':'target'} ${g.duty}% · actual ${g.actual}% · ${g.temp}°C`:`${g.duty}% · ${g.temp}°C`;
  document.getElementById('dir-row').hidden=k!=='rear';
  groupEls.forEach(b=>{b.setAttribute('aria-selected',b.dataset.g===k);b.title=rowTitle(b.dataset.g)});
  labelEls.forEach(b=>b.setAttribute('aria-pressed',b.dataset.g===k));
  document.querySelectorAll('[data-preset]').forEach(b=>{b.disabled=!!(g.readonly||g.fixed)});
  document.getElementById('identify').disabled=!!(g.readonly||g.fixed);
  drawCurve();renderControls();
}
let renderControls=()=>{};
balance();select('rad',true);

/* ---------- live fan control (Homebase backend → prox) ----------
   Same-origin calls with the dashboard session. If there's no session or no fan service
   (for example on the public demo), everything stays modeled. Curve edits apply on Save; Hold pins a speed for a time. */
const live={on:false,csrf:null,mode:null,timer:0,dirty:new Set(),saved:{},holds:{},holdsAt:0,holdsServer:0,holdTotal:{}};
const ctlEl=document.getElementById('ctl'),applyEl=document.getElementById('apply-state'),identifyEl=document.getElementById('identify'),noteEl=document.getElementById('live-note');
const CONTROLLED=['rad','top','floor','rear'];
const say=(text,tone='')=>{applyEl.hidden=!text;applyEl.textContent=text;applyEl.className='apply '+tone};
async function api(method,body){
  const r=await fetch('/api/fans',{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(live.csrf?{'X-Homebase-CSRF':live.csrf}:{})},body:body?JSON.stringify(body):undefined});
  if(!(r.headers.get('content-type')||'').includes('json'))throw new Error('unavailable');
  const data=await r.json();if(!r.ok||data.error)throw new Error(data.error||'failed');return data;
}
function applyStatus(st){
  const avg=a=>a&&a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;
  for(const[g,v]of Object.entries(st.groups||{})){if(!GROUPS[g])continue;liveRpm[g]=avg(v.rpm)??0;const a=avg(v.duty),d=v.target??a;GROUPS[g].actual=a;if(d!=null)GROUPS[g].duty=Math.round(d)}
  live.holds=st.holds||{};live.holdsAt=performance.now();live.holdsServer=st.observedAt/1000;for(const g of CONTROLLED)GROUPS[g].held=!!live.holds[g];
  if(st.temps?.tctl!=null){GROUPS.rad.temp=Math.round(st.temps.tctl);GROUPS.pump.temp=GROUPS.rad.temp}
  if(st.temps?.system!=null)['top','floor','rear'].forEach(g=>GROUPS[g].temp=Math.round(st.temps.system));
  for(const g of CONTROLLED)if(st.curves?.[g]){live.saved[g]=st.curves[g].map(p=>[...p]);if(!live.dirty.has(g)&&!(drag!==null&&g===sel))GROUPS[g].curve=st.curves[g].map(p=>[...p])}
  live.mode=st.mode;
  document.getElementById('mode-curves').setAttribute('aria-pressed',st.requestedMode==='curves');
  document.getElementById('mode-bios').setAttribute('aria-pressed',st.requestedMode!=='curves');
  groupEls.forEach(b=>{const g=GROUPS[b.dataset.g],tick=b.querySelector('.duty em');b.querySelector('.rpm').textContent=g.readonly?'auto':rpmOf(b.dataset.g).toLocaleString();b.querySelector('.duty b').style.width=(g.actual??g.duty)+'%';tick.hidden=g.readonly||g.fixed||g.actual==null;tick.style.left=g.duty+'%'});   // bar = actual speed, tick = target
  labelEls.forEach(b=>{const k=b.dataset.g;b.querySelector('b').textContent=GROUPS[k].readonly?'auto':rpmOf(k).toLocaleString()+' rpm'});
  const msg=st.error?`BIOS in charge · ${st.error}`:st.mode==='curves'?'Live from prox · your curves are running':'Live from prox · BIOS curves in charge';
  noteEl.textContent=msg;parent!==window&&parent.postMessage({type:'homebase-case-live',live:true,mode:st.mode,error:st.error||null},location.origin);
  buildFlow();balance();select(sel,true);
}
async function poll(){
  clearTimeout(live.timer);
  if(document.visibilityState==='visible'){try{applyStatus(await api('GET'))}catch{}}
  live.timer=setTimeout(poll,3000);
}
function markDirty(g){if(!live.on||!CONTROLLED.includes(g))return;live.dirty.add(g);say('');renderControls()}
async function saveCurve(){
  const g=sel;if(!live.dirty.has(g))return;say('Saving…');
  try{const st=await api('POST',{group:g,curve:GROUPS[g].curve});live.dirty.delete(g);applyStatus(st);say(`Saved · ${GROUPS[g].name} targets ${GROUPS[g].duty}% now`,'ok')}
  catch(e){say(`Not saved · ${e.message}`,'bad')}
}
function revertCurve(){const g=sel;if(live.saved[g])GROUPS[g].curve=live.saved[g].map(p=>[...p]);live.dirty.delete(g);document.querySelectorAll('[data-preset]').forEach(b=>b.setAttribute('aria-pressed','false'));say('');drawCurve();renderControls()}
document.getElementById('save').onclick=saveCurve;document.getElementById('revert').onclick=revertCurve;
/* hold: pin the selected group at a speed for a time; with "Other fans off" every other group stops meanwhile */
const holdDuty=document.getElementById('hold-duty'),holdVal=document.getElementById('hold-val'),holdBtn=document.getElementById('hold-btn'),holdBar=document.getElementById('hold-bar');
let holdSecs=60;
const timeChips=[...document.querySelectorAll('#hold-times .chip')];
timeChips.forEach(c=>c.onclick=()=>{holdSecs=c.dataset.s==='hold'?null:+c.dataset.s;renderControls()});
holdDuty.oninput=()=>renderControls();
const remaining=g=>{const h=live.holds[g];if(!h)return null;if(h.until==null)return Infinity;return Math.max(0,h.until-live.holdsServer-(performance.now()-live.holdsAt)/1000)};
const clock=s=>s>=60?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`:`${Math.ceil(s)} s`;
renderControls=()=>{
  const g=GROUPS[sel],ctl=live.on&&CONTROLLED.includes(sel);
  document.getElementById('savebar').hidden=!(ctl&&live.dirty.has(sel));
  document.getElementById('hold-box').hidden=!ctl;if(!ctl)return;
  const d=+holdDuty.value;holdVal.textContent=d+'%';
  timeChips.forEach(c=>{const s=c.dataset.s==='hold'?null:+c.dataset.s;c.setAttribute('aria-pressed',s===holdSecs)});
  const left=remaining(sel);
  if(left!=null&&left>0){const h=live.holds[sel];holdBtn.classList.add('running');holdBtn.textContent=left===Infinity?`Holding ${h.duty}% · Release`:`Holding ${h.duty}% · ${clock(left)} · Release`;
    const tot=live.holdTotal[sel];holdBar.hidden=left===Infinity||!tot;if(tot)holdBar.style.width=Math.max(0,Math.min(100,left/tot*100))+'%'}
  else{holdBtn.classList.remove('running');holdBtn.textContent=`Hold ${d}%`;holdBar.hidden=true}
};
holdBtn.onclick=async()=>{
  const g=sel,left=remaining(g);
  try{
    if(left!=null&&left>0){say('Releasing…');applyStatus(await api('POST',{release:g}));say(`${GROUPS[g].name} back on its curve`,'ok');return}
    const duty=+holdDuty.value;say(`Holding ${GROUPS[g].name} at ${duty}%…`);
    const othersOff=document.getElementById('hold-others').checked;const st=await api('POST',{hold:g,duty,seconds:holdSecs,othersOff});live.holdTotal[g]=holdSecs;applyStatus(st);say(`${GROUPS[g].name} held at ${duty}%${holdSecs?` for ${clock(holdSecs)}`:' until you release it'}${othersOff?' · other fans off':''}`,'ok');
  }catch(e){say(`Not changed · ${e.message}`,'bad')}
};
setInterval(()=>{if(live.on&&Object.keys(live.holds).length)renderControls()},250);
async function setMode(mode){
  if(!live.on)return;say(mode==='curves'?'Turning your curves on…':'Handing back to the BIOS…');
  try{applyStatus(await api('POST',{mode}));say(mode==='curves'?'Your curves are running':'BIOS curves are in charge','ok')}catch(e){say(`Not changed · ${e.message}`,'bad')}
}
document.getElementById('mode-curves').onclick=()=>setMode('curves');
document.getElementById('mode-bios').onclick=()=>setMode('bios');
const IDENTIFY_S=4;   // matches the fan service's pulse
identifyEl.onclick=async()=>{
  if(!live.on||!CONTROLLED.includes(sel)||identifyEl.classList.contains('running'))return;
  const g=sel;identifyEl.classList.add('running');identifyEl.disabled=true;identifyEl.textContent='Identifying…';
  identifyEl.style.setProperty('--dur',IDENTIFY_S+'s');say(`${GROUPS[g].name} at 100% · everything else stopped`);
  const done=()=>{identifyEl.classList.remove('running');identifyEl.textContent='Identify';identifyEl.disabled=!!(GROUPS[sel].readonly||GROUPS[sel].fixed);say(`${GROUPS[g].name} back on its curve`,'ok');poll()};
  try{await api('POST',{pulse:g});setTimeout(done,IDENTIFY_S*1000-1500)}   // the reply arrives about 1.5 s into the pulse
  catch(e){identifyEl.classList.remove('running');identifyEl.textContent='Identify';identifyEl.disabled=false;say(`Not changed · ${e.message}`,'bad')}
};
(async()=>{
  try{
    const s=await fetch('/api/session',{credentials:'same-origin'}).then(r=>r.json());
    if(!s?.user||!s.csrf)return;
    live.csrf=s.csrf;const st=await api('GET');
    live.on=true;ctlEl.hidden=false;identifyEl.hidden=false;applyStatus(st);
    live.timer=setTimeout(poll,3000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')poll()});
  }catch{}
})();
})();
