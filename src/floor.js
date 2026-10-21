// One residential floor built from the architect's plan: room floors, walls and columns,
// windows and glazing, balconies, the furniture and sanitary ware where the drawing has them, and
// the lifts. Used for the cut-away floor view and, with a ceiling and lights, for the walk-through.
//
// The drawing gives walls, windows, room outlines, door swings, furniture, fittings and lift cars
// (tools/ab/extract_plan.py, tools/ab/furniture.py). Every room edge is probed from inside to find
// what is behind it (wall, window, glazing or nothing); a gap of door width between two rooms gets
// a door, its frame and the wall above it. The drawn furniture stands where it is drawn, turned as
// drawn; rooms the drawing leaves empty (halls, wardrobes) get a few pieces against solid walls,
// away from door swings and windows (src/interior/ has the models, materials and textures).
import * as THREE from 'three';
import { PLANS, planFrame, towerByKey } from './config.js';
import { distToPolygon, distToSegment, inside, innerRect, interiorPoint } from './geometry.js';
import { interiorMaterials } from './interior/materials.js';
import { Kit } from './interior/kit.js';
import * as F from './interior/furniture.js';
import { Q } from './quality.js';

const SILL = 0.85;
const HEAD = 0.35;
const DOOR_H = 2.1;
const HIGH = Q.level === 'high';

const shape = (poly) => new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
// plan polygon -> vertical prism in local (x, height, -y)
function prism(poly, y0, y1) {
  const g = new THREE.ExtrudeGeometry(shape(poly), { depth: y1 - y0, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}
function flat(poly, y) {
  const g = new THREE.ShapeGeometry(shape(poly));
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

// ---------- what is where on the plan ----------

function bbox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  return { x0, y0, x1, y1 };
}

/** polygons with their bounds, for quick point lookups */
class PolyIndex {
  constructor() { this.items = []; }
  add(poly, kind, data) {
    this.items.push({ poly, kind, data, b: bbox(poly) });
    return this;
  }
  at(x, y) {
    for (const it of this.items) {
      const b = it.b;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (inside(it.poly, x, y)) return it;
    }
    return null;
  }
}

/**
 * Walk round a room's outline from inside and sort it into runs of what is behind it:
 * 'wall' (walls, columns), 'window', 'glass' (floor-to-ceiling glazing) or 'open'.
 * The outline is sampled every 5 cm along its length with a smoothed direction (the drawings'
 * outlines have many tiny, jagged edges); runs break where what is behind changes or at a corner.
 * Each run: { kind, a: [x, y], b: [x, y], u, n: [nx, ny] (into the room), len, face }
 */
function edgeRuns(room, solid) {
  const p = room.poly, ccw = polygonArea2(p) > 0;
  const segs = [];
  let total = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    segs.push({ a, b, L, s0: total });
    total += L;
  }
  if (total < 0.2) return [];
  const at = (s) => {
    s = ((s % total) + total) % total;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (segs[m].s0 <= s) lo = m;
      else hi = m - 1;
    }
    const g = segs[lo], t = (s - g.s0) / g.L;
    return [g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t];
  };
  const N = Math.max(8, Math.round(total / 0.05)), step = total / N;
  const samples = [];
  for (let k = 0; k < N; k++) {
    const sp = (k + 0.5) * step, P = at(sp), q0 = at(sp - 0.06), q1 = at(sp + 0.06);
    let tx = q1[0] - q0[0], ty = q1[1] - q0[1];
    const tl = Math.hypot(tx, ty) || 1;
    (tx /= tl), (ty /= tl);
    const nx = ccw ? -ty : ty, ny = ccw ? tx : -tx;
    let kind = 'open';
    for (const d of [0.03, 0.08]) {
      const hit = solid.at(P[0] - nx * d, P[1] - ny * d);
      if (hit) { kind = hit.kind; break; }
    }
    samples.push({ s: sp, kind, tx, ty });
  }
  // start at a break so no run wraps round the end of the list
  const breaks = (i, j) => samples[i].kind !== samples[j].kind || samples[i].tx * samples[j].tx + samples[i].ty * samples[j].ty < 0.87;
  let first = samples.findIndex((x, i) => i > 0 && breaks(i - 1, i));
  if (first < 0) first = 0;
  const runs = [];
  let cur = null;
  for (let k = 0; k < N; k++) {
    const i = (first + k) % N;
    if (cur && samples[i].kind === cur.kind && samples[i].tx * samples[cur.i0].tx + samples[i].ty * samples[cur.i0].ty >= 0.87) cur.s1 = samples[i].s + step / 2;
    else runs.push((cur = { kind: samples[i].kind, i0: i, s0: samples[i].s - step / 2, s1: samples[i].s + step / 2 }));
  }
  return runs.map((r) => {
    const a = at(r.s0), b = at(r.s1 < r.s0 ? r.s1 + total : r.s1);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const nx = ccw ? -uy : uy, ny = ccw ? ux : -ux;
    // where the wall's face is: walls overlap the room outlines by a few centimetres
    let face = 0;
    if (r.kind !== 'open') {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      while (face < 0.1 && solid.at(mx + nx * (face + 0.002), my + ny * (face + 0.002))) face += 0.005;
    }
    return { kind: r.kind, a, b, u: [ux, uy], n: [nx, ny], len, face };
  });
}

function polygonArea2(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]);
  return a / 2;
}

/** principal axis of a polygon's points: centre, direction u, extents along u and across */
function axisOf(poly) {
  let cx = 0, cy = 0;
  for (const [x, y] of poly) (cx += x), (cy += y);
  cx /= poly.length;
  cy /= poly.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of poly) (sxx += (x - cx) ** 2), (syy += (y - cy) ** 2), (sxy += (x - cx) * (y - cy));
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  let t0 = Infinity, t1 = -Infinity, s0 = Infinity, s1 = -Infinity;
  for (const [x, y] of poly) {
    const t = (x - cx) * ux + (y - cy) * uy, s = -(x - cx) * uy + (y - cy) * ux;
    (t0 = Math.min(t0, t)), (t1 = Math.max(t1, t)), (s0 = Math.min(s0, s)), (s1 = Math.max(s1, s));
  }
  return { cx, cy, u: [ux, uy], v: [-uy, ux], t0, t1, s0, s1 };
}

// ---------- the floor ----------

/**
 * @param towerKey 'V' | 'B'
 * @param floor floor number
 * @param apts apartments of this floor (data.js)
 * @param walk the apartment to walk around in (adds ceiling and lights), or null
 */
