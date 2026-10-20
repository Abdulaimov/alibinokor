import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LETTER, PLACES, RESIDENTIAL, TOWERS, toScene, towerByKey } from './config.js';
import { apartments, aptsOnFloor, summaryOf } from './data.js';
import { buildWorld } from './world.js';
import { OUTLINE, loadComplex } from './building.js';
import { buildFloor } from './floor.js';
import { WalkControls } from './walk.js';
import { drawPlan, planTransform } from './plan.js';
import { Q, setQuality } from './quality.js';
import { createRenderer, createPipeline } from './render.js';
import { setupMaterial, water } from './materials.js';
import { updateCars } from './props.js';
import { L, getLang, num, setLang } from './i18n.js';

const $ = (s) => document.querySelector(s);
const ACCENT = 0xc8955a;

// ---------- static wording ----------
function applyStatic() {
  document.querySelectorAll('[data-t]').forEach((el) => {
    const v = L()[el.dataset.t];
    if (typeof v === 'string') el.textContent = v;
  });
  document.querySelectorAll('.lang button').forEach((b) => b.classList.toggle('on', b.dataset.lang === getLang()));
  $('#walk-help').innerHTML = L().walkHelp;
  const q = $('#quality');
  q.textContent = L().quality(Q.level === 'high');
  q.title = L().qualityTitle(Q.level === 'high');
  document.title = `${L().brand} — 3D`;
}
applyStatic();
document.querySelector('.lang').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-lang]');
  if (!b || b.dataset.lang === getLang()) return;
  setLang(b.dataset.lang);
  applyStatic();
  buildPlaces();
  buildLabels();
  refresh();
  if (state.mode === 'walk' && walkInterior) setWalkTitle(walkInterior.apt);
});

// ---------- renderer / scene ----------
let renderer;
try {
  renderer = createRenderer();
} catch (err) {
  console.error(err);
  document.body.classList.add('no-webgl');
  $('#loading').hidden = true;
  $('#nogl').hidden = false;
  throw err;
}
$('#stage').appendChild(renderer.domElement);
const canvas = renderer.domElement;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  $('#nogl').hidden = false;
  $('#nogl .why').textContent = L().contextLost;
});

const scene = new THREE.Scene();
// the scene stands still: the sun's shadow map is redrawn only when something changes
renderer.shadowMap.autoUpdate = false;
let shadowFrames = 2;
const shadowsDirty = () => (shadowFrames = 2);
THREE.DefaultLoadingManager.onProgress = shadowsDirty;

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 30000);
// Start view: the whole complex from the south-west, over the street, the mountains behind it.
const HOME_WIDE = { pos: new THREE.Vector3(-150, 165, 285), target: new THREE.Vector3(5, 22, -5) };
// portrait: the panel covers the lower half, so the camera aims below the complex (it shows higher up)
const HOME_TALL = { pos: new THREE.Vector3(-420, 520, 700), target: new THREE.Vector3(-10, -60, 90) };
const home = () => (innerWidth < innerHeight ? HOME_TALL : HOME_WIDE);
camera.position.copy(home().pos);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(home().target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 12;
controls.maxDistance = 900;
controls.maxPolarAngle = Math.PI * 0.48;
controls.autoRotate = false;
controls.autoRotateSpeed = 0.3;

let building = null;
const loadingEl = $('#loading');
const modelLoad = loadComplex(apartments, renderer, (k) => (loadingEl.querySelector('b').textContent = `${Math.round(k * 100)}%`));
const world = buildWorld(scene, renderer, modelLoad.then(() => {}, () => {}));
const pipeline = createPipeline(renderer, scene, camera);
const walk = new WalkControls(camera, canvas);

// invisible prisms over every block, for hovering / clicking a whole block
const blockPicks = [];
for (const t of TOWERS) {
  const shape = new THREE.Shape(t.outline.map(([x, y]) => {
    const w = toScene(x, y);
    return new THREE.Vector2(w.x, -w.z);
  }));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t.top + 4, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ visible: false }));
  m.userData.block = t.key;
  scene.add(m);
  blockPicks.push(m);
}

modelLoad
  .then((b) => {
    building = b;
    scene.add(b.group);
    setupMaterial(world.cityMat, renderer);
    shadowsDirty();
    loadingEl.hidden = true;
    refresh();
  })
  .catch((err) => {
    console.error(err);
    loadingEl.textContent = L().loadFailed;
  });

