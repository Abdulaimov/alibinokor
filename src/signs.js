// Shop signs over the shop windows: a layer laid over the model, so the tenants' names and logos
// change without rebuilding the scene. public/signs/signs.json says which artwork goes over which
// shop (?signs=neutral picks another set); the build gives the places (model/complex.json shops: the
// street faces' portals with the dark frieze over them, model/build blender/ab/podium.py). Each sign
// is the artwork's letters standing 7 cm off the frieze, centred over its portals, white metal by
// day, lit at night (src/night.js reads userData.nightGlow).
import * as THREE from 'three';

const BASE = `${import.meta.env.BASE_URL}signs/`;

export async function addSigns(scene, shops, toScene, setName = null) {
  const conf = await fetch(`${BASE}signs.json`).then((r) => r.json());
  const list = conf.sets[setName ?? conf.set] ?? conf.sets[conf.set];
  const loader = new THREE.TextureLoader();
  const group = new THREE.Group();
  group.name = 'signs';
  const textures = new Map();
  await Promise.all(list.map(async (s) => {
    const bays = shops.filter((b) => b[0] === s.block && b[1] === s.face).sort((a, b) => a[2] - b[2]);
    const first = bays[s.bay], last = bays[s.bay + (s.span ?? 1) - 1];
    if (!first || !last) {
      console.warn('sign: no such shop', s);
      return;
    }
    if (!textures.has(s.file)) {
      textures.set(s.file, loader.loadAsync(BASE + s.file).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        return t;
      }));
    }
    const tex = await textures.get(s.file);
    // as tall as asked, no wider than its portals (less 0.3 m), never stretched
    const span = Math.hypot(last[5] - first[3], last[6] - first[4]) - 0.3;
    let h = s.height, w = (h * tex.image.width) / tex.image.height;
    if (w > span) (h *= span / w), (w = span);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, alphaTest: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25, roughness: 0.45, metalness: 0.2,
    });
    mat.userData.nightGlow = [0.25, 2.4];
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    const [nx, ny] = [first[9], first[10]];
    const p = toScene((first[3] + last[5]) / 2 + nx * 0.07, (first[4] + last[6]) / 2 + ny * 0.07);
    mesh.position.set(p.x, (first[7] + first[8]) / 2, p.z);
    mesh.rotation.y = Math.atan2(nx, -ny); // the plane's face (+z) to the street (site n -> scene (nx, -ny))
    mesh.name = `sign ${s.file}`;
    group.add(mesh);
  }));
  scene.add(group);
  return group;
}
