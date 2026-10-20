// One residential floor built from the architect's plan: room floors, walls and columns,
// windows and glazing, balconies, bathroom fittings from the drawing, and furniture.
// Used for the cut-away floor view and, with a ceiling and lights, for the walk-through.
//
// The drawing gives walls, windows and room outlines but no doors or furniture. Both are worked
// out here: every room edge is probed from inside to find what is behind it (wall, window,
// glazing or nothing); a gap of door width between two rooms gets a door, its frame and the wall
// above it; furniture goes against solid walls, away from door swings and windows, and is
// checked to fit inside the room (src/interior/ has the models, materials and textures).
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
    fittings(apt).some((fx) => fixtureKind(fx) === 'toilet' && inside(room.poly, ...centre(fx.poly))));
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
  for (const w of plan.windows) {
    k.world().add(M.wall, prism(w, 0, SILL));
    k.world().add(M.wall, prism(w, H - HEAD, H));
  }

  // ---- windows: glass (frosted in bathrooms), frames, sills, curtains ----
  const roomOf = (x, y) => roomsAt.at(x, y)?.data ?? null;
  for (const w of plan.windows) {
    const ax = axisOf(w);
    const thick = ax.s1 - ax.s0, mid = (ax.s0 + ax.s1) / 2;
    // which side is the room?
    let n = null, owner = null;
    for (const sgn of [1, -1]) {
      const d = sgn > 0 ? ax.s1 + 0.15 : ax.s0 - 0.15;
      const r = roomOf(ax.cx + ax.v[0] * d, ax.cy + ax.v[1] * d);
      if (r) { n = [ax.v[0] * sgn, ax.v[1] * sgn]; owner = r; break; }
    }
    const glass = owner?.room._wet ? M.frosted : M.glass;
    k.world().add(glass, prism(w, SILL, H - HEAD));
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
    if (fitHere && ['living', 'bedroom'].includes(owner.room.kind)) curtains(k, M, ia, ib, n, H, len);
    if (fitHere && !owner.room._wet && len > 0.7) radiator(k, M, ia, ib, n, len);
  }
  // floor-to-ceiling glazing: glass, then mullions and rails along its inner face
  for (const w of plan.glazing) {
    k.world().add(M.glass, prism(w, 0, H));
    glazingFrame(k, M, w, H, roomOf, fitted, (x, y) => (solid.at(x, y)?.kind === 'glass' ? solid.at(x, y) : null));
  }

  // ---- per room: what is behind each edge; doors; skirting and tiles ----
  // (keepout: plan polygons furniture must stay out of - door swings, the way through openings)
  const doors = [], leaves = []; // centres of the doorways fitted so far, and of those with a leaf
  const keepout = []; // plan polygons furniture must stay out of (door swings)
  const roomInfo = new Map();
  // doors open into the rooms rather than into the hall, but out of the small rooms (bathrooms,
  // WCs, wardrobes, loggias), where an open leaf would stand in the way
  const order = (r) => (['bath', 'wc', 'storage', 'loggia'].includes(r.kind) ? 2 : r.kind === 'hall' ? 1 : 0);
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
        keepout.push(poly);
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
      // doors: door-wide gaps with wall on both sides
      runs.forEach((r) => {
        if (r.kind !== 'open' || r.len < 0.55 || r.len > 1.3) return;
        // the slot through the wall: where the wall ends beside the gap, across its thickness
        // (s along n, 0 = this run; the outline may run along the wall face or inside the gap)
        const side = (p, sgn, s) => solid.at(p[0] - r.u[0] * 0.05 * sgn + r.n[0] * s, p[1] - r.u[1] * 0.05 * sgn + r.n[1] * s)?.kind === 'wall';
        const inWall = (s) => side(r.a, 1, s) && side(r.b, -1, s);
        let s0 = null, s1 = null;
        for (let s = -0.6; s <= 0.3; s += 0.01) {
          if (inWall(s)) {
            if (s0 === null) s0 = s;
            s1 = s;
          } else if (s0 !== null && s1 > -0.02) break;
          else if (s0 !== null) s0 = s1 = null;
        }
        if (s0 === null || s1 - s0 < 0.05) return; // no wall beside the gap: an open plan
        s0 -= 0.005;
        s1 += 0.005;
        const mx = (r.a[0] + r.b[0]) / 2, my = (r.a[1] + r.b[1]) / 2, sm = (s0 + s1) / 2;
        const behind = roomsAt.at(mx + r.n[0] * (s0 - 0.15), my + r.n[1] * (s0 - 0.15));
        const entrance = !behind || behind.kind === 'common' || behind.data.apt !== apt;
        const centre = [mx + r.n[0] * sm, my + r.n[1] * sm];
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
        if (seen(leaves)) return;
        // the leaf, open 90 degrees into this room, hinged at the end nearer a corner
        // a leaf only in door-sized openings (wider ones are passages without a door)
        if (r.len > 1.15 || s1 - s0 > 0.45) return;
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
        keepout.push([h, tip, [tip[0] + sx, tip[1] + sy], [h[0] + sx, h[1] + sy]]);
      });
    }
  }

  // ---- fittings from the drawing, furniture ----
  for (const apt of fitted) {
    for (const fx of fittings(apt)) {
      const room = apt.data.rooms.find((r) => inside(r.poly, ...centre(fx.poly)));
      const placedFx = placeFixture(k, M, fx, room, H);
      if (placedFx) {
        // a fitting that reaches into the clear zone in front of a doorway does not shut the room:
        // it is drawn, but the visitor can pass it
        const box = placedFx.box;
        const overlaps = (z) => box.some((p) => inside(z.poly, ...p)) || z.poly.some((p) => inside(box, ...p));
        if (placedFx.solid && !zones.some(overlaps)) addOutline(box, 'fixture');
        keepout.push(box);
      }
    }
    // in the flat being walked through, no room may be shut off by furniture: after each room
    // the way from the entrance is checked, and a room that blocks it is furnished again with
    // the essentials only (or left empty)
    const check = walk === apt;
    const start = check ? interiorPoint(entranceHall(apt).poly) : null;
    const before = check ? reachableRooms(apt, segments, start) : null;
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
      const snap = mark();
      for (const sparse of [false, true]) {
        // ceiling fittings only under a ceiling (not in the cut-away view)
        const ctx = { k, M, H, room, apt, keepout, addOutline: (p) => addOutline(p, room.kind), lights, solid, runs: roomInfo.get(room), ceiling: !!walk, notes, sparse, mark, rollback };
        furnish(ctx);
        if (ctx.ceiling) downlights(ctx);
        if (!check) break;
        const now = reachableRooms(apt, segments, start);
        if ([...before].every((i) => now.has(i))) break;
        rollback(snap);
        notes.push(`${room.kind} ${room.area} m²: ${sparse ? 'left empty' : 'essentials only'}, to keep the way through`);
      }
    }
  }
  k.build(group, own);

  // ---- ceiling and lights for the walk ----
  let spawn = null, outline = null;
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

    // start in the hall, looking into the largest room
    // the drawing's entrance hall ("Даҳлез"), else any hall, else the smallest real room
    const rooms = [...walk.data.rooms].sort((p, q) => q.area - p.area);
    const hall = entranceHall(walk);
    const [sx, sy] = interiorPoint(hall.poly);
    const [tx, ty] = interiorPoint(rooms[0].poly);
    // look the way with the widest clear view (open over the whole field of view, not through a
    // doorway's slot), leaning a little towards the largest room
    const toRoom = Math.atan2(ty - sy, tx - sx);
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
    let best = toRoom, bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      let open = 0;
      for (let j = -5; j <= 5; j++) open += Math.min(dists[(i + j + N) % N], 8); // +-25 degrees
      const a = (i / N) * Math.PI * 2;
      const score = open * (1 + 0.2 * Math.cos(a - toRoom));
      if (score > bestScore) [bestScore, best] = [score, a];
    }
    const s0 = frame.toScene(sx, sy), t0 = frame.toScene(sx + Math.cos(best), sy + Math.sin(best));
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

