// Sky, sun, mountains, trees, cars and people. Ground, roads and buildings come with the model.
//
// Light: the sky is an HDRI (Poly Haven, CC0) that lights the scene through the environment map
// and is the background; its sun disc was taken out (scripts/build_web_assets.py) and replaced by
// a directional light from the same direction, so the sun casts shadows and is counted once.
// Dushanbe lies in a valley: the Hissar range rises to the north, lower ridges close it in the
// south; they are drawn here as a ring of hazy ridges far beyond the city.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { CARS, PEOPLE, TREES, toScene } from './config.js';
import { addCars, addPeople, addTrees } from './props.js';
import { Q } from './quality.js';
import skyInfo from '../public/env/sky.json';

const ENV = `${import.meta.env.BASE_URL}env/`;
// daylight like the marketing renders: a clear afternoon sun, nearly white (a yellow sun and a
// warmed sky light made the brick and the white stone read yellow, 22.10.2026), the sky's light a
// little blue in the shadows; the sky seen behind the blocks lighter than the light it gives, airy
// and pale as on the renders, its clouds white; ?sun= ?sky= ?bg= ?suncolor= to compare
const LIGHT = new URLSearchParams(location.search);
const SKY_INTENSITY = +(LIGHT.get('sky') ?? 1.35);
const BG_INTENSITY = +(LIGHT.get('bg') ?? 1.7);
const SUN_INTENSITY = +(LIGHT.get('sun') ?? 3.0);
const SUN_COLOR = LIGHT.get('suncolor') ? `#${LIGHT.get('suncolor')}` : '#fff7ee';
const HAZE = new THREE.Color(0xcad6e0);

function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

// the views of the client renders (render 1 from the south, render 2 from the north-west): the
// background city keeps out of the way between these cameras and the complex
const CORRIDORS = [
  { from: [-81, 420], to: [[-150, 40], [80, 40]] },
  { from: [-315, -158], to: [[-140, 60], [-60, -100]] },
];
function inCorridor(x, z, w, l) {
  const r = Math.hypot(w, l) / 2 + 12;
  for (const c of CORRIDORS) {
    const [ax, az] = c.from;
    for (const [bx, bz] of [c.to[0], c.to[1], [(c.to[0][0] + c.to[1][0]) / 2, (c.to[0][1] + c.to[1][1]) / 2]]) {
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < r + 18 * t) return true;
    }
    // and the wedge between the two edge rays
    const cross = (p, q) => p[0] * q[1] - p[1] * q[0];
    const v0 = [c.to[0][0] - ax, c.to[0][1] - az], v1 = [c.to[1][0] - ax, c.to[1][1] - az], v = [x - ax, z - az];
    const inside = cross(v0, v) * cross(v0, v1) >= 0 && cross(v1, v) * cross(v1, v0) >= 0;
    if (inside && Math.hypot(...v) < Math.hypot(...v0) + 20) return true;
  }
  return false;
}

/** the city round the complex: quarters of four- to nine-storey blocks on the street grid of the
 * site (turned 27 degrees), with trees along the streets and in the yards; returns the trees */
// the modelled site in scene metres: the genplan's area and the school's ground (blender/ab)
const offSite = (p) => (p.x > -237 && p.x < 209 && p.z > -160 && p.z < 132) || (p.x > -195 && p.x < 30 && p.z > -230 && p.z < -30);