export function buildFloor(towerKey, floor, apts, walk = null) {
  const M = interiorMaterials();
  const tower = towerByKey[towerKey];
  const fl = tower.floors.find((f) => f.floor === floor);
  const plan = PLANS[fl.plan];
  const frame = planFrame(tower);
  const baseY = fl.z + tower.slab;
  const H = fl.h - 0.5; // clear height

  const group = new THREE.Group();
  group.position.set(frame.position.x, baseY, frame.position.z);
  group.rotation.y = frame.rotY;
  const own = [];
  const floorMeshes = [];
  const k = new Kit();
  const lights = []; // { pos: [x, y, z] in plan / height, room, kind }

  const solid = new PolyIndex();
  for (const w of plan.walls) solid.add(w, 'wall');
  for (const w of plan.struct) solid.add(w, 'wall');
  for (const w of plan.windows) solid.add(w, 'window');
  for (const w of plan.glazing) solid.add(w, 'glass');
  const roomsAt = new PolyIndex();
  for (const apt of apts) for (const room of apt.data.rooms) roomsAt.add(room.poly, 'room', { apt, room });
  for (const c of plan.common ?? []) roomsAt.add(c, 'common', null);

  // collision outlines (plan segments): walls, windows and glazing, then doors and furniture
  const segments = [];
  const obstacles = []; // furniture and door leaves (for the checks in tools/)
  const notes = [];
  const addOutline = (p, what) => {
    if (what) obstacles.push({ what, poly: p });
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) segments.push([p[j][0], p[j][1], p[i][0], p[i][1]]);
  };
  for (const list of [plan.walls, plan.struct, plan.windows, plan.glazing]) for (const p of list) addOutline(p);

  // the flats to fit out: all of them in the cut-away view, the visited one when walking
  const fitted = walk ? apts.filter((a) => a === walk) : apts;

  // ---- room floors and the shell ----
  // wet rooms (bathrooms, WCs): tiles up the walls, frosted glass, bathroom fittings; loggias and
  // terraces only get a tiled floor and stay open to the view (clear glass, a table and chairs)
  const wet = (room, apt) => ['bath', 'wc'].includes(room.kind) || (!['loggia', 'terrace'].includes(room.kind) &&
    (apt.data.furniture ?? []).some((it) => (it.type === 'toilet' || it.type === 'bath') && inside(room.poly, ...it.c)));
  const outdoor = (room) => ['loggia', 'terrace'].includes(room.kind);
  for (const apt of apts) {
    for (const room of apt.data.rooms) {
      room._wet = wet(room, apt);
      const g = flat(room.poly, 0.006);
      own.push(g);
      const m = new THREE.Mesh(g, room._wet || outdoor(room) ? M.tileFloor : M.floor);
      m.receiveShadow = true;
      m.userData = { apt, room };
      group.add(m);
      floorMeshes.push(m);
    }
    for (const b of apt.data.balconies) {
      k.world().add(M.balcony, flat(b.poly, 0.012));
      balconyFurniture(k, M, b.poly);
    }
  }
  for (const c of plan.common ?? []) k.world().add(M.corridor, flat(c, 0.004));

  for (const w of plan.walls) k.world().add(M.wall, prism(w, 0, H));
  for (const w of plan.struct) k.world().add(M.struct, prism(w, 0, H));
  const openings = new Map(plan.windows.map((w) => [w, windowOpening(w, solid)]));
  for (const w of plan.windows) {
    k.world().add(M.wall, prism(openings.get(w).poly, 0, SILL));
    k.world().add(M.wall, prism(openings.get(w).poly, H - HEAD, H));
  }

  // ---- windows: glass (frosted in bathrooms), frames, sills, curtains ----
  const roomOf = (x, y) => roomsAt.at(x, y)?.data ?? null;
  // what the drawn furniture covers: no radiator or curtain where a piece stands against the window
  const drawnFloor = fitted.flatMap((a) => (a.data.furniture ?? []).flatMap(drawnFootprints));
  const covered = (poly) => drawnFloor.some((q) => overlaps(poly, q));
  for (const w of plan.windows) {
    const ax = openings.get(w).ax;
    const thick = ax.s1 - ax.s0, mid = (ax.s0 + ax.s1) / 2;
    // which side is the room?
    let n = null, owner = null;
    for (const sgn of [1, -1]) {
      const d = sgn > 0 ? ax.s1 + 0.15 : ax.s0 - 0.15;
      const r = roomOf(ax.cx + ax.v[0] * d, ax.cy + ax.v[1] * d);
      if (r) { n = [ax.v[0] * sgn, ax.v[1] * sgn]; owner = r; break; }
    }
    const glass = owner?.room._wet ? M.frosted : M.glass;
    k.world().add(glass, prism(openings.get(w).poly, SILL, H - HEAD));
    if (!n) continue;
    const fitHere = fitted.includes(owner.apt);
    // segment along the window at the middle of the wall
    const P = (t, s) => [ax.cx + ax.u[0] * t + ax.v[0] * s, ax.cy + ax.u[1] * t + ax.v[1] * s];
    const a = P(ax.t0, mid), b = P(ax.t1, mid), len = ax.t1 - ax.t0;
    windowFrame(k, M, a, b, n, len, SILL, H - HEAD);
    // sill board, flush with the inside face and a little proud of it
    const inner = n[0] * ax.v[0] + n[1] * ax.v[1] > 0 ? ax.s1 : ax.s0;
    const ia = P(ax.t0, inner), ib = P(ax.t1, inner);
    slab(k, M.sill, ia, ib, n, -thick / 2 + 0.04, thick / 2 - 0.04 + 0.05, SILL - 0.02, SILL + 0.005, 0.03);
    const along = (t0, t1, z0, z1) => {
      const at = (t, z) => [ia[0] + ((ib[0] - ia[0]) * t) / len + n[0] * z, ia[1] + ((ib[1] - ia[1]) * t) / len + n[1] * z];
      return [at(t0, z0), at(t1, z0), at(t1, z1), at(t0, z1)];
    };
    const cw = Math.min(0.55, len * 0.3);
    if (fitHere && ['living', 'bedroom'].includes(owner.room.kind) && !covered(along(-0.3, cw, 0.08, 0.2)) && !covered(along(len - cw, len + 0.3, 0.08, 0.2))) curtains(k, M, ia, ib, n, H, len);
    const rw = Math.min(len * 0.75, 1.6);
    if (fitHere && !owner.room._wet && len > 0.7 && !covered(along((len - rw) / 2 - 0.08, (len + rw) / 2 + 0.08, 0.02, 0.16))) radiator(k, M, ia, ib, n, len);
  }
  // floor-to-ceiling glazing: glass, then mullions and rails along its inner face
  for (const w of plan.glazing) {
    k.world().add(M.glass, prism(w, 0, H));
    glazingFrame(k, M, w, H, roomOf, fitted, (x, y) => (solid.at(x, y)?.kind === 'glass' ? solid.at(x, y) : null));
  }

  // ---- the lifts: the cars in their shafts as drawn, the doors on the hall side ----
  const liftTags = [];
  const halls = [];
  for (const lf of plan.lifts ?? []) {
    const face = lift(k, M, lf, H, solid);
    // lifts side by side with their doors the same way share a hall: one tag for them
    const near = halls.find((g) => Math.abs(g.f - lf.f) < 0.1 && g.lifts.some((o) => dist(o.c, lf.c) < 3.2));
    if (near) near.lifts.push({ ...lf, face });
    else halls.push({ f: lf.f, lifts: [{ ...lf, face }] });
  }
  for (const g of halls) {
    const fs = g.lifts.map((l) => l.face ?? l.c);
    const at = [fs.reduce((a, p) => a + p[0], 0) / fs.length, fs.reduce((a, p) => a + p[1], 0) / fs.length];
    const sc = frame.toScene(at[0], at[1]);
    liftTags.push({ x: sc.x, y: baseY + H + 0.4, z: sc.z, q: g.lifts.map((l) => l.q) });
  }

  // ---- per room: what is behind each edge; doors; skirting and tiles ----
  // (keepout: plan polygons furniture must stay out of - door swings, the way through openings)
  const doors = [], leaves = []; // centres of the doorways fitted so far, and of those with a leaf
  const keepout = []; // plan polygons furniture must stay out of (door swings)
  // ways to walk (door zones, swings, the space in front of a piece) may overlap one another;
  // furniture may stand in none of them. Each belongs to its room: a swing's way round the leaf
  // that reaches through the wall does not keep the furniture of the next room away
  const way = (q, room) => Object.assign(q, { way: true, room });
  const roomInfo = new Map();
  // doors open into the rooms rather than into the hall, but out of the small rooms (bathrooms,
  // WCs, wardrobes, loggias), where an open leaf would stand in the way
  const order = (r) => (['bath', 'wc', 'storage', 'loggia'].includes(r.kind) ? 2 : r.kind === 'hall' ? 1 : 0);
  // ...unless the drawing says otherwise: the side each drawn door opens to ([x, y] of the doorway,
  // [x, y] half a metre into that side)
  const swingAt = (c) => {
    let best = null, bd = 0.75;
    for (const q of plan.swings ?? []) {
      const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
      if (d < bd) [best, bd] = [q, d];
    }
    return best;
  };
  const later = []; // leaves the drawing puts in the room on the other side, hung after all rooms
  const entrances = []; // the doors into each flat: { apt, room, common, mid, n (into the room), s1 }
  // first pass: what is round each room, and a clear zone in front of every opening
  const zones = []; // { poly, mid }
  for (const apt of apts) {
    for (const room of apt.data.rooms) {
      const runs = edgeRuns(room, solid);
      roomInfo.set(room, runs);
      for (const r of runs) {
        if (r.kind !== 'open' || r.len < 0.45) continue;
        // a doorway keeps its whole width clear; a wide open-plan opening only a 1.1 m way through
        // its middle (furniture may stand along the rest of it, as in any open-plan room)
        const e = 0.15, d = 0.95;
        let a = [r.a[0] - r.u[0] * e, r.a[1] - r.u[1] * e], b = [r.b[0] + r.u[0] * e, r.b[1] + r.u[1] * e];
        if (r.len > 1.3) {
          const m = [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2];
          a = [m[0] - r.u[0] * 0.55, m[1] - r.u[1] * 0.55];
          b = [m[0] + r.u[0] * 0.55, m[1] + r.u[1] * 0.55];
        }
        const poly = [a, b, [b[0] + r.n[0] * d, b[1] + r.n[1] * d], [a[0] + r.n[0] * d, a[1] + r.n[1] * d]];
        keepout.push(way(poly, room));
        zones.push({ poly, mid: [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2] });
      }
    }
  }
  for (const apt of apts) {
    const fit = fitted.includes(apt);
    for (const room of [...apt.data.rooms].sort((p, q) => order(p) - order(q))) {
      const runs = roomInfo.get(room);
      for (const r of runs) {
        if (r.kind === 'wall' || r.kind === 'window') {
          if (room._wet) slab(k, M.tileWall, r.a, r.b, r.n, r.face, 0.008, 0, r.kind === 'window' ? SILL : H);
          else slab(k, M.skirting, r.a, r.b, r.n, r.face, 0.014, 0, 0.08);
          if (room._wet && r.kind === 'window') slab(k, M.tileWall, r.a, r.b, r.n, r.face, 0.008, H - HEAD, H);
        }
      }
      // doors: door-wide gaps with wall on both sides. Returns the wall's band [s0, s1] (along n)
      // when a doorway was made. `band`: the band to use where the gap's ends find no wall
      const doorway = (r, band = null) => {
        if (r.kind !== 'open' || r.len < 0.55 || r.len > 1.3) return null;
        // the slot through the wall: where the wall ends beside the gap, across its thickness
        // (s along n, 0 = this run; the outline may run along the wall face or inside the gap)
        // (the door into a flat may stand in an opening a little wider than the hall's gap: the wall
        // beside it is looked for up to 20 cm on, where the corridor is across)
        const mx0 = (r.a[0] + r.b[0]) / 2, my0 = (r.a[1] + r.b[1]) / 2;
        const across = roomsAt.at(mx0 - r.n[0] * 0.5, my0 - r.n[1] * 0.5) ?? roomsAt.at(mx0 - r.n[0] * 0.7, my0 - r.n[1] * 0.7);
        const reachOn = across?.kind === 'common' ? [0.05, 0.1, 0.15, 0.2] : [0.05];
        const side = (p, sgn, s) => reachOn.some((e) => solid.at(p[0] - r.u[0] * e * sgn + r.n[0] * s, p[1] - r.u[1] * e * sgn + r.n[1] * s)?.kind === 'wall');
        const inWall = (s) => side(r.a, 1, s) && side(r.b, -1, s);
        let s0 = null, s1 = null;
        for (let s = -0.6; s <= 0.3; s += 0.01) {
          if (inWall(s)) {
            if (s0 === null) s0 = s;
            s1 = s;
          } else if (s0 !== null && s1 > -0.02) break;
          else if (s0 !== null) s0 = s1 = null;
        }
        if ((s0 === null || s1 - s0 < 0.05) && reachOn.length > 1) {
          // the door into a flat in a corner of the corridor: the flat's wall on one side only
          s0 = s1 = null;
          for (let s = -0.6; s <= 0.3; s += 0.01) {
            if (side(r.a, 1, s) || side(r.b, -1, s)) {
              if (s0 === null) s0 = s;
              s1 = s;
            } else if (s0 !== null && s1 > -0.02) break;
            else if (s0 !== null) s0 = s1 = null;
          }
        }
        if ((s0 === null || s1 - s0 < 0.05) && band) [s0, s1] = band;
        if (s0 === null || s1 - s0 < 0.05) return null; // no wall beside the gap: an open plan
        s0 -= 0.005;
        s1 += 0.005;
        const mx = (r.a[0] + r.b[0]) / 2, my = (r.a[1] + r.b[1]) / 2, sm = (s0 + s1) / 2;
        const behind = roomsAt.at(mx + r.n[0] * (s0 - 0.15), my + r.n[1] * (s0 - 0.15));
        const entrance = !behind || behind.kind === 'common' || behind.data.apt !== apt;
        const centre = [mx + r.n[0] * sm, my + r.n[1] * sm];
        if (entrance) entrances.push({ apt, room, common: !behind || behind.kind === 'common', mid: [mx, my], n: r.n, s1 });
        const shift = (p, s) => [p[0] + r.n[0] * s, p[1] + r.n[1] * s];
        const face = { ...r, a: shift(r.a, s1), b: shift(r.b, s1) };
        // casing on this side of the wall
        casing(k, entrance ? M.entrance : M.skirting, face);
        // the same doorway seen from the room on its other side: the wall over it once, the leaf
        // in whichever room it fits first
        const seen = (list) => list.some((c) => dist(c, centre) < 0.45);
        if (!seen(doors)) {
          doors.push(centre);
          slab(k, M.wall, shift(r.a, s0), shift(r.b, s0), r.n, 0, s1 - s0, DOOR_H, H);
        }
        if (seen(leaves)) return [s0, s1];
        // the leaf, open 90 degrees into this room, hinged at the end nearer a corner
        // a leaf only in door-sized openings (wider ones are passages without a door)
        if (r.len > 1.15 || s1 - s0 > 0.45) return [s0, s1];
        // the drawing opens this door into the room on the other side: the leaf goes there (or back
        // here, once every room is done, if it does not fit there)
        const drawn = swingAt(centre);
        if (drawn && (drawn[2] - drawn[0]) * r.n[0] + (drawn[3] - drawn[1]) * r.n[1] < 0) {
          later.push({ centre, hang: () => hang(room, r, face, centre, entrance, s0, s1, fit) });
          return [s0, s1];
        }
        hang(room, r, face, centre, entrance, s0, s1, fit);
        return [s0, s1];
      };
      for (const r of runs) {
        if (r.kind !== 'open') continue;
        if (r.len <= 1.3) {
          doorway(r);
          continue;
        }
        // a stretch of the flat's wall to the corridor that the drawing leaves unfilled beside the
        // entrance door (a 2 m gap): the door where its swing is drawn, the rest walled up
        const mx0 = (r.a[0] + r.b[0]) / 2, my0 = (r.a[1] + r.b[1]) / 2;
        if (roomsAt.at(mx0 - r.n[0] * 0.5, my0 - r.n[1] * 0.5)?.kind !== 'common') continue;
        const sw = (plan.swings ?? []).find((q) => {
          const t = (q[0] - r.a[0]) * r.u[0] + (q[1] - r.a[1]) * r.u[1], d = (q[0] - r.a[0]) * r.n[0] + (q[1] - r.a[1]) * r.n[1];
          return t > 0.3 && t < r.len - 0.3 && Math.abs(d) < 0.5;
        });
        if (!sw) continue;
        const tc = (sw[0] - r.a[0]) * r.u[0] + (sw[1] - r.a[1]) * r.u[1];
        const t0 = Math.max(0, tc - 0.48), t1 = Math.min(r.len, tc + 0.48);
        const P = (t) => [r.a[0] + r.u[0] * t, r.a[1] + r.u[1] * t];
        // the wall's band, from the walls at the ends of the stretch
        let band = null;
        for (const [p, sg] of [[r.a, -1], [r.b, 1]]) {
          let b0 = null, b1 = null;
          for (let s = -0.6; s <= 0.3; s += 0.01) {
            const q = [p[0] + r.u[0] * sg * 0.1 + r.n[0] * s, p[1] + r.u[1] * sg * 0.1 + r.n[1] * s];
            if (solid.at(...q)?.kind === 'wall') {
              if (b0 === null) b0 = s;
              b1 = s;
            } else if (b0 !== null) break;
          }
          if (b0 !== null && b1 - b0 >= 0.05) band = [b0, b1];
        }
        const got = doorway({ ...r, a: P(t0), b: P(t1), len: t1 - t0 }, band);
        if (!got) continue;
        const [s0, s1] = got;
        for (const [u0, u1] of [[0, t0], [t1, r.len]]) {
          if (u1 - u0 < 0.03) continue;
          const A = P(u0), B = P(u1), sh = (q, s) => [q[0] + r.n[0] * s, q[1] + r.n[1] * s];
          slab(k, M.wall, sh(A, s0), sh(B, s0), r.n, 0, s1 - s0, 0, H);
          slab(k, M.skirting, sh(A, s1), sh(B, s1), r.n, 0, 0.014, 0, 0.08);
          addOutline([sh(A, s0), sh(B, s0), sh(B, s1), sh(A, s1)]);
        }
      }
    }
  }
  for (const d of later) if (!leaves.some((c) => dist(c, d.centre) < 0.45)) d.hang();

  // the leaf of a doorway, open 90 degrees into `room`, hinged at the end nearer a corner
  function hang(room, r, face, centre, entrance, s0, s1, fit) {
    const leafW = r.len - 0.03;
    // hinge on the side with the shorter stretch of wall to the next corner, so the open leaf
    // stands near that corner; the open leaf has to stand inside the room
    const reach = (p, sgn) => {
      let d = 0;
      while (d < 3 && solid.at(p[0] - r.u[0] * sgn * (d + 0.05) + r.n[0] * (s1 - 0.03), p[1] - r.u[1] * sgn * (d + 0.05) + r.n[1] * (s1 - 0.03))) d += 0.1;
      return d;
    };
    const ends = reach(r.a, 1) <= reach(r.b, -1) ? [true, false] : [false, true];
    let h = null, w = null, tip = null;
    for (const atA of ends) {
      const hh = atA ? face.a : face.b, ww = atA ? r.u : [-r.u[0], -r.u[1]];
      const tt = [hh[0] + r.n[0] * leafW, hh[1] + r.n[1] * leafW];
      // ...and leave room to walk round its edge (not across a narrow hall)
      // ...and not swing into the way to another doorway
      const P = (f) => [hh[0] + r.n[0] * leafW * f + ww[0] * 0.03, hh[1] + r.n[1] * leafW * f + ww[1] * 0.03];
      const ok = [0.5, 1, 1 + 0.75 / leafW].every((f) => inside(room.poly, ...P(f))) &&
        !zones.some((z) => dist(z.mid, centre) > 0.6 && [0.15, 0.5, 0.85, 1].some((f) => inside(z.poly, ...P(f))));
      if (ok) {
        [h, w, tip] = [hh, ww, tt];
        break;
      }
    }
    if (!h) return;
    leaves.push(centre);
    if (fit || !walk) doorLeaf(k, M, h, tip, w, entrance);
    segments.push([h[0], h[1], tip[0], tip[1]]);
    obstacles.push({ what: 'door', poly: [h, tip] });
    const sx = w[0] * leafW, sy = w[1] * leafW;
    keepout.push(way([h, tip, [tip[0] + sx, tip[1] + sy], [h[0] + sx, h[1] + sy]], room));
    // and a way round the open leaf's edge (furniture right at its tip would shut the room off)
    const far = [h[0] + r.n[0] * (leafW + 0.7), h[1] + r.n[1] * (leafW + 0.7)];
    keepout.push(way([tip, far, [far[0] + sx, far[1] + sy], [tip[0] + sx, tip[1] + sy]], room));
    keepout.push(way([tip, far, [far[0] - w[0] * 0.65, far[1] - w[1] * 0.65], [tip[0] - w[0] * 0.65, tip[1] - w[1] * 0.65]], room));
  }

  // ---- furniture and fittings: as drawn; the rooms the drawing leaves empty, furnished here ----
  let walkBefore = null; // rooms of the walked flat reachable before any furniture (for the checks)
  for (const apt of fitted) {
    // in the flat being walked through, no room may be shut off by furniture: the way from the
    // entrance is checked, and what blocks it loses its collision (the smaller pieces first) or,
    // in the rooms furnished here, is furnished again with the essentials only (or left empty)
    const check = walk === apt;
    const door = entranceOf(entrances, apt);
    const start = check ? door?.inside ?? interiorPoint(entranceHall(apt).poly) : null;
    const before = check ? reachableRooms(apt, segments, start) : null;
    if (check) walkBefore = before;
    const drawnRooms = placeDrawn({ k, M, H, apt, solid, keepout, lights, ceiling: !!walk });
    // the drawn pieces' collisions, the smaller ones given up first if they shut a room off
    const mark0 = { seg: segments.length, obs: obstacles.length };
    for (let keepFrom = 0; keepFrom <= 4; keepFrom++) {
      for (const p of drawnRooms.solids) if (p.prio >= keepFrom) addOutline(p.poly, p.what);
      if (!check) break;
      const now = reachableRooms(apt, segments, start);
      if ([...before].every((i) => now.has(i))) break;
      segments.length = mark0.seg;
      obstacles.length = mark0.obs;
      if (keepFrom === 4) notes.push(`${apt.id}: drawn furniture shuts a room off even without collisions`);
    }
    // take back everything added after a mark (the kit's pieces, collisions, keep-out zones, lights)
    const mark = () => ({ kit: k.mark(), seg: segments.length, keep: keepout.length, obs: obstacles.length, lights: lights.length });
    const rollback = (m) => {
      k.rollback(m.kit);
      segments.length = m.seg;
      keepout.length = m.keep;
      obstacles.length = m.obs;
      lights.length = m.lights;
    };
    for (const room of apt.data.rooms) {
      if (drawnRooms.rooms.has(room) && !room._wet) {
        // furnished as drawn: only the light
        const ctx = { k, M, H, room, apt, keepout, lights, solid, ceiling: !!walk };
        if (walk) {
          const rug = drawnRooms.rugs.find((r) => inside(room.poly, ...r));
          const r = innerRect(room.poly, 0.06);
          const [px, py] = rug ?? [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
          const outdoors = ['loggia', 'terrace'].includes(room.kind);
          if (!outdoors && (['bedroom', 'living'].includes(room.kind) || !drawnRooms.lit.has(room))) pendant(ctx, px, py, 'drum');
          downlights(ctx);
        }
        continue;
      }
      // a clear way between every two openings of the room (doors, balcony doors, open plan):
      // kept free of furniture when the room, furnished freely, shuts the way through
      const walkways = () => {
        const out = [];
        const mids = (roomInfo.get(room) ?? []).filter((r) => r.kind === 'open' && r.len >= 0.45)
          .map((r) => [(r.a[0] + r.b[0]) / 2 + r.n[0] * 0.3, (r.a[1] + r.b[1]) / 2 + r.n[1] * 0.3]);
        for (let i = 0; i < mids.length; i++) {
          for (let j = i + 1; j < mids.length; j++) {
            const [a, b] = [mids[i], mids[j]];
            const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (L < 0.3) continue;
            const nx = (-(b[1] - a[1]) / L) * 0.32, ny = ((b[0] - a[0]) / L) * 0.32;
            out.push(way([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], room));
          }
        }
        return out;
      };
      const snap = mark();
      // full; the essentials (no wardrobe, no plant); full with clear walkways between the doors;
      // the essentials with walkways; and if all of them shut a room off or lose the main piece,
      // the essentials with walkways whatever is lost (a loggia must always stay reachable)
      const loggias = new Set();
      const tiers = [[false, false, false], [true, false, false], [false, true, false], [true, true, false], [true, true, true]];
      const notes0 = notes.length;
      for (const [sparse, ways, noLoggias] of tiers) {
        if (ways) keepout.push(...walkways());
        // (in the flat walked through: does every room it could be walked to before still stay so?)
        const open = check ? () => {
          const now = reachableRooms(apt, segments, start);
          return [...before].every((i) => now.has(i));
        } : null;
        const ctx = { k, M, H, room, apt, keepout, addOutline: (p) => addOutline(p, room.kind), lights, solid, runs: roomInfo.get(room), ceiling: !!walk, notes, sparse, mark, rollback, open };
        furnish(ctx);
        if (ctx.ceiling) downlights(ctx);
        if (!check) break;
        const now = reachableRooms(apt, segments, start);
        // a fit-out that lost the room's main piece (sofa, bed, kitchen) only counts on the last tiers
        const lost = notes.slice(notes0).some((n) => / no (place|wall) for /.test(n)) && !noLoggias;
        if (!lost && [...before].every((i) => now.has(i) || (noLoggias && loggias.has(i)))) break;
        rollback(snap);
        notes.length = notes0; // what furnish() said about this attempt no longer applies
        if (noLoggias) notes.push(`${room.kind} ${room.area} m²: left empty, to keep the way through`);
      }
    }
  }
  k.build(group, own);

  // ---- ceiling and lights for the walk ----
  let spawn = null, outline = null, reach = null;
  const lightObjects = [];
  if (walk) {
    outline = walk.data.outline;
    const ceil = flat(plan.enclosure, H);
    own.push(ceil);
    const c = new THREE.Mesh(ceil, M.ceiling);
    group.add(c);
    // one light per room, the biggest rooms first; shadows keep each room's light in the room
    const budget = HIGH ? 6 : 3, shadowed = HIGH ? 4 : 0;
    const byRoom = new Map();
    for (const l of lights) if (!byRoom.has(l.room) || l.main) byRoom.set(l.room, l);
    const chosen = [...byRoom.values()].sort((p, q) => q.room.area - p.room.area).slice(0, budget);
    chosen.forEach((l, i) => {
      const area = l.room.area;
      const range = Math.max(4, Math.sqrt(area) * 2.4);
      let light;
      if (l.spot) {
        // recessed downlights: one spot for the group, pointing down
        light = new THREE.SpotLight(0xffe2bf, THREE.MathUtils.clamp(area * 0.9, 4, 14), range, 1.1, 0.8, 2);
        light.target.position.set(l.x, 0, -l.y);
        group.add(light.target);
      } else {
        light = new THREE.PointLight(0xffdcb6, THREE.MathUtils.clamp(area * 0.36, 3, 9), range, 2);
      }
      light.position.set(l.x, l.z, -l.y);
      if (i < shadowed) {
        light.castShadow = true;
        light.shadow.mapSize.set(512, 512);
        light.shadow.bias = -0.003;
        light.shadow.normalBias = 0.02;
        light.shadow.radius = 3;
        light.shadow.camera.near = 0.03;
      }
      group.add(light);
      lightObjects.push(light);
    });

    // start just inside the entrance door, looking in (the way one walks in: what is on the right
    // on entering is on the right); where a wall is close ahead, turned to the most open view, but
    // never more than a right angle away from the way in
    const door = entranceOf(entrances, walk);
    const rooms = [...walk.data.rooms].sort((p, q) => q.area - p.area);
    const [sx, sy] = door?.inside ?? interiorPoint(entranceHall(walk).poly);
    const ahead = door ? Math.atan2(door.n[1], door.n[0]) : Math.atan2(interiorPoint(rooms[0].poly)[1] - sy, interiorPoint(rooms[0].poly)[0] - sx);
    const N = 72, dists = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      let d = 10;
      for (const [ax, ay, bx, by] of segments) {
        const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((ax - sx) * ey - (ay - sy) * ex) / den, u = ((ax - sx) * dy - (ay - sy) * dx) / den;
        if (t > 0 && u >= 0 && u <= 1) d = Math.min(d, t);
      }
      dists.push(d);
    }
    const along = (a) => dists[((Math.round((a / (Math.PI * 2)) * N) % N) + N) % N];
    let best = ahead;
    if (along(ahead) < 2.2) {
      let bestScore = -Infinity;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2, off = Math.atan2(Math.sin(a - ahead), Math.cos(a - ahead));
        if (Math.abs(off) > Math.PI / 2) continue;
        let open = 0;
        for (let j = -4; j <= 4; j++) open += Math.min(dists[(i + j + N) % N], 8); // +-20 degrees
        const score = open * (1 + 0.35 * Math.cos(off));
        if (score > bestScore) [bestScore, best] = [score, a];
      }
    }
    const s0 = frame.toScene(sx, sy), t0 = frame.toScene(sx + Math.cos(best), sy + Math.sin(best));
    reach = { rooms: walk.data.rooms.length, before: [...(walkBefore ?? [])], after: [...reachableRooms(walk, segments, [sx, sy])], start: [sx, sy], look: best, door: !!door };
    spawn = { x: s0.x, z: s0.z, yaw: Math.atan2(-(t0.x - s0.x), -(t0.z - s0.z)) };
  }

  const RADIUS = 0.2; // the visitor: half a shoulder width, so a 0.6 m bathroom door lets them through
  return {
    apt: walk,
    group,
    floorMeshes,
    baseY,
    spawn,
    frame,
    plan,
    lights: lightObjects,
    obstacles,
    segments, // collision lines in plan coordinates (for the checks in tools/)
    notes, // rooms where something could not be fitted (for the checks in tools/)
    doors: doors.length,
    liftTags, // { x, y, z (scene), q: [kg, ...] }: one per lift hall, for the floor view's tags
    reach, // walk-through: rooms reachable before furniture and from the start after it (for the checks)
    // Move from (x, z) to (nx, nz) in the scene without walking through walls or out of the flat.
    move(x, z, nx, nz) {
      const p = frame.toPlan(nx, nz);
      let px = p.x, py = p.y;
      for (let iter = 0; iter < 3; iter++) {
        for (const [ax, ay, bx, by] of segments) {
          if (Math.min(ax, bx) - RADIUS > px || Math.max(ax, bx) + RADIUS < px) continue;
          if (Math.min(ay, by) - RADIUS > py || Math.max(ay, by) + RADIUS < py) continue;
          const { d, px: qx, py: qy } = distToSegment(px, py, ax, ay, bx, by);
          if (d < RADIUS && d > 1e-6) {
            px = qx + ((px - qx) / d) * RADIUS;
            py = qy + ((py - qy) / d) * RADIUS;
          }
        }
      }
      if (outline && !inside(outline, px, py)) return { x, z };
      const s = frame.toScene(px, py);
      return { x: s.x, z: s.z };
    },
    dispose() {
      group.removeFromParent();
      own.forEach((g) => g.dispose());
      lightObjects.forEach((l) => l.shadow?.map?.dispose());
    },
  };
}