// ---------- fittings from the drawing ----------

/**
 * The fittings of a flat as drawn: the drawing outlines many of them twice (a bath's rim and its
 * inner tub, a basin's counter and its bowl), so overlapping outlines are merged into one fitting
 * (the bounding box of all of them, the point count of the most detailed one).
 * Returns [{ poly, n, b }] (cached on the flat's data).
 */
function fittings(apt) {
  if (apt.data._fittings) return apt.data._fittings;
  const items = apt.data.fixtures.map((fx) => ({ b: bbox(fx), n: fx.length }));
  const overlap = (p, q) => Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 0.02 && Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) > 0.02;
  const groups = [];
  for (const it of items) {
    const hit = groups.filter((g) => overlap(g.b, it.b));
    const g = { b: { ...it.b }, n: it.n };
    for (const h of hit) {
      g.b = { x0: Math.min(g.b.x0, h.b.x0), y0: Math.min(g.b.y0, h.b.y0), x1: Math.max(g.b.x1, h.b.x1), y1: Math.max(g.b.y1, h.b.y1) };
      g.n = Math.max(g.n, h.n);
      groups.splice(groups.indexOf(h), 1);
    }
    groups.push(g);
  }
  // two basins drawn edge to edge along a wall are one double vanity
  const basinSized = (g) => g.n < 15 && Math.min(g.b.x1 - g.b.x0, g.b.y1 - g.b.y0) >= 0.3 && Math.max(g.b.x1 - g.b.x0, g.b.y1 - g.b.y0) < 0.95;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const p = groups[i], q = groups[j];
      if (!basinSized(p) || !basinSized(q) || p.double || q.double) continue;
      const sameRowY = Math.abs(p.b.y0 - q.b.y0) < 0.05 && Math.abs(p.b.y1 - q.b.y1) < 0.05;
      const sameRowX = Math.abs(p.b.x0 - q.b.x0) < 0.05 && Math.abs(p.b.x1 - q.b.x1) < 0.05;
      const gapX = Math.max(p.b.x0, q.b.x0) - Math.min(p.b.x1, q.b.x1), gapY = Math.max(p.b.y0, q.b.y0) - Math.min(p.b.y1, q.b.y1);
      // side by side along their long sides' direction (x for a row in y, y for a column in x)
      const wideX = p.b.x1 - p.b.x0 > p.b.y1 - p.b.y0;
      if ((sameRowY && wideX && gapX < 0.06) || (sameRowX && !wideX && gapY < 0.06)) {
        p.b = { x0: Math.min(p.b.x0, q.b.x0), y0: Math.min(p.b.y0, q.b.y0), x1: Math.max(p.b.x1, q.b.x1), y1: Math.max(p.b.y1, q.b.y1) };
        p.double = true;
        groups.splice(j, 1);
        j--;
      }
    }
  }
  apt.data._fittings = groups.map(({ b, n, double }) => ({ b, n, double: !!double, poly: [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] }));
  return apt.data._fittings;
}

