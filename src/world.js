import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './data.js';

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- glow ---- */

// Emissive-looking materials whose brightness follows the time-of-day preset.
export const glowMaterials = [];
function glowMat(hex, strength = 1, extra = {}) {
  const base = new THREE.Color(hex);
  const mat = new THREE.MeshBasicMaterial({ color: base.clone(), toneMapped: false, ...extra });
  mat.userData.glowBase = base;
  mat.userData.glowStrength = strength;
  glowMaterials.push(mat);
  return mat;
}
export function applyGlow(level) {
  for (const m of glowMaterials) {
    const k = lerp(1, level, m.userData.glowStrength);
    if (m.uniforms?.uGlow) m.uniforms.uGlow.value = k;
    else m.color.copy(m.userData.glowBase).multiplyScalar(k);
  }
}

// Accent point lights scale with the user's effect-intensity setting.
const fxLights = [];
let lightFx = 1;
function fxLight(hex, intensity, distance, decay) {
  const light = new THREE.PointLight(hex, intensity * lightFx, distance, decay);
  light.userData.base = intensity;
  fxLights.push(light);
  return light;
}
export function setLightFx(fx) {
  lightFx = fx;
  for (const l of fxLights) l.intensity = l.userData.base * fx;
}

/* ----------------------------------------------------------------- sky ---- */

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uBottom: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uStars: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHorizon, uBottom, uSunColor, uSunDir;
      uniform float uStars;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(h, 0.55)) : mix(uHorizon, uBottom, pow(-h, 0.4));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.12);
        vec3 g = floor(d * 420.0);
        float star = step(0.9975, hash(g)) * smoothstep(0.05, 0.4, h);
        col += vec3(star) * uStars * 1.4;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/* --------------------------------------------------------------- water ---- */

export function createWater() {
  const geo = new THREE.PlaneGeometry(2400, 2400, 260, 260);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color() },
      uShallow: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uFogColor: { value: new THREE.Color() },
      uFogNear: { value: 300 },
      uFogFar: { value: 900 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vN;
      float wave(vec2 p) {
        return sin(p.x * 0.05 + uTime * 0.8) * 0.22
             + sin(p.y * 0.07 + uTime * 0.6) * 0.18
             + sin((p.x + p.y) * 0.13 + uTime * 1.3) * 0.08;
      }
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        float h = wave(w.xz);
        float e = 0.6;
        float hx = wave(w.xz + vec2(e, 0.0)) - h;
        float hz = wave(w.xz + vec2(0.0, e)) - h;
        vN = normalize(vec3(-hx / e, 1.0, -hz / e));
        w.y += h;
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uFogNear, uFogFar;
      uniform vec3 uDeep, uShallow, uHorizon, uSunColor, uSunDir, uFogColor;
      varying vec3 vWorld;
      varying vec3 vN;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        float detail = 1.0 - smoothstep(70.0, 240.0, length(cameraPosition - vWorld));
        vec3 N = normalize(vN + detail * vec3(
          sin(vWorld.x * 0.9 + uTime * 2.1) * 0.035 + sin(vWorld.z * 1.7 - uTime * 1.3) * 0.02,
          0.0,
          cos(vWorld.z * 0.8 + uTime * 1.7) * 0.035 + cos(vWorld.x * 1.5 + uTime) * 0.02));
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        vec3 col = mix(uShallow, uDeep, 0.55);
        col = mix(col, uHorizon, fres * 0.65);
        vec3 L = normalize(uSunDir);
        float spec = pow(max(dot(reflect(-L, N), V), 0.0), 160.0);
        float dist = length(cameraPosition - vWorld);
        col += uSunColor * spec * 2.2 * (1.0 - smoothstep(140.0, 480.0, dist));
        col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
        float alpha = mix(0.74, 0.97, fres);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return mesh;
}

export function createSeabed() {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(1200, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#2b5a66', roughness: 1 }),
  );
  mesh.position.y = -7.6;
  mesh.receiveShadow = true;
  return mesh;
}

/* -------------------------------------------------------------- island ---- */

