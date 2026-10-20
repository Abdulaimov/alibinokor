"""Floor plans of the Ali Binokor blocks (vector PDFs) -> walls, columns, windows, rooms, apartments.

    tools/ab/py tools/ab/extract_plan.py [KEY ...]   # -> blender/ab/plans.json, build/plans/KEY.png

The sheets are AutoCAD exports in which every filled area is split into triangles and the lettering
is drawn as outlines (no text to read). What is read from them:
  - rooms: the fills in the apartment colours (one colour per flat on a sheet) and the beige hatch of
    the stair / lift halls; the triangles of one colour are joined back into room polygons;
  - room names: from the outlined lettering (labels.py);
  - walls: the black fills (sheets of blocks Б-Д); on the block A sheets the walls are drawn as
    double lines, so there they are the strips between the rooms, with the doorways cut out at the
    door swings; columns and concrete walls: the closed blue / magenta outlines;
  - bathroom fittings: the brown outlines (baths, basins, toilets);
  - balcony doors: the orange door swings between a room and its loggia.
Windows are the stretches of a room's outline with no wall and no room across them (outside a
balcony door); on block A (a glass tower) they are floor-to-ceiling glazing. Plan coordinates are
metres in the block's own frame.
"""
import json
import math
import os
import sys
from collections import defaultdict

import pymupdf
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, split, unary_union

sys.path.insert(0, os.path.dirname(__file__))
from labels import glyphs, room_name  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
SHEETS = os.path.join(ROOT, '..', '00_Материалы_клиента', 'Планы')

R2 = lambda c: tuple(round(v, 2) for v in c) if c is not None else None

# Sheet -> plan frame. Axis positions on the sheet (pt) were read off the red axis lines.
# 'swap': the numbered axes run down the sheet and become the plan's x (the long side).
SHEET_INFO = {
    'BG': dict(file='ПЛАН-БЛОК -Б-Г.pdf', ax=(268.9, 616.0), ay=(146.4, 1119.4), size=(21.4, 60.0), swap=True,
               walls='fill', door_w=0.72, title='Блоки Б, В, Г, Д: этажи 3–18'),
    'BG_top': dict(file='ПЛАН БЛОК-Б-1-20-21-22.pdf', ax=(268.9, 616.0), ay=(146.4, 1119.4), size=(21.4, 60.0), swap=True,
                   walls='fill', door_w=0.72, title='Блоки Б и Г: этажи 19–22'),
    'A': dict(file='ПЛАН БЛОК-А -4-5-8-11-12-1314-15-16-19.pdf', ax=(145.9, 743.7), ay=(320.1, 917.9), size=(40.0, 40.0),
              swap=False, walls='gaps', door_w=0.42, title='Блок А: типовой этаж'),
    'A_t': dict(file='ПЛАН БЛОК-А 9-10-20-21.pdf', ax=(145.9, 743.7), ay=(320.1, 917.9), size=(40.0, 40.0),
                swap=False, walls='gaps', door_w=0.42, title='Блок А: этажи 9–10 и 20–21'),
}
SMALL_LOGGIA_AREA = 2.6  # m2: the small loggias are behind screens (no door needed)
MARGIN = 2.75  # m around the axes that still belongs to the plan (loggias); the flat labels are further out

IGNORE_FILL = {(1.0, 1.0, 1.0), (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, 0.0, 0.72), (0.01, 0.62, 0.13), (0.66, 0.06, 0.01),
               (0.41, 0.41, 0.41), (0.86, 0.86, 0.86), (0.98, 0.98, 0.98), (0.64, 0.28, 0.79), (0.0, 0.36, 0.72), (0.96, 0.96, 0.96)}
COMMON_FILL = {(0.98, 0.94, 0.82), (0.96, 0.33, 0.5)}   # stair / lift hall hatch, refuse room
WALL_FILL = (0.0, 0.0, 0.0)
STRUCT_STROKES = {(0.0, 0.12, 0.5), (1.0, 0.0, 1.0), (0.0, 0.0, 1.0)}  # columns (blue), concrete walls (magenta)
FIXTURE_STROKE = (0.65, 0.58, 0.4)
BALCONY_DOOR_STROKE = (1.0, 0.4, 0.0)

