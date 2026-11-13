import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CATEGORIES, generateApps } from './data.js';
import { createWorld, createSky, createWater, createSeabed, applyGlow, setLightFx } from './world.js';
import './style.css';

const $ = (sel) => document.querySelector(sel);
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : n.toLocaleString('zh-CN'));

/* ---------------------------------------------------------------- data ---- */

const apps = generateApps();
const byCat = new Map(CATEGORIES.map((c) => [c.id, apps.filter((a) => a.cat === c)]));
const STORAGE_KEY = 'archipelago-explored';
const explored = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));

/* --------------------------------------------------------------- scene ---- */

const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#ffffff', 340, 950);
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 3000);
camera.position.set(0, 760, 560);

const hemi = new THREE.HemisphereLight('#ffffff', '#444444', 1);
const sun = new THREE.DirectionalLight('#ffffff', 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 10, far: 900 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.4;
scene.add(hemi, sun, sun.target);

const sky = createSky();
const water = createWater();
scene.add(sky, water, createSeabed());

const world = createWorld(CATEGORIES, apps);
scene.add(world.group);

const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 26;
controls.maxDistance = 470;
controls.minPolarAngle = 0.2;
controls.maxPolarAngle = 1.22;
controls.zoomToCursor = true;
controls.autoRotateSpeed = 0.35;
controls.target.set(0, 0, 0);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.22, 0.3, 1.1);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ---------------------------------------------------- time of day -------- */

const PRESETS = {
  day: {
    skyTop: '#3d84c6', horizon: '#d3e9ef', bottom: '#8fc0d0', fog: '#cfe3ea',
    sun: '#fff1d6', sunI: 2.5, sunDir: [0.55, 0.85, 0.35],
    hemiSky: '#cbe6ff', hemiGround: '#6b8a5a', hemiI: 1.0,
    deep: '#16698f', shallow: '#3fbfc6', glow: 1.15, stars: 0, bloom: 0.08, threshold: 1.1, exposure: 0.88,
  },
  dusk: {
    skyTop: '#1d2d58', horizon: '#f39a68', bottom: '#3b3a58', fog: '#b98479',
    sun: '#ffab6e', sunI: 2.6, sunDir: [-0.85, 0.28, -0.35],
    hemiSky: '#8b95d8', hemiGround: '#5a4438', hemiI: 1.25,
    deep: '#173a5c', shallow: '#3c8d99', glow: 1.5, stars: 0.15, bloom: 0.22, threshold: 1.1, exposure: 0.95,
  },
  night: {
    skyTop: '#040a1a', horizon: '#1a2a4c', bottom: '#050912', fog: '#111d36',
    sun: '#9fb8ff', sunI: 1.0, sunDir: [0.35, 0.65, -0.55],
    hemiSky: '#4a62a8', hemiGround: '#141c28', hemiI: 0.75,
    deep: '#06192b', shallow: '#124459', glow: 2.0, stars: 1, bloom: 0.38, threshold: 0.85, exposure: 1.0,
  },
};

function toState(p) {
  return {
    skyTop: new THREE.Color(p.skyTop), horizon: new THREE.Color(p.horizon), bottom: new THREE.Color(p.bottom),
    fog: new THREE.Color(p.fog), sun: new THREE.Color(p.sun), hemiSky: new THREE.Color(p.hemiSky),
    hemiGround: new THREE.Color(p.hemiGround), deep: new THREE.Color(p.deep), shallow: new THREE.Color(p.shallow),
    sunDir: new THREE.Vector3(...p.sunDir).normalize(),
    sunI: p.sunI, hemiI: p.hemiI, glow: p.glow, stars: p.stars, bloom: p.bloom, threshold: p.threshold, exposure: p.exposure,
  };
}

const FX_LEVELS = { soft: 0.5, normal: 1, vivid: 1.7 };
const FX_KEY = 'archipelago.fx';
let fxName = FX_LEVELS[localStorage.getItem(FX_KEY)] ? localStorage.getItem(FX_KEY) : 'normal';
let fx = FX_LEVELS[fxName];

let tod = { from: toState(PRESETS.dusk), to: toState(PRESETS.dusk), k: 1 };
const cur = toState(PRESETS.dusk);