export function createIslandShape(cat, seed) {
  const rng = mulberry32(seed);
  // Islands keep a minimum size so the centrepiece and a handful of works still fit.
  const R = 14 + Math.sqrt(Math.max(cat.count, 24)) * 2.6;
  const ph = [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
  const radiusAt = (a) =>
    R * (1 + 0.1 * Math.sin(3 * a + ph[0]) + 0.06 * Math.sin(5 * a + ph[1]) + 0.035 * Math.sin(8 * a + ph[2]));

  const heightLocal = (lx, lz) => {
    const d0 = Math.hypot(lx, lz);
    const d = d0 / radiusAt(Math.atan2(lz, lx));
    let h;
    if (d < 0.62) h = 3.2;
    else if (d < 1.0) h = lerp(3.2, 0.35, smooth((d - 0.62) / 0.38));
    else h = lerp(0.35, -7, smooth(clamp01((d - 1.0) / 0.45)));
    const n = Math.sin(lx * 0.21 + ph[0]) * Math.cos(lz * 0.18 + ph[1]) * 0.5 + Math.sin(lx * 0.5 + lz * 0.4 + ph[3]) * 0.16;
    h += n * (d < 1 ? smooth(clamp01((1 - d) * 4)) : 0);
    const c = d0 / R;
    if (cat.theme === 'volcano') {
      if (c < 0.3) h += 20 * Math.pow(1 - c / 0.3, 1.4);
      if (c < 0.075) h -= 6 * smooth(1 - c / 0.075);
    } else if (c < 0.22) {
      h += 2.4 * smooth(1 - c / 0.22);
    }
    return Math.max(h, -7.2);
  };

  const [cx, cz] = cat.pos;
  return {
    cat,
    R,
    rng,
    radiusAt,
    heightLocal,
    heightAt: (x, z) => heightLocal(x - cx, z - cz),
    center: new THREE.Vector3(cx, heightLocal(0, 0), cz),
    reserve: cat.theme === 'volcano' ? 0.33 : 0.23,
    occupied: [],
  };
}

function buildTerrain(shape) {
  const { cat, R } = shape;
  const size = R * 3.1;
  const seg = Math.round(size / 1.2);
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, shape.heightLocal(p.getX(i), p.getZ(i)));
  const geo = g.toNonIndexed();
  g.dispose();
  geo.computeVertexNormals();

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const sand = new THREE.Color('#ecd6a2');
  const wet = new THREE.Color('#bfa577');
  const sea = new THREE.Color('#2f6670');
  const grass = new THREE.Color(cat.ground);
  const grass2 = grass.clone().offsetHSL(0.035, 0.02, 0.07);
  const rock = new THREE.Color('#6d5a50');
  const ash = new THREE.Color('#3a2f2e');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const n = Math.sin(x * 0.37) * Math.cos(z * 0.41) * 0.5 + 0.5;
    if (y < -0.15) c.copy(wet).lerp(sea, smooth(clamp01(-y / 6)));
    else if (y < 1.05) c.copy(sand);
    else {
      c.copy(grass).lerp(grass2, n);
      if (cat.theme === 'volcano' && y > 5.5) c.lerp(rock, smooth(clamp01((y - 5.5) / 4))).lerp(ash, smooth(clamp01((y - 14) / 6)));
    }
    for (let k = 0; k < 3; k++) c.toArray(colors, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }),
  );
  mesh.position.set(cat.pos[0], 0, cat.pos[1]);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData.island = cat.id;
  return mesh;
}

function buildFoam(shape) {
  const seg = 180;
  const verts = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * TAU;
    const r = shape.radiusAt(a);
    for (const [k, f] of [[0, 0.98], [1, 1.14]]) {
      verts.push(Math.cos(a) * r * f, 0, Math.sin(a) * r * f);
      uvs.push(i / seg, k);
    }
    if (i < seg) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float band = sin(vUv.y * 14.0 - uTime * 2.2 + sin(vUv.x * 60.0) * 1.5) * 0.5 + 0.5;
        float a = smoothstep(1.0, 0.25, vUv.y) * smoothstep(0.0, 0.12, vUv.y) * (0.25 + 0.55 * band);
        gl_FragColor = vec4(vec3(1.0), a * 0.8);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(shape.cat.pos[0], 0.5, shape.cat.pos[1]);
  mesh.renderOrder = 2;
  return mesh;
}

/* ----------------------------------------------------------- placement ---- */

const FOOTPRINT = [2.0, 2.8, 4.3];

function isFree(shape, x, z, r, relax = 1) {
  for (const o of shape.occupied) {
    const dx = o.x - x;
    const dz = o.z - z;
    const min = (o.r + r) * relax;
    if (dx * dx + dz * dz < min * min) return false;
  }
  return true;
}

function samplePoint(shape, f0, f1, r, tries = 80) {
  const rng = shape.rng;
  let best = null;
  for (let t = 0; t < tries; t++) {
    const a = rng() * TAU;
    const f = f0 + (f1 - f0) * Math.sqrt(rng());
    const rr = f * shape.radiusAt(a);
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    best = { x, z };
    if (isFree(shape, x, z, r, t < 40 ? 1 : 0.75)) return { x, z, ok: true };
  }
  return { ...best, ok: false };
}

export function placeApps(shape, apps) {
  const sorted = [...apps].sort((a, b) => b.score - a.score);
  const res = shape.reserve;
  for (const app of sorted) {
    const r = FOOTPRINT[app.tier];
    const [f0, f1] = app.tier === 2 ? [res + 0.03, 0.62] : app.tier === 1 ? [res + 0.05, 0.8] : [res + 0.08, 0.88];
    const p = samplePoint(shape, f0, f1, r);
    shape.occupied.push({ x: p.x, z: p.z, r });
    const [cx, cz] = shape.cat.pos;
    app.position = new THREE.Vector3(cx + p.x, shape.heightLocal(p.x, p.z) - 0.25, cz + p.z);
    app.rotation = shape.rng() * TAU;
  }
}