function city(scene) {
  const rnd = rng(31);
  const boxes = [], trees = [], lights = [];
  const a = (27 * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const Q = 150; // a quarter with its streets
  const site = (u, v) => ({ x: ca * u - sa * v, z: -(sa * u + ca * v) });
  for (let i = -9; i <= 9; i++) {
    for (let j = -9; j <= 9; j++) {
      const u0 = i * Q, v0 = j * Q;
      const d = Math.hypot(u0, v0);
      if (d > 1400) continue;
      // not on the modelled site (the genplan area, spread 1.1 times, and the school's ground to
      // the north-west) nor on its roads
      const c = site(u0, v0);
      if (offSite(c)) continue;
      const kind = rnd();
      const n = kind < 0.15 ? 0 : 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) {
        const long = rnd() < 0.6;
        const w = long ? 50 + rnd() * 50 : 14 + rnd() * 14, l = long ? 12 + rnd() * 3 : 14 + rnd() * 10;
        const floors = d < 600 ? (rnd() < 0.25 ? 9 : 4 + Math.floor(rnd() * 2)) : 4 + Math.floor(rnd() * 3);
        const u = u0 + (rnd() - 0.5) * (Q - 60), v = v0 + (rnd() - 0.5) * (Q - 50);
        const p = site(u, v);
        if (offSite(p)) continue;
        // nothing between the presentation cameras (renders 1 and 2) and the complex
        if (inCorridor(p.x, p.z, w, l)) continue;
        boxes.push({ x: p.x, z: p.z, w, l, h: floors * 3.0, r: a + (rnd() < 0.5 ? 0 : Math.PI / 2) });
      }
      // street trees on the quarter's edges, a few in the yard
      for (let k = 0; k < 18; k++) {
        const side = Math.floor(rnd() * 4), t = (rnd() - 0.5) * Q;
        const e = Q / 2 - 6;
        const [u, v] = side === 0 ? [u0 + t, v0 - e] : side === 1 ? [u0 + t, v0 + e] : side === 2 ? [u0 - e, v0 + t] : [u0 + e, v0 + t];
        trees.push({ ...site(u, v), h: 7 + rnd() * 6 });
      }
      for (let k = 0; k < 8; k++) trees.push({ ...site(u0 + (rnd() - 0.5) * Q * 0.8, v0 + (rnd() - 0.5) * Q * 0.8), h: 6 + rnd() * 6 });
      // street lights along two of its edges (the next quarter has the other two), lit at night
      for (let t = -Q / 2 + 12; t < Q / 2; t += 27) {
        for (const [u, v] of [[u0 + t, v0 - Q / 2 + 4], [u0 - Q / 2 + 4, v0 + t]]) lights.push({ ...site(u, v), y: 7.5 });
      }
    }
  }
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ name: 'City', color: 0xffffff, roughness: 0.95 });
  const im = new THREE.InstancedMesh(geo, mat, boxes.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  boxes.forEach((b, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.r);
    m4.compose(p.set(b.x, 0, b.z), q, s.set(b.w, b.h, b.l));
    im.setMatrixAt(i, m4);
    // walls painted as in Dushanbe's quarters (22.10.2026: no more grey boxes): cream, peach,
    // terracotta, dusty pink, pale blue, mint, sand, white, brick; soft, not loud
    const tones = [[0.11, 0.42, 0.74], [0.07, 0.4, 0.72], [0.03, 0.34, 0.62], [0.97, 0.22, 0.74], [0.56, 0.24, 0.72], [0.42, 0.18, 0.7], [0.09, 0.26, 0.66], [0.08, 0.05, 0.84], [0.03, 0.36, 0.5]];
    const t = tones[Math.floor(rnd() * tones.length)];
    im.setColorAt(i, col.setHSL(t[0] + (rnd() - 0.5) * 0.02, t[1] * (0.8 + rnd() * 0.4), t[2] * (0.94 + rnd() * 0.1)));
  });
  im.castShadow = false;
  im.receiveShadow = true;
  im.name = 'city';
  scene.add(im);
  return { mat, trees, lights };
}

/**
 * @param after  resolves when the model is in: sky, trees and cars wait for it
 */