/** the drawing's entrance hall ("Даҳлез"), else any hall, else the smallest room */
function entranceHall(apt) {
  const rooms = apt.data.rooms;
  return rooms.find((r) => r.tj === 'Даҳлез') ?? rooms.find((r) => r.kind === 'hall') ?? [...rooms].sort((p, q) => p.area - q.area)[0];
}

/**
 * Rooms of a flat reachable on foot from `start`: a 10 cm grid over the flat, cells closer than
 * 22 cm to a collision line blocked (the visitor keeps 25 cm), flood-filled from the start.
 */
function reachableRooms(apt, segments, start) {
  const out = apt.data.outline, b = bbox(out), step = 0.1, R = 0.23; // a little more than the walker (0.2 m): furniture always leaves a way the visitor fits through
  const nx = Math.ceil((b.x1 - b.x0) / step) + 1, ny = Math.ceil((b.y1 - b.y0) / step) + 1;
  const blocked = new Uint8Array(nx * ny);
  const cx = (i) => b.x0 + i * step, cy = (j) => b.y0 + j * step;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (!inside(out, cx(i), cy(j))) blocked[j * nx + i] = 1;
  for (const [ax, ay, bx, by] of segments) {
    if (Math.max(ax, bx) < b.x0 - R || Math.min(ax, bx) > b.x1 + R || Math.max(ay, by) < b.y0 - R || Math.min(ay, by) > b.y1 + R) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R - b.x0) / step)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + R - b.x0) / step));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - R - b.y0) / step)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + R - b.y0) / step));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!blocked[j * nx + i] && distToSegment(cx(i), cy(j), ax, ay, bx, by).d < R) blocked[j * nx + i] = 1;
  }
  // from the free cell nearest the start
  let s = -1, best = Infinity;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (blocked[j * nx + i]) continue;
    const d = Math.hypot(cx(i) - start[0], cy(j) - start[1]);
    if (d < best) [best, s] = [d, j * nx + i];
  }
  const seen = new Uint8Array(nx * ny), queue = [s], rooms = new Set();
  if (s < 0) return rooms;
  seen[s] = 1;
  while (queue.length) {
    const c = queue.pop(), i = c % nx, j = (c - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const n = jj * nx + ii;
      if (seen[n] || blocked[n]) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  apt.data.rooms.forEach((r, k) => {
    const rb = bbox(r.poly);
    for (let j = Math.max(0, Math.floor((rb.y0 - b.y0) / step)); j < Math.min(ny, Math.ceil((rb.y1 - b.y0) / step) + 1) && !rooms.has(k); j++) {
      for (let i = Math.max(0, Math.floor((rb.x0 - b.x0) / step)); i < Math.min(nx, Math.ceil((rb.x1 - b.x0) / step) + 1); i++) {
        if (seen[j * nx + i] && inside(r.poly, cx(i), cy(j))) {
          rooms.add(k);
          break;
        }
      }
    }
  });
  return rooms;
}

// ---------- shell details ----------

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const centre = (poly) => {
  const b = bbox(poly);
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
};

/** slab along a -> b on the side `n` points to, from off to off + thick away from the line */
function slab(k, mat, a, b, n, off, thick, z0, z1, ext = 0) {
  const L = dist(a, b);
  if (L < 0.01) return;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const p = [a[0] - ux * ext, a[1] - uy * ext], q = [b[0] + ux * ext, b[1] + uy * ext];
  // Kit.along offsets to the left of p -> q
  const left = -uy * n[0] + ux * n[1] > 0;
  if (left) k.along(mat, p[0], p[1], q[0], q[1], off, thick, z0, z1);
  else k.along(mat, q[0], q[1], p[0], p[1], off, thick, z0, z1);
}

function casing(k, mat, r) {
  const w = 0.07, t = 0.016;
  const ext = (p, s) => [p[0] + r.u[0] * s, p[1] + r.u[1] * s];
  slab(k, mat, ext(r.a, -w), r.a, r.n, 0, t, 0, DOOR_H + w);
  slab(k, mat, r.b, ext(r.b, w), r.n, 0, t, 0, DOOR_H + w);
  slab(k, mat, ext(r.a, -w), ext(r.b, w), r.n, 0, t, DOOR_H, DOOR_H + w);
}

/** a door leaf from hinge h to tip (standing in the room), its face towards w */
function doorLeaf(k, M, h, tip, w, entrance) {
  const mat = entrance ? M.entrance : M.door;
  slab(k, mat, h, tip, w, 0.006, 0.04, 0.008, DOOR_H - 0.006);
  const L = dist(h, tip), d = [(tip[0] - h[0]) / L, (tip[1] - h[1]) / L];
  const at = (s) => [h[0] + d[0] * s, h[1] + d[1] * s];
  // lever handles on both faces (the leaf's faces are 0.006 and 0.046 from the hinge line)
  for (const [lever, rose] of [[0.058, 0.046], [-0.02, -0.004]]) {
    slab(k, M.blackMetal, at(L - 0.2), at(L - 0.07), w, lever, 0.014, 0.99, 1.012);
    slab(k, M.blackMetal, at(L - 0.09), at(L - 0.05), w, rose, 0.014, 0.97, 1.03);
  }
  if (entrance) {
    // panels: two thin grooves
    for (const y of [0.7, 1.4]) slab(k, M.blackMetal, at(0.12), at(L - 0.12), w, 0.0455, 0.002, y, y + 0.006);
  }
}

/** window frame in the middle of the wall: outer frame, mullions every 1.2 m or so */
function windowFrame(k, M, a, b, n, len, z0, z1) {
  const fw = 0.06, fd = 0.07;
  const at = (t) => [a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len];
  slab(k, M.frame, a, b, n, -fd / 2, fd, z0, z0 + fw);
  slab(k, M.frame, a, b, n, -fd / 2, fd, z1 - fw, z1);
  slab(k, M.frame, a, at(fw), n, -fd / 2, fd, z0, z1);
  slab(k, M.frame, at(len - fw), b, n, -fd / 2, fd, z0, z1);
  const panes = Math.max(1, Math.round(len / 1.2));
  for (let i = 1; i < panes; i++) {
    const t = (len * i) / panes;
    slab(k, M.frame, at(t - 0.03), at(t + 0.03), n, -fd / 2, fd, z0, z1);
  }
  // opening sash handle on the first pane
  if (len > 0.6) slab(k, M.chrome, at(len / panes - 0.09), at(len / panes - 0.07), n, fd / 2, 0.03, (z0 + z1) / 2 - 0.08, (z0 + z1) / 2 + 0.08);
}

/** steel panel radiator under a window: front with fine vertical channels, grille on top */
function radiator(k, M, a, b, n, len) {
  const w = Math.min(len * 0.75, 1.6), t0 = (len - w) / 2;
  const at = (t) => [a[0] + ((b[0] - a[0]) * t) / len, a[1] + ((b[1] - a[1]) * t) / len];
  const off = 0.05, z0 = 0.16, z1 = 0.66;
  slab(k, M.radiator, at(t0), at(t0 + w), n, off, 0.09, z0, z1);
  for (let t = t0 + 0.03; t < t0 + w - 0.02; t += 0.05) slab(k, M.radiator, at(t), at(t + 0.022), n, off + 0.09, 0.006, z0 + 0.02, z1 - 0.02);
  slab(k, M.color(0x9a9894, 0.6), at(t0 + 0.02), at(t0 + w - 0.02), n, off + 0.01, 0.07, z1, z1 + 0.002);
  // valve and pipes down to the floor
  slab(k, M.chrome, at(t0 - 0.06), at(t0 - 0.03), n, off + 0.03, 0.03, z0 + 0.05, z0 + 0.12);
  slab(k, M.radiator, at(t0 - 0.055), at(t0 - 0.035), n, off + 0.035, 0.02, 0, z0 + 0.06);
  slab(k, M.radiator, at(t0 + w + 0.035), at(t0 + w + 0.055), n, off + 0.035, 0.02, 0, z0 + 0.06);
}

/** sheer curtains gathered at both ends of a window, on a ceiling track */
function curtains(k, M, a, b, n, H, len) {
  const off = 0.13;
  slab(k, M.blackMetal, a, b, n, off - 0.015, 0.03, H - 0.035, H - 0.005, 0.3);
  const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const facing = Math.atan2(n[1], n[0]);
  const cw = Math.min(0.55, len * 0.3);
  for (const [p, s] of [[a, -1], [b, 1]]) {
    // centre of the gathered panel: half on the wall beside the window, half over the glass
    const c = [p[0] + u[0] * s * 0.08 + n[0] * off, p[1] + u[1] * s * 0.08 + n[1] * off];
    k.at(c[0], c[1], facing);
    F.curtain(k, M.sheer, cw, H - 0.05, 0.015);
  }
}

/** mullions and rails along floor-to-ceiling glazing (also curved) */
function glazingFrame(k, M, poly, H, roomOf, fitted, glassAt) {
  // split the outline at its two farthest points into the two faces, keep the face inside
  let i0 = 0, i1 = 0, best = -1;
  for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) {
    const d = dist(poly[i], poly[j]);
    if (d > best) [best, i0, i1] = [d, i, j];
  }
  if (best < 0.5) return;
  const chainA = poly.slice(i0, i1 + 1), chainB = [...poly.slice(i1), ...poly.slice(0, i0 + 1)].reverse();
  const probe = (chain) => {
    const m = chain[Math.floor(chain.length / 2)];
    const [cx, cy] = centre(poly);
    const dx = m[0] - cx, dy = m[1] - cy, L = Math.hypot(dx, dy) || 1;
    return roomOf(m[0] + (dx / L) * 0.2, m[1] + (dy / L) * 0.2);
  };
  const ra = probe(chainA), rb = probe(chainB);
  const chain = ra ? chainA : chainB, owner = ra ?? rb;
  // resample the inside face every ~1.4 m: mullions there, rails along it
  const pts = [chain[0]];
  let acc = 0;
  for (let i = 1; i < chain.length; i++) {
    acc += dist(chain[i - 1], chain[i]);
    if (acc > 0.25) {
      pts.push(chain[i]);
      acc = 0;
    }
  }
  if (dist(pts[pts.length - 1], chain[chain.length - 1]) > 0.01) pts.push(chain[chain.length - 1]);
  const [cx, cy] = centre(poly);
  const inward = (p, q) => {
    const L = dist(p, q) || 1, ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L;
    let nx = -uy, ny = ux;
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) (nx = -nx), (ny = -ny);
    return [nx, ny];
  };
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], n = inward(p, q);
    slab(k, M.frame, p, q, n, -0.06, 0.07, 0, 0.09);
    slab(k, M.frame, p, q, n, -0.06, 0.07, H - 0.07, H);
    run += dist(p, q);
    if (run > 1.3 || i === pts.length - 1 || i === 1) {
      const L = dist(p, q), ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L;
      const m = i === 1 ? p : q;
      slab(k, M.frame, [m[0] - ux * 0.025, m[1] - uy * 0.025], [m[0] + ux * 0.025, m[1] + uy * 0.025], n, -0.07, 0.09, 0, H);
      run = 0;
    }
  }
  // a sheer curtain gathered at each end in living rooms and bedrooms
  if (owner && fitted.includes(owner.apt) && ['living', 'bedroom', 'kitchen'].includes(owner.room.kind)) {
    for (const [p, q] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
      // only where the glass ends (a wall next to it), not where the next pane of glazing goes on
      const L0 = dist(p, q), along = [(p[0] - q[0]) / L0, (p[1] - q[1]) / L0], n0 = inward(p, q);
      const nb = glassAt(p[0] + along[0] * 0.25 - n0[0] * 0.04, p[1] + along[1] * 0.25 - n0[1] * 0.04);
      if (nb && nb.poly !== poly) continue;
      const n = inward(p, q), L = dist(p, q), ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L;
      const c = [p[0] + ux * 0.3 + n[0] * 0.16, p[1] + uy * 0.3 + n[1] * 0.16];
      k.at(c[0], c[1], Math.atan2(n[1], n[0]));
      F.curtain(k, M.sheer, 0.55, H - 0.05, 0.015);
    }
  }
}