$('#quality').onclick = () => setQuality(Q.level === 'high' ? 'low' : 'high');

// ---------- state ----------
const state = {
  mode: 'overview', // overview | block | floor | walk
  tower: null,
  floor: null,
  apt: null,
  hoverApt: null,
  hoverFloor: null, // { tower, floor }
  filter: { rooms: 0 },
};
let dollhouse = [];
let walkInterior = null;
let lastInteraction = performance.now();

const isOpen = (a) => a.tower === state.tower && a.floor === state.floor;
const filterActive = () => state.filter.rooms > 0;
const matches = (a) => !state.filter.rooms || a.rooms === state.filter.rooms || (state.filter.rooms === 4 && a.rooms >= 4);
const towerApts = (k) => apartments.filter((a) => a.tower === k);
const sameFloor = (a, b) => !!a && !!b && a.tower === b.tower && a.floor === b.floor;

// ---------- camera flights ----------
let tween = null;
function flyTo(pos, target, dur = 1.2) {
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), t: 0, dur };
  controls.enabled = false;
}
function azimuth() {
  return Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
}
function towerCentre(k) {
  const t = towerByKey[k];
  const w = toScene(t.centre[0], t.centre[1]);
  return new THREE.Vector3(w.x, 0, w.z);
}
function blockView(k) {
  const t = towerByKey[k];
  const c = towerCentre(k);
  const target = c.clone().setY(t.top * 0.45);
  // from the side of the camera now, far enough to see the whole block
  const az = Math.atan2(camera.position.x - c.x, camera.position.z - c.z);
  const d = t.top * 1.55 + 40;
  return { pos: target.clone().add(new THREE.Vector3(Math.sin(az) * d, t.top * 0.35, Math.cos(az) * d)), target };
}
function floorCentre(tower, floor) {
  const list = aptsOnFloor(tower, floor);
  const c = new THREE.Vector3();
  for (const a of list) c.add(building.units.get(a.id).center);
  return c.divideScalar(list.length);
}
function floorView(tower, floor) {
  // far enough for the whole floor to fit between the side panels (slab blocks 64 m, tower A 45 m)
  const target = floorCentre(tower, floor);
  const az = azimuth();
  const size = tower === 'A' ? 46 : 66;
  const d = size * (innerWidth < innerHeight ? 2.6 : 1.75);
  return { pos: target.clone().add(new THREE.Vector3(Math.sin(az) * d * 0.55, d * 0.85, Math.cos(az) * d * 0.55)), target };
}
function aptView(apt) {
  const c = building.units.get(apt.id).center;
  const target = new THREE.Vector3(c.x, c.y + 0.5, c.z);
  const tc = towerCentre(apt.tower);
  const dir = new THREE.Vector3(c.x - tc.x, 0, c.z - tc.z).normalize();
  // steeply from above the opened floor (the neighbouring block can stand 25 m away)
  const tall = innerWidth < innerHeight;
  const pos = target.clone().add(dir.multiplyScalar(tall ? 14 : 15)).add(new THREE.Vector3(0, tall ? 52 : 34, 0));
  // on a portrait screen the panel covers the lower half: aim below the flat so it shows higher up
  return { pos, target: tall ? target.clone().addScaledVector(dir.normalize(), 12) : target };
}

// ---------- overlays on the building ----------
function updateOverlays() {
  if (!building) return;
  for (const a of apartments) {
    const u = building.units.get(a.id);
    if (!u) continue;
    let show = false, color = 0xffffff, op = 0, edges = null;
    const hoverFloor = sameFloor(state.hoverFloor, a);
    if (state.mode === 'overview' || state.mode === 'block') {
      if (hoverFloor) {
        // the floor under the pointer: amber (it shows on the brick and on the white top floors
        // alike), with a white outline round every flat
        show = true; op = 0.62; edges = OUTLINE.floor; color = 0xffa42b;
      } else if (filterActive() && matches(a) && (state.mode === 'overview' || a.tower === state.tower)) {
        show = true; color = ACCENT; op = 0.55;
      }
    } else if (state.mode === 'floor') {
      if (isOpen(a)) {
        // the flats of the open floor: a light outline each; the one under the pointer (or chosen)
        // lit up in amber with a thick outline drawn over the walls and furniture
        const lit = a === state.apt || a === state.hoverApt;
        show = true; color = lit ? 0xffa42b : ACCENT;
        edges = a === state.apt ? OUTLINE.chosen : a === state.hoverApt ? OUTLINE.hover : OUTLINE.open;
        op = a === state.apt ? 0.48 : a === state.hoverApt ? 0.44 : 0.06;
        if (filterActive() && !matches(a)) [op, edges] = [0.0, null];
      } else if (hoverFloor) {
        show = true; op = 0.35;
      }
    }
    u.overlay.visible = show;
    u.overlay.material.color.setHex(color);
    u.overlay.material.opacity = op;
    // a floor seen from outside: the outline of every flat's volume; the open floor: each flat's
    // outline on the floor plan
    const line = state.mode === 'floor' ? u.ring : u.edges;
    (line === u.ring ? u.edges : u.ring).visible = false;
    line.visible = show && !!edges;
    if (edges) line.material = edges;
    line.renderOrder = edges === OUTLINE.hover || edges === OUTLINE.chosen ? 12 : 11;
  }
}