function setTimeOfDay(name) {
  const snapshot = toState(PRESETS.dusk);
  for (const key in cur) {
    if (cur[key]?.copy) snapshot[key].copy(cur[key]);
    else snapshot[key] = cur[key];
  }
  tod = { from: snapshot, to: toState(PRESETS[name]), k: 0 };
  document.querySelectorAll('[data-tod]').forEach((b) => b.classList.toggle('on', b.dataset.tod === name));
}

function applyTimeOfDay(dt) {
  if (tod.k >= 1 && tod.applied) return;
  tod.k = Math.min(1, tod.k + dt / 1.6);
  const k = easeInOut(tod.k);
  const { from, to } = tod;
  for (const key in cur) {
    if (cur[key]?.lerpColors) cur[key].lerpColors(from[key], to[key], k);
    else if (cur[key]?.lerpVectors) cur[key].lerpVectors(from[key], to[key], k).normalize();
    else cur[key] = from[key] + (to[key] - from[key]) * k;
  }
  const su = sky.material.uniforms;
  su.uTop.value.copy(cur.skyTop);
  su.uHorizon.value.copy(cur.horizon);
  su.uBottom.value.copy(cur.bottom);
  su.uSunColor.value.copy(cur.sun);
  su.uSunDir.value.copy(cur.sunDir);
  su.uStars.value = cur.stars;
  const wu = water.material.uniforms;
  wu.uDeep.value.copy(cur.deep);
  wu.uShallow.value.copy(cur.shallow);
  wu.uHorizon.value.copy(cur.horizon);
  wu.uSunColor.value.copy(cur.sun);
  wu.uSunDir.value.copy(cur.sunDir);
  wu.uFogColor.value.copy(cur.fog);
  wu.uFogNear.value = scene.fog.near;
  wu.uFogFar.value = scene.fog.far;
  scene.fog.color.copy(cur.fog);
  sun.color.copy(cur.sun);
  sun.intensity = cur.sunI;
  sun.position.copy(cur.sunDir).multiplyScalar(420);
  hemi.color.copy(cur.hemiSky);
  hemi.groundColor.copy(cur.hemiGround);
  hemi.intensity = cur.hemiI;
  bloom.strength = cur.bloom * fx;
  bloom.threshold = cur.threshold;
  renderer.toneMappingExposure = cur.exposure;
  applyGlow(1 + (cur.glow - 1) * fx);
  setLightFx(fx);
  tod.applied = tod.k >= 1;
}

/* ------------------------------------------------------------- camera ---- */

let flight = null;
const OVERVIEW = { target: new THREE.Vector3(0, 0, 8), distance: 420, polar: 0.82 };

function flyTo(target, distance, { duration = 1.6, arc = 0, polar = 0.92, spin = 0 } = {}) {
  const fromT = controls.target.clone();
  const fromC = camera.position.clone();
  const sph = new THREE.Spherical().setFromVector3(fromC.clone().sub(fromT));
  sph.radius = distance;
  sph.phi = polar;
  sph.theta += spin;
  const toC = target.clone().add(new THREE.Vector3().setFromSpherical(sph));
  flight = { fromT, fromC, toT: target.clone(), toC, t: 0, duration, arc };
  controls.enabled = false;
}

function updateFlight(dt) {
  if (!flight) return false;
  flight.t = Math.min(1, flight.t + dt / flight.duration);
  const k = easeInOut(flight.t);
  controls.target.lerpVectors(flight.fromT, flight.toT, k);
  camera.position.lerpVectors(flight.fromC, flight.toC, k);
  camera.position.y += Math.sin(Math.PI * k) * flight.arc;
  camera.lookAt(controls.target);
  if (flight.t >= 1) {
    flight = null;
    controls.enabled = true;
    controls.update();
  }
  return true;
}

controls.addEventListener('change', () => {
  const t = controls.target;
  const r = Math.hypot(t.x, t.z);
  if (r > 230) {
    const k = 230 / r;
    const dx = t.x * k - t.x;
    const dz = t.z * k - t.z;
    t.x += dx;
    t.z += dz;
    camera.position.x += dx;
    camera.position.z += dz;
  }
});

function camDistance() {
  return camera.position.distanceTo(controls.target);
}

/* ------------------------------------------------------- selection ring ---- */