// ---------- what the drawing has: furniture, fittings, lifts ----------

/**
 * A window's opening: the window's own outline as a rectangle along its axis, run on to the wall
 * on either side (the drawings leave slits of a few centimetres between a window and the wall
 * beside it, and the sky showed through them). Returns { poly, ax }.
 */
function windowOpening(w, solid) {
  const ax0 = axisOf(w);
  const mid = (ax0.s0 + ax0.s1) / 2;
  const P = (t, s) => [ax0.cx + ax0.u[0] * t + ax0.v[0] * s, ax0.cy + ax0.u[1] * t + ax0.v[1] * s];
  // how far to the next wall (or window) beyond each end, along the middle of the wall; nothing
  // within 8 cm: the window ends there as drawn
  const reach = (t, sgn) => {
    for (let e = 0.004; e <= 0.08; e += 0.004) {
      const q = P(t + sgn * e, mid);
      const hit = solid.at(q[0], q[1]);
      if (hit && hit.poly !== w) return hit.kind === 'wall' ? e + 0.01 : e;
    }
    return 0;
  };
  const ax = { ...ax0, t0: ax0.t0 - reach(ax0.t0, -1), t1: ax0.t1 + reach(ax0.t1, 1) };
  return { poly: [P(ax.t0, ax.s0), P(ax.t1, ax.s0), P(ax.t1, ax.s1), P(ax.t0, ax.s1)], ax };
}

