// The time of day. The site is lit for a summer afternoon (src/world.js: the sun from the south-
// south-west at 15:00); the slider moves the sun along its day over Dushanbe and on into dusk and
// night. As it sets the light turns warm and long; after it the sky becomes a dome of deepening blue
// with stars and the moon, moonlight takes the sun's place, and the windows (src/materials.js,
// NIGHT), the shops, the lamps along the paths and streets, the pitch's floodlights and the city
// round about light up.
//   lamps: the build's lamp heads (model/complex.json lamps: [x, y, z, aim x, aim y, kind], site
//   metres; kind 0 a path lamp, 1 a street lamp on its arm, 2 a floodlight aimed at the pitch)
import * as THREE from 'three';
import { NIGHT } from './materials.js';

export const DAY = 15; // the hour the scene was lit for: the slider starts here
export const FIRST = 6, LAST = 23.5; // the slider's hours
const RISE = 5.5, SET = 19.75; // sunrise and sunset of a summer day
const DEG = Math.PI / 180;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// a soft round spot (light pools on the ground, the glow round a lamp head)
function spot(inner = 0) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  if (inner) r.addColorStop(inner, 'rgba(255,255,255,0.55)');
  r.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// the sky at dusk and at night: drawn first, over the day's sky as it fades and under everything