// ---------- tags over the apartments of the open floor ----------
const labelsEl = $('#labels');
let labels = [];
function sidesText(a) {
  return a.sides.map((s) => L().sides[s]).join(', ');
}
function buildLabels() {
  labelsEl.innerHTML = '';
  labels = [];
  if (state.mode !== 'floor') return;
  for (const a of aptsOnFloor(state.tower, state.floor)) {
    const el = document.createElement('div');
    el.className = 'tag';
    el.innerHTML = `<b>№ ${a.number}</b> <span>· ${L().roomsShort(a.rooms)} · ${num(a.area)} ${L().m2}</span>`;
    el.onclick = () => selectApt(a);
    el.onpointerenter = () => setHover(a);
    el.onpointerleave = () => setHover(null);
    labelsEl.appendChild(el);
    labels.push({ el, apt: a });
  }
}
const tmp = new THREE.Vector3();
function project(v) {
  tmp.copy(v).project(camera);
  return { x: ((tmp.x + 1) / 2) * innerWidth, y: ((1 - tmp.y) / 2) * innerHeight, behind: tmp.z > 1 };
}
function updateLabels() {
  for (const { el, apt } of labels) {
    const u = building.units.get(apt.id);
    const tc = towerCentre(apt.tower);
    const dx = u.center.x - tc.x, dz = u.center.z - tc.z, d = Math.hypot(dx, dz) || 1;
    const p = project(new THREE.Vector3(u.center.x + (dx / d) * 7, u.top + 0.6, u.center.z + (dz / d) * 7));
    const hidden = p.behind || (filterActive() && !matches(apt));
    el.style.display = hidden ? 'none' : '';
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.classList.toggle('hover', apt === state.hoverApt);
  }
}

// ---------- block letters and the places around ----------
const placesEl = $('#places');
let places = [];
function buildPlaces() {
  placesEl.innerHTML = '';
  places = [];
  for (const p of PLACES) {
    const el = document.createElement('div');
    const w = toScene(p.x, p.y);
    const pos = new THREE.Vector3(w.x, p.z, w.z);
    if (p.kind === 'block') {
      const t = towerByKey[p.key];
      el.className = `block-tag ${t.sales ? 'sales' : 'neighbour'}`;
      el.innerHTML = `<b>${LETTER[p.key]}</b>`;
      el.title = L().block(LETTER[p.key]);
      el.onclick = () => (t.sales ? selectBlock(p.key) : toast(L().neighbourBlock));
    } else {
      el.className = `place-tag ${p.kind}`;
      el.innerHTML = `<i></i><span>${L().places[p.kind] ?? (getLang() === 'tj' ? p.tj : p.ru)}</span>`;
      el.onclick = () => flyToPlace(pos);
    }
    placesEl.appendChild(el);
    places.push({ el, pos, p });
  }
}
// a place behind a block (seen through it) is shown faint; checked a few times a second
const occRay = new THREE.Raycaster();
let occAt = 0;
function updatePlaces() {
  const show = state.mode === 'overview' || state.mode === 'block';
  placesEl.style.display = show ? '' : 'none';
  if (!show) return;
  const now = performance.now(), checkOcc = now - occAt > 200;
  if (checkOcc) occAt = now;
  for (const it of places) {
    const { el, pos, p } = it;
    const q = project(pos);
    const hideBlock = p.kind === 'block' && state.mode === 'block' && p.key === state.tower;
    el.style.display = q.behind || hideBlock ? 'none' : '';
    el.style.left = `${q.x}px`;
    el.style.top = `${q.y}px`;
    if (checkOcc && p.kind !== 'block') {
      const d = pos.clone().sub(camera.position), L = d.length();
      occRay.set(camera.position, d.normalize());
      occRay.far = L - 2;
      it.hidden = occRay.intersectObjects(blockPicks, false).length > 0;
      el.classList.toggle('behind', it.hidden);
    }
  }
}
function flyToPlace(pos) {
  const az = azimuth();
  const target = pos.clone().setY(8);
  flyTo(target.clone().add(new THREE.Vector3(Math.sin(az) * 110, 70, Math.cos(az) * 110)), target, 1.4);
}

