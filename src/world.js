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
// soft, bright daylight like the marketing renders: more sky, a little less sun
const SKY_INTENSITY = 1.35;
const SUN_INTENSITY = 3.0;
const HAZE = new THREE.Color(0xcad6e0);

function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** the city round the complex: quarters of four- to nine-storey blocks on the street grid of the
 * site (turned 27 degrees), with trees along the streets and in the yards; returns the trees */
function city(scene) {
  const rnd = rng(31);
  const boxes = [], trees = [];
  const a = (27 * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const Q = 150; // a quarter with its streets
  const site = (u, v) => ({ x: ca * u - sa * v, z: -(sa * u + ca * v) });
  for (let i = -9; i <= 9; i++) {
    for (let j = -9; j <= 9; j++) {
      const u0 = i * Q, v0 = j * Q;
      const d = Math.hypot(u0, v0);
      if (d > 1400) continue;
      // not on the modelled site (the genplan area and the school to the north) nor on its roads
      const c = site(u0, v0);
      if ((c.x > -215 && c.x < 190 && c.z > -145 && c.z < 120) || (c.x > 0 && c.x < 250 && c.z > -235 && c.z < -90)) continue;
      const kind = rnd();
      const n = kind < 0.15 ? 0 : 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) {
        const long = rnd() < 0.6;
        const w = long ? 50 + rnd() * 50 : 14 + rnd() * 14, l = long ? 12 + rnd() * 3 : 14 + rnd() * 10;
        const floors = d < 600 ? (rnd() < 0.25 ? 9 : 4 + Math.floor(rnd() * 2)) : 4 + Math.floor(rnd() * 3);
        const u = u0 + (rnd() - 0.5) * (Q - 60), v = v0 + (rnd() - 0.5) * (Q - 50);
        const p = site(u, v);
        if ((p.x > -215 && p.x < 190 && p.z > -145 && p.z < 120) || (p.x > 0 && p.x < 250 && p.z > -235 && p.z < -90)) continue;
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
    im.setColorAt(i, col.setHSL(0.09 + rnd() * 0.04, 0.1 + rnd() * 0.12, 0.8 + rnd() * 0.1));
  });
  im.castShadow = false;
  im.receiveShadow = true;
  im.name = 'city';
  scene.add(im);
  return { mat, trees };
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

  scene.fog = new THREE.FogExp2(HAZE.getHex(), 0.00028);
  scene.background = new THREE.Color(0xb9cde0);
  scene.backgroundIntensity = SKY_INTENSITY;
  scene.environmentIntensity = SKY_INTENSITY;

  const sun = new THREE.DirectionalLight(0xfff1df, SUN_INTENSITY);
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
    new THREE.MeshStandardMaterial({ color: 0x7d8656, roughness: 1 }),
  );
  plain.position.y = -0.12;
  plain.receiveShadow = false;
  scene.add(plain);
  const { mat: cityMat, trees: cityTrees } = city(scene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const hdr = new RGBELoader();
  const sky = (res) => hdr.loadAsync(`${ENV}sky_${res}.hdr`).then((t) => ((t.mapping = THREE.EquirectangularReflectionMapping), t));
  const ready = after
    .then(() => sky('1k'))
    .then((t) => {
      scene.background = t;
      scene.environment = pmrem.fromEquirectangular(t).texture;
      fill.removeFromParent();
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

  return { sun, cityMat, ready: Promise.all([ready, props]) };
}
