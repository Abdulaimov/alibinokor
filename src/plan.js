// 2D floor plan of an apartment, drawn from the architect's plan (same orientation as the drawings).
import { PLANS } from './config.js';
import { bounds, centroid, interiorPoint } from './geometry.js';
import { num, roomName } from './text.js';
import { L } from './i18n.js';

const FILL = {
  living: '#f6eee1', kitchen: '#f3ead8', bedroom: '#e9f0f6', hall: '#f1f0ec', bath: '#e1eef3', wc: '#e1eef3', storage: '#ecebe7',
  loggia: '#eceae4', terrace: '#e8eee0',
};

export function planTransform(apt, cw, ch, pad) {
  const pts = [...apt.data.outline, ...apt.data.balconies.flatMap((b) => b.poly)];
  const b = bounds(pts);
  const s = Math.min((cw - 2 * pad) / (b.x1 - b.x0), (ch - 2 * pad) / (b.y1 - b.y0));
  const ox = (cw - (b.x1 - b.x0) * s) / 2, oy = (ch - (b.y1 - b.y0) * s) / 2;
  return { s, px: (x) => ox + (x - b.x0) * s, py: (y) => oy + (b.y1 - y) * s, b };
}

export function drawPlan(canvas, apt, { pad = 14, labels = true } = {}) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cw = canvas.clientWidth || canvas.width, ch = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  const T = planTransform(apt, cw, ch, pad);
  const path = (poly) => {
    g.beginPath();
    poly.forEach(([x, y], i) => (i ? g.lineTo(T.px(x), T.py(y)) : g.moveTo(T.px(x), T.py(y))));
    g.closePath();
  };

  // only this apartment: clip to its outline and balconies
  g.save();
  g.beginPath();
  for (const poly of [apt.data.outline, ...apt.data.balconies.map((b) => b.poly)]) {
    poly.forEach(([x, y], i) => (i ? g.lineTo(T.px(x), T.py(y)) : g.moveTo(T.px(x), T.py(y))));
    g.closePath();
  }
  g.clip();
  for (const b of apt.data.balconies) {
    path(b.poly);
    g.fillStyle = '#eceae4';
    g.fill();
  }
  for (const r of apt.data.rooms) {
    path(r.poly);
    g.fillStyle = FILL[r.kind] ?? '#f2f2f2';
    g.fill();
  }
  // the furniture and fittings as the architect drew them
  g.lineWidth = 1;
  for (const it of apt.data.furniture ?? []) drawPiece(g, T, it);
  g.restore();

  // walls, columns and glass of the whole floor, around the apartment
  const plan = PLANS[apt.plan];
  g.save();
  g.beginPath();
  g.rect(T.px(T.b.x0) - 6, T.py(T.b.y1) - 6, (T.b.x1 - T.b.x0) * T.s + 12, (T.b.y1 - T.b.y0) * T.s + 12);
  g.clip();
  g.fillStyle = '#2b2f36';
  for (const w of [...plan.walls, ...plan.struct]) {
    path(w);
    g.fill();
  }
  g.fillStyle = '#5fa4d6';
  for (const w of [...plan.windows, ...plan.glazing]) {
    path(w);
    g.fill();
  }
  g.restore();

  // apartment outline
  path(apt.data.outline);
  g.strokeStyle = '#9a6a3c';
  g.lineWidth = 2;
  g.stroke();

  if (labels) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const r of [...apt.data.rooms, ...apt.data.balconies]) {
      if (r.area < 3.5) continue;
      const [x, y] = r.area > 6 ? interiorPoint(r.poly) : centroid(r.poly);
      const small = r.area < 9;
      g.fillStyle = '#2b2f36';
      const nameFont = (px) => (g.font = `600 ${px}px system-ui, -apple-system, sans-serif`);
      let size = small ? 9 : 11;
      nameFont(size);
      // a name wider than the room ("Семейная комната") goes on two lines, in the small size if
      // it still doesn't fit
      const { x0, x1 } = bounds(r.poly);
      const roomW = Math.abs(T.px(x1) - T.px(x0)), name = roomName(r.name);
      const lines = name.includes(' ') && g.measureText(name).width > roomW * 0.9 ? name.split(' ') : [name];
      if (size > 9 && Math.max(...lines.map((l) => g.measureText(l).width)) > roomW * 0.9) nameFont((size = 9));
      const lh = size + 1, top = T.py(y) - 6 - ((lines.length - 1) * lh) / 2;
      // kept inside the canvas (a room on the plan's edge has its label point near it)
      const half = Math.max(...lines.map((l) => g.measureText(l).width)) / 2 + 2;
      const cx = Math.min(Math.max(T.px(x), half), cw - half);
      // (a light halo keeps the names readable over the furniture)
      g.lineWidth = 3;
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      lines.forEach((l, i) => g.strokeText(l, cx, top + i * lh));
      lines.forEach((l, i) => g.fillText(l, cx, top + i * lh));
      g.fillStyle = '#6b7280';
      g.font = `${small ? 9 : 10}px system-ui, -apple-system, sans-serif`;
      g.strokeText(`${num(+r.area.toFixed(1))} ${L().m2}`, cx, top + (lines.length - 1) * lh + 13);
      g.fillText(`${num(+r.area.toFixed(1))} ${L().m2}`, cx, top + (lines.length - 1) * lh + 13);
    }
  }
  return T;
}

// ---------- furniture symbols (outlines in plan metres, like the drawing) ----------