// ---------- panels ----------
function renderFloors() {
  const T = L();
  let html = `<button class="overview-btn ${state.mode === 'overview' ? 'active' : ''}" data-act="overview">⌂ ${T.complex}</button>`;
  html += `<h3>${T.blocks}</h3><div class="block-tabs">`;
  for (const t of TOWERS) {
    const on = state.tower === t.key && state.mode !== 'overview';
    html += `<button class="block-tab ${on ? 'on' : ''} ${t.sales ? '' : 'off'}" data-block="${t.key}" title="${t.sales ? T.block(LETTER[t.key]) : T.neighbourBlock}">${LETTER[t.key]}</button>`;
  }
  html += '</div>';
  if (state.tower && state.mode !== 'overview') {
    const t = towerByKey[state.tower];
    html += `<h3>${T.floors}</h3>`;
    for (const { floor: f } of [...t.floors].reverse()) {
      const list = aptsOnFloor(t.key, f);
      const n = list.filter(matches).length;
      const active = state.mode === 'floor' && state.floor === f;
      const hover = state.hoverFloor && state.hoverFloor.tower === t.key && state.hoverFloor.floor === f;
      html += `<button class="floor-btn ${active ? 'active' : ''} ${hover ? 'hover' : ''} ${filterActive() && !n ? 'dim' : ''}" data-floor="${f}">
        <span class="num">${f}</span><span class="meta">${filterActive() ? `${n} / ` : ''}${T.flats(list.length)}</span></button>`;
    }
    html += `<button class="floor-btn lobby" disabled><span class="num">1–2</span><span class="meta">${T.shops}</span></button>`;
  } else {
    html += `<div class="block-list">`;
    for (const t of RESIDENTIAL) {
      const list = towerApts(t.key);
      html += `<button class="block-row" data-block="${t.key}"><b>${LETTER[t.key]}</b><span>${T.floorsN(t.levels)}<br>${T.flats(list.length)}</span></button>`;
    }
    html += `</div>`;
  }
  $('#floors').innerHTML = html;
}
$('#floors').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'overview') goOverview();
  else if (b.dataset.block) {
    const t = towerByKey[b.dataset.block];
    if (t.sales) selectBlock(t.key);
    else toast(L().neighbourBlock);
  } else if (b.dataset.floor) selectFloor(state.tower, +b.dataset.floor);
});
$('#floors').addEventListener('pointerover', (e) => {
  const b = e.target.closest('[data-floor]');
  const hf = b ? { tower: state.tower, floor: +b.dataset.floor } : null;
  if (JSON.stringify(hf) !== JSON.stringify(state.hoverFloor)) {
    state.hoverFloor = hf;
    updateOverlays();
  }
});
$('#floors').addEventListener('pointerleave', () => {
  state.hoverFloor = null;
  updateOverlays();
});

function roomFilter(list) {
  const T = L();
  const rooms = [...new Set(list.map((a) => Math.min(a.rooms, 4)))].sort();
  return `<div class="label">${T.rooms}</div><div class="seg" data-filter="rooms">
    ${[0, ...rooms].map((r) => `<button data-v="${r}" class="${state.filter.rooms === r ? 'on' : ''}">${r ? T.roomsShort(r) : T.all}</button>`).join('')}
  </div>`;
}