const selRing = new THREE.Mesh(
  new THREE.RingGeometry(3.1, 3.7, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#ffe3a3', transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }),
);
selRing.visible = false;
scene.add(selRing);

/* ------------------------------------------------------------- labels ---- */

const labelLayer = $('#labels');
const tmpV = new THREE.Vector3();

const islandLabels = world.shapes.map((shape) => {
  const list = byCat.get(shape.cat.id);
  const featured = list.filter((a) => a.tier === 2).length;
  const fresh = list.filter((a) => a.isNew).length;
  const el = document.createElement('button');
  el.className = 'island-label';
  el.style.setProperty('--c', shape.cat.color);
  el.innerHTML = `
    <span class="il-title">${shape.cat.title}</span>
    <span class="il-stats"><b>${list.length}</b> 作品<i></i><b>${featured}</b> 精品<i></i><b>${fresh}</b> 新作</span>`;
  el.addEventListener('click', () => flyToIsland(shape));
  labelLayer.appendChild(el);
  const lift = shape.cat.theme === 'volcano' ? 34 : 28;
  return { el, shape, pos: shape.center.clone().setY(shape.center.y + lift) };
});

const labelOrder = [...apps].sort((a, b) => b.tier - a.tier || Number(b.isNew) - Number(a.isNew) || b.score - a.score);
const LABEL_LIFT = [2.6, 4.8, 15.6];
for (const app of labelOrder) {
  const el = document.createElement('button');
  el.className = `app-label tier-${app.tier}${app.isNew ? ' is-new' : ''}`;
  el.style.setProperty('--c', app.cat.color);
  el.innerHTML = `${app.tier === 2 ? `<em>${app.score}</em>` : ''}<span>${app.name}</span>${app.isNew ? '<strong>NEW</strong>' : ''}`;
  el.addEventListener('click', () => focusApp(app));
  labelLayer.appendChild(el);
  app.label = el;
  app.labelPos = app.position.clone().setY(app.position.y + LABEL_LIFT[app.tier] * app.render.scale);
  if (explored.has(app.id)) el.classList.add('visited');
}

function project(pos) {
  tmpV.copy(pos).project(camera);
  if (tmpV.z > 1) return null;
  return [(tmpV.x * 0.5 + 0.5) * window.innerWidth, (-tmpV.y * 0.5 + 0.5) * window.innerHeight];
}

const LABEL_FADE_IN = 6;
const LABEL_FADE_OUT = 14;

// Opacity eases toward the target so labels never pop; hidden once fully faded.
function place(el, xy, target, dt) {
  const a = el._a ?? 0;
  const rate = target > a ? LABEL_FADE_IN : LABEL_FADE_OUT;
  el._a = a + (target - a) * Math.min(1, dt * rate);
  if (!xy || (target === 0 && el._a < 0.02)) {
    el._a = xy ? el._a : 0;
    if (el._shown) {
      el.style.display = 'none';
      el._shown = false;
    }
    return;
  }
  if (!el._shown) {
    el.style.display = 'flex';
    el._shown = true;
    el._w ??= el.offsetWidth;
    el._h ??= el.offsetHeight;
  }
  el.style.transform = `translate3d(${xy[0].toFixed(1)}px, ${xy[1].toFixed(1)}px, 0) translate(-50%, -100%)`;
  el.style.opacity = el._a.toFixed(3);
}

const placedRects = [];
function overlaps(x, y, w, h) {
  for (const r of placedRects) if (x < r[2] && x + w > r[0] && y < r[3] && y + h > r[1]) return true;
  return false;
}

function updateLabels(dt) {
  const dist = camDistance();
  // During camera flights everything but the destination fades out, so labels don't
  // swim across the screen or fight each other for space mid-flight.
  const quiet = flight ? 1 - smoothstep(0.75, 1, flight.t) : 0;
  const islandAlpha = smoothstep(150, 215, dist) * (1 - quiet);
  for (const l of islandLabels) place(l.el, project(l.pos), islandAlpha, dt);

  const candidates = [];
  for (const app of labelOrder) {
    let alpha = 0;
    const d = camera.position.distanceTo(app.position);
    if (app.tier === 2) alpha = 1 - smoothstep(230, 290, dist);
    else if (app.isNew) alpha = 1 - smoothstep(170, 220, dist);
    else {
      const near = app.position.distanceTo(controls.target);
      const reach = app.tier === 1 ? 45 : 26;
      alpha = (1 - smoothstep(75, 110, dist)) * (1 - smoothstep(reach, reach + 15, near));
    }
    alpha *= (1 - smoothstep(380, 460, d)) * (1 - quiet);
    if (app === selected) alpha = flight ? smoothstep(0.55, 0.85, flight.t) : 1;
    candidates.push({ app, alpha, rank: app === selected ? 0 : app.label._shown ? 1 : 2 });
  }
  // Labels already on screen keep their spot; newcomers only fill free space.
  candidates.sort((a, b) => a.rank - b.rank);

  placedRects.length = 0;
  for (const { app, alpha } of candidates) {
    const el = app.label;
    let xy = null;
    let target = 0;
    if (alpha > 0.02 || el._shown) xy = project(app.labelPos);
    if (xy && alpha > 0.02 && placedRects.length < 60) {
      const w = (el._w ?? 120) + 6;
      const h = (el._h ?? 24) + 4;
      const x = xy[0] - w / 2;
      const y = xy[1] - h;
      if (app === selected || !overlaps(x, y, w, h)) {
        placedRects.push([x, y, x + w, y + h]);
        target = alpha;
      }
    }
    place(el, xy, target, dt);
  }
}

/* ------------------------------------------------------------ picking ---- */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const pickTargets = [...world.terrains, ...world.buildings.pickables];
let hovered = null;
let pointerDirty = false;
const pointer = { x: 0, y: 0, downX: 0, downY: 0, downT: 0 };
const tooltip = $('#tooltip');

function pick() {
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(pickTargets, false);
  for (const h of hits) {
    if (h.object.userData.apps && h.instanceId != null) return { app: h.object.userData.apps[h.instanceId] };
    if (h.object.userData.island) return { island: h.object.userData.island, point: h.point };
  }
  return {};
}

renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  pointerDirty = true;
});
renderer.domElement.addEventListener('pointerleave', () => setHovered(null));
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
  pointer.downT = performance.now();
  dismissHint();
  if (flight) {
    flight = null;
    controls.enabled = true;
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  const moved = Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY);
  if (moved > 6 || performance.now() - pointer.downT > 500) return;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  const hit = pick();
  if (hit.app) focusApp(hit.app);
  else if (hit.island && camDistance() > 150) flyToIsland(world.shapes.find((s) => s.cat.id === hit.island));
});