const STROKE = 'rgba(40, 45, 55, 0.36)';

/** a rectangle centred on c, w along angle a, d across it */
function rectAt(c, w, d, a) {
  const u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [c[0] + (u[0] * i * w + v[0] * j * d) / 2, c[1] + (u[1] * i * w + v[1] * j * d) / 2]);
}

/** a piece against the wall: its back at the middle of the drawn back, facing f; a point x along it and z out */
function wallFrame(it, d = it.d) {
  const f = [Math.cos(it.f), Math.sin(it.f)], r = [-f[1], f[0]];
  const b = [it.c[0] - (f[0] * d) / 2, it.c[1] - (f[1] * d) / 2];
  return (x, z) => [b[0] + r[0] * x + f[0] * z, b[1] + r[1] * x + f[1] * z];
}

function drawPiece(g, T, it) {
  const poly = (pts, fill = '#ffffff') => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(T.px(x), T.py(y)) : g.moveTo(T.px(x), T.py(y))));
    g.closePath();
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    g.strokeStyle = STROKE;
    g.stroke();
  };
  // rx along the plan angle a, ry across it
  const ellipse = (c, rx, ry, a) => {
    g.beginPath();
    g.ellipse(T.px(c[0]), T.py(c[1]), rx * T.s, ry * T.s, -a, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.strokeStyle = STROKE;
    g.stroke();
  };
  const box = (P, x0, z0, x1, z1, fill) => poly([P(x0, z0), P(x1, z0), P(x1, z1), P(x0, z1)], fill);
  switch (it.type) {
    case 'rug':
      poly(rectAt(it.c, it.w, it.d, it.a), '#f3efe8');
      break;
    case 'bed': {
      const P = wallFrame(it, it.l), w = it.w / 2;
      box(P, -w, 0, w, it.l);
      box(P, -w + 0.06, 0.08, -0.04, 0.42);
      box(P, 0.04, 0.08, w - 0.06, 0.42);
      const [a, b] = [P(-w, 0.62), P(w, 0.62)];
      g.beginPath();
      g.moveTo(T.px(a[0]), T.py(a[1]));
      g.lineTo(T.px(b[0]), T.py(b[1]));
      g.stroke();
      for (const [x, y, sw, sd] of it.stands) poly(rectAt([x, y], sw, sd, it.f - Math.PI / 2));
      break;
    }
    case 'sofa':
      for (const b of it.boxes) poly(rectAt([b[0], b[1]], b[2], b[3], b[6]), b[7] === 'seat' ? '#ffffff' : '#f1efeb');
      break;
    case 'armchair': {
      const P = wallFrame(it), w = it.w / 2;
      box(P, -w, 0, w, it.d);
      box(P, -w + 0.12, 0.18, w - 0.12, it.d - 0.02);
      break;
    }
    case 'ctable':
      poly(rectAt(it.c, it.w, it.d, it.a));
      break;
    case 'dining':
      for (const [x, y, f] of it.chairs) poly(rectAt([x - Math.cos(f) * 0.08, y - Math.sin(f) * 0.08], 0.42, 0.4, f - Math.PI / 2));
      poly(rectAt(it.c, it.w, it.d, it.a));
      break;
    case 'tv': {
      const P = wallFrame(it), w = it.w / 2;
      box(P, -w, 0, w, Math.max(it.d, 0.32) * 0.7);
      break;
    }
    case 'kitchen': {
      const d = Math.max(it.d, 0.5), P = wallFrame(it, d), w = it.w / 2;
      box(P, -w, 0, w, d);
      if (it.sink !== undefined) {
        const n = it.bowls ?? 1, bw = n === 2 ? 0.34 : 0.4;
        for (let i = 0; i < n; i++) {
          const x = it.sink + (n === 2 ? (i - 0.5) * 0.38 : 0);
          box(P, x - bw / 2, 0.1, x + bw / 2, d - 0.08);
        }
      }
      if (it.hob !== undefined) {
        box(P, it.hob - 0.27, 0.06, it.hob + 0.27, d - 0.04);
        for (const [dx, dz] of [[-0.12, 0.16], [0.12, 0.16], [-0.12, d - 0.2], [0.12, d - 0.2]]) {
          const c = P(it.hob + dx, dz);
          g.beginPath();
          g.arc(T.px(c[0]), T.py(c[1]), 0.08 * T.s, 0, Math.PI * 2);
          g.stroke();
        }
      }
      break;
    }
    case 'toilet': {
      const P = wallFrame(it), w = Math.max(it.w, 0.36) / 2;
      box(P, -w, 0, w, 0.18);
      ellipse(P(0, 0.18 + (it.d - 0.18) / 2), w * 0.95, (it.d - 0.18) / 2, it.f + Math.PI / 2);
      break;
    }
    case 'basin': {
      const P = wallFrame(it), w = it.w / 2;
      box(P, -w, 0, w, it.d);
      ellipse(P(0, it.d / 2 + 0.02), w * 0.7, it.d * 0.32, it.f + Math.PI / 2);
      break;
    }
    case 'bath': {
      const P = wallFrame(it), w = it.w / 2;
      box(P, -w, 0, w, it.d);
      ellipse(P(0, it.d / 2), w - 0.08, it.d / 2 - 0.08, it.f + Math.PI / 2);
      break;
    }
    case 'ac': {
      const P = wallFrame(it), w = it.w / 2;
      box(P, -w, 0, w, it.d, '#f4f4f2');
      break;
    }
    default:
      break;
  }
}