function renderSide() {
  const side = $('#side');
  const T = L();
  if (state.mode === 'overview') {
    const areas = apartments.map((a) => a.area);
    side.innerHTML = `
      <h2>${T.chooseTitle}</h2>
      <div class="sub">${T.chooseSub}</div>
      <div class="stats">
        <div class="stat"><b>${apartments.length}</b><span>${T.stat1}</span></div>
        <div class="stat"><b>${num(Math.round(Math.min(...areas)))}–${num(Math.round(Math.max(...areas)))}</b><span>${T.stat2}</span></div>
        <div class="stat"><b>${Math.min(...RESIDENTIAL.map((t) => t.levels))}–${Math.max(...RESIDENTIAL.map((t) => t.levels))}</b><span>${T.stat3}</span></div>
      </div>
      ${roomFilter(apartments)}
      <div class="note">${T.chooseNote}</div>
      <div class="label">${T.nearby}</div>
      <div class="near">
        ${PLACES.filter((p) => p.kind !== 'block').map((p, i) => `<button class="near-btn ${p.kind}" data-place="${i}"><i></i>${T.places[p.kind]}</button>`).join('')}
      </div>`;
  } else if (state.mode === 'block') {
    const t = towerByKey[state.tower];
    const list = towerApts(t.key);
    const areas = list.map((a) => a.area);
    side.innerHTML = `
      <button class="back" data-act="overview">${T.backTo(T.complex)}</button>
      <h2>${T.block(LETTER[t.key])}</h2>
      <div class="sub">${T.blockSub(T.floorsN(t.levels), T.flats(list.length))} · ${T.shopsFloors}</div>
      <div class="stats">
        <div class="stat"><b>${list.length}</b><span>${T.stat1}</span></div>
        <div class="stat"><b>${num(Math.round(Math.min(...areas)))}–${num(Math.round(Math.max(...areas)))}</b><span>${T.stat2}</span></div>
        <div class="stat"><b>${t.levels}</b><span>${T.stat3}</span></div>
      </div>
      ${roomFilter(list)}
      <div class="note">${T.blockNote}</div>`;
  } else if (state.mode === 'floor' && !state.apt) {
    const list = aptsOnFloor(state.tower, state.floor);
    side.innerHTML = `
      <button class="back" data-act="block">${T.backTo(T.block(LETTER[state.tower]))}</button>
      <h2>${T.block(LETTER[state.tower])} · ${T.floorN(state.floor)}</h2>
      <div class="sub">${T.flatsOnFloor(list.length)}</div>
      ${roomFilter(list)}
      <div class="apt-list">
        ${[...list].sort((a, b) => a.number - b.number).map((a) => `
          <button class="apt-row ${filterActive() && !matches(a) ? 'muted' : ''}" data-apt="${a.id}">
            <span class="t">№ ${a.number}</span><span class="p">${num(a.area)} ${T.m2}</span>
            <span class="d">${T.roomsN(a.rooms)} · ${sidesText(a)}</span>
          </button>`).join('')}
      </div>
      <div class="note">${T.floorNote}</div>`;
  } else if (state.mode === 'floor' && state.apt) {
    const a = state.apt;
    side.innerHTML = `
      <button class="back" data-act="floor">${T.backTo(T.floorN(a.floor))}</button>
      <h2>${T.flat(a.number)}</h2>
      <div class="sub">${T.block(a.letter)} · ${T.roomsN(a.rooms)} · ${T.floorN(a.floor)}</div>
      <canvas class="plan"></canvas>
      <div class="area-big">${num(a.area)} <small>${T.m2}</small></div>
      <div class="specs">
        <div><span>${T.rooms}</span><b>${a.rooms}</b></div>
        <div><span>${T.floor}</span><b>${T.floorOf(a.floor, a.floors)}</b></div>
        <div><span>${T.ceiling}</span><b>${num(a.ceiling)} ${T.m}</b></div>
        <div><span>${T.windows}</span><b>${sidesText(a)}</b></div>
        <div style="grid-column: span 2"><span>${T.layout}</span><b>${summaryOf(a.data.rooms.concat(a.data.balconies))}</b></div>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="walk">${T.walk}</button>
        <button class="btn" data-act="request">${T.contact}</button>
      </div>`;
    drawPlan(side.querySelector('.plan'), a);
  }
}
$('#side').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'overview') goOverview();
  else if (b.dataset.act === 'block') selectBlock(state.tower);
  else if (b.dataset.act === 'floor') selectFloor(state.tower, state.floor);
  else if (b.dataset.act === 'walk') enterWalk(state.apt);
  else if (b.dataset.act === 'request') toast(L().contactToast);
  else if (b.dataset.apt) selectApt(apartments.find((a) => a.id === b.dataset.apt));
  else if (b.dataset.place !== undefined) {
    const p = PLACES.filter((q) => q.kind !== 'block')[+b.dataset.place];
    const w = toScene(p.x, p.y);
    flyToPlace(new THREE.Vector3(w.x, p.z, w.z));
  } else if (b.dataset.v !== undefined) {
    state.filter.rooms = +b.dataset.v;
    refresh();
  }
});
$('#side').addEventListener('pointerover', (e) => {
  const row = e.target.closest('[data-apt]');
  setHover(row ? apartments.find((a) => a.id === row.dataset.apt) : null);
});
$('#side').addEventListener('pointerleave', () => setHover(null));