/** the flat's entrance door (into the corridor), with a point just inside it */
function entranceOf(entrances, apt) {
  const e = entrances.find((x) => x.apt === apt && x.common) ?? entrances.find((x) => x.apt === apt);
  if (!e) return null;
  for (const d of [0.75, 0.6, 0.45, 0.35]) {
    const p = [e.mid[0] + e.n[0] * (e.s1 + d), e.mid[1] + e.n[1] * (e.s1 + d)];
    if (inside(e.room.poly, ...p) && distToEdge(e.room.poly, ...p) > 0.24) return { ...e, inside: p };
  }
  return { ...e, inside: [e.mid[0] + e.n[0] * (e.s1 + 0.4), e.mid[1] + e.n[1] * (e.s1 + 0.4)] };
}

/** door width of a lift by the length of its door wall */
const liftDoor = (w) => (w >= 2.4 ? 1.2 : w >= 2.1 ? 1.1 : 0.9);

/**
 * A lift as drawn: the car in its shaft (origin at the middle of its back wall, the doors at the
 * front, facing lf.f), a steel threshold out to the shaft wall and the landing doors on the hall
 * face of that wall. Returns where the landing doors are (plan), or null.
 */
function lift(k, M, lf, H, solid) {
  const [fx, fy] = [Math.cos(lf.f), Math.sin(lf.f)];
  const doorW = liftDoor(lf.w);
  const back = [lf.c[0] - (fx * lf.d) / 2, lf.c[1] - (fy * lf.d) / 2];
  k.at(back[0], back[1], lf.f);
  F.liftCar(k, M, lf.w, lf.d, H, doorW);
  // the shaft wall in front of the doors: from s0 to s1 beyond the car's front
  let s0 = null, s1 = null;
  for (let e = 0; e < 1.2; e += 0.01) {
    const q = [lf.c[0] + fx * (lf.d / 2 + e), lf.c[1] + fy * (lf.d / 2 + e)];
    const hit = solid.at(q[0], q[1]);
    if (hit && s0 === null) s0 = e;
    if (!hit && s0 !== null) {
      s1 = e;
      break;
    }
  }
  if (s0 === null || s1 === null) return null;
  k.box(M.steel, -doorW / 2 - 0.05, 0, lf.d, doorW / 2 + 0.05, 0.015, lf.d + s0 + 0.01);
  const face = [lf.c[0] + fx * (lf.d / 2 + s1), lf.c[1] + fy * (lf.d / 2 + s1)];
  k.at(face[0], face[1], lf.f);
  F.liftPortal(k, M, doorW);
  return face;
}

/** the floor a drawn piece takes (plan polygons; no snapping to the wall, for the overlap tests) */
function drawnFootprints(it) {
  const rect = (c, w, d, a) => {
    const u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [c[0] + (u[0] * i * w + v[0] * j * d) / 2, c[1] + (u[1] * i * w + v[1] * j * d) / 2]);
  };
  switch (it.type) {
    case 'bed':
      return [rect(it.c, it.w, it.l, it.f - Math.PI / 2), ...it.stands.map(([x, y, w, d]) => rect([x, y], w, d, it.f - Math.PI / 2))];
    case 'sofa':
      return it.boxes.map((b) => rect([b[0], b[1]], b[2], b[3], b[6]));
    case 'dining':
    case 'ctable':
      return [rect(it.c, it.w, it.d, it.a)];
    case 'rug':
      return [];
    default:
      return it.c && it.w ? [rect(it.c, it.w, Math.max(it.d ?? 0.4, 0.3), it.f - Math.PI / 2)] : [];
  }
}

/** do two convex polygons overlap (more than touch)? */
function overlaps(a, b) {
  for (const [p, q] of [[a, b], [b, a]]) {
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
      const nx = y0 - y1, ny = x1 - x0;
      let pmin = Infinity, pmax = -Infinity, qmin = Infinity, qmax = -Infinity;
      for (const [x, y] of p) (pmin = Math.min(pmin, nx * x + ny * y)), (pmax = Math.max(pmax, nx * x + ny * y));
      for (const [x, y] of q) (qmin = Math.min(qmin, nx * x + ny * y)), (qmax = Math.max(qmax, nx * x + ny * y));
      const L = Math.hypot(nx, ny) || 1;
      if (Math.min(pmax, qmax) - Math.max(pmin, qmin) < 0.01 * L) return false;
    }
  }
  return true;
}

/**
 * Every piece the drawing has in the flat, where it is drawn and turned as drawn (furniture.py:
 * plan metres; `f` the way a piece's front faces, its back against the wall). Returns the rooms
 * that got pieces, the pieces' collision outlines (prio 0: small pieces, the first given up if they
 * shut a room off ... 3: built in), the rugs' centres (where a living room's light hangs) and the
 * rooms lit already (a pendant over the dining table).
 */