function fixtureKind(fx) {
  const b = fx.b, w = b.x1 - b.x0, h = b.y1 - b.y0;
  const L = Math.max(w, h), S = Math.min(w, h);
  if (S < 0.2) return null; // a line on the drawing (a screen or a step), not a fitting
  if (fx.double) return 'basin';
  if (L >= 1.6 && S >= 0.55) return 'bath';
  if (L >= 1.25 && S >= 0.45 && L < 1.6) return 'laundry';
  if (fx.n >= 15 && L < 1) return 'toilet';
  if (S < 0.3 && L > 0.7 && L < 1.3) return 'cabinet';
  if (fx.double || (L < 0.95 && S >= 0.3)) return 'basin';
  return null;
}

/**
 * Draws a fitting in its outline from the drawing. Returns { box, solid }: the footprint other
 * pieces keep out of, and whether it is also something to walk round (a WC or a basin is only
 * stood at: walking up to it must work, or a small WC would be shut off).
 */
function placeFixture(k, M, fx, room, H) {
  const kind = fixtureKind(fx);
  if (!kind || !room) return null;
  const isWet = room._wet;
  if (kind === 'basin' && !isWet) return null; // pairs of small rectangles in dry rooms: not furniture
  const b = fx.b, w = b.x1 - b.x0, h = b.y1 - b.y0;
  // the side against the wall: of the two sides across the depth, the one nearer the room's edge
  const deepAlongY = kind === 'toilet' ? h > w : h < w;
  const wide = deepAlongY ? w : h, deep = deepAlongY ? h : w;
  const cands = deepAlongY
    ? [{ p: [(b.x0 + b.x1) / 2, b.y0], f: Math.PI / 2 }, { p: [(b.x0 + b.x1) / 2, b.y1], f: -Math.PI / 2 }]
    : [{ p: [b.x0, (b.y0 + b.y1) / 2], f: 0 }, { p: [b.x1, (b.y0 + b.y1) / 2], f: Math.PI }];
  const edge = (p) => {
    let d = Infinity;
    const q = room.poly;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) d = Math.min(d, distToSegment(p[0], p[1], q[j][0], q[j][1], q[i][0], q[i][1]).d);
    return d;
  };
  const c = edge(cands[0].p) <= edge(cands[1].p) ? cands[0] : cands[1];
  k.at(c.p[0], c.p[1], c.f);
  if (kind === 'toilet') F.toilet(k, M, wide, deep, H);
  else if (kind === 'basin') F.vanity(k, M, Math.max(0.6, wide), H, fx.double ? 2 : 1);
  else if (kind === 'bath') F.bathtub(k, M, wide, deep);
  else if (kind === 'laundry') F.laundry(k, M, wide, deep);
  else if (kind === 'cabinet') F.shoeCabinet(k, M, wide, Math.max(0.25, deep));
  const box = kind === 'basin' ? footprint(c.p, c.f, Math.max(0.6, wide), 0, 0.5) : fx.poly;
  return { box, solid: kind !== 'toilet' && kind !== 'basin' };
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