function refresh() {
  renderFloors();
  renderSide();
  updateOverlays();
  const T = L();
  $('#hint').textContent = state.mode === 'overview' ? T.hintOverview : state.mode === 'block' ? T.hintBlock : T.hintFloor;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function setHover(a) {
  if (state.hoverApt === a) return;
  state.hoverApt = a;
  updateOverlays();
  document.querySelectorAll('.apt-row').forEach((r) => r.classList.toggle('hover', a && r.dataset.apt === a.id));
}

// ---------- navigation ----------
function clearDollhouse() {
  dollhouse.forEach((d) => d.dispose());
  dollhouse = [];
}

function goOverview() {
  shadowsDirty();
  clearDollhouse();
  building?.showAll();
  Object.assign(state, { mode: 'overview', tower: null, floor: null, apt: null, hoverApt: null, hoverFloor: null });
  buildLabels();
  flyTo(home().pos, home().target, 1.4);
  refresh();
}

function selectBlock(k) {
  shadowsDirty();
  clearDollhouse();
  building?.showAll();
  Object.assign(state, { mode: 'block', tower: k, floor: null, apt: null, hoverApt: null, hoverFloor: null });
  const v = blockView(k);
  flyTo(v.pos, v.target, 1.3);
  buildLabels();
  refresh();
}

function selectFloor(tower, floor) {
  shadowsDirty();
  if (!building) return;
  if (state.tower !== tower || state.floor !== floor || state.mode !== 'floor') {
    clearDollhouse();
    building.showUpTo(tower, floor);
    const d = buildFloor(tower, floor, aptsOnFloor(tower, floor));
    scene.add(d.group);
    dollhouse.push(d);
  }
  Object.assign(state, { mode: 'floor', tower, floor, apt: null, hoverFloor: null });
  const v = floorView(tower, floor);
  flyTo(v.pos, v.target);
  buildLabels();
  refresh();
}

function selectApt(a) {
  if (state.mode !== 'floor' || !isOpen(a)) selectFloor(a.tower, a.floor);
  state.apt = a;
  const v = aptView(a);
  flyTo(v.pos, v.target);
  refresh();
}

function fade(fn) {
  const f = $('#fade');
  f.classList.add('on');
  setTimeout(() => {
    fn();
    requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  }, 380);
}

function setWalkTitle(a) {
  const T = L();
  $('#walk-title').innerHTML = `<b>№ ${a.number}</b> · ${T.block(a.letter)} · ${T.roomsShort(a.rooms)} · ${num(a.area)} ${T.m2} · ${T.floorN(a.floor)}`;
}

function enterWalk(a) {
  shadowsDirty();
  fade(() => {
    clearDollhouse();
    labelsEl.innerHTML = '';
    labels = [];
    building.showAll(a.tower, a.floor);
    walkInterior = buildFloor(a.tower, a.floor, aptsOnFloor(a.tower, a.floor), a);
    scene.add(walkInterior.group);
    shadowsDirty();
    state.mode = 'walk';
    state.hoverApt = null;
    updateOverlays();
    tween = null;
    controls.enabled = false;
    camera.fov = 72;
    camera.near = 0.05;
    pipeline.walk(true);
    lightInterior(walkInterior);
    camera.updateProjectionMatrix();
    walk.start(walkInterior, scene);
    $('#ext-ui').hidden = true;
    $('#walk-ui').hidden = false;
    document.body.classList.add('walking');
    setWalkTitle(a);
    prepareMinimap(a);
  });
}

// Indoors: a studio-like environment instead of the sky, the sun's shadow pulled in round the flat.
let roomEnv = null, outdoor = null, bounce = null;
function lightInterior(interior) {
  const sun = world.sun, sc = sun.shadow.camera;
  if (interior) {
    roomEnv ??= new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    outdoor = {
      env: scene.environment, envI: scene.environmentIntensity,
      cam: [sc.left, sc.right, sc.top, sc.bottom, sc.near, sc.far], pos: sun.position.clone(), target: sun.target.position.clone(),
    };
    scene.environment = roomEnv;
    scene.environmentIntensity = 0.32;
    bounce ??= new THREE.HemisphereLight(0xfff3e4, 0xd9c3a5, 0.9);
    scene.add(bounce);
    const c = new THREE.Box3().setFromObject(interior.group).getCenter(new THREE.Vector3());
    const dir = sun.position.clone().sub(sun.target.position).normalize();
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(dir, 120);
    [sc.left, sc.right, sc.top, sc.bottom, sc.near, sc.far] = [-30, 30, 30, -30, 60, 200];
  } else if (outdoor) {
    bounce?.removeFromParent();
    scene.environment = outdoor.env;
    scene.environmentIntensity = outdoor.envI;
    [sc.left, sc.right, sc.top, sc.bottom, sc.near, sc.far] = outdoor.cam;
    sun.position.copy(outdoor.pos);
    sun.target.position.copy(outdoor.target);
    outdoor = null;
  }
  sun.target.updateMatrixWorld();
  sc.updateProjectionMatrix();
  shadowsDirty();
}

function exitWalk() {
  shadowsDirty();
  const a = walkInterior.apt;
  fade(() => {
    walk.stop();
    walkInterior.dispose();
    walkInterior = null;
    camera.fov = 38;
    camera.near = 1;
    pipeline.walk(false);
    lightInterior(null);
    camera.updateProjectionMatrix();
    controls.enabled = true;
    $('#ext-ui').hidden = false;
    $('#walk-ui').hidden = true;
    document.body.classList.remove('walking');
    state.mode = 'block';
    selectFloor(a.tower, a.floor);
    selectApt(a);
    const v = aptView(a);
    camera.position.copy(v.pos);
    controls.target.copy(v.target);
    tween = null;
    controls.enabled = true;
  });
}
$('#exit-walk').onclick = exitWalk;
addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (state.mode === 'walk') exitWalk();
    else if (state.mode === 'floor' && state.apt) selectFloor(state.tower, state.floor);
    else if (state.mode === 'floor') selectBlock(state.tower);
    else if (state.mode === 'block') goOverview();
  }
});