// else (no depth: what is drawn after covers it)
const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const DOME_FRAG = /* glsl */ `
  uniform vec3 uSun, uMoon, uFog;
  uniform float uNight, uDusk, uOpacity;
  varying vec3 vDir;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float toSun = max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-5)), 0.0);
    // dusk: deep blue above, warm at the horizon towards the sun, mauve away from it
    vec3 duskTop = vec3(0.16, 0.26, 0.52), duskLow = mix(vec3(0.5, 0.38, 0.52), vec3(1.1, 0.5, 0.2), pow(toSun, 3.0));
    vec3 dusk = mix(duskLow, duskTop, smoothstep(0.0, 0.45, h));
    // the glow where the sun went down; as bright as the day's sky at first (it is drawn over it,
    // in the same light units), dimming into the blue hour
    dusk += vec3(1.2, 0.5, 0.12) * pow(toSun, 8.0) * exp(-max(h, 0.0) * 7.0);
    dusk *= mix(1.0, 0.22, smoothstep(0.0, 0.7, uNight));
    // night: near black above, the city's glow low on the horizon
    vec3 nightTop = vec3(0.008, 0.012, 0.03), nightLow = vec3(0.07, 0.075, 0.11);
    vec3 night = mix(nightLow, nightTop, smoothstep(0.0, 0.35, h));
    night += vec3(0.16, 0.1, 0.06) * exp(-max(h, 0.0) * 26.0) * 0.5;
    vec3 col = mix(dusk, night, smoothstep(0.3, 1.0, uNight));
    // the moon, a soft halo round it
    float m = dot(d, uMoon);
    col += vec3(0.95, 0.93, 0.85) * smoothstep(0.99985, 0.99992, m) * uNight * 1.6;
    col += vec3(0.25, 0.3, 0.42) * pow(max(m, 0.0), 220.0) * uNight * 0.6;
    // below the horizon: the haze
    col = mix(uFog, col, smoothstep(-0.04, 0.02, h));
    gl_FragColor = vec4(col, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function timeOfDay({ scene, camera, renderer, world, lamps = [], toScene, cityLights = [], changed = () => {} }) {
  const sun = world.sun;
  const base = {
    dir: sun.position.clone().sub(sun.target.position).normalize(),
    sunI: sun.intensity,
    sunC: sun.color.clone(),
    env: scene.environmentIntensity,
    bg: scene.backgroundIntensity,
    fog: null,
    fogD: scene.fog.density,
    glass: new Map(), // glass material -> its own reflection strength
    glow: new Map(), // lamp heads' emissive material -> its daytime strength
  };
  const A0 = Math.atan2(base.dir.x, -base.dir.z), el0 = Math.asin(base.dir.y);
  const sinMax = Math.min(1, Math.sin(el0) / Math.sin((Math.PI * (DAY - RISE)) / (SET - RISE)));
  const sunAt = (t) => {
    const el = Math.asin(sinMax * Math.sin((Math.PI * (t - RISE)) / (SET - RISE)));
    const A = A0 + (t - DAY) * 15 * DEG;
    return { el, A };
  };
  const dirOf = (A, el) => new THREE.Vector3(Math.sin(A) * Math.cos(el), Math.sin(el), -Math.cos(A) * Math.cos(el));
  const moonDir = dirOf(160 * DEG, 38 * DEG);

  // ---------- the sky dome and the stars ----------
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: base.dir.clone() },
      uMoon: { value: moonDir.clone() },
      uFog: { value: new THREE.Color() },
      uNight: { value: 0 },
      uDusk: { value: 0 },
      uOpacity: { value: 0 },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    // with the opaque objects, first of them, blended over the background (custom blending:
    // three.js turns normal blending off for a material that is not transparent)
    transparent: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -100;

  // stars: a few thousand on the upper half of the sky, a handful bright
  const starGeo = (n, seed) => {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pos = [], col = [];
    while (pos.length < n * 3) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const y = Math.abs(u);
      if (y < 0.06) continue;
      pos.push(r * Math.cos(a) * 90, y * 90, r * Math.sin(a) * 90);
      const w = 0.55 + rnd() * 0.45, tint = rnd();
      col.push(w * (tint < 0.2 ? 0.8 : 1), w * (tint < 0.2 ? 0.88 : tint > 0.85 ? 0.9 : 1), w * (tint > 0.85 ? 0.75 : 1));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return g;
  };
  const dot = spot(0.25);
  const starMat = (size) => new THREE.PointsMaterial({ size, map: dot, vertexColors: true, sizeAttenuation: false, transparent: false, depthTest: false, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, opacity: 0 });
  const dpr = renderer.getPixelRatio();
  const stars = [new THREE.Points(starGeo(2200, 11), starMat(2.6 * dpr)), new THREE.Points(starGeo(140, 29), starMat(4.6 * dpr))];
  for (const s of stars) {
    s.frustumCulled = false;
    s.renderOrder = -99;
  }
  const sky = new THREE.Group();
  sky.add(dome, ...stars);
  sky.visible = false;
  // the sky goes with the camera (inside its far plane, behind everything)
  dome.onBeforeRender = (r, s, cam) => {
    sky.position.copy(cam.position);
    sky.updateMatrixWorld();
  };
  scene.add(sky);

  // moonlit sky's light (the day's sky light comes from the environment map, dimmed at night): the
  // world's fill light, dark by day once the sky is in
  const moonSky = world.fill, dayFill = moonSky.intensity; // (still lit if the sky failed to load)
  moonSky.color.set(0x6074a8);
  moonSky.groundColor.set(0x24262c);

  // ---------- lamps: the glow round each head and the pool of light on the ground under it ----------
  const lampsGroup = new THREE.Group();
  lampsGroup.visible = false;
  scene.add(lampsGroup);
  const warm = new THREE.Color(0xffcf94), cool = new THREE.Color(0xf4f1ff);
  const poolMat = new THREE.MeshBasicMaterial({ map: spot(), color: warm, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4 });
  const floodMat = poolMat.clone();
  floodMat.color = cool.clone();
  const glowMat = new THREE.PointsMaterial({ map: spot(0.18), color: 0xffe0b0, size: 1.7, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0 });
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const pools = lamps.filter((l) => l[5] !== 2);
  if (pools.length) {
    const im = new THREE.InstancedMesh(plane, poolMat, pools.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    pools.forEach(([x, y, z, , , kind], i) => {
      const c = toScene(x, y), r = kind === 1 ? 15 : 9;
      im.setMatrixAt(i, m4.compose(p.set(c.x, 0.17, c.z), q, s.set(r, 1, r)));
    });
    im.frustumCulled = false;
    im.renderOrder = 2;
    lampsGroup.add(im);
  }
  // the pitch under its floodlights: one long pool from the masts' aim, a little wider than it
  const floods = lamps.filter((l) => l[5] === 2);
  if (floods.length) {
    const xs = floods.map((l) => toScene(l[0], l[1])), aim = toScene(floods[0][3], floods[0][4]);
    const span = Math.max(...xs.map((c) => Math.hypot(c.x - aim.x, c.z - aim.z)));
    const far = xs.reduce((a, c) => (Math.hypot(c.x - aim.x, c.z - aim.z) > Math.hypot(a.x - aim.x, a.z - aim.z) ? c : a));
    const ang = Math.atan2(far.z - aim.z, far.x - aim.x);
    const pool = new THREE.Mesh(plane, floodMat);
    pool.position.set(aim.x, 0.2, aim.z);
    pool.scale.set(span * 2.2, 1, span * 2.2);
    pool.rotation.y = -ang;
    pool.renderOrder = 2;
    lampsGroup.add(pool);
  }
  const heads = new THREE.BufferGeometry();
  heads.setAttribute('position', new THREE.Float32BufferAttribute(lamps.flatMap(([x, y, z]) => {
    const c = toScene(x, y);
    return [c.x, z, c.z];
  }), 3));
  const glows = new THREE.Points(heads, glowMat);
  glows.frustumCulled = false;
  glows.renderOrder = 3;
  lampsGroup.add(glows);

  // the city's street lights, and the plain beyond lit with towns out to the haze
  const cityMat = new THREE.PointsMaterial({ map: dot, color: 0xffb862, size: 3 * dpr, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, opacity: 0 });
  const farLights = [];
  {
    let s = 977;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 7000; i++) {
      const r = 1500 + Math.pow(rnd(), 0.7) * 7000, a = rnd() * Math.PI * 2;
      // clustered: towns along a few directions, not an even sprinkle
      if (Math.sin(a * 5 + 1.3) + Math.sin(a * 11 + 0.4) * 0.6 < -0.4 && rnd() < 0.8) continue;
      farLights.push(Math.cos(a) * r, 2 + rnd() * 6, Math.sin(a) * r);
    }
  }
  const cityPts = new THREE.BufferGeometry();
  cityPts.setAttribute('position', new THREE.Float32BufferAttribute([...cityLights.flatMap((c) => [c.x, c.y, c.z]), ...farLights], 3));
  const city = new THREE.Points(cityPts, cityMat);
  city.frustumCulled = false;
  lampsGroup.add(city);

  // ---------- applying an hour ----------
  let hours = DAY, indoors = false;
  const state = { hours, night: 0, lights: 0, dir: base.dir.clone(), env: base.env };
  const sunWarm = new THREE.Color(0xffa565), moonC = new THREE.Color(0xb4c4ff);
  const duskFog = new THREE.Color(0xd9a588), blueFog = new THREE.Color(0x3a3a52), nightFog = new THREE.Color(0x0b0f19);

  function collect() {
    // the glass (it reflects the real sky through its own map) and the lamp heads, as loaded
    scene.traverse((o) => {
      for (const m of [o.material].flat()) {
        if (!m) continue;
        if (m.userData?.glass && !base.glass.has(m)) base.glass.set(m, m.envMapIntensity);
        if ((m.name === 'Lamp glow') && !base.glow.has(m)) base.glow.set(m, m.emissiveIntensity);
      }
    });
  }

  function apply() {
    base.fog ??= scene.fog.color.clone();
    const { el, A } = sunAt(hours);
    const e = el / DEG;
    const n = smooth(1, -12, e); // the sky's darkness: civil and nautical twilight, about an hour
    const g = smooth(20, 4, e) * (1 - n); // the warm low sun
    const L = smooth(5, -4, e); // lights on
    state.night = n;
    state.lights = L;
    state.hours = hours;

    // the sun while it is up (no lower than 4 degrees for the shadows' sake), then the moon
    const sunI = base.sunI * smooth(-1, 4, e) * (1 - 0.35 * g);
    const up = sunI > 1e-3;
    state.dir = up ? dirOf(A, Math.max(el, 4 * DEG)) : moonDir.clone();
    const dist = sun.position.distanceTo(sun.target.position) || 600;
    sun.position.copy(sun.target.position).addScaledVector(state.dir, dist);
    sun.intensity = up ? sunI : 0.32 * n;
    sun.color.copy(up ? base.sunC.clone().lerp(sunWarm, g * 0.8) : moonC);

    state.env = base.env * (1 - 0.95 * n) * (1 - 0.4 * g);
    if (!indoors) scene.environmentIntensity = state.env;
    scene.backgroundIntensity = base.bg * (1 - 0.85 * n) * (1 - 0.45 * g);
    moonSky.intensity = dayFill * (1 - n) + 0.42 * n;
    for (const [m, v] of base.glass) m.envMapIntensity = v * (1 - 0.9 * n) * (1 - 0.3 * g);
    for (const [m, v] of base.glow) m.emissiveIntensity = mix(v, Math.max(v, 1) * 5, L);

    // the haze: warm at sunset, the blue hour's violet, then the night's
    scene.fog.color.copy(base.fog).lerp(duskFog, g * 0.35).lerp(blueFog, smooth(0, 0.45, n)).lerp(nightFog, smooth(0.4, 1, n));
    scene.fog.density = base.fogD * (1 - 0.5 * n);

    NIGHT.value = L;
    domeMat.uniforms.uSun.value.copy(dirOf(A, el));
    domeMat.uniforms.uNight.value = n;
    domeMat.uniforms.uDusk.value = g;
    domeMat.uniforms.uFog.value.copy(scene.fog.color);
    domeMat.uniforms.uOpacity.value = Math.min(1, Math.max(n * 1.6, 0.7 * g));
    sky.visible = n > 0 || g > 0;
    for (const s of stars) s.material.opacity = smooth(0.45, 1, n);
    lampsGroup.visible = L > 0;
    poolMat.opacity = 0.36 * L;
    floodMat.opacity = 0.34 * L;
    glowMat.opacity = 0.75 * L;
    cityMat.opacity = 0.85 * L;
    changed(state);
  }

  collect();
  return {
    state,
    get hours() {
      return hours;
    },
    set(h) {
      hours = Math.min(LAST, Math.max(FIRST, h));
      apply();
    },
    // inside a flat the sky's light is the room's (main.js lightInterior); the hour still counts
    indoors(on) {
      indoors = on;
    },
    // the glass and lamps of a model part loaded later (the floors' interiors)
    refresh() {
      collect();
      apply();
    },
  };
}

// "15:00"
export const clock = (h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