function setHovered(app) {
  if (app === hovered) return;
  if (hovered) world.buildings.setHighlight(hovered, false);
  hovered = app;
  if (app) {
    world.buildings.setHighlight(app, true);
    tooltip.innerHTML = `<b>${app.name}</b><span><i style="--c:${app.cat.color}"></i>${app.cat.name} · 品质 ${app.score}${app.isNew ? ' · 新作' : ''}</span><small>点击查看与试玩</small>`;
    tooltip.classList.add('on');
  } else tooltip.classList.remove('on');
  renderer.domElement.style.cursor = app ? 'pointer' : '';
}

function updateHover() {
  if (pointerDirty && !flight) {
    pointerDirty = false;
    setHovered(pick().app ?? null);
  }
  if (hovered) tooltip.style.transform = `translate3d(${pointer.x + 16}px, ${pointer.y + 16}px, 0)`;
}

/* ------------------------------------------------------------- focus ---- */

let selected = null;
const panel = $('#panel');

function flyToIsland(shape) {
  if (!shape) return;
  closePanel();
  const far = camDistance() > 250;
  flyTo(shape.center.clone().setY(2), shape.R * 2.6 + 40, { polar: 0.86, arc: far ? 0 : 30, duration: 1.8 });
}

function focusApp(app, { teleport = false } = {}) {
  selected = app;
  const far = camDistance() > 160 || app.position.distanceTo(controls.target) > 120;
  flyTo(app.position.clone().setY(app.position.y + 2), app.tier === 2 ? 68 : 54, {
    polar: 0.9,
    arc: teleport ? 90 : far ? 35 : 0,
    duration: teleport ? 2.6 : far ? 2 : 1.2,
    spin: teleport ? 0.9 : 0,
  });
  selRing.position.copy(app.position).setY(app.position.y + 0.35);
  selRing.scale.setScalar([0.75, 1, 1.5][app.tier]);
  selRing.visible = true;
  markExplored(app);
  openPanel(app);
}

function markExplored(app) {
  if (explored.has(app.id)) return;
  explored.add(app.id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...explored]));
  app.label.classList.add('visited');
  renderProgress();
}