// ---------- mini-map ----------
const mini = $('#minimap canvas');
let miniBg = null, miniT = null;
function prepareMinimap(a) {
  const off = document.createElement('canvas');
  off.width = mini.clientWidth;
  off.height = mini.clientHeight;
  drawPlan(off, a, { pad: 6, labels: false });
  miniBg = off;
  miniT = planTransform(a, mini.clientWidth, mini.clientHeight, 6);
}
function drawMinimap() {
  if (!miniBg || !walk.enabled) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = mini.clientWidth, h = mini.clientHeight;
  if (mini.width !== Math.round(w * dpr)) {
    mini.width = Math.round(w * dpr);
    mini.height = Math.round(h * dpr);
  }
  const g = mini.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, mini.width, mini.height);
  g.drawImage(miniBg, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = walk.localState();
  const x = miniT.px(s.x), y = miniT.py(s.y);
  const ang = Math.atan2(-s.dy, s.dx);
  g.fillStyle = 'rgba(200, 149, 90, 0.3)';
  g.beginPath();
  g.moveTo(x, y);
  g.arc(x, y, 30, ang - 0.6, ang + 0.6);
  g.closePath();
  g.fill();
  g.fillStyle = '#9a6a3c';
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, 5, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}

// ---------- joystick (touch screens) ----------
const joy = $('#joystick'), knob = joy.querySelector('.knob');
let joyId = null;
const joyMove = (e) => {
  const r = joy.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2 - 10, d = Math.hypot(dx, dy);
  if (d > max) { dx *= max / d; dy *= max / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  walk.setJoystick(dx / max, dy / max);
};
joy.addEventListener('pointerdown', (e) => { joyId = e.pointerId; joy.setPointerCapture(joyId); joyMove(e); });
joy.addEventListener('pointermove', (e) => e.pointerId === joyId && joyMove(e));
const joyEnd = () => { joyId = null; knob.style.transform = ''; walk.setJoystick(0, 0); };
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);
addEventListener('pointerdown', (e) => {
  lastInteraction = performance.now();
  if (e.pointerType === 'touch') document.body.classList.add('touch');
});
addEventListener('wheel', () => (lastInteraction = performance.now()), { passive: true });