function placeDrawn({ k, M, H, apt, solid, keepout, lights, ceiling }) {
  const out = { rooms: new Set(), solids: [], rugs: [], lit: new Set() };
  const rooms = apt.data.rooms;
  const roomAt = (p) => rooms.find((r) => inside(r.poly, p[0], p[1])) ??
    rooms.reduce((b, r) => (distToPolygon(r.poly, ...p) < distToPolygon(b.poly, ...p) ? r : b));
  const dir = (f) => [Math.cos(f), Math.sin(f)];
  // a rectangle centred on c, w along angle a, d across it
  const rect = (c, w, d, a) => {
    const u = dir(a), v = [-u[1], u[0]];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [c[0] + (u[0] * i * w + v[0] * j * d) / 2, c[1] + (u[1] * i * w + v[1] * j * d) / 2]);
  };
  const piece = (poly, prio, what) => {
    out.solids.push({ poly, prio, what });
    keepout.push(poly);
  };
  // the middle of a piece's back, moved onto the face of the wall behind it (the drawn pieces
  // stand a centimetre or two off the wall, or a little into it)
  const backOf = (it, d = it.d) => {
    const [fx, fy] = dir(it.f);
    const p = [it.c[0] - (fx * d) / 2, it.c[1] - (fy * d) / 2];
    const at = (e) => solid.at(p[0] - fx * e, p[1] - fy * e);
    if (at(0)) {
      for (let e = 0; e > -0.12; e -= 0.005) if (!at(e)) return [p[0] - fx * e, p[1] - fy * e];
      return p;
    }
    for (let e = 0.005; e < 0.12; e += 0.005) if (at(e)) return [p[0] - fx * (e - 0.004), p[1] - fy * (e - 0.004)];
    return p;
  };
  // window and glass spans behind a run along a wall, in the run's frame x (no wall cabinets there)
  const glassBehind = (p, f, w) => {
    const [fx, fy] = dir(f), rx = [-fy, fx], spans = [];
    for (let t = -w / 2 + 0.025; t < w / 2; t += 0.05) {
      const q = [p[0] + rx[0] * t - fx * 0.06, p[1] + rx[1] * t - fy * 0.06];
      const hit = solid.at(...q);
      if (!hit || (hit.kind !== 'window' && hit.kind !== 'glass')) continue;
      const last = spans[spans.length - 1];
      if (last && t - last[1] < 0.06) last[1] = t + 0.025;
      else spans.push([t - 0.025, t + 0.025]);
    }
    return spans;
  };
  for (const it of apt.data.furniture ?? []) {
    const c = it.c ?? [it.boxes.reduce((a, b) => a + b[0], 0) / it.boxes.length, it.boxes.reduce((a, b) => a + b[1], 0) / it.boxes.length];
    const room = roomAt(c);
    out.rooms.add(room);
    switch (it.type) {
      case 'bed': {
        const p = backOf(it, it.l);
        k.at(p[0], p[1], it.f);
        // (the model's headboard is 12 cm wider than its bed: the headboard is the drawn width)
        F.bed(k, M, it.w - 0.12, it.l - 0.02);
        if (solid.at(p[0] - Math.cos(it.f) * 0.03, p[1] - Math.sin(it.f) * 0.03)) F.picture(k, M, Math.min(1.2, it.w * 0.65), 0.7, 1.72, 0, M.oak);
        piece(footprint(p, it.f, it.w, 0, it.l), 1, 'bed');
        for (const [x, y, w, d] of it.stands) {
          const q = backOf({ c: [x, y], f: it.f, d });
          k.at(q[0], q[1], it.f);
          F.nightstand(k, M, w, d);
          piece(footprint(q, it.f, w, 0, d), 1, 'nightstand');
        }
        break;
      }
      case 'tv': {
        const d = Math.max(it.d, 0.32), p = backOf(it);
        k.at(p[0], p[1], it.f);
        F.mediaWall(k, M, it.w, d);
        piece(footprint(p, it.f, it.w, 0, d), 2, 'tv');
        break;
      }
      case 'kitchen': {
        const d = Math.max(it.d, 0.5), p = backOf(it);
        k.at(p[0], p[1], it.f);
        F.kitchen(k, M, it.w, H, glassBehind(p, it.f, it.w), { d, sink: it.sink, hob: it.hob, bowls: it.bowls });
        piece(footprint(p, it.f, it.w, 0, d), 3, 'kitchen');
        break;
      }
      case 'toilet': {
        const p = backOf(it), w = Math.max(it.w, 0.5);
        k.at(p[0], p[1], it.f);
        F.toilet(k, M, w, it.d, H);
        keepout.push(footprint(p, it.f, w, 0, it.d));
        break;
      }
      case 'basin': {
        const p = backOf(it), w = Math.max(it.w, 0.5), d = Math.max(it.d, 0.4);
        k.at(p[0], p[1], it.f);
        F.vanity(k, M, w, H, 1, d);
        keepout.push(footprint(p, it.f, w, 0, d));
        break;
      }
      case 'bath': {
        const p = backOf(it);
        k.at(p[0], p[1], it.f);
        F.bathtub(k, M, it.w, it.d, it.tap ?? 1);
        piece(footprint(p, it.f, it.w, 0, it.d), 3, 'bath');
        break;
      }
      case 'ac': {
        const p = backOf(it);
        k.at(p[0], p[1], it.f);
        F.acUnit(k, M, it.w, it.d);
        piece(footprint(p, it.f, it.w, 0, it.d), 0, 'ac');
        break;
      }
      case 'dining': {
        k.at(it.c[0], it.c[1], it.a - Math.PI / 2);
        F.diningTable(k, M, it.w, it.d);
        piece(rect(it.c, it.w, it.d, it.a), 2, 'table');
        // the chairs as drawn, pushed in a little under the table (the drawing shows their backs)
        for (const [x, y, f] of it.chairs) {
          k.at(x - Math.cos(f) * 0.125, y - Math.sin(f) * 0.125, f);
          F.chair(k, M);
        }
        if (ceiling) {
          k.at(it.c[0], it.c[1], it.a - Math.PI / 2);
          F.pendants(k, M, it.w >= 1.4 ? [-it.w / 4, it.w / 4] : [0], 0, H, 1.55);
          lights.push({ x: it.c[0], y: it.c[1], z: 1.5, room, main: true });
          out.lit.add(room);
        }
        break;
      }
      case 'rug': {
        k.at(it.c[0], it.c[1], it.a - Math.PI / 2);
        F.rugAt(k, M, it.w, it.d, M.rugGrey);
        out.rugs.push(it.c);
        break;
      }
      case 'sofa': {
        F.sofaBoxes(k, M, it.boxes);
        for (const b of it.boxes) piece(rect([b[0], b[1]], b[2], b[3], b[6]), 1, 'sofa');
        break;
      }
      case 'armchair': {
        const [fx, fy] = dir(it.f), p = [it.c[0] - (fx * it.d) / 2, it.c[1] - (fy * it.d) / 2];
        k.at(p[0], p[1], it.f);
        F.armchair(k, M, it.w, it.d);
        piece(footprint(p, it.f, it.w, 0, it.d), 0, 'armchair');
        break;
      }
      case 'ctable': {
        k.at(it.c[0], it.c[1], it.a - Math.PI / 2);
        F.nestTable(k, M, it.w, it.d, it.h);
        piece(rect(it.c, it.w, it.d, it.a), 0, 'table');
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ---------- furniture ----------

/**
 * The four sides of the room's largest rectangle, each with what is behind it: samples every
 * 10 cm say 'wall', 'window', 'glass', 'open' (a door or an opening) or 'far' (the room goes on).
 */
function rectSides(room, r, solid) {
  const defs = [
    { a: [r.x0, r.y0], u: [1, 0], n: [0, 1], L: r.x1 - r.x0, across: r.y1 - r.y0 },
    { a: [r.x1, r.y1], u: [-1, 0], n: [0, -1], L: r.x1 - r.x0, across: r.y1 - r.y0 },
    { a: [r.x0, r.y1], u: [0, -1], n: [1, 0], L: r.y1 - r.y0, across: r.x1 - r.x0 },
    { a: [r.x1, r.y0], u: [0, 1], n: [-1, 0], L: r.y1 - r.y0, across: r.x1 - r.x0 },
  ];
  for (const s of defs) {
    s.facing = Math.atan2(s.n[1], s.n[0]);
    s.samples = [];
    const gaps = [];
    for (let t = 0.05; t < s.L; t += 0.1) {
      const x = s.a[0] + s.u[0] * t, y = s.a[1] + s.u[1] * t;
      let label = 'far';
      for (let d = 0; d <= 0.45; d += 0.03) {
        const px = x - s.n[0] * d, py = y - s.n[1] * d;
        if (inside(room.poly, px, py)) continue;
        const hit = solid.at(px - s.n[0] * 0.05, py - s.n[1] * 0.05) ?? solid.at(px, py);
        label = hit ? hit.kind : 'open';
        if (label === 'wall') {
          // the room's edge lies within the last step: find it to the millimetre
          let lo = Math.max(0, d - 0.03), hi = d;
          for (let it = 0; it < 6; it++) {
            const m = (lo + hi) / 2;
            if (inside(room.poly, x - s.n[0] * m, y - s.n[1] * m)) lo = m;
            else hi = m;
          }
          // the wall's face: walls overlap the room outlines by a few centimetres
          let e = 0;
          while (e < 0.1 && solid.at(x - s.n[0] * (lo - e - 0.002), y - s.n[1] * (lo - e - 0.002))) e += 0.005;
          gaps.push(lo - e);
        }
        break;
      }
      s.samples.push({ t, label });
    }
    gaps.sort((p, q) => p - q);
    s.gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    // contiguous stretches of solid wall
    s.free = [];
    let cur = null;
    for (const { t, label } of s.samples) {
      if (label === 'wall') {
        if (!cur) s.free.push((cur = { t0: t - 0.05, t1: t + 0.05 }));
        else cur.t1 = t + 0.05;
      } else cur = null;
    }
    for (const f of s.free) f.len = f.t1 - f.t0;
    s.free.sort((p, q) => q.len - p.len);
    // stretches of wall or window: base units (a kitchen run) can stand under a window too
    s.low = [];
    cur = null;
    for (const { t, label } of s.samples) {
      if (label === 'wall' || label === 'window') {
        if (!cur) s.low.push((cur = { t0: t - 0.05, t1: t + 0.05 }));
        else cur.t1 = t + 0.05;
      } else cur = null;
    }
    for (const f of s.low) f.len = f.t1 - f.t0;
    s.low.sort((p, q) => q.len - p.len);
    // any closed stretch (wall, window or floor-to-ceiling glass): the last resort for a bed
    s.any = [];
    cur = null;
    for (const { t, label } of s.samples) {
      if (label === 'wall' || label === 'window' || label === 'glass') {
        if (!cur) s.any.push((cur = { t0: t - 0.05, t1: t + 0.05 }));
        else cur.t1 = t + 0.05;
      } else cur = null;
    }
    for (const f of s.any) f.len = f.t1 - f.t0;
    s.any.sort((p, q) => q.len - p.len);
    s.wall = s.samples.filter((x) => x.label === 'wall').length / Math.max(1, s.samples.length);
    s.windows = s.samples.some((x) => x.label === 'window' || x.label === 'glass');
    // a point on this side, `t` along it and `d` into the room (d = -gap: against the wall)
    s.at = (t, d) => [s.a[0] + s.u[0] * t + s.n[0] * d, s.a[1] + s.u[1] * t + s.n[1] * d];
  }
  return defs;
}

/** footprint of a piece at plan point p facing f: w wide, from z0 to z1 in front of p */
function footprint(p, f, w, z0, z1) {
  const fx = Math.cos(f), fy = Math.sin(f), rx = -fy, ry = fx;
  const P = (x, z) => [p[0] + rx * x + fx * z, p[1] + ry * x + fy * z];
  return [P(-w / 2, z0), P(w / 2, z0), P(w / 2, z1), P(-w / 2, z1)];
}

/** does a footprint fit in the room, clear of door swings and fittings? (a way to walk: clear of
 * the furniture, but it may overlap the other ways) */
function fits(ctx, poly, margin = 0.02, isWay = false) {
  const { room, keepout } = ctx;
  const [a, b, , d] = poly;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = a[0] + (b[0] - a[0]) * (i / 4) + (d[0] - a[0]) * (j / 4);
      const y = a[1] + (b[1] - a[1]) * (i / 4) + (d[1] - a[1]) * (j / 4);
      if (!inside(room.poly, x, y) && distToPolygon(room.poly, x, y) > margin) return false;
      for (const q of keepout) if (!(isWay && q.way) && !(q.room && q.room !== room) && inside(q, x, y)) return false;
    }
  }
  return true;
}

/**
 * Put a piece against side s at t (centre), d0 from the side line, w wide and `depth` deep.
 * Draws it with draw() when it fits; returns its footprint or null.
 */
function place(ctx, s, t, w, depth, draw, { collide = true, keep = true, z0 = 0, clear = 0 } = {}) {
  const d0 = -s.gap + 0.005 + z0;
  const p = s.at(t, d0);
  const fp = footprint(p, s.facing, w, 0, depth);
  // `clear`: space to stand and walk in front of it, kept free of other furniture
  const front = clear ? footprint(p, s.facing, w, depth, depth + clear) : null;
  if (!fits(ctx, fp) || (front && !fits(ctx, front, 0.02, true))) return null;
  ctx.k.at(p[0], p[1], s.facing);
  draw(p);
  if (collide) ctx.addOutline(fp);
  if (keep) ctx.keepout.push(fp);
  if (front) ctx.keepout.push(Object.assign(front, { way: true, room: ctx.room }));
  return fp;
}

/** best free stretch of wall: the longest of at least `need`, optionally not on the sides in `not` */
function bestWall(sides, need, not = []) {
  let best = null;
  for (const s of sides) {
    if (not.includes(s)) continue;
    const f = s.free[0];
    if (!f || f.len < need) continue;
    if (!best || f.len > best.f.len) best = { s, f };
  }
  return best;
}

const opposite = (sides, s) => sides.find((o) => o.n[0] === -s.n[0] && o.n[1] === -s.n[1]);

/**
 * Fit a piece against the walls: every stretch of every side (longest first; `stretches` 'free'
 * for solid wall, 'low' for wall or window), the widest size from maxW down to minW, slid along
 * the stretch from its middle outwards. draw(w, s, t) draws it once the kit is placed.
 * Returns { s, t, w, fp } or null.
 */
function fitAlong(ctx, sides, { minW, maxW, depth, clear = 0, stretches = 'free', not = [], minAcross = 0, accept = null }, draw) {
  const cands = [];
  for (const s of sides) {
    if (not.includes(s) || s.across < minAcross) continue;
    for (const f of s[stretches]) if (f.len >= minW) cands.push({ s, f });
  }
  cands.sort((p, q) => q.f.len - p.f.len);
  for (const { s, f } of cands) {
    for (let w = Math.min(maxW, f.len - 0.05); w >= minW - 1e-6; w -= 0.2) {
      const mid = (f.t0 + f.t1) / 2, span = (f.len - w) / 2;
      for (let o = 0; o <= span + 1e-6; o += 0.15) {
        for (const t of o ? [mid - o, mid + o] : [mid]) {
          // (`accept`: a test of the piece once placed, e.g. that it shuts no room off; else it is
          // taken back and the next place tried)
          const m = accept && ctx.mark();
          const fp = place(ctx, s, t, w, depth, () => draw(w, s, t), { clear });
          if (fp && (!accept || accept())) return { s, t, w, fp };
          if (fp) ctx.rollback(m);
        }
      }
    }
  }
  return null;
}

/** window spans of side s within a piece centred at t, w wide, in the piece's frame x */
function windowSpans(s, t, w) {
  const out = [];
  for (const smp of s.samples) {
    if (smp.label !== 'window' || Math.abs(smp.t - t) > w / 2 + 0.05) continue;
    const x = -(smp.t - t); // the piece's frame x runs against the side's direction
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - (x + 0.05)) < 0.11) last[0] = x - 0.05;
    else out.push([x - 0.05, x + 0.05]);
  }
  return out.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]);
}