/** does a footprint fit in the room, clear of door swings and fittings? */
function fits(ctx, poly, margin = 0.02) {
  const { room, keepout } = ctx;
  const [a, b, , d] = poly;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = a[0] + (b[0] - a[0]) * (i / 4) + (d[0] - a[0]) * (j / 4);
      const y = a[1] + (b[1] - a[1]) * (i / 4) + (d[1] - a[1]) * (j / 4);
      if (!inside(room.poly, x, y) && distToPolygon(room.poly, x, y) > margin) return false;
      for (const q of keepout) if (inside(q, x, y)) return false;
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
  if (!fits(ctx, fp) || (front && !fits(ctx, front))) return null;
  ctx.k.at(p[0], p[1], s.facing);
  draw(p);
  if (collide) ctx.addOutline(fp);
  if (keep) ctx.keepout.push(fp);
  if (front) ctx.keepout.push(front);
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
function fitAlong(ctx, sides, { minW, maxW, depth, clear = 0, stretches = 'free', not = [], minAcross = 0 }, draw) {
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
          const fp = place(ctx, s, t, w, depth, () => draw(w, s, t), { clear });
          if (fp) return { s, t, w, fp };
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
          bed = fitAlong(ctx, sides, { minW: total, maxW: total, depth: 2.2, clear: 0.45, minAcross: 2.65 }, () => {
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
          else ctx.notes.push(`living ${room.area} m²: no place for the sofa`);
        } else if (!alt) ctx.notes.push(`living ${room.area} m²: no place for the sofa`);
      }
      if (placed) {
        const dz = back + s.gap; // the sofa's back, from the side line
        const tableZ = dz + 0.97 + 0.45 + 0.48;
        place(ctx, s, t, sw + 0.8, Math.min(2.4, across - dz - 0.6), () => F.rugAt(k.offset(0, 1.2), M, sw + 0.8, 2.3, M.rugGrey), { collide: false, keep: false, z0: dz + 0.55 });
        place(ctx, s, t, 0.96, 0.96, () => F.coffeeTable(k.offset(0, 0.48), M), { z0: tableZ - 0.48 });
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