// ---------- picking ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tooltip = $('#tooltip');
// What is under the pointer: { apt } (a flat of a block for sale), { block } (a neighbour block), or null.
function pick(e) {
  if (!building) return null;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hidden = (o) => {
    const a = o.userData.apt;
    return state.mode === 'floor' && a && a.tower === state.tower && a.floor > state.floor;
  };
  const hits = ray.intersectObjects([...building.pickables.filter((o) => !hidden(o)), ...blockPicks], false);
  for (const h of hits) {
    const d = h.object.userData;
    if (d.apt) return d;
    if (d.block && !towerByKey[d.block].sales) return d;
  }
  return null;
}
let down = null;
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointermove', (e) => {
  if (state.mode === 'walk' || e.pointerType === 'touch') return;
  if (e.buttons) {
    tooltip.style.opacity = 0;
    return;
  }
  const hit = pick(e);
  const a = hit?.apt ?? null;
  const floorHover = a && (state.mode !== 'floor' || !isOpen(a)) ? { tower: a.tower, floor: a.floor } : null;
  const changed = JSON.stringify(floorHover) !== JSON.stringify(state.hoverFloor);
  state.hoverFloor = floorHover;
  if (changed) {
    renderFloors();
    updateOverlays();
  }
  setHover(a);
  canvas.style.cursor = a || hit?.block ? 'pointer' : '';
  const place = () => {
    tooltip.style.left = `${e.clientX + 16}px`;
    tooltip.style.top = `${e.clientY + 12}px`;
    tooltip.style.opacity = 1;
  };
  const T = L();
  if (a && (state.mode !== 'floor' || !isOpen(a))) {
    const list = aptsOnFloor(a.tower, a.floor);
    const n = filterActive() ? list.filter(matches).length : list.length;
    tooltip.innerHTML = T.tipFloor(a.letter, a.floor, T.flats(n));
    place();
  } else if (hit?.block) {
    tooltip.innerHTML = T.tipNeighbour(LETTER[hit.block]);
    place();
  } else tooltip.style.opacity = 0;
});
canvas.addEventListener('pointerleave', () => {
  tooltip.style.opacity = 0;
  if (state.mode !== 'walk') {
    setHover(null);
    state.hoverFloor = null;
    updateOverlays();
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (state.mode === 'walk' || !down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6;
  down = null;
  if (moved) return;
  const hit = pick(e);
  if (!hit) return;
  tooltip.style.opacity = 0;
  if (hit.block) {
    toast(L().neighbourBlock);
    return;
  }
  const a = hit.apt;
  if (state.mode === 'floor' && isOpen(a)) selectApt(a);
  else selectFloor(a.tower, a.floor);
});

// ---------- loop ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  pipeline.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
renderer.info.autoReset = false;
renderer.setAnimationLoop(() => {
  renderer.info.reset();
  const dt = Math.min(clock.getDelta(), 0.05);
  if (tween) {
    tween.t += dt;
    const k = ease(Math.min(1, tween.t / tween.dur));
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    controls.target.lerpVectors(tween.t0, tween.t1, k);
    if (k >= 1) {
      tween = null;
      controls.enabled = true;
    }
  }
  if (state.mode === 'walk') {
    walk.update(dt);
    drawMinimap();
  } else {
    controls.autoRotate = state.mode === 'overview' && performance.now() - lastInteraction > 25000;
    if (!tween) controls.update();
    else camera.lookAt(controls.target);
    if (building) updateLabels();
    updatePlaces();
  }
  for (const n of water) n.offset.x += dt * 0.006, n.offset.y += dt * 0.004;
  updateCars(camera);
  if (shadowFrames > 0) {
    renderer.shadowMap.needsUpdate = true;
    shadowFrames--;
  }
  pipeline.render(dt);
});

buildPlaces();
refresh();
const STILL = new URLSearchParams(location.search).has('still');
lastInteraction = STILL ? Infinity : performance.now();

// handles for the automated checks in tools/ (screenshots, picking and walk tests)
window.__app = {
  THREE, scene, camera, controls, renderer, state, walk, apartments, pipeline, world, quality: Q,
  get building() { return building; },
  get interior() { return walkInterior; },
  selectBlock, selectFloor, selectApt, enterWalk, exitWalk, goOverview,
  setView(pos, target) {
    tween = null;
    camera.position.set(...pos);
    controls.target.set(...target);
    controls.update();
  },
};