ROOM_NAMES = {  # kind -> (en, ru, tj)
    'living': ('Living room', 'Гостиная', 'Меҳмонхона'),
    'bedroom': ('Bedroom', 'Спальня', 'Хонаи хоб'),
    'kitchen': ('Kitchen', 'Кухня', 'Ошхона'),
    'hall': ('Hall', 'Холл', 'Даҳлез'),
    'bath': ('Bathroom', 'Ванная', 'Ҳаммом'),
    'wc': ('WC', 'Санузел', 'Ҳоҷатхона'),
    'storage': ('Wardrobe', 'Гардероб', 'Либосхона'),
    'loggia': ('Loggia', 'Лоджия', 'Айвон'),
    'terrace': ('Terrace', 'Терраса', 'Айвони кушод'),
}

# flat labels on the sheets: (rooms, area m2) as written next to each flat
LABELS = {
    'BG': [(3, 119.60)] * 2 + [(2, 75.77)] * 2 + [(2, 64.98)] * 2 + [(1, 67.57), (3, 145.18)] + [(3, 95.50)] * 2
          + [(2, 56.09)] * 2 + [(1, 36.63)] * 2 + [(2, 66.93)],
    'BG_top': [(3, 119.60)] * 2 + [(2, 75.77)] * 2 + [(2, 64.98)] * 2 + [(3, 145.18)] * 2 + [(3, 95.50)] * 2
              + [(2, 56.09)] * 2 + [(1, 36.63)] * 2,
    'A': [(3, 163.58)] * 2 + [(2, 98.41)] * 2 + [(2, 90.19)] * 2 + [(2, 90.95)] * 2 + [(4, 174.94)] * 2 + [(3, 134.74)] * 2,
    'A_t': [(3, 162.20)] * 2 + [(2, 97.73)] * 2 + [(4, 182.85)] * 2 + [(4, 173.47)] * 2 + [(3, 133.93)] * 2,
}
# name length in cap heights -> room (calibrated on all four sheets)
NAME_BY_LENGTH = [(2.0, 2.7, 'wc'), (3.2, 3.55, 'hall'), (3.6, 3.8, 'kitchen'), (3.8, 4.1, 'bath'), (4.5, 5.0, 'storage'),
                  (5.1, 5.6, 'bedroom'), (6.2, 6.9, 'living')]


# ----------------------------------------------------------------------------
# geometry helpers
# ----------------------------------------------------------------------------