function furnish(ctx) {
  const { room, k, M, H } = ctx;
  if (room._wet) return bathroom(ctx);
  if (room.kind === 'loggia' || room.kind === 'terrace') {
    // a loggia: a small table with two chairs where it is wide enough, else left clear
    if (!ctx.sparse && room.area >= 3.5) balconyFurniture(k, M, room.poly);
    return;
  }
  const r = innerRect(room.poly, 0.06);
  const w = r.x1 - r.x0, d = r.y1 - r.y0;
  if (w < 0.9 || d < 0.9) return;
  const sides = rectSides(room, r, ctx.solid);
  const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
  const light = (x, y, z, main = false) => ctx.lights.push({ x, y, z, room, main });

  switch (room.kind) {
    case 'bedroom': {
      // the bed's head against a solid wall, with a nightstand each side if there is room: a double
      // bed if the room allows, else a narrower double or a single
      let bed = null;
      for (const bw of Math.min(w, d) >= 2.6 ? [1.6, 1.4, 0.9] : [0.9]) {
        for (const stands of [true, false]) {
          const total = bw + 0.14 + (stands ? 1.0 : 0);
          bed = fitAlong(ctx, sides, { minW: total, maxW: total, depth: 2.2, clear: 0.45, minAcross: 2.65, accept: ctx.open }, () => {
            k.save().offset(0, 1.15);
            F.rugAt(k, M, bw + 1.2, 2.0, M.rugBeige);
            k.restore();
            F.bed(k, M, bw);
            F.picture(k, M, 1.0, 0.7, 1.72, 0, M.oak);
            if (stands) {
              for (const sg of [-1, 1]) {
                k.save().offset(sg * (bw / 2 + 0.36), 0);
                F.nightstand(k, M);
                k.restore();
              }
            }
          });
          if (bed) break;
        }
        if (bed) break;
      }
      // no free wall long enough (doors and windows on every side): the bed under a window, or
      // against the glass, without nightstands
      for (const [stretches, across, clear] of [['free', 2.3, 0.25], ['low', 2.3, 0.25], ['any', 2.2, 0.2]]) {
        for (const bw of [1.4, 0.9]) {
          if (bed) break;
          bed = fitAlong(ctx, sides, { minW: bw + 0.14, maxW: bw + 0.14, depth: 2.1, clear, minAcross: across, stretches, accept: ctx.open }, () => {
            k.save().offset(0, 1.15);
            F.rugAt(k, M, bw + 1.0, 1.8, M.rugBeige);
            k.restore();
            F.bed(k, M, bw);
          });
        }
      }
      if (!bed) {
        ctx.notes.push(`bedroom ${room.area} m²: no wall for a bed`);
        break;
      }
      // wardrobe on another wall
      if (!ctx.sparse) {
        fitAlong(ctx, sides, { minW: 1.0, maxW: 2.4, depth: 0.62, clear: 0.75 }, (ww) => F.wardrobe(k, M, ww, H));
        // a plant in a free corner
        corners(ctx, sides, 0.5, () => F.plant(k, M, 0.85));
      }
      pendant(ctx, cx, cy, 'drum');
      break;
    }
    case 'living': {
      if (Math.min(w, d) < 2.4) break;
      const beforeTv = ctx.mark();
      // a sofa against a wall with the coffee table and a rug in front of it, a picture above it
      const sofaGroup = (sw2) => {
        F.sofa(k, M, sw2);
        k.save().offset(0, 0.97 + 0.45 + 0.48);
        F.coffeeTable(k, M);
        k.restore();
        k.save().offset(0, 1.3);
        F.rugAt(k, M, sw2 + 0.6, 2.2, M.rugGrey);
        k.restore();
        F.picture(k, M, 1.2, 0.8, 1.55, 1, M.blackMetal);
      };
      // last resort: the sofa on its own against any wall or window, a side table at its end
      const sofaAlone = () => {
        for (const stretches of ['free', 'low']) {
          const got = fitAlong(ctx, sides, { minW: 1.7, maxW: 2.4, depth: 0.97, clear: 0.55, stretches }, (sw2) => {
            F.sofa(k, M, sw2);
            k.save().offset(sw2 / 2 + 0.32, 0.27);
            F.sideTable(k, M);
            k.restore();
          });
          if (got) return got;
        }
        return null;
      };
      const tv = fitAlong(ctx, sides, { minW: 1.4, maxW: 2.2, depth: 0.44, clear: 0.6, minAcross: 3.0 }, (cw) => F.mediaWall(k, M, cw));
      let sofaSide = null, tvT = null, tvS = null;
      if (tv) {
        tvS = tv.s;
        tvT = tv.t;
        sofaSide = opposite(sides, tvS);
      }
      // sofa facing the TV, about 2.8 m from it (against the far wall in smaller rooms)
      const s = sofaSide ?? sides.reduce((p, q) => (q.wall > p.wall ? q : p));
      const across = s.across;
      const back = Math.max(-s.gap, across - (tvS ? 0.44 + 2.5 + 0.96 : across));
      const t = tvS ? s.L - tvT : s.L / 2; // opposite side runs the other way
      let sw = Math.min(2.6, s.L - 0.6);
      let placed = null;
      while (!placed && sw >= 1.7) {
        placed = place(ctx, s, t, sw, 0.97, () => F.sofa(k, M, sw), { z0: back + s.gap });
        if (!placed) sw -= 0.2;
      }
      if (!placed) {
        // against any other solid wall, with the coffee table in front of it
        const alt = fitAlong(ctx, sides, { minW: 1.7, maxW: 2.6, depth: 2.4, clear: 0.3, not: tvS ? [tvS] : [] }, (sw2) => sofaGroup(sw2));
        if (!alt && tv) {
          // the TV took the wall the sofa needs (a square room): sofa first, TV opposite it
          ctx.rollback(beforeTv);
          const first = fitAlong(ctx, sides, { minW: 1.7, maxW: 2.6, depth: 2.4, clear: 0.3 }, (sw2) => sofaGroup(sw2));
          if (first) fitAlong(ctx, [opposite(sides, first.s)].filter(Boolean), { minW: 1.4, maxW: 2.2, depth: 0.44, clear: 0.6 }, (cw) => F.mediaWall(k, M, cw));
          else if (!sofaAlone()) ctx.notes.push(`living ${room.area} m²: no place for the sofa`);
        } else if (!alt && !sofaAlone()) ctx.notes.push(`living ${room.area} m²: no place for the sofa`);
      }
      if (placed) {
        const dz = back + s.gap; // the sofa's back, from the side line
        const tableZ = dz + 0.97 + 0.45 + 0.48;
        place(ctx, s, t, sw + 0.8, Math.min(2.4, across - dz - 0.6), () => F.rugAt(k.offset(0, 1.2), M, sw + 0.8, 2.3, M.rugGrey), { collide: false, keep: false, z0: dz + 0.55 });
        // the coffee table only where it leaves a way past it (a narrow living room gets the sofa
        // and a side table)
        if (across - (tableZ + 0.48) >= 0.8) place(ctx, s, t, 0.96, 0.96, () => F.coffeeTable(k.offset(0, 0.48), M), { z0: tableZ - 0.48 });
        if (back > -s.gap + 0.3) {
          // floating sofa: a console behind? keep it simple: a floor lamp at its end
        } else {
          F.picture(k.at(...s.at(t, -s.gap), s.facing), M, 1.2, 0.8, 1.55, 1, M.blackMetal);
        }
        // floor lamp and side table at the sofa's ends, an armchair beside the table
        const endA = t - sw / 2 - 0.3, endB = t + sw / 2 + 0.3;
        if (endA > 0.2) place(ctx, s, endA, 0.4, 0.4, () => {
          F.floorLamp(k.offset(0, 0.25), M);
          const p = s.at(endA, dz - s.gap + 0.25);
          light(p[0], p[1], 1.4);
        }, { z0: dz });
        if (endB < s.L - 0.2) place(ctx, s, endB, 0.5, 0.5, () => F.sideTable(k.offset(0, 0.27), M), { z0: dz });
        const armT = t + sw / 2 + 0.75, armZ = tableZ;
        if (armT < s.L - 0.45 && !ctx.sparse) {
          const p = s.at(armT, armZ - s.gap);
          const f = s.facing + Math.PI / 2 * (s.u[0] * s.n[1] - s.u[1] * s.n[0] > 0 ? 1 : -1);
          const fp = footprint(p, f + Math.PI, 0.85, -0.42, 0.42);
          if (fits(ctx, fp)) {
            // turn it to face the coffee table
            const tp = s.at(t, tableZ - s.gap);
            const face = Math.atan2(tp[1] - p[1], tp[0] - p[0]);
            const back = [p[0] - Math.cos(face) * 0.42, p[1] - Math.sin(face) * 0.42];
            k.at(back[0], back[1], face);
            F.armchair(k, M);
            ctx.addOutline(fp);
            ctx.keepout.push(fp);
          }
        }
      }
      if (!ctx.sparse) {
        corners(ctx, sides, 0.5, () => F.plant(k, M, 1.1));
        corners(ctx, sides, 0.5, () => F.plant(k, M, 0.8));
      }
      pendant(ctx, cx, cy, 'drum');
      break;
    }
    case 'kitchen': {
      // the run along a wall (under a window too: the sink goes there), 1.5 to 4.4 m long
      const run = fitAlong(ctx, sides, { minW: 1.2, maxW: 4.4, depth: 0.64, clear: 0.9, stretches: 'low' }, (len, s, t) => F.kitchen(k, M, len, H, windowSpans(s, t, len)));
      let runSide = null;
      if (!run) ctx.notes.push(`kitchen ${room.area} m²: no wall for the kitchen run`);
      if (run) {
        // an island 1.1 m in front of a long run in a deep room
        const { s, t, w: len } = run;
        runSide = s;
        if (s.across >= 4.6 && len >= 2.6 && !ctx.sparse) {
          const iw = Math.min(2.2, len - 0.4);
          const p = s.at(t, -s.gap + 0.64 + 1.1 + 0.45);
          const ifp = footprint(p, s.facing, iw, -0.45, 1.1);
          if (fits(ctx, ifp)) {
            k.at(p[0], p[1], s.facing);
            F.island(k, M, iw);
            ctx.addOutline(footprint(p, s.facing, iw + 0.04, -0.47, 0.47));
            ctx.keepout.push(ifp);
            if (ctx.ceiling) F.pendants(k, M, [-iw / 4, iw / 4], 0, H, 1.6);
            light(p[0], p[1], 1.65, true);
          }
        }
      }
      // dining table in the most open part of the room
      const tw = Math.min(w, d) >= 3.2 ? 1.8 : 1.4;
      const spotT = ctx.sparse ? null : openSpot(ctx, r, tw + 0.2, 0.9 + 1.4);
      if (spotT) {
        const { p, f } = spotT;
        k.at(p[0], p[1], f);
        const ls = F.dining(k, M, tw, 0.9, ctx.ceiling ? H : 0);
        for (const l of ls) {
          const fx = Math.cos(f), fy = Math.sin(f);
          light(p[0] - fy * l.x + fx * l.z, p[1] + fx * l.x + fy * l.z, l.y, true);
          break;
        }
        ctx.addOutline(footprint([p[0] - Math.cos(f) * 0.45, p[1] - Math.sin(f) * 0.45], f, tw, 0, 0.9));
      }
      if (!ctx.sparse) corners(ctx, sides.filter((s) => s !== runSide), 0.45, () => F.plant(k, M, 0.9));
      break;
    }
    case 'hall': {
      const con = fitAlong(ctx, sides, { minW: 0.8, maxW: 1.3, depth: 0.36, clear: 0.7 }, (cw) => F.console_(k, M, cw));
      if (!ctx.sparse) fitAlong(ctx, sides, { minW: 0.9, maxW: 0.9, depth: 0.2, clear: 0.6, not: con ? [con.s] : [], minAcross: 1.3 }, () => F.coatRack(k, M, 0.9));
      if (Math.min(w, d) >= 1.5 && Math.max(w, d) >= 3) {
        const long = w > d ? sides[0] : sides[2];
        place(ctx, long, long.L / 2, Math.min(long.L - 0.6, 3), Math.min(1.0, long.across - 0.4), () => F.rugAt(k.offset(0, 0.5), M, Math.min(long.L - 0.6, 3), Math.min(1.0, long.across - 0.4) - 0.05, M.rugGrey), { collide: false, keep: false, z0: (long.across - Math.min(1.0, long.across - 0.4)) / 2 });
      }
      if (!ctx.sparse) corners(ctx, sides, 0.45, () => F.plant(k, M, 0.75));
      break;
    }
    case 'storage': {
      const s = sides.reduce((p, q) => ((q.free[0]?.len ?? 0) > (p.free[0]?.len ?? 0) ? q : p));
      if (s.free[0] && s.across >= 0.9) place(ctx, s, (s.free[0].t0 + s.free[0].t1) / 2, s.free[0].len - 0.05, 0.4, () => F.shelving(k, M, s.free[0].len - 0.05, Math.min(H - 0.1, 2.3)));
      break;
    }
    default:
      break;
  }
}