export function buildWorld(scene, renderer, after = Promise.resolve()) {
  // The HDRI's sun stands in the east-south-east (azimuth 124 deg). The sky is turned so that the sun
  // comes from the south-south-west (210 deg), the afternoon light of the renders: the street faces of
  // the blocks and the west face of the glass tower are in the sun.
  const SKY_TURN = THREE.MathUtils.degToRad(-86);
  const sunDir = new THREE.Vector3(...skyInfo.sun_dir).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), SKY_TURN);
  scene.backgroundRotation.set(0, SKY_TURN, 0);
  scene.environmentRotation.set(0, SKY_TURN, 0);

  // aerial perspective: the city a kilometre out a little hazy, the complex (100-400 m) clear
  scene.fog = new THREE.FogExp2(HAZE.getHex(), +(LIGHT.get('fog') ?? 0.0003));
  scene.background = new THREE.Color(0xb9cde0);
  scene.backgroundIntensity = BG_INTENSITY;
  scene.environmentIntensity = SKY_INTENSITY;

  const sun = new THREE.DirectionalLight(new THREE.Color(SUN_COLOR), SUN_INTENSITY);
  sun.position.copy(sunDir).multiplyScalar(600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  const sc = sun.shadow.camera;
  sc.left = -250;
  sc.right = 250;
  sc.top = 250;
  sc.bottom = -250;
  sc.near = 200;
  sc.far = 1100;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);

  const fill = new THREE.HemisphereLight(0xd8e6f5, 0x8a8170, 1.2);
  scene.add(fill);
  // (no mountains: the renders show none, and a drawn ridge reads as fake at this distance)
  // the plain beyond the modelled ground (3 x 3 km) out to the haze, so the horizon is the fog's
  const plain = new THREE.Mesh(
    new THREE.RingGeometry(1400, 16000, 64, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x86955c, roughness: 1 }),
  );
  plain.position.y = -0.12;
  plain.receiveShadow = false;
  scene.add(plain);
  const { mat: cityMat, trees: cityTrees, lights: cityLights } = city(scene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const hdr = new RGBELoader().setDataType(THREE.FloatType);
  const sky = (res) => hdr.loadAsync(`${ENV}sky_${res}.hdr`).then((t) => ((t.mapping = THREE.EquirectangularReflectionMapping), t));
  // the light of the sky on the buildings: part of the HDRI's blue taken out (the renders' white
  // stone is white, not blue-grey), no warmth added (it turned the facades yellow); the background
  // keeps the real sky
  const neutral = (t) => {
    const src = t.image.data, n = src.length / 4;
    const out = new Float32Array(src.length);
    const K = +(LIGHT.get('skysat') ?? 0.55);
    for (let i = 0; i < n; i++) {
      const r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      out[i * 4] = l + (r - l) * K;
      out[i * 4 + 1] = l + (g - l) * K;
      out[i * 4 + 2] = l + (b - l) * K;
      out[i * 4 + 3] = 1;
    }
    const e = new THREE.DataTexture(out, t.image.width, t.image.height, THREE.RGBAFormat, THREE.FloatType);
    e.mapping = THREE.EquirectangularReflectionMapping;
    e.colorSpace = t.colorSpace;
    e.needsUpdate = true;
    return e;
  };
  const horizon = (t) => {
    const { data, width: w, height: h } = t.image;
    const rows = [Math.round(h * 0.5) - 3, Math.round(h * 0.5) - 1];   // just above the horizon
    const c = [0, 0, 0];
    let n = 0;
    for (const y of rows) {
      for (let x = 0; x < w; x += 4) {
        const i = (y * w + x) * 4;
        c[0] += data[i]; c[1] += data[i + 1]; c[2] += data[i + 2];
        n++;
      }
    }
    const k = BG_INTENSITY / n; // the haze as bright as the sky seen at the horizon
    scene.fog.color.setRGB(c[0] * k, c[1] * k, c[2] * k);
  };
  const ready = after
    .then(() => sky('1k'))
    .then((t) => {
      scene.background = t;
      horizon(t);
      const e = neutral(t);
      scene.environment = pmrem.fromEquirectangular(e).texture;
      e.dispose();
      // the glass reflects the real sky (blue at the top of the facades, as on the renders); the
      // walls and the ground are lit by the neutral version
      const skyEnv = pmrem.fromEquirectangular(t).texture;
      scene.traverse((o) => {
        for (const m of [o.material].flat()) {
          if (m?.userData?.glass && !m.envMap) {
            m.envMap = skyEnv;
            m.needsUpdate = true;
          }
        }
      });
      // dark from now on, kept for the moonlit sky at night (src/night.js): the number of lights stays
      // the same, so no shader is rebuilt when the evening comes
      fill.intensity = 0;
      pmrem.dispose();
    })
    .catch((e) => console.warn('sky', e));

  addPeople(scene, PEOPLE, toScene);
  const props = after.then(() => {
    // the complex's trees, then the city's (site metres for both: scene z = -north)
    const around = cityTrees.map((t, i) => [t.x, -t.z, 0, t.h, t.h * 0.38, i % 7 === 0 ? 'conifer' : i % 5 === 0 ? 'poplar' : 'broad']);
    addTrees(scene, TREES.protos, TREES.list, [...TREES.placed, ...around], toScene);
    addCars(scene, CARS, toScene);
  });
  if (Q.skyRes !== '1k') {
    Promise.all([ready, props])
      .then(() => new Promise((r) => setTimeout(r, 1500)))
      .then(() => sky(Q.skyRes))
      .then((t) => {
        const old = scene.background;
        scene.background = t;
        old?.dispose?.();
      })
      .catch((e) => console.warn('sky background', e));
  }

  return { sun, fill, cityMat, cityLights, ready: Promise.all([ready, props]) };
}