function scatter(shape, count, f0, f1, r, cb) {
  const [cx, cz] = shape.cat.pos;
  for (let i = 0; i < count; i++) {
    const p = samplePoint(shape, f0, f1, r, 30);
    if (!p.ok) continue;
    shape.occupied.push({ x: p.x, z: p.z, r });
    cb(cx + p.x, shape.heightLocal(p.x, p.z), cz + p.z, i);
  }
}

/* ----------------------------------------------------------- buildings ---- */

export function createBuildings(apps) {
  const tiers = [0, 1, 2].map((t) => apps.filter((a) => a.tier === t));

  const wallGeo = [
    new THREE.BoxGeometry(1.5, 1.2, 1.5).translate(0, 0.6, 0),
    new THREE.BoxGeometry(2.3, 2.6, 2.3).translate(0, 1.3, 0),
    mergeGeometries([
      new THREE.CylinderGeometry(1.9, 2.4, 6.6, 8).translate(0, 3.3, 0),
      new THREE.CylinderGeometry(2.45, 2.45, 0.9, 8).translate(0, 6.9, 0),
      new THREE.CylinderGeometry(0.8, 0.9, 3.6, 6).translate(2.6, 1.8, 0),
      new THREE.CylinderGeometry(0.8, 0.9, 3.6, 6).translate(-2.6, 1.8, 0),
    ]),
  ];
  const roofGeo = [
    new THREE.ConeGeometry(1.25, 1.1, 4).rotateY(Math.PI / 4).translate(0, 1.75, 0),
    new THREE.ConeGeometry(2.0, 1.8, 4).rotateY(Math.PI / 4).translate(0, 3.5, 0),
    mergeGeometries([
      new THREE.ConeGeometry(2.3, 3.6, 8).translate(0, 9.15, 0),
      new THREE.ConeGeometry(1.05, 1.6, 6).translate(2.6, 4.4, 0),
      new THREE.ConeGeometry(1.05, 1.6, 6).translate(-2.6, 4.4, 0),
    ]),
  ];
  const wallMat = new THREE.MeshStandardMaterial({ color: '#f1e7d4', roughness: 0.85, flatShading: true });
  const roofMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, flatShading: true });

  const meshes = [];
  const pickables = [];
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  tiers.forEach((list, t) => {
    const walls = new THREE.InstancedMesh(wallGeo[t], wallMat, list.length);
    const roofs = new THREE.InstancedMesh(roofGeo[t], roofMat, list.length);
    list.forEach((app, i) => {
      const s = t === 2 ? 0.9 + (app.score - 90) * 0.03 : t === 1 ? 0.85 + (app.score - 70) * 0.012 : 0.8 + (app.score - 40) * 0.008;
      dummy.position.copy(app.position);
      dummy.rotation.set(0, app.rotation, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      walls.setMatrixAt(i, dummy.matrix);
      roofs.setMatrixAt(i, dummy.matrix);
      roofs.setColorAt(i, color.set(app.cat.color));
      app.render = { tier: t, index: i, scale: s };
    });
    for (const m of [walls, roofs]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.apps = list;
      m.computeBoundingSphere();
      meshes.push(m);
      pickables.push(m);
    }
    list.meshes = [walls, roofs];
  });

  // Floating orbs above landmarks.
  const featured = tiers[2];
  const orbMat = glowMat('#ffffff', 1);
  const orbs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.85, 0), orbMat, featured.length);
  featured.forEach((app, i) => orbs.setColorAt(i, color.set(app.cat.color).multiplyScalar(1.15)));
  orbs.userData.apps = featured;
  meshes.push(orbs);
  pickables.push(orbs);

  // Light beams for brand-new apps.
  const beamGeo = new THREE.CylinderGeometry(0.7, 1.3, 46, 16, 1, true).translate(0, 23, 0);
  const beamMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#ffd27a') }, uGlow: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFade;
      void main() {
        vUv = uv;
        vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vFade = smoothstep(30.0, 130.0, distance(cameraPosition, base));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uGlow;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        float a = pow(1.0 - vUv.y, 2.0) * 0.22 * (0.05 + 0.95 * vFade);
        a *= 0.8 + 0.2 * sin(uTime * 2.0 - vUv.y * 10.0);
        gl_FragColor = vec4(uColor * (0.45 + uGlow * 0.35), a);
      }`,
  });
  beamMat.userData.glowStrength = 1;
  glowMaterials.push(beamMat);
  const ringGeo = new THREE.RingGeometry(2.2, 2.7, 40).rotateX(-Math.PI / 2);
  const ringMat = glowMat('#ffd27a', 0.8, { transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  const beams = new THREE.Group();
  const rings = [];
  apps.filter((a) => a.isNew).forEach((app) => {
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.copy(app.position);
    beam.renderOrder = 3;
    beams.add(beam);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(app.position).setY(app.position.y + 0.4);
    ring.userData.phase = Math.random() * TAU;
    beams.add(ring);
    rings.push(ring);
  });
  meshes.push(beams);

  const hoverScale = new Map();

  function writeMatrix(app, extra = 1) {
    const { tier, index, scale } = app.render;
    dummy.position.copy(app.position);
    dummy.rotation.set(0, app.rotation, 0);
    dummy.scale.setScalar(scale * extra);
    dummy.updateMatrix();
    for (const m of tiers[tier].meshes) {
      m.setMatrixAt(index, dummy.matrix);
      m.instanceMatrix.needsUpdate = true;
    }
  }

  function setHighlight(app, on) {
    if (!app) return;
    app._hoverTarget = on ? 1.22 : 1;
    if (!hoverScale.has(app)) hoverScale.set(app, 1);
  }

  function update(t, dt) {
    for (const [app, cur] of hoverScale) {
      const next = cur + ((app._hoverTarget ?? 1) - cur) * Math.min(1, dt * 12);
      writeMatrix(app, next);
      if (Math.abs(next - 1) < 0.002 && (app._hoverTarget ?? 1) === 1) {
        writeMatrix(app, 1);
        hoverScale.delete(app);
      } else hoverScale.set(app, next);
    }
    featured.forEach((app, i) => {
      const s = app.render.scale * (hoverScale.get(app) ?? 1);
      dummy.position.copy(app.position);
      dummy.position.y += (11.8 + Math.sin(t * 1.6 + i) * 0.45) * s;
      dummy.rotation.set(t * 0.6 + i, t * 0.9 + i, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      orbs.setMatrixAt(i, dummy.matrix);
    });
    orbs.instanceMatrix.needsUpdate = true;
    beamMat.uniforms.uTime.value = t;
    for (const r of rings) {
      const k = (t * 0.6 + r.userData.phase) % 1;
      r.scale.setScalar(0.6 + k * 1.6);
    }
  }

  return { meshes, pickables, update, setHighlight };
}

/* -------------------------------------------------------------- nature ---- */

function createTrees(shapes) {
  const pines = [];
  const rounds = [];
  for (const shape of shapes) {
    const t = shape.cat.theme;
    const count = Math.round(shape.R * (t === 'garden' ? 1.0 : 1.7));
    const pineRatio = t === 'observatory' || t === 'windmill' ? 0.7 : t === 'volcano' ? 0.45 : 0.25;
    scatter(shape, count, shape.reserve + 0.02, 0.97, 1.3, (x, y, z) => {
      if (y < 1.1) return;
      const s = 0.7 + shape.rng() * 0.7;
      (shape.rng() < pineRatio ? pines : rounds).push({ x, y, z, s, cat: shape.cat, r: shape.rng() });
    });
  }
  const group = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#7a5236', roughness: 1, flatShading: true });
  const leafMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true });
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const build = (list, trunkGeo, leafGeo, tint) => {
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, list.length);
    list.forEach((p, i) => {
      dummy.position.set(p.x, p.y - 0.2, p.z);
      dummy.rotation.set(0, p.r * TAU, 0);
      dummy.scale.setScalar(p.s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      leaves.setMatrixAt(i, dummy.matrix);
      leaves.setColorAt(i, tint(p, col));
    });
    for (const m of [trunks, leaves]) {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
  };
  build(
    pines,
    new THREE.CylinderGeometry(0.18, 0.25, 1.2, 5).translate(0, 0.6, 0),
    mergeGeometries([
      new THREE.ConeGeometry(1.2, 2.2, 6).translate(0, 2.0, 0),
      new THREE.ConeGeometry(0.85, 1.7, 6).translate(0, 3.1, 0),
    ]),
    (p, c) => c.set('#2f6b45').offsetHSL((p.r - 0.5) * 0.04, 0, (p.r - 0.5) * 0.08),
  );
  build(
    rounds,
    new THREE.CylinderGeometry(0.2, 0.28, 1.4, 5).translate(0, 0.7, 0),
    new THREE.IcosahedronGeometry(1.25, 0).translate(0, 2.3, 0),
    (p, c) => {
      if (p.cat.theme === 'garden' && p.r < 0.45) return c.set('#ffb7c9').offsetHSL(0, 0, (p.r - 0.2) * 0.2);
      if (p.cat.theme === 'crystal' && p.r < 0.3) return c.set('#7fd6c2');
      return c.set('#4f8f3f').offsetHSL((p.r - 0.5) * 0.06, 0, (p.r - 0.5) * 0.1);
    },
  );
  return group;
}

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------- theme landmarks ---- */

function volcanoProps(shape, updaters) {
  const g = new THREE.Group();
  const { R } = shape;
  const [cx, cz] = shape.cat.pos;
  const top = shape.heightLocal(0, 0);
  const lava = new THREE.Mesh(new THREE.CircleGeometry(R * 0.085, 20).rotateX(-Math.PI / 2), glowMat('#ff6a1a', 1.2));
  lava.position.set(cx, top + 0.6, cz);
  g.add(lava);
  const light = fxLight('#ff7a30', 200, 70, 1.6);
  light.position.set(cx, top + 6, cz);
  g.add(light);

  const lavaMat = glowMat('#ff5a14', 1);
  for (let k = 0; k < 4; k++) {
    const a = k * 1.7 + 0.4;
    const pts = [];
    for (let s = 0; s <= 14; s++) {
      const f = 0.07 + (s / 14) * 0.26;
      const aa = a + Math.sin(s * 0.6 + k) * 0.08;
      const x = Math.cos(aa) * f * R;
      const z = Math.sin(aa) * f * R;
      pts.push(new THREE.Vector3(cx + x, shape.heightLocal(x, z) + 0.15, cz + z));
    }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.32, 5), lavaMat);
    g.add(tube);
  }

  const N = 70;
  const geo = new THREE.BufferGeometry();
  const arr = new Float32Array(N * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const seeds = Array.from({ length: N }, () => [Math.random(), Math.random() * TAU, Math.random()]);
  const smoke = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 9, map: softDotTexture(), transparent: true, opacity: 0.32, depthWrite: false, color: '#9a8f8a' }),
  );
  smoke.frustumCulled = false;
  g.add(smoke);
  updaters.push((t) => {
    for (let i = 0; i < N; i++) {
      const [ph, a, r] = seeds[i];
      const k = (t * 0.07 + ph) % 1;
      arr[i * 3] = cx + Math.cos(a) * (1 + k * 9 * r) + k * 10;
      arr[i * 3 + 1] = top + 1 + k * 34;
      arr[i * 3 + 2] = cz + Math.sin(a) * (1 + k * 9 * r);
    }
    geo.attributes.position.needsUpdate = true;
    light.intensity = light.userData.base * lightFx * (0.9 + Math.sin(t * 3) * 0.08 + Math.sin(t * 7) * 0.04);
  });
  return g;
}

function crystalProps(shape, updaters) {
  const g = new THREE.Group();
  const [cx, cz] = shape.cat.pos;
  const crystalMat = new THREE.MeshStandardMaterial({
    color: '#7ff3ff',
    emissive: '#1fb8d0',
    emissiveIntensity: 0.35,
    roughness: 0.15,
    metalness: 0.1,
    flatShading: true,
  });
  const list = [];
  scatter(shape, 26, shape.reserve, 0.95, 1.6, (x, y, z) => {
    if (y > 1.1) list.push([x, y, z]);
  });
  const crystals = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), crystalMat, list.length * 3);
  const d = new THREE.Object3D();
  let n = 0;
  for (const [x, y, z] of list) {
    for (let k = 0; k < 3; k++) {
      const s = 0.5 + Math.random() * 0.7;
      d.position.set(x + (Math.random() - 0.5) * 1.6, y + s * 1.4, z + (Math.random() - 0.5) * 1.6);
      d.rotation.set((Math.random() - 0.5) * 0.6, Math.random() * TAU, (Math.random() - 0.5) * 0.6);
      d.scale.set(s * 0.6, s * 2.2, s * 0.6);
      d.updateMatrix();
      crystals.setMatrixAt(n++, d.matrix);
    }
  }
  crystals.castShadow = true;
  g.add(crystals);

  const top = shape.heightLocal(0, 0);
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(3.4, 0), glowMat('#6ff0ff', 0.55));
  core.scale.set(1, 1.8, 1);
  const shell = new THREE.Mesh(
    new THREE.OctahedronGeometry(4.6, 0),
    new THREE.MeshStandardMaterial({ color: '#bff8ff', transparent: true, opacity: 0.25, roughness: 0, flatShading: true }),
  );
  shell.scale.set(1, 1.8, 1);
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(8, 0.18, 6, 64), glowMat('#6ff0ff', 0.6));
  const ringB = ringA.clone();
  const core0 = new THREE.Group();
  core0.add(core, shell, ringA, ringB);
  core0.position.set(cx, top + 14, cz);
  g.add(core0);
  const light = fxLight('#5fe8ff', 90, 60, 1.6);
  light.position.copy(core0.position);
  g.add(light);
  updaters.push((t) => {
    core0.position.y = top + 14 + Math.sin(t * 1.2) * 1.2;
    core.rotation.y = t * 0.5;
    shell.rotation.y = -t * 0.3;
    ringA.rotation.set(Math.PI / 2 + Math.sin(t * 0.7) * 0.4, t * 0.4, 0);
    ringB.rotation.set(Math.PI / 2 + 0.9, -t * 0.5, Math.cos(t * 0.5) * 0.3);
  });
  return g;
}

function gardenProps(shape, updaters) {
  const g = new THREE.Group();
  const [cx, cz] = shape.cat.pos;
  const palette = ['#ff8fab', '#ffd166', '#ffffff', '#ff6f91', '#c3a6ff', '#ffb37a'].map((h) => new THREE.Color(h));
  const pts = [];
  scatter(shape, 120, shape.reserve, 0.96, 0.5, (x, y, z) => {
    if (y > 1.1) pts.push([x, y, z]);
  });
  const flowers = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.32, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.7, flatShading: true }),
    pts.length * 4,
  );
  const d = new THREE.Object3D();
  let n = 0;
  for (const [x, y, z] of pts) {
    const c = palette[Math.floor(Math.random() * palette.length)];
    for (let k = 0; k < 4; k++) {
      d.position.set(x + (Math.random() - 0.5) * 1.8, y + 0.25, z + (Math.random() - 0.5) * 1.8);
      d.scale.setScalar(0.7 + Math.random() * 0.6);
      d.updateMatrix();
      flowers.setMatrixAt(n, d.matrix);
      flowers.setColorAt(n++, c);
    }
  }
  g.add(flowers);

  const top = shape.heightLocal(0, 0);
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.6, 9, 7).translate(0, 4.5, 0),
    new THREE.MeshStandardMaterial({ color: '#6e4a36', flatShading: true }),
  );
  trunk.castShadow = true;
  tree.add(trunk);
  const blossom = new THREE.MeshStandardMaterial({ color: '#ffb3c8', emissive: '#ff6f91', emissiveIntensity: 0.15, flatShading: true });
  [[0, 11, 0, 5], [3.5, 9.5, 1.5, 3.6], [-3.4, 9.8, -1, 3.8], [1, 9.2, -3.4, 3.4], [-1.2, 13.4, 1.2, 3.2]].forEach(([x, y, z, r]) => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), blossom);
    m.position.set(x, y, z);
    m.castShadow = true;
    tree.add(m);
  });
  tree.position.set(cx, top - 0.3, cz);
  g.add(tree);

  const N = 90;
  const geo = new THREE.BufferGeometry();
  const arr = new Float32Array(N * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const seeds = Array.from({ length: N }, () => [Math.random(), Math.random() * TAU, 3 + Math.random() * 14]);
  const petals = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 0.8, map: softDotTexture(), transparent: true, depthWrite: false, color: '#ffc4d4' }),
  );
  petals.frustumCulled = false;
  g.add(petals);
  updaters.push((t) => {
    for (let i = 0; i < N; i++) {
      const [ph, a, r] = seeds[i];
      const k = (t * 0.05 + ph) % 1;
      arr[i * 3] = cx + Math.cos(a + k * 2) * r + k * 6;
      arr[i * 3 + 1] = top + 14 - k * 13;
      arr[i * 3 + 2] = cz + Math.sin(a + k * 2) * r;
    }
    geo.attributes.position.needsUpdate = true;
    tree.rotation.z = Math.sin(t * 0.8) * 0.01;
  });
  return g;
}

function windmill(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.5, 6.5, 8).translate(0, 3.25, 0),
    new THREE.MeshStandardMaterial({ color: '#f3ead8', flatShading: true }),
  );
  const cap = new THREE.Mesh(
    new THREE.ConeGeometry(1.3, 1.8, 8).translate(0, 7.4, 0),
    new THREE.MeshStandardMaterial({ color, flatShading: true }),
  );
  body.castShadow = cap.castShadow = true;
  const hub = new THREE.Group();
  hub.position.set(0, 6.2, 1.2);
  const bladeMat = new THREE.MeshStandardMaterial({ color: '#fff6e6', flatShading: true });
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 4.2, 0.1).translate(0, 2.3, 0), bladeMat);
    b.rotation.z = (i * Math.PI) / 2;
    b.castShadow = true;
    hub.add(b);
  }
  g.add(body, cap, hub);
  g.userData.hub = hub;
  return g;
}

function windmillProps(shape, updaters) {
  const g = new THREE.Group();
  const [cx, cz] = shape.cat.pos;
  const hubs = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3;
    const r = shape.radiusAt(a) * 0.9;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!isFree(shape, x, z, 2.2)) continue;
    shape.occupied.push({ x, z, r: 2.2 });
    const w = windmill(shape.cat.color);
    w.position.set(cx + x, shape.heightLocal(x, z) - 0.3, cz + z);
    w.rotation.y = -a + Math.PI / 2;
    g.add(w);
    hubs.push(w.userData.hub);
  }

  const top = shape.heightLocal(0, 0);
  const tower = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: '#efe4cf', flatShading: true });
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 15, 4.4).translate(0, 7.5, 0), stone);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(3.6, 5, 4).rotateY(Math.PI / 4).translate(0, 17.5, 0),
    new THREE.MeshStandardMaterial({ color: shape.cat.color, flatShading: true }),
  );
  body.castShadow = roof.castShadow = true;
  tower.add(body, roof);
  const faceMat = glowMat('#ffe7a8', 0.9);
  const handMat = new THREE.MeshBasicMaterial({ color: '#3a2a1a' });
  const hands = [];
  for (let i = 0; i < 4; i++) {
    const face = new THREE.Group();
    face.rotation.y = (i * Math.PI) / 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), faceMat);
    disc.position.set(0, 12.5, 2.22);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.2, 0.05).translate(0, 0.5, 0), handMat);
    hand.position.set(0, 12.5, 2.26);
    face.add(disc, hand);
    hands.push(hand);
    tower.add(face);
  }
  tower.position.set(cx, top - 0.3, cz);
  g.add(tower);
  updaters.push((t) => {
    hubs.forEach((h, i) => (h.rotation.z = t * (0.9 + i * 0.07)));
    hands.forEach((h) => (h.rotation.z = -t * 0.6));
  });
  return g;
}

function soundProps(shape, updaters) {
  const g = new THREE.Group();
  const [cx, cz] = shape.cat.pos;
  const top = shape.heightLocal(0, 0);
  const pillarMat = new THREE.MeshStandardMaterial({ color: '#2b2740', roughness: 0.4, metalness: 0.4, flatShading: true });
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.2, 13, 8).translate(0, 6.5, 0), pillarMat);
  pillar.position.set(cx, top - 0.3, cz);
  pillar.castShadow = true;
  g.add(pillar);
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 1), glowMat('#b9a8ff', 1.2));
  orb.position.set(cx, top + 15, cz);
  g.add(orb);

  const BARS = 28;
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 1, 0.9).translate(0, 0.5, 0), glowMat('#8f7bff', 0.9), BARS);
  const d = new THREE.Object3D();
  g.add(bars);

  const waveMat = glowMat('#a796ff', 1, { transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const waves = [0, 1, 2].map((i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(4, 0.12, 6, 64).rotateX(Math.PI / 2), waveMat.clone());
    m.material.userData = waveMat.userData;
    glowMaterials.push(m.material);
    m.position.set(cx, top + 15, cz);
    m.userData.phase = i / 3;
    g.add(m);
    return m;
  });
  const light = fxLight('#9d8cff', 120, 55, 1.6);
  light.position.set(cx, top + 15, cz);
  g.add(light);

  updaters.push((t) => {
    for (let i = 0; i < BARS; i++) {
      const a = (i / BARS) * TAU;
      const amp = 1.5 + 4 * Math.abs(Math.sin(t * 3.1 + i * 0.7) * Math.sin(t * 1.3 + i * 0.31));
      d.position.set(cx + Math.cos(a) * 6.5, top - 0.2, cz + Math.sin(a) * 6.5);
      d.rotation.set(0, -a, 0);
      d.scale.set(1, amp, 1);
      d.updateMatrix();
      bars.setMatrixAt(i, d.matrix);
    }
    bars.instanceMatrix.needsUpdate = true;
    const beat = Math.pow(Math.max(0, Math.sin(t * 4.2)), 8);
    orb.scale.setScalar(1 + beat * 0.25);
    for (const w of waves) {
      const k = (t * 0.35 + w.userData.phase) % 1;
      w.scale.setScalar(1 + k * 5);
      w.material.opacity = (1 - k) * 0.9;
    }
  });
  return g;
}

function observatoryProps(shape, updaters) {
  const g = new THREE.Group();
  const [cx, cz] = shape.cat.pos;
  const top = shape.heightLocal(0, 0);
  const obs = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.5, flatShading: true });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(5, 5.4, 4, 16).translate(0, 2, 0), white);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4.9, 16, 10, 0, TAU, 0, Math.PI / 2).translate(0, 4, 0), white);
  const slit = new THREE.Mesh(new THREE.BoxGeometry(1.4, 5.2, 6).translate(0, 6.2, 0), new THREE.MeshStandardMaterial({ color: '#2b3a4a' }));
  slit.scale.set(1, 1, 0.98);
  const scope = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.9, 7, 10),
    new THREE.MeshStandardMaterial({ color: '#c9a35a', metalness: 0.6, roughness: 0.3 }),
  );
  scope.position.set(0, 8.5, 1.6);
  scope.rotation.x = -0.6;
  for (const m of [base, dome, scope]) m.castShadow = true;
  const head = new THREE.Group();
  head.add(dome, slit, scope);
  obs.add(base, head);
  obs.position.set(cx, top - 0.3, cz);
  g.add(obs);

  const planets = [
    [1.1, '#ffcf6b', 9, 0.5],
    [0.8, '#6fd3ff', 12.5, -0.35],
    [1.4, '#ff8a6b', 16, 0.22],
  ].map(([r, c, orbit, speed]) => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), glowMat(c, 0.9));
    m.userData = { orbit, speed };
    g.add(m);
    return m;
  });
  const orbitMat = glowMat('#ffffff', 0.4, { transparent: true, opacity: 0.25 });
  planets.forEach((p) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(p.userData.orbit, 0.05, 4, 96).rotateX(Math.PI / 2), orbitMat);
    ring.position.set(cx, top + 17, cz);
    g.add(ring);
  });
  updaters.push((t) => {
    head.rotation.y = t * 0.15;
    planets.forEach((p, i) => {
      const a = t * p.userData.speed + i * 2;
      p.position.set(cx + Math.cos(a) * p.userData.orbit, top + 17, cz + Math.sin(a) * p.userData.orbit);
    });
  });
  return g;
}

const THEME_BUILDERS = {
  volcano: volcanoProps,
  crystal: crystalProps,
  garden: gardenProps,
  windmill: windmillProps,
  sound: soundProps,
  observatory: observatoryProps,
};

/* ------------------------------------------------------ ocean dressing ---- */

function createLighthouse(updaters) {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(6, 1),
    new THREE.MeshStandardMaterial({ color: '#7d756c', flatShading: true, roughness: 1 }),
  );
  rock.scale.set(1, 0.45, 1);
  rock.position.y = -0.6;
  rock.receiveShadow = true;
  g.add(rock);
  const white = new THREE.MeshStandardMaterial({ color: '#f6f1e7', flatShading: true });
  const red = new THREE.MeshStandardMaterial({ color: '#d9534f', flatShading: true });
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(1.25 - i * 0.12, 1.37 - i * 0.12, 2.2, 12), i % 2 ? red : white);
    seg.position.y = 2.2 + i * 2.2;
    seg.castShadow = true;
    g.add(seg);
  }
  const lamp = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), glowMat('#fff2c4', 1.3));
  lamp.position.y = 11.4;
  g.add(lamp);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.4, 12), red);
  cap.position.y = 12.7;
  g.add(cap);

  const beamGeo = new THREE.ConeGeometry(5, 60, 24, 1, true).rotateZ(Math.PI / 2).translate(30, 0, 0);
  const beamMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uGlow: { value: 1 } },
    vertexShader: /* glsl */ `
      varying float vK;
      void main() { vK = clamp(position.x / 60.0, 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uGlow;
      varying float vK;
      void main() { gl_FragColor = vec4(vec3(1.0, 0.92, 0.7) * uGlow, (1.0 - vK) * 0.07 * uGlow); }`,
  });
  beamMat.userData.glowStrength = 1;
  glowMaterials.push(beamMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = 11.4;
  g.add(beam);
  updaters.push((t) => (beam.rotation.y = t * 0.7));
  return g;
}

function boat(color) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.5, 3.6, 6, 1).rotateZ(Math.PI / 2).scale(1, 0.6, 0.9),
    new THREE.MeshStandardMaterial({ color: '#8a5a3c', flatShading: true }),
  );
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4), new THREE.MeshStandardMaterial({ color: '#5a3d2b' }));
  mast.position.y = 1.9;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(1.7, 0);
  shape.lineTo(0, 2.8);
  const sail = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, flatShading: true }),
  );
  sail.position.set(0.05, 0.6, 0);
  hull.castShadow = sail.castShadow = true;
  g.add(hull, mast, sail);
  return g;
}

function createBoats(updaters) {
  const g = new THREE.Group();
  const specs = [
    [16, 0.12, 0, '#fff4e0'],
    [16, 0.12, Math.PI, '#ffd27a'],
    [168, -0.03, 0.4, '#fff4e0'],
    [176, 0.025, 2.2, '#ff8a6b'],
    [190, -0.022, 3.9, '#fff4e0'],
    [200, 0.02, 5.1, '#6fd3ff'],
    [215, -0.018, 1.3, '#fff4e0'],
  ];
  const boats = specs.map(([r, speed, ph, color]) => {
    const b = boat(color);
    b.userData = { r, speed, ph };
    g.add(b);
    return b;
  });
  updaters.push((t) => {
    for (const b of boats) {
      const { r, speed, ph } = b.userData;
      const a = ph + t * speed;
      b.position.set(Math.cos(a) * r, Math.sin(t * 1.4 + ph) * 0.18 + 0.15, Math.sin(a) * r);
      b.rotation.y = -a + (speed > 0 ? Math.PI : 0);
      b.rotation.z = Math.sin(t * 1.1 + ph) * 0.06;
    }
  });
  return g;
}

function createClouds(updaters) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, transparent: true, opacity: 0.92, roughness: 1 });
  const rng = mulberry32(7);
  const clouds = [];
  for (let i = 0; i < 18; i++) {
    const c = new THREE.Group();
    const parts = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < parts; k++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(3 + rng() * 4, 1), mat);
      m.position.set((k - parts / 2) * 4 + rng() * 2, rng() * 2, rng() * 4 - 2);
      m.scale.y = 0.6;
      m.castShadow = true;
      c.add(m);
    }
    c.position.set(rng() * 700 - 350, 62 + rng() * 26, rng() * 600 - 300);
    c.userData.speed = 2 + rng() * 3;
    clouds.push(c);
    g.add(c);
  }
  updaters.push((t, dt) => {
    for (const c of clouds) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 380) c.position.x = -380;
    }
  });
  return g;
}

/* --------------------------------------------------------------- world ---- */

export function createWorld(categories, apps) {
  const group = new THREE.Group();
  const updaters = [];
  const shapes = categories.map((cat, i) => createIslandShape(cat, 100 + i * 17));
  const terrains = [];
  const foams = [];

  shapes.forEach((shape) => {
    const terrain = buildTerrain(shape);
    terrains.push(terrain);
    group.add(terrain);
    const foam = buildFoam(shape);
    foams.push(foam);
    group.add(foam);
    placeApps(shape, apps.filter((a) => a.cat === shape.cat));
  });
  shapes.forEach((shape) => group.add(THEME_BUILDERS[shape.cat.theme](shape, updaters)));
  group.add(createTrees(shapes));

  const buildings = createBuildings(apps);
  buildings.meshes.forEach((m) => group.add(m));

  group.add(createLighthouse(updaters));
  group.add(createBoats(updaters));
  group.add(createClouds(updaters));

  function update(t, dt) {
    for (const f of foams) f.material.uniforms.uTime.value = t;
    buildings.update(t, dt);
    for (const u of updaters) u(t, dt);
  }

  return { group, shapes, terrains, buildings, update };
}