def parts(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [g]
    return [q for q in getattr(g, 'geoms', []) if q.geom_type == 'Polygon']


def ring(poly, nd=3):
    p = poly.simplify(0.01, preserve_topology=True)
    c = list(p.exterior.coords)[:-1]
    if not Polygon(c).exterior.is_ccw:
        c = c[::-1]
    return [[round(x, nd), round(y, nd)] for x, y in c]


def no_holes(p, depth=0):
    """Split a polygon through its holes until none is left (the viewer extrudes outer rings).
    The cut goes through a point inside the hole (the centroid of an L- or U-shaped hole can lie
    outside it, and a cut there would miss the hole and leave it to be filled in)."""
    if p.geom_type != 'Polygon' or not p.interiors:
        return [p]
    c = Polygon(p.interiors[0]).representative_point()
    x0, y0, x1, y1 = p.bounds
    pieces = list(split(p, LineString([(c.x, y0 - 1), (c.x, y1 + 1)])).geoms)
    if len(pieces) < 2 or depth > 40:
        # vertical cut failed: try a horizontal one through the same point
        pieces = list(split(p, LineString([(x0 - 1, c.y), (x1 + 1, c.y)])).geoms)
        if len(pieces) < 2:
            raise ValueError('cannot split a polygon with a hole')
    out = []
    for q in pieces:
        out += no_holes(q, depth + 1)
    return out


def snap(g, grid=0.01):
    return shapely.set_precision(g, grid)


def min_width(p):
    c = list(p.minimum_rotated_rectangle.exterior.coords)
    return min(math.dist(c[0], c[1]), math.dist(c[1], c[2]))


# ----------------------------------------------------------------------------
# reading a sheet
# ----------------------------------------------------------------------------

class Sheet:
    def __init__(self, key):
        info = SHEET_INFO[key]
        self.key, self.info = key, info
        self.pg = pymupdf.open(os.path.join(SHEETS, info['file']))[0]
        (ax0, ax1), (ay0, ay1) = info['ax'], info['ay']
        w, h = info['size']
        self.s = ((ax1 - ax0) / w + (ay1 - ay0) / h) / 2  # pt per metre
        self.cx, self.cy = (ax0 + ax1) / 2, (ay0 + ay1) / 2
        sw = (ax1 - ax0) / 2 + MARGIN * self.s
        sh = (ay1 - ay0) / 2 + MARGIN * self.s
        self.region = pymupdf.Rect(self.cx - sw, self.cy - sh, self.cx + sw, self.cy + sh)
        self.drawings = [d for d in self.pg.get_drawings() if self.region.contains(d['rect'])]
        self._fills = None

    def P(self, p):
        """sheet point -> plan metres"""
        dx, dy = (p[0] - self.cx) / self.s, (p[1] - self.cy) / self.s
        if self.info['swap']:
            return (round(dy, 4), round(dx, 4))
        return (round(dx, 4), round(-dy, 4))

    def path_points(self, d, keep_curves=False):
        """Sub-paths of a drawing as lists of plan points (curves flattened)."""
        subs, cur, curves = [], [], []
        for it in d['items']:
            k = it[0]
            if k in ('re', 'qu'):
                if cur:
                    subs.append(cur)
                    cur = []
                q = it[1].quad if k == 're' else it[1]
                subs.append([q.ul, q.ur, q.lr, q.ll])
                continue
            p0 = it[1]
            if cur and (abs(cur[-1].x - p0.x) > 1e-3 or abs(cur[-1].y - p0.y) > 1e-3):
                subs.append(cur)
                cur = []
            if not cur:
                cur = [p0]
            if k == 'l':
                cur.append(it[2])
            else:  # bezier
                b = it[1:5]
                curves.append([self.P((q.x, q.y)) for q in b])
                for i in range(1, 9):
                    t = i / 8
                    w = ((1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3)
                    cur.append(pymupdf.Point(sum(a * q.x for a, q in zip(w, b)), sum(a * q.y for a, q in zip(w, b))))
        if cur:
            subs.append(cur)
        pts = [[self.P((p.x, p.y)) for p in s] for s in subs]
        return (pts, curves) if keep_curves else pts

    def fills(self):
        """Filled areas by colour, as they show on the sheet: what a later fill paints over is gone
        (the sheets draw a wall and then a room's fill over part of it, e.g. in some bathrooms)."""
        if self._fills is None:
            seq = []
            for d in self.drawings:
                f = R2(d.get('fill'))
                if f is None:
                    continue
                shape = None
                for s in self.path_points(d):
                    if len(s) >= 3:
                        g = Polygon(s).buffer(0)
                        if g.area > 1e-6:
                            shape = g if shape is None else (shape.symmetric_difference(g) if d.get('even_odd') else shape.union(g))
                if shape is not None and not shape.is_empty:
                    seq.append((f, shape.buffer(0)))
            import shapely
            covers = [i for i, (f, g) in enumerate(seq) if f not in IGNORE_FILL or f in COMMON_FILL]
            tree = shapely.STRtree([seq[i][1] for i in covers])
            by = defaultdict(list)
            for i, (f, g) in enumerate(seq):
                if f == WALL_FILL:
                    later = [seq[covers[j]][1] for j in tree.query(g) if covers[j] > i]
                    if later:
                        g = g.difference(unary_union(later).buffer(0.002))
                by[f] += [q for q in parts(g) if q.area > 1e-6]
            self._fills = by
            return by
        if False:
            by = defaultdict(list)
            for d in self.drawings:
                f = R2(d.get('fill'))
                if f is None:
                    continue
                # the sub-paths of one fill: even-odd fills (a wall drawn as an outer and an inner
                # ring) are the rings XOR'd, else their union
                shape = None
                for s in self.path_points(d):
                    if len(s) >= 3:
                        g = Polygon(s).buffer(0)
                        if g.area > 1e-6:
                            shape = g if shape is None else (shape.symmetric_difference(g) if d.get('even_odd') else shape.union(g))
                if shape is not None:
                    by[f] += [q for q in parts(shape.buffer(0)) if q.area > 1e-6]
            self._fills = by
        return self._fills

    def strokes(self, colour, width=None, curves=False):
        out = []
        for d in self.drawings:
            if R2(d.get('color')) != colour:
                continue
            if width is not None and abs((d.get('width') or 0) - width) > 0.02:
                continue
            if curves:
                out.append(self.path_points(d, keep_curves=True))
            else:
                out += [s for s in self.path_points(d) if len(s) >= 2]
        return out


def door_symbols(sh, gaps, room_geom):
    """Doorways from the door symbols (block A sheets draw them as short strokes: leaf, swing,
    ticks at the jambs). Each symbol is a door-sized cluster of strokes against a wall: the doorway is
    its extent along that wall, cut through the whole wall thickness. Only between rooms of one flat,
    or from a flat to the stair / lift hall, never through a wall between two flats."""
    segs = [LineString(s) for s in sh.strokes((0.0, 0.0, 0.0), sh.info['door_w']) if len(s) >= 2]
    blobs = parts(unary_union([q.buffer(0.04) for q in segs]))
    colour_at = []
    for c, g in room_geom.items():
        colour_at.append((c, g))

    def colour(pt):
        for c, g in colour_at:
            if g.buffer(0.02).contains(pt):
                return c
        return None
    out = []
    for b in blobs:
        r = b.minimum_rotated_rectangle
        cs = list(r.exterior.coords)
        e = sorted([math.dist(cs[0], cs[1]), math.dist(cs[1], cs[2])])
        if not (0.45 <= e[1] <= 1.6 and e[0] <= 1.3):
            continue
        near = gaps.intersection(b.buffer(0.45))
        if near.is_empty or near.area < 0.02:
            continue
        wr = near.minimum_rotated_rectangle
        wc = list(wr.exterior.coords)
        d1 = (wc[1][0] - wc[0][0], wc[1][1] - wc[0][1])
        d2 = (wc[2][0] - wc[1][0], wc[2][1] - wc[1][1])
        d = d1 if math.hypot(*d1) >= math.hypot(*d2) else d2
        L = math.hypot(*d) or 1.0
        ux, uy = d[0] / L, d[1] / L
        nx, ny = -uy, ux
        o = near.centroid
        ss = [(p[0] - o.x) * ux + (p[1] - o.y) * uy for p in b.exterior.coords]
        s0, s1 = min(ss) + 0.03, max(ss) - 0.03
        if s1 - s0 < 0.55:
            continue
        sm = (s0 + s1) / 2
        mid = (o.x + ux * sm, o.y + uy * sm)
        sides = [colour(Point(mid[0] + nx * k, mid[1] + ny * k)) for k in (0.55, -0.55)]
        if None in sides:
            continue
        common = [c in COMMON_FILL for c in sides]
        if sides[0] != sides[1] and not any(common):
            continue  # a wall between two flats
        T = 0.6
        out.append(Polygon([(o.x + ux * s0 + nx * T, o.y + uy * s0 + ny * T), (o.x + ux * s1 + nx * T, o.y + uy * s1 + ny * T),
                            (o.x + ux * s1 - nx * T, o.y + uy * s1 - ny * T), (o.x + ux * s0 - nx * T, o.y + uy * s0 - ny * T)]))
    return out


def door_openings(sh, walls_hint):
    """Doorways from the door swings: a quarter arc round the hinge, from the leaf tip to the jamb.
    Returns the opening rectangles (across the wall) as polygons."""
    out = []
    for pts, curves in sh.strokes((0.0, 0.0, 0.0), sh.info['door_w'], curves=True):
        for b in curves:
            p0, c1, c2, p3 = b
            chord = math.dist(p0, p3)
            r = chord / math.sqrt(2)
            if not (0.55 <= r <= 1.25):
                continue
            # the two possible centres of a quarter circle through p0 and p3; the arc bulges away from it
            mx, my = (p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2
            ux, uy = (p3[0] - p0[0]) / chord, (p3[1] - p0[1]) / chord
            nx, ny = -uy, ux
            h = chord / 2
            bulge = ((c1[0] + c2[0]) / 2 - mx) * nx + ((c1[1] + c2[1]) / 2 - my) * ny
            sgn = -1 if bulge > 0 else 1
            C = (mx + nx * h * sgn, my + ny * h * sgn)
            # the closed end of the leaf lies in the wall line: the arc end nearer the walls / gaps
            d0 = walls_hint.distance(Point(p0))
            d3 = walls_hint.distance(Point(p3))
            E = p0 if d0 < d3 else p3
            L = math.dist(C, E)
            ex, ey = (E[0] - C[0]) / L, (E[1] - C[1]) / L
            qx, qy = -ey, ex
            T = 0.45
            out.append(Polygon([(C[0] + qx * T, C[1] + qy * T), (E[0] + qx * T, E[1] + qy * T),
                                (E[0] - qx * T, E[1] - qy * T), (C[0] - qx * T, C[1] - qy * T)]))
    return out


def extract(key):
    sh = Sheet(key)
    by = sh.fills()

    apt_colours = [c for c, ps in by.items() if c not in IGNORE_FILL and c not in COMMON_FILL and sum(p.area for p in ps) > 3.0]
    room_geom = {}
    for c in apt_colours + [c for c in COMMON_FILL if c in by]:
        room_geom[c] = snap(unary_union([p.buffer(0.004) for p in by[c]]).buffer(-0.004))

    # columns and concrete walls: closed outlines
    lines = [LineString(s) for col in STRUCT_STROKES for s in sh.strokes(col)]
    struct = [p for p in polygonize(unary_union(lines)) if p.area > 0.03]
    struct = snap(unary_union([p.buffer(0.005) for p in struct]))

    rooms_all = unary_union(list(room_geom.values()))
    fill_walls = snap(unary_union([p.buffer(0.004) for p in by.get(WALL_FILL, [])]).buffer(-0.004))
    doors = []
    if sh.info['walls'] == 'gaps':
        # walls are the strips between the rooms (up to 0.7 m), less the doorways
        closed = rooms_all.buffer(0.35, join_style='mitre').buffer(-0.35, join_style='mitre')
        gaps = closed.difference(rooms_all)
        doors = door_symbols(sh, gaps, room_geom)
        walls = gaps.difference(unary_union(doors)) if doors else gaps
        walls = unary_union([walls, fill_walls])
        walls = unary_union([g for g in parts(walls.buffer(-0.02).buffer(0.02)) if g.area > 0.02])
    else:
        walls = fill_walls
    walls = snap(walls.difference(struct))

    everything = unary_union([walls, struct, rooms_all])
    enclosure = everything.buffer(0.45, join_style='mitre').buffer(-0.45, join_style='mitre')
    enclosure = max(parts(enclosure), key=lambda q: q.area)
    outside = box(*enclosure.buffer(5).bounds).difference(enclosure)

    rooms = []
    # a room is its fill less the walls and shafts drawn over it (some fills run on under a shaft);
    # columns standing inside a room stay part of it (the viewer draws them in the room)
    solid = unary_union([walls, struct])
    for c, g in room_geom.items():
        g = g.difference(walls).difference(struct.buffer(0.01)) if not g.is_empty else g
        for q in parts(g.buffer(-0.02).buffer(0.02)):
            q = Polygon(q.exterior) if q.interiors and all(Polygon(h).area < 2.5 for h in q.interiors) else q
            if q.area >= 0.6:
                rooms.append(dict(colour=c, poly=q, common=c in COMMON_FILL))

    fixtures = parts(unary_union([LineString(s).buffer(0.03) for s in sh.strokes(FIXTURE_STROKE)]))
    fixtures = [p.minimum_rotated_rectangle for p in fixtures if p.area > 0.05]
    doors_balc = [LineString(s) for s in sh.strokes(BALCONY_DOOR_STROKE, 0.42) if len(s) >= 2]

    gl = glyphs(by)
    for r in rooms:
        p = r['poly']
        r['area'] = p.area
        r['outer'] = p.buffer(0.6).intersection(outside).area
        r['fix'] = [f for f in fixtures if p.contains(f.centroid)]
        r['width'] = min_width(p)
        r['label'] = room_name(p, gl)
        r['kind'] = classify(r)
    return sh, dict(rooms=rooms, walls=walls, struct=struct, enclosure=enclosure, outside=outside, fixtures=fixtures,
                    doors_balc=doors_balc, doors=doors, apt_colours=apt_colours)


def classify(r):
    """Room kind from its written name (labels.py), with the drawing as a fallback."""
    if r['common']:
        return 'common'
    nm = r['label'] and r['label'].get('name')
    kind = None
    if nm:
        for lo, hi, k in NAME_BY_LENGTH:
            if lo <= nm['rel'] <= hi:
                kind = k
        if kind == 'wc' and any(f.area > 0.9 for f in r['fix']):
            kind = 'bath'   # "С/У" with a bath tub: a combined bathroom
    if kind:
        return kind
    if r['fix']:
        return 'bath' if any(f.area > 0.9 for f in r['fix']) or r['area'] >= 3.2 else 'wc'
    if r['outer'] > 0.1:
        return 'terrace' if r['area'] > 7.5 else 'loggia'
    return 'storage' if r['area'] < 7.0 else 'hall'


def group_apartments(key, x):
    """Rooms of one colour that meet across a wall are one flat; match each flat to a sheet label."""
    flats = []
    for c in x['apt_colours']:
        rs = [r for r in x['rooms'] if r['colour'] == c]
        blob = unary_union([r['poly'].buffer(0.42, join_style='mitre') for r in rs])
        for q in parts(blob):
            mine = [r for r in rs if q.contains(r['poly'].representative_point())]
            if mine and sum(r['area'] for r in mine) >= 20:
                flats.append(dict(colour=c, rooms=mine))
    labels = list(LABELS[key])
    for f in flats:
        f['rooms_count'] = sum(1 for r in f['rooms'] if r['kind'] in ('bedroom', 'living'))
        f['drawn_area'] = sum(r['area'] for r in f['rooms'])
    pairs = sorted(((abs(f['drawn_area'] - a) + (0 if n == f['rooms_count'] else 25), i, j)
                    for i, f in enumerate(flats) for j, (n, a) in enumerate(labels)))
    used_f, used_l = set(), set()
    for cost, i, j in pairs:
        if i in used_f or j in used_l:
            continue
        used_f.add(i)
        used_l.add(j)
        flats[i]['label'] = labels[j]
    return flats


def openings(key, x):
    """Windows: free stretches of a room's outline (no wall on it) with no room across them, or with a
    loggia across them (less the balcony door). Block A's outer windows are floor-to-ceiling glazing."""
    rooms = x['rooms']
    W = unary_union([x['walls'], x['struct']])
    Wb = W.buffer(0.04)
    allrooms = unary_union([r['poly'] for r in rooms])
    doors = unary_union([d.buffer(0.05) for d in x['doors_balc']]) if x['doors_balc'] else None
    glass_tower = key.startswith('A')
    open_air = ('loggia', 'terrace')
    wins, glaz = [], []
    door_to, candidates = set(), []
    for r in rooms:
        p = r['poly'].simplify(0.02)
        cs = list(p.exterior.coords)
        if not p.exterior.is_ccw:
            cs = cs[::-1]
        for a, b in zip(cs, cs[1:]):
            seg = LineString([a, b])
            if seg.length < 0.35:
                continue
            free = seg.difference(Wb)
            for f in getattr(free, 'geoms', [free]):
                if f.is_empty or f.length < 0.4 or f.geom_type != 'LineString':
                    continue
                dx, dy = b[0] - a[0], b[1] - a[1]
                L = math.hypot(dx, dy)
                n = (dy / L, -dx / L)  # outward (CCW ring: inside on the left)
                fa, fb = f.coords[0], f.coords[-1]
                strip = Polygon([fa, fb, (fb[0] + n[0] * 0.7, fb[1] + n[1] * 0.7), (fa[0] + n[0] * 0.7, fa[1] + n[1] * 0.7)])
                across = [q for q in rooms if q is not r and strip.intersection(q['poly']).area > 0.03]
                mine_air = r['kind'] in open_air
                if across:
                    air = [q for q in across if q['kind'] in open_air]
                    if mine_air or not air or len(air) != len(across):
                        continue  # a doorway between rooms (the viewer puts a door there), or seen from the loggia
                elif mine_air and (glass_tower or r['kind'] == 'terrace'):
                    continue  # the open edge of a balcony or terrace: a railing, not a window
                # how far out the wall reaches next to the opening
                T = 0.0
                for end in (fa, fb):
                    near = W.intersection(Point(end).buffer(0.45))
                    for g in parts(near):
                        for c in g.exterior.coords:
                            T = max(T, (c[0] - end[0]) * n[0] + (c[1] - end[1]) * n[1])
                if across:
                    T = across[0]['poly'].distance(seg)
                    T = T if T > 0.05 else 0.25
                T = min(max(T, 0.2), 0.55)
                spans = [(0.0, f.length)]
                ux, uy = (fb[0] - fa[0]) / f.length, (fb[1] - fa[1]) / f.length
                if across and doors is not None:
                    d = doors.intersection(strip.buffer(0.9))
                    if not d.is_empty:
                        ss = [((c[0] - fa[0]) * ux + (c[1] - fa[1]) * uy) for g in parts(d) for c in g.exterior.coords]
                        s0, s1 = max(0.0, min(ss)), min(f.length, max(ss))
                        if s1 - s0 > 0.5:
                            spans = [(0.0, s0 - 0.02), (s1 + 0.02, f.length)]
                            door_to.add(id(across[0]))
                if across:
                    candidates.append((f.length, id(across[0]), across[0], r, fa, fb, n, T, len(wins)))
                for s0, s1 in spans:
                    if s1 - s0 < 0.4:
                        continue
                    q0 = (fa[0] + ux * s0, fa[1] + uy * s0)
                    q1 = (fa[0] + ux * s1, fa[1] + uy * s1)
                    poly = Polygon([q0, q1, (q1[0] + n[0] * T, q1[1] + n[1] * T), (q0[0] + n[0] * T, q0[1] + n[1] * T)])
                    poly = poly.difference(allrooms.buffer(-0.005)).difference(W)
                    for g in parts(poly):
                        if g.area > 0.04:
                            (glaz if glass_tower and not mine_air else wins).append(g)
    # a loggia that the drawing gives no door to (only windows from the rooms): a balcony door in
    # the middle of its longest window, so it can be walked onto
    best = {}
    for c in candidates:
        if c[1] not in door_to and c[2]['area'] > SMALL_LOGGIA_AREA and (c[1] not in best or c[0] > best[c[1]][0]):
            best[c[1]] = c
    for length, _, lg, r, fa, fb, n, T, _ in best.values():
        if length < 0.6:
            continue
        ux, uy = (fb[0] - fa[0]) / length, (fb[1] - fa[1]) / length
        m = length / 2
        hw = 0.45 if length >= 1.3 else length / 2 + 0.05  # a short opening becomes the door as a whole
        cut = Polygon([(fa[0] + ux * (m - hw) - n[0] * 0.3, fa[1] + uy * (m - hw) - n[1] * 0.3),
                       (fa[0] + ux * (m + hw) - n[0] * 0.3, fa[1] + uy * (m + hw) - n[1] * 0.3),
                       (fa[0] + ux * (m + hw) + n[0] * (T + 0.3), fa[1] + uy * (m + hw) + n[1] * (T + 0.3)),
                       (fa[0] + ux * (m - hw) + n[0] * (T + 0.3), fa[1] + uy * (m - hw) + n[1] * (T + 0.3))])
        out = []
        for w in wins:
            if w.intersects(cut):
                out += [g for g in parts(w.difference(cut)) if g.area > 0.04]
            else:
                out.append(w)
        wins = out
    return wins, glaz


def doorways(x):
    """Free stretches of room outlines (no wall, no window) with another room across: the doorways."""
    W = unary_union([x['walls'], x['struct']] + list(x['windows']) + list(x['glazing'])).buffer(0.04)
    out = []
    rooms = x['rooms']
    for r in rooms:
        free = r['poly'].exterior.difference(W)
        for f in getattr(free, 'geoms', [free]):
            if f.is_empty or f.length < 0.45 or f.geom_type != 'LineString':
                continue
            probe = f.buffer(0.35)
            if any(q is not r and probe.intersection(q['poly']).area > 0.02 for q in rooms):
                out.append(f)
    return out


def build(key):
    sh, x = extract(key)
    x['flats'] = group_apartments(key, x)
    x['windows'], x['glazing'] = openings(key, x)
    # fittings read from the drawing that lie across a doorway (a door swing caught in with a bath
    # or a sink): left out, the viewer furnishes the room itself
    ways = unary_union([d.buffer(0.3) for d in doorways(x)])
    keep = [fx for fx in x['fixtures'] if fx.intersection(ways).area < 0.02]
    print('  %d fittings across doorways left out' % (len(x['fixtures']) - len(keep)))
    x['fixtures'] = keep
    return sh, x


def to_json(key, x):
    def rings(g):
        out = []
        for q in parts(g):
            pieces = no_holes(q)
            # the pieces must cover exactly the solid (no hole filled in)
            assert abs(sum(h.area for h in pieces) - q.area) < 0.01, 'hole lost while splitting'
            out += [ring(h) for h in pieces if h.area > 0.005]
        return out

    enc = x['enclosure'].simplify(0.03)
    flats = []
    for f in sorted(x['flats'], key=lambda f: (-round(f['rooms'][0]['poly'].centroid.y), f['rooms'][0]['poly'].centroid.x)):
        rooms, balconies = [], []
        for r in f['rooms']:
            en, ru, tj = ROOM_NAMES[r['kind']]
            item = dict(name=en, ru=ru, tj=tj, kind=r['kind'], area=round(r['area'], 2), poly=ring(r['poly']))
            (balconies if r['kind'] == 'terrace' else rooms).append(item)
        outline = unary_union([r['poly'].buffer(0.2, join_style='mitre') for r in f['rooms']]).buffer(-0.2, join_style='mitre')
        outline = max(parts(outline), key=lambda q: q.area)
        n, area = f.get('label', (f['rooms_count'], f['drawn_area']))
        flats.append(dict(colour='#%02x%02x%02x' % tuple(int(v * 255) for v in f['colour']), rooms_count=n,
                          label_rooms=n, area=round(area, 2), outline=ring(outline), rooms=rooms, balconies=balconies,
                          fixtures=[ring(fx) for fx in x['fixtures'] if outline.buffer(0.1).contains(fx.centroid)]))
    common = [ring(r['poly']) for r in x['rooms'] if r['common']]
    return dict(title=SHEET_INFO[key]['title'], slab=ring(enc), enclosure=ring(enc), walls=rings(x['walls']),
                struct=rings(x['struct']), windows=[ring(w) for w in x['windows']], glazing=[ring(g) for g in x['glazing']],
                common=common, apartments=flats)


def draw_debug(key, x, scale=40):
    from PIL import Image, ImageDraw, ImageFont
    x0, y0, x1, y1 = x['enclosure'].buffer(1.5).bounds
    im = Image.new('RGB', (int((x1 - x0) * scale), int((y1 - y0) * scale)), 'white')
    g = ImageDraw.Draw(im)
    T = lambda p: ((p[0] - x0) * scale, (y1 - p[1]) * scale)
    KC = {'living': (255, 215, 140), 'bedroom': (170, 200, 255), 'kitchen': (255, 170, 170), 'hall': (225, 225, 200),
          'bath': (140, 230, 230), 'wc': (120, 200, 210), 'storage': (210, 180, 230), 'loggia': (190, 240, 170),
          'terrace': (150, 225, 120), 'common': (235, 235, 235)}
    poly = lambda q, **kw: g.polygon([T(p) for p in q.exterior.coords], **kw)
    for r in x['rooms']:
        poly(r['poly'], fill=KC[r['kind']], outline=(150, 150, 150))
    for q in parts(x['walls']):
        for h in no_holes(q):
            poly(h, fill=(30, 30, 30))
    for q in parts(x['struct']):
        for h in no_holes(q):
            poly(h, fill=(40, 60, 200))
    for w in x.get('windows', []):
        poly(w, fill=(0, 200, 255))
    for w in x.get('glazing', []):
        poly(w, fill=(0, 110, 255))
    for f in x['fixtures']:
        poly(f, outline=(150, 100, 30))
    for d in x['doors_balc']:
        g.line([T(p) for p in d.coords], fill=(255, 100, 0), width=2)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 13)
        big = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 17)
    except OSError:
        font = big = None
    for f in x.get('flats', []):
        o = unary_union([r['poly'].buffer(0.2) for r in f['rooms']]).buffer(-0.1)
        for q in parts(o):
            g.line([T(p) for p in q.exterior.coords], fill=(255, 0, 120), width=3)
        c = max(f['rooms'], key=lambda r: r['area'])['poly'].representative_point()
        n, a = f.get('label', ('?', f['drawn_area']))
        g.text(T((c.x, c.y + 0.9)), f'{n}к {a:.2f}', fill=(200, 0, 90), font=big, anchor='mm')
    for r in x['rooms']:
        c = r['poly'].representative_point()
        g.text(T((c.x, c.y)), f"{ROOM_NAMES.get(r['kind'], ('', r['kind']))[1] if r['kind'] != 'common' else ''} {r['area']:.1f}",
               fill=(0, 0, 0), font=font, anchor='mm')
    im.save(os.path.join(ROOT, 'build', 'plans', f'{key}.png'))


def main():
    os.makedirs(os.path.join(ROOT, 'build', 'plans'), exist_ok=True)
    keys = sys.argv[1:] or list(SHEET_INFO)
    out = {}
    for key in keys:
        sh, x = build(key)
        print(key, 'rooms', len(x['rooms']), 'flats', len(x['flats']), '(labels %d)' % len(LABELS[key]),
              'windows', len(x['windows']), 'glazing', len(x['glazing']), 'walls %.0f m2' % x['walls'].area)
        for f in sorted(x['flats'], key=lambda f: f['drawn_area']):
            kinds = sorted(r['kind'] for r in f['rooms'])
            print('   drawn %6.1f label %-12s rooms %d  %s' % (f['drawn_area'], f.get('label'), f['rooms_count'], ' '.join(kinds)))
        draw_debug(key, x)
        out[key] = to_json(key, x)
    dst = os.path.join(ROOT, 'blender', 'ab', 'plans.json')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    old = json.load(open(dst)) if os.path.exists(dst) else {}
    old.update(out)
    json.dump(old, open(dst, 'w'), separators=(',', ':'), ensure_ascii=False)
    print('->', dst)


if __name__ == '__main__':
    main()