/* -------------------------------------------------------------- panel ---- */

function demoHTML(app) {
  const c = app.cat.color;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;background:#0b1320;font-family:'Noto Sans SC',sans-serif;color:#f4efe6}
    canvas{display:block;width:100%;height:100%}
    .t{position:absolute;inset:auto 0 18px 0;text-align:center;pointer-events:none}
    .t b{display:block;font-size:22px;letter-spacing:.04em}
    .t span{font-size:12px;opacity:.6}
  </style></head><body><canvas></canvas>
  <div class="t"><b>${app.name}</b><span>示例画面 · 正式上线后这里直接加载作品本体</span></div>
  <script>
    const cv=document.querySelector('canvas'),g=cv.getContext('2d');
    let W,H,mx=-1,my=-1;const P=[];
    function rs(){W=cv.width=innerWidth*devicePixelRatio;H=cv.height=innerHeight*devicePixelRatio}
    addEventListener('resize',rs);rs();
    addEventListener('pointermove',e=>{mx=e.clientX*devicePixelRatio;my=e.clientY*devicePixelRatio});
    addEventListener('pointerdown',e=>{for(let i=0;i<40;i++){const a=Math.random()*6.28,s=2+Math.random()*6;P.push({x:e.clientX*devicePixelRatio,y:e.clientY*devicePixelRatio,vx:Math.cos(a)*s,vy:Math.sin(a)*s,l:1})}});
    for(let i=0;i<160;i++)P.push({x:Math.random()*W,y:Math.random()*H,vx:0,vy:0,l:-1});
    (function f(){g.fillStyle='rgba(11,19,32,.22)';g.fillRect(0,0,W,H);
      for(const p of P){
        if(mx>0){const dx=mx-p.x,dy=my-p.y,d=Math.hypot(dx,dy)+30;p.vx+=dx/d*.35;p.vy+=dy/d*.35}
        else{p.vx+=Math.sin(p.y*.01+performance.now()*.001)*.08;p.vy+=Math.cos(p.x*.01)*.08}
        p.vx*=.96;p.vy*=.96;p.x+=p.vx;p.y+=p.vy;
        if(p.l>0)p.l-=.012;
        g.fillStyle='${c}';g.globalAlpha=p.l>0?p.l:.85;g.beginPath();g.arc(p.x,p.y,(p.l>0?3:2)*devicePixelRatio,0,6.28);g.fill();
      }
      g.globalAlpha=1;for(let i=P.length-1;i>=0;i--)if(P[i].l>=0&&P[i].l<=.01)P.splice(i,1);
      requestAnimationFrame(f)})();
  <\/script></body></html>`;
}

function daysAgo(d) {
  if (d < 1) return '今天发布';
  if (d < 2) return '昨天发布';
  return `${Math.floor(d)} 天前发布`;
}

function openPanel(app) {
  const related = byCat
    .get(app.cat.id)
    .filter((a) => a !== app && a.tier === 2)
    .slice(0, 4);
  panel.style.setProperty('--c', app.cat.color);
  panel.innerHTML = `
    <button class="panel-close" aria-label="关闭">×</button>
    <div class="cover">
      <iframe sandbox="allow-scripts" title="${app.name} 预览"></iframe>
      <span class="cover-tag">实时预览 · 可交互</span>
    </div>
    <div class="panel-body">
      <div class="meta">
        <span class="chip"><i></i>${app.cat.title}</span>
        ${app.tier === 2 ? '<span class="badge gold">精品</span>' : app.tier === 1 ? '<span class="badge">优质</span>' : ''}
        ${app.isNew ? '<span class="badge new">NEW</span>' : ''}
      </div>
      <h2>${app.name}</h2>
      <p class="author">${app.author} · ${daysAgo(app.ageDays)}</p>
      <p class="desc">${app.desc}</p>
      <dl class="stats">
        <div><dt>品质分</dt><dd>${app.score}</dd></div>
        <div><dt>试玩次数</dt><dd>${fmt(app.plays)}</dd></div>
        <div><dt>标签</dt><dd class="tags">${app.tags.map((t) => `<span>${t}</span>`).join('')}</dd></div>
      </dl>
      <div class="actions">
        <button class="btn primary" data-act="play">开始试玩</button>
        <button class="btn ghost" data-act="island">逛逛这座岛</button>
      </div>
      ${
        related.length
          ? `<h4>同岛精品</h4><ul class="related">${related
              .map((r) => `<li><button data-id="${r.id}"><em>${r.score}</em><span>${r.name}</span><small>${r.tags[0]}</small></button></li>`)
              .join('')}</ul>`
          : ''
      }
    </div>`;
  panel.querySelector('iframe').srcdoc = demoHTML(app);
  panel.querySelector('.panel-close').onclick = closePanel;
  panel.querySelector('[data-act="play"]').onclick = () => openPlay(app);
  panel.querySelector('[data-act="island"]').onclick = () => flyToIsland(world.shapes.find((s) => s.cat === app.cat));
  panel.querySelectorAll('.related button').forEach((b) => {
    b.onclick = () => focusApp(apps.find((a) => a.id === b.dataset.id));
  });
  panel.classList.add('open');
  document.body.classList.add('panel-open');
}

function closePanel() {
  if (!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  document.body.classList.remove('panel-open');
  selected = null;
  selRing.visible = false;
  setTimeout(() => {
    if (!panel.classList.contains('open')) panel.innerHTML = '';
  }, 400);
}

const playModal = $('#play');
function openPlay(app) {
  playModal.style.setProperty('--c', app.cat.color);
  playModal.querySelector('.play-title').textContent = app.name;
  playModal.querySelector('.play-sub').textContent = `${app.cat.title} · ${app.author}`;
  playModal.querySelector('iframe').srcdoc = demoHTML(app);
  playModal.classList.add('open');
}
playModal.querySelector('.play-close').onclick = () => {
  playModal.classList.remove('open');
  playModal.querySelector('iframe').srcdoc = '';
};

/* ---------------------------------------------------------------- hud ---- */

$('#stat-total').textContent = apps.length;
$('#stat-featured').textContent = apps.filter((a) => a.tier === 2).length;
$('#stat-new').textContent = apps.filter((a) => a.isNew).length;

const islandNav = $('#island-nav');
const navItems = world.shapes.map((shape) => {
  const list = byCat.get(shape.cat.id);
  const featured = list.filter((a) => a.tier === 2).length;
  const quality = list.filter((a) => a.tier === 1).length;
  const btn = document.createElement('button');
  btn.className = 'nav-item';
  btn.style.setProperty('--c', shape.cat.color);
  btn.innerHTML = `
    <span class="nav-name"><i></i>${shape.cat.name}</span>
    <span class="nav-count">${list.length}</span>
    <span class="nav-bar"><span style="width:${(featured / list.length) * 100}%" class="f"></span><span style="width:${(quality / list.length) * 100}%" class="q"></span></span>
    <span class="nav-sub">精品 ${featured} · 优质 ${quality}<span class="nav-exp"></span></span>`;
  btn.onclick = () => flyToIsland(shape);
  islandNav.appendChild(btn);
  return { btn, shape, list };
});

function renderProgress() {
  const n = explored.size;
  $('#explore-count').textContent = n;
  $('#explore-total').textContent = apps.length;
  const ring = $('#explore-ring');
  const c = 2 * Math.PI * 15;
  ring.style.strokeDasharray = `${(n / apps.length) * c} ${c}`;
  for (const item of navItems) {
    const e = item.list.filter((a) => explored.has(a.id)).length;
    item.btn.querySelector('.nav-exp').textContent = e ? ` · 已逛 ${e}` : '';
  }
}
renderProgress();

function updateActiveIsland() {
  let active = null;
  if (camDistance() < 260) {
    for (const item of navItems) {
      const d = Math.hypot(controls.target.x - item.shape.center.x, controls.target.z - item.shape.center.z);
      if (d < item.shape.R * 1.3) active = item;
    }
  }
  for (const item of navItems) item.btn.classList.toggle('active', item === active);
}

$('#btn-overview').onclick = () => {
  closePanel();
  flyTo(OVERVIEW.target, OVERVIEW.distance, { polar: OVERVIEW.polar, duration: 1.8 });
};

$('#btn-random').onclick = () => {
  const r = Math.random();
  const unexplored = apps.filter((a) => !explored.has(a.id) && a !== selected);
  const pool =
    r < 0.45 ? unexplored.filter((a) => a.tier === 2) : r < 0.75 ? unexplored.filter((a) => a.isNew) : unexplored;
  const list = pool.length ? pool : apps;
  const app = list[Math.floor(Math.random() * list.length)];
  document.body.classList.remove('warp');
  void document.body.offsetWidth;
  document.body.classList.add('warp');
  focusApp(app, { teleport: true });
};

/* ------------------------------------------------------------- search ---- */

const searchInput = $('#search');
const results = $('#results');
let resultList = [];
function renderResults() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    results.classList.remove('on');
    return;
  }
  resultList = apps
    .filter((a) => a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)) || a.cat.name.includes(q))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  results.innerHTML = resultList.length
    ? resultList
        .map(
          (a, i) =>
            `<button data-i="${i}" style="--c:${a.cat.color}"><i></i><span>${a.name}</span><small>${a.cat.name} · ${a.score}${a.tier === 2 ? ' · 精品' : ''}${a.isNew ? ' · 新作' : ''}</small></button>`,
        )
        .join('')
    : '<p class="empty">没有找到相关作品，换个关键词试试</p>';
  results.classList.add('on');
  results.querySelectorAll('button').forEach((b) => {
    b.onclick = () => choose(resultList[+b.dataset.i]);
  });
}
function choose(app) {
  if (!app) return;
  searchInput.value = '';
  searchInput.blur();
  results.classList.remove('on');
  focusApp(app);
}
searchInput.addEventListener('input', renderResults);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') choose(resultList[0]);
  if (e.key === 'Escape') {
    searchInput.value = '';
    renderResults();
    searchInput.blur();
  }
});
searchInput.addEventListener('blur', () => setTimeout(() => results.classList.remove('on'), 150));

window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
  if (e.key === 'Escape' && document.activeElement !== searchInput) {
    if (playModal.classList.contains('open')) playModal.querySelector('.play-close').click();
    else closePanel();
  }
});

/* ------------------------------------------------------------- tweaks ---- */

document.querySelectorAll('[data-tod]').forEach((b) => (b.onclick = () => setTimeOfDay(b.dataset.tod)));
function setFx(name) {
  fxName = name;
  fx = FX_LEVELS[name];
  localStorage.setItem(FX_KEY, name);
  tod.applied = false;
  document.querySelectorAll('[data-fx]').forEach((b) => b.classList.toggle('on', b.dataset.fx === name));
}
document.querySelectorAll('[data-fx]').forEach((b) => (b.onclick = () => setFx(b.dataset.fx)));
setFx(fxName);
$('#tw-cruise').onchange = (e) => (controls.autoRotate = e.target.checked);
$('#tw-labels').onchange = (e) => labelLayer.classList.toggle('hidden', !e.target.checked);
$('#tweaks-toggle').onclick = () => $('#tweaks').classList.toggle('open');

/* --------------------------------------------------------------- hint ---- */

let hintTimer = setTimeout(dismissHint, 9000);
function dismissHint() {
  clearTimeout(hintTimer);
  $('#hint').classList.add('gone');
}

/* --------------------------------------------------------------- loop ---- */

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

let viewShift = 0;
function updateViewOffset(dt) {
  const want = document.body.classList.contains('panel-open') && window.innerWidth > 900 ? 200 : 0;
  if (viewShift === want) return;
  viewShift += (want - viewShift) * Math.min(1, dt * 5);
  if (Math.abs(want - viewShift) < 0.5) viewShift = want;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (viewShift === 0) camera.clearViewOffset();
  else camera.setViewOffset(w, h, viewShift, 0, w, h);
}

const timer = new THREE.Timer();
let elapsed = 0;
function frame(now) {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.05);
  elapsed += dt;
  applyTimeOfDay(dt);
  updateViewOffset(dt);
  water.material.uniforms.uTime.value = elapsed;
  world.update(elapsed, dt);
  if (!updateFlight(dt)) controls.update();
  if (selRing.visible) {
    selRing.rotation.y = elapsed * 0.8;
    selRing.material.opacity = 0.6 + Math.sin(elapsed * 4) * 0.3;
  }
  updateHover();
  updateLabels(dt);
  updateActiveIsland();
  composer.render();
  requestAnimationFrame(frame);
}

applyTimeOfDay(1);
frame();
flyTo(OVERVIEW.target, OVERVIEW.distance, { polar: OVERVIEW.polar, duration: 3.4, spin: 0.5 });
requestAnimationFrame(() => document.body.classList.add('ready'));
