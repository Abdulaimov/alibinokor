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
  g.fillStyle = '#ffffff';
  g.strokeStyle = 'rgba(40, 45, 55, 0.45)';
  g.lineWidth = 1;
  for (const f of apt.data.fixtures) {
    path(f);
    g.fill();
    g.stroke();
  }
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
      lines.forEach((l, i) => g.fillText(l, cx, top + i * lh));
      g.fillStyle = '#6b7280';
      g.font = `${small ? 9 : 10}px system-ui, -apple-system, sans-serif`;
      g.fillText(`${num(+r.area.toFixed(1))} ${L().m2}`, cx, top + (lines.length - 1) * lh + 13);
    }
  }
  return T;
}