/** the most open spot of the rectangle for a w x d piece (both turns), clear of everything */
function openSpot(ctx, r, w, d) {
  let best = null;
  for (let x = r.x0 + 0.3; x <= r.x1 - 0.3; x += 0.15) {
    for (let y = r.y0 + 0.3; y <= r.y1 - 0.3; y += 0.15) {
      for (const f of [0, Math.PI / 2]) {
        const fp = footprint([x - Math.cos(f) * (d / 2), y - Math.sin(f) * (d / 2)], f, w, 0, d);
        if (!fits(ctx, fp, 0)) continue;
        // prefer the middle of the free space: distance to the room edge and to other pieces
        let clear = distToEdge(ctx.room.poly, x, y);
        for (const q of ctx.keepout) clear = Math.min(clear, distToPolygon(q, x, y));
        if (!best || clear > best.clear) best = { p: [x, y], f, clear };
      }
    }
  }
  return best;
}

function distToEdge(p, x, y) {
  let d = Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) d = Math.min(d, distToSegment(x, y, p[j][0], p[j][1], p[i][0], p[i][1]).d);
  return d;
}

/** a piece in the first free corner where two walls meet */
function corners(ctx, sides, size, draw) {
  for (const s of sides) {
    for (const t of [0.3, s.L - 0.3]) {
      const near = s.samples.find((x) => Math.abs(x.t - t) < 0.1);
      if (!near || near.label !== 'wall') continue;
      const p = s.at(t, -s.gap + 0.3);
      const fp = footprint(s.at(t, -s.gap), s.facing, size, 0, size + 0.05);
      if (!fits(ctx, fp)) continue;
      ctx.k.at(p[0], p[1], s.facing);
      draw();
      ctx.addOutline(fp);
      ctx.keepout.push(fp);
      return true;
    }
  }
  return false;
}

/** ceiling light: a linen drum pendant in the middle of the room */
function pendant(ctx, x, y, kind) {
  const { k, M, H, room } = ctx;
  if (!ctx.ceiling) return;
  k.at(x, y, 0);
  if (kind === 'drum') {
    k.cyl(M.blackMetal, 0, H - 0.012, 0, 0.06, H, 20);
    k.cyl(M.blackMetal, 0, H - 0.55, 0, 0.003, H, 6);
    k.lathe(M.shade, [[0.3, 0], [0.3, 0.26]], 0, H - 0.8, 0, 48);
    k.cyl(M.shade, 0, H - 0.8, 0, 0.29, H - 0.795, 48);
    k.cyl(M.brass, 0, H - 0.56, 0, 0.012, H - 0.55, 12);
    ctx.lights.push({ x, y, z: H - 0.62, room, main: true });
  }
}

/** recessed downlights in halls, kitchens and bathrooms (the real light goes in the middle) */
function downlights(ctx) {
  const { k, M, H, room } = ctx;
  if (!['hall', 'kitchen', 'bath', 'storage'].includes(room.kind) && !room._wet) return;
  const r = innerRect(room.poly, 0.3);
  const w = r.x1 - r.x0, d = r.y1 - r.y0;
  if (w < 0.2 || d < 0.2) return;
  const nx = Math.max(1, Math.round(w / 1.3)), ny = Math.max(1, Math.round(d / 1.3));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = r.x0 + (w * (i + 0.5)) / nx, y = r.y0 + (d * (j + 0.5)) / ny;
      k.at(x, y, 0);
      k.cyl(M.chrome, 0, H - 0.004, 0, 0.05, H - 0.001, 24);
      k.cyl(M.downlight, 0, H - 0.006, 0, 0.035, H - 0.003, 24);
    }
  }
  ctx.lights.push({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, z: H - 0.03, room, main: false, spot: true });
}

function bathroom(ctx) {
  const { room, k, M } = ctx;
  const r = innerRect(room.poly, 0.06);
  const sides = rectSides(room, r, ctx.solid);
  // towel rail on a free wall, a bath mat
  const spot = bestWall(sides, 0.7);
  if (spot) place(ctx, spot.s, (spot.f.t0 + spot.f.t1) / 2, 0.6, 0.12, () => F.towelRail(k, M), { collide: false });
  const w = r.x1 - r.x0, d = r.y1 - r.y0;
  if (w > 1.2 && d > 1.2) {
    const s = sides[0];
    place(ctx, s, s.L / 2, 0.8, 0.5, () => F.rugAt(k.offset(0, 0.25), M, 0.8, 0.5, M.towel), { collide: false, keep: false, z0: s.across / 2 - 0.25 + s.gap });
  }
}

function balconyFurniture(k, M, poly) {
  const [x, y] = interiorPoint(poly);
  if (distToPolygon(poly, x, y) > 0) return;
  k.at(x, y, 0);
  k.cyl(M.blackMetal, 0, 0, 0, 0.2, 0.01, 20);
  k.cyl(M.blackMetal, 0, 0, 0, 0.02, 0.72, 10);
  k.cyl(M.oak, 0, 0.72, 0, 0.32, 0.75, 32);
  for (const dx of [-0.65, 0.65]) {
    if (!inside(poly, x + dx, y)) continue;
    k.at(x + dx, y, dx > 0 ? Math.PI : 0).offset(0, -0.25);
    F.chair(k, M);
  }
}
