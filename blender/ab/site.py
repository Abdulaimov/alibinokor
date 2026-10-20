"""The site from the genplan (build/site_raw.json, tools/ab/site_map.py): ground, kerbs, hedges,
lamps, benches, playgrounds, the football pitch, car parks, the kindergarten, the hospital (№13),
the school to the north, the houses across the road; and the trees, cars and people the viewer draws.

Levels: roads at 0, paving +0.12, lawns +0.15 behind a kerb, play surfaces +0.13.
"""
import json
import math
import os
import random

import numpy as np
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

from complex.geom import MeshBuilder, make_object, resample, ring_coords

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')

Z = dict(asphalt=0.0, paving=0.12, lawn=0.15, play=0.13, sport=0.13)
REGION = box(-200, -110, 175, 135)


def polys_of(raw, cls):
    out = []
    for p in raw['classes'].get(cls, []):
        g = Polygon(p['ring'], [h for h in p['holes'] if len(h) >= 3]).buffer(0)
        if not g.is_empty:
            out.append(g)
    return out


def clean(g, r=0.35, tol=0.12):
    g = g.buffer(r, join_style='round').buffer(-2 * r, join_style='round').buffer(r, join_style='round')
    return g.simplify(tol, preserve_topology=True)


def parts(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [g]
    return [q for q in getattr(g, 'geoms', []) if q.geom_type == 'Polygon']


def raised(mb, g, z, top, side='Kerb'):
    """A ground area at height z with its edge as a step down to the road."""
    for q in parts(g):
        if q.area < 0.5:
            continue
        mb.polygon_face(q, z, top)
        for ring in [q.exterior] + list(q.interiors):
            c = list(ring.coords)
            u = 0.0
            for a, b in zip(c, c[1:]):
                mb.quad_wall(a, b, -0.05, z, side, u0=u, flip=not ring.is_ccw if ring is q.exterior else ring.is_ccw)
                u += math.dist(a, b)


def kerb_line(mb, g, z, w=0.12, h=0.06, mat='Kerb'):
    for q in parts(g):
        for ring in [q.exterior] + list(q.interiors):
            c = list(ring.coords)
            if len(c) < 3:
                continue
            mb.tube(c[:-1], [z] * (len(c) - 1), [z + h] * (len(c) - 1), w, mat, closed=True)


# ----------------------------------------------------------------------------
# props
# ----------------------------------------------------------------------------

def lamp(mb, x, y, z, h=4.5, street=False, rot=0.0):
    mb.box(x, y, z, 0.14, 0.14, h, 'Lamp dark')
    if street:
        ca, sa = math.cos(rot), math.sin(rot)
        mb.box(x + ca * 0.9, y + sa * 0.9, z + h - 0.1, 1.8, 0.12, 0.1, 'Lamp dark', rot=rot)
        mb.box(x + ca * 1.7, y + sa * 1.7, z + h - 0.22, 0.6, 0.28, 0.14, 'Lamp dark', rot=rot)
        mb.box(x + ca * 1.7, y + sa * 1.7, z + h - 0.24, 0.5, 0.22, 0.03, 'Lamp glow', rot=rot)
    else:
        mb.box(x, y, z + h, 0.42, 0.42, 0.08, 'Lamp dark')
        mb.box(x, y, z + h - 0.35, 0.3, 0.3, 0.35, 'Lamp glow')


def bench(mb, x, y, z, rot):
    ca, sa = math.cos(rot), math.sin(rot)
    mb.box(x, y, z + 0.42, 1.8, 0.45, 0.06, 'Wood', rot=rot)
    mb.box(x - sa * 0.22, y + ca * 0.22, z + 0.48, 1.8, 0.06, 0.42, 'Wood', rot=rot)
    for e in (-0.75, 0.75):
        mb.box(x + ca * e, y + sa * e, z, 0.08, 0.45, 0.42, 'Lamp dark', rot=rot)


def play_set(mb, poly, z, rnd):
    """Playground kit inside a play area: a tower with a slide, swings, springers, a climbing dome."""
    c = poly.representative_point()
    w = math.sqrt(poly.area)
    items = []
    inner = poly.buffer(-1.8)
    if inner.is_empty:
        return items
    tries = 0
    kinds = ['tower', 'swing', 'spring', 'dome', 'spring', 'swing', 'see']
    k = 0
    while k < min(len(kinds), max(2, int(poly.area / 45))) and tries < 120:
        tries += 1
        x0, y0, x1, y1 = inner.bounds
        p = Point(rnd.uniform(x0, x1), rnd.uniform(y0, y1))
        if not inner.contains(p) or any(p.distance(q) < 4.2 for q in items):
            continue
        items.append(p)
        kind = kinds[k]
        k += 1
        rot = rnd.uniform(0, math.pi)
        ca, sa = math.cos(rot), math.sin(rot)
        x, y = p.x, p.y
        if kind == 'tower':
            for dx, dy in ((-0.8, -0.8), (0.8, -0.8), (0.8, 0.8), (-0.8, 0.8)):
                mb.box(x + ca * dx - sa * dy, y + sa * dx + ca * dy, z, 0.12, 0.12, 2.6, 'Play blue', rot=rot)
            mb.box(x, y, z + 1.2, 1.8, 1.8, 0.1, 'Wood', rot=rot)
            mb.box(x, y, z + 2.6, 2.1, 2.1, 0.12, 'Play orange', rot=rot)
            # slide
            sx, sy = x + ca * 2.3, y + sa * 2.3
            pts = [(x + ca * 0.9, y + sa * 0.9), (sx + ca * 1.4, sy + sa * 1.4)]
            mb.tube(pts, [z + 1.2, z + 0.25], [z + 1.3, z + 0.35], 0.6, 'Fitness yellow')
        elif kind == 'swing':
            for e in (-1.4, 1.4):
                mb.box(x + ca * e, y + sa * e, z, 0.1, 0.1, 2.3, 'Play blue', rot=rot)
            mb.box(x, y, z + 2.3, 3.0, 0.1, 0.1, 'Play blue', rot=rot)
            for e in (-0.6, 0.6):
                mb.box(x + ca * e, y + sa * e, z + 0.45, 0.45, 0.2, 0.05, 'Rubber blue', rot=rot)
                mb.box(x + ca * e, y + sa * e, z + 0.5, 0.02, 0.02, 1.8, 'Metal', rot=rot)
        elif kind == 'spring':
            mb.box(x, y, z, 0.18, 0.18, 0.45, 'Metal', rot=rot)
            mb.blob(x, y, z + 0.7, 0.45, 0.2, 0.3, rnd.choice(['Kinder red', 'Kinder green', 'Kinder yellow']), subdiv=1)
        elif kind == 'dome':
            mb.blob(x, y, z + 0.05, 1.5, 1.5, 1.4, 'Dark lattice', subdiv=1)
        else:
            mb.box(x, y, z + 0.35, 3.0, 0.25, 0.08, 'Kinder yellow', rot=rot)
            mb.box(x, y, z, 0.3, 0.3, 0.35, 'Metal', rot=rot)
    return items


def football(mb, poly, z):
    r = poly.minimum_rotated_rectangle
    c = list(r.exterior.coords)
    e1 = (c[1][0] - c[0][0], c[1][1] - c[0][1])
    e2 = (c[2][0] - c[1][0], c[2][1] - c[1][1])
    if math.hypot(*e1) < math.hypot(*e2):
        e1, e2 = e2, e1
    L, W = math.hypot(*e1), math.hypot(*e2)
    rot = math.atan2(e1[1], e1[0])
    cx, cy = r.centroid.x, r.centroid.y
    pitch = affinity.rotate(box(cx - L / 2, cy - W / 2, cx + L / 2, cy + W / 2), rot, origin=(cx, cy), use_radians=True)
    mb.polygon_face(pitch, z + 0.02, 'Sport green')
    ca, sa = math.cos(rot), math.sin(rot)
    lines = [((-L / 2 + 1, -W / 2 + 1), (L / 2 - 1, -W / 2 + 1)), ((-L / 2 + 1, W / 2 - 1), (L / 2 - 1, W / 2 - 1)),
             ((-L / 2 + 1, -W / 2 + 1), (-L / 2 + 1, W / 2 - 1)), ((L / 2 - 1, -W / 2 + 1), (L / 2 - 1, W / 2 - 1)),
             ((0, -W / 2 + 1), (0, W / 2 - 1))]
    T = lambda p: (cx + ca * p[0] - sa * p[1], cy + sa * p[0] + ca * p[1])
    for a, b in lines:
        mb.tube([T(a), T(b)], [z + 0.025] * 2, [z + 0.03] * 2, 0.1, 'Road line')
    circle = [T((math.cos(t) * 3.0, math.sin(t) * 3.0)) for t in np.linspace(0, 2 * math.pi, 28, endpoint=False)]
    mb.tube(circle, [z + 0.025] * len(circle), [z + 0.03] * len(circle), 0.1, 'Road line', closed=True)
    for s in (-1, 1):
        g = T((s * (L / 2 - 1), 0))
        for e in (-1.5, 1.5):
            p = T((s * (L / 2 - 1), e))
            mb.box(p[0], p[1], z, 0.1, 0.1, 2.0, 'Frame light', rot=rot)
        mb.box(g[0], g[1], z + 2.0, 0.1, 3.1, 0.1, 'Frame light', rot=rot)
    # fence round the pitch, 4 m of mesh on posts
    ring = ring_coords(pitch.buffer(0.6, join_style='mitre'))
    mb.ribbon(ring, z, z + 4.0, 'Mesh screen', closed=True, double=True)
    for p in resample(ring, 3.0):
        mb.box(p[0], p[1], z, 0.08, 0.08, 4.0, 'Fence')


def parking(mb, asphalt, spot, rnd, cars, blocked):
    """Bays along the asphalt edge nearest a "8" mark: 2.5 x 5 m, perpendicular, white lines; cars in most."""
    near = asphalt.intersection(Point(spot).buffer(22))
    best = None
    for q in parts(near):
        for ring in [q.exterior] + list(q.interiors):
            c = list(ring.coords)
            for a, b in zip(c, c[1:]):
                seg = LineString([a, b])
                if seg.length < 7 or seg.distance(Point(spot)) > 14:
                    continue
                if best is None or seg.length > best.length:
                    best = seg
    if best is None:
        return
    a, b = best.coords[0], best.coords[1]
    L = best.length
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    nx, ny = -uy, ux
    # inward normal: towards the asphalt
    if not asphalt.contains(Point((a[0] + b[0]) / 2 + nx * 2.5, (a[1] + b[1]) / 2 + ny * 2.5)):
        nx, ny = -nx, -ny
    n = int((L - 1) // 2.5)
    rot = math.atan2(ny, nx)
    for k in range(n + 1):
        s = 0.5 + k * 2.5
        p = (a[0] + ux * s, a[1] + uy * s)
        q = (p[0] + nx * 5.0, p[1] + ny * 5.0)
        if not asphalt.buffer(0.3).contains(LineString([p, q])):
            continue
        mb.tube([p, q], [0.005, 0.005], [0.012, 0.012], 0.1, 'Road line')
        if k < n and rnd.random() < 0.78:
            c = (p[0] + ux * 1.25 + nx * 2.6, p[1] + uy * 1.25 + ny * 2.6)
            if not any(Point(c).distance(Point(o[0], o[1])) < 2.2 for o in cars) and not blocked.contains(Point(c)):
                cars.append([round(c[0], 2), round(c[1], 2), 0.0, round(rot + (math.pi if rnd.random() < 0.5 else 0), 3), rnd.randrange(8)])


# ----------------------------------------------------------------------------
# buildings round the complex
# ----------------------------------------------------------------------------

def punched(mb, poly, z0, floors, fh, wall, glass='Window glass', bay=3.0, win=1.6, sill=0.9, wh=1.6, frame='Frame light'):
    """Plain walls with punched windows (neighbours: school, hospital, kindergarten)."""
    pts = ring_coords(poly)
    for a, b in zip(pts, pts[1:] + pts[:1]):
        L = math.dist(a, b)
        if L < 0.5:
            continue
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, ny = uy, -ux
        rot = math.atan2(uy, ux)
        mb.quad_wall(a, b, z0, z0 + floors * fh, wall)
        nb = int(L // bay)
        if nb < 1:
            continue
        off = (L - nb * bay) / 2
        for f in range(floors):
            for k in range(nb):
                s = off + (k + 0.5) * bay
                c = (a[0] + ux * s + nx * 0.02, a[1] + uy * s + ny * 0.02)
                zz = z0 + f * fh + sill
                mb.box(c[0], c[1], zz - 0.05, win + 0.1, 0.06, wh + 0.1, frame, rot=rot)
                mb.box(c[0] + nx * 0.02, c[1] + ny * 0.02, zz, win, 0.06, wh, glass, rot=rot)


def flat_roof(mb, poly, z, parapet='Stone white'):
    mb.polygon_face(poly.buffer(-0.3), z + 0.05, 'Roof')
    ring = poly.buffer(0.1, join_style='mitre').difference(poly.buffer(-0.3, join_style='mitre'))
    mb.prism(ring, z, z + 0.9, parapet, parapet)


def kindergarten(mb, polys, labels, rnd):
    """Kindergarten for 300 (№7): three two-storey wings round a glazed hexagonal hall, coloured panels."""
    wings = [p for p in polys if p.area > 150]
    if not wings:
        return
    H = 7.4
    for wi, w in enumerate(wings):
        w = w.minimum_rotated_rectangle if w.area / w.minimum_rotated_rectangle.area > 0.85 else w.simplify(0.4)
        punched(mb, w, 0.0, 2, 3.7, 'Kinder wall', bay=3.2, win=1.8, wh=1.7)
        flat_roof(mb, w, H, 'Stone white')
        # coloured vertical panels between windows
        pts = ring_coords(w)
        cols = ['Kinder red', 'Kinder yellow', 'Kinder blue', 'Kinder green']
        for a, b in zip(pts, pts[1:] + pts[:1]):
            L = math.dist(a, b)
            if L < 6:
                continue
            ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
            nx, ny = uy, -ux
            for k, s in enumerate(np.arange(1.6, L - 1.0, 3.2)):
                c = (a[0] + ux * s + nx * 0.08, a[1] + uy * s + ny * 0.08)
                mb.box(c[0], c[1], 0.4, 1.1, 0.14, 6.6, cols[(k + wi) % 4], rot=math.atan2(uy, ux))
    c = unary_union(wings).centroid
    hexa = Polygon([(c.x + 6.5 * math.cos(t), c.y + 6.5 * math.sin(t)) for t in np.linspace(0, 2 * math.pi, 7)[:-1] + 0.3])
    hexa = hexa.difference(unary_union(wings).buffer(0.2))
    for q in parts(hexa):
        mb.prism(q, 0.0, 4.2, 'Shop glass', 'Stone white')
    labels.append(dict(x=round(c.x, 2), y=round(c.y, 2), z=H + 3, ru='Детский сад на 300 мест', tj='Боғчаи кӯдакона барои 300 ҷой', kind='kindergarten'))


def hospital(mb, poly, labels):
    """№13 on the genplan: a five-storey hospital."""
    r = poly.minimum_rotated_rectangle
    floors, fh = 5, 3.6
    punched(mb, r, 0.0, floors, fh, 'Hospital wall', bay=2.6, win=1.7, wh=1.8)
    flat_roof(mb, r, floors * fh, 'Hospital wall')
    # blue bands at the floor slabs, an entrance canopy, the sign and a red cross on the roof
    ring = r.buffer(0.15, join_style='mitre').difference(r.buffer(-0.05, join_style='mitre'))
    for f in range(1, floors):
        mb.prism(ring, f * fh - 0.15, f * fh + 0.25, 'Hospital accent', 'Hospital accent')
    c = list(r.exterior.coords)
    edges = sorted([(math.dist(c[i], c[i + 1]), i) for i in range(4)])
    L, i = edges[-1]
    a, b = c[i], c[i + 1]
    ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    nx, ny = uy, -ux
    m = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    rot = math.atan2(uy, ux)
    mb.box(m[0] + nx * 2.5, m[1] + ny * 2.5, 3.6, 9.0, 5.0, 0.3, 'Stone white', rot=rot)
    mb.box(m[0] + nx * 0.3, m[1] + ny * 0.3, floors * fh + 0.9, 12.0, 0.25, 1.6, 'Hospital accent', rot=rot)
    cr = (m[0] + ux * 9 + nx * 0.4, m[1] + uy * 9 + ny * 0.4)
    mb.box(cr[0], cr[1], floors * fh + 0.9, 1.8, 0.3, 0.6, 'Sign red', rot=rot)
    mb.box(cr[0], cr[1], floors * fh + 0.6, 0.6, 0.3, 1.8, 'Sign red', rot=rot)
    cc = r.centroid
    labels.append(dict(x=round(cc.x, 2), y=round(cc.y, 2), z=floors * fh + 4, ru='Больница', tj='Беморхона', kind='hospital'))


def school(mb, labels, centre=(118.0, 150.0), rot_deg=27.5):
    """The big school north of blocks Г and Д (marked "МАКТАБ" by the client): a four-storey U round a
    yard, with a sports ground and a running track beside it."""
    cx, cy = centre
    rot = math.radians(rot_deg)
    T = lambda g: affinity.translate(affinity.rotate(g, rot_deg, origin=(0, 0)), cx, cy)
    main = T(box(-42, -8, 42, 8))
    wing1 = T(box(-42, 8, -26, 40))
    wing2 = T(box(26, 8, 42, 40))
    hall = T(box(-12, 8, 12, 28))
    for g, floors in ((main, 4), (wing1, 3), (wing2, 3)):
        punched(mb, g, 0.0, floors, 3.6, 'School wall', bay=3.0, win=1.9, wh=1.9)
        flat_roof(mb, g, floors * 3.6, 'School accent')
    mb.prism(hall, 0.0, 9.0, 'School accent', 'Roof')
    # sports ground with a track, south-west of the building
    field = T(box(-120, -10, -50, 40))
    mb.polygon_face(field, 0.05, 'Track red')
    mb.polygon_face(field.buffer(-4.5), 0.07, 'Sport green')
    yard = T(box(-26, 8, 26, 40)).difference(hall)
    mb.polygon_face(yard, 0.04, 'Paving')
    entrance = T(box(-6, -14, 6, -8))
    mb.prism(entrance, 3.4, 3.7, 'Stone white', 'Stone white', 'Stone white')
    c = main.centroid
    labels.append(dict(x=round(c.x, 2), y=round(c.y, 2), z=4 * 3.6 + 4, ru='Школа', tj='Мактаб', kind='school'))
    return unary_union([main, wing1, wing2, hall, field])


# ----------------------------------------------------------------------------
# the site
# ----------------------------------------------------------------------------

def build_site(mats, col, towers, pods):
    raw = json.load(open(os.path.join(ROOT, 'build', 'site_raw.json')))
    rnd = random.Random(20261020)
    plot = Polygon(raw['plot']).buffer(0)
    inside = plot.buffer(6)
    footprints = [Polygon(t['outline']).buffer(0) for t in towers]
    built = unary_union(footprints + [p for p in pods.values()])

    cls = {k: [g.intersection(REGION) for g in polys_of(raw, k)] for k in raw['classes']}
    asphalt = unary_union([clean(g, 0.3, 0.1) for g in cls['asphalt']]).intersection(REGION)
    # outside the plot only the roads and the verges and pavements along them
    road_zone = asphalt.buffer(9)

    def keep(g):
        # inside the plot: everything; outside: only real verges and pavements along the roads
        # (the road hatching of the genplan leaves small slivers that are not ground at all)
        if g.intersects(inside):
            return True
        if not g.within(road_zone) or g.area < 80:
            return False
        r = g.minimum_rotated_rectangle
        c = list(r.exterior.coords)
        return min(math.dist(c[0], c[1]), math.dist(c[1], c[2])) > 1.8
    edge = plot.buffer(1.0)

    def trimmed(gs):
        # inside the plot as drawn; outside it only the verges and pavements along the roads
        ins = unary_union([g.intersection(edge) for g in gs if g.intersects(inside)])
        out = unary_union([g.difference(edge) for g in gs if keep(g)])
        out = unary_union([q for q in parts(out) if q.area > 80 and q.distance(asphalt) < 1.0])
        return unary_union([clean(ins), clean(out)])
    lawn = trimmed(cls['lawn'])
    paving = trimmed(cls['paving'] + cls['building'] + cls['podium'] + cls['kindergarten'])
    play = unary_union([clean(g) for g in cls['play'] if g.intersects(inside)])
    sport = unary_union([clean(g, 0.6) for g in cls['sport'] if g.intersects(inside)])
    blue = [g for g in cls['blue'] if g.area > 30]
    # one owner per spot: sport > play > lawn > paving > asphalt
    play = play.difference(sport)
    lawn = lawn.difference(play).difference(sport)
    paving = paving.difference(lawn).difference(play).difference(sport)
    lawn = lawn.difference(built.buffer(0.5))
    asphalt = asphalt.difference(unary_union([lawn, paving, play, sport]))
    # asphalt islands inside the plot that no road reaches (outlines of the genplan's symbols): paving
    islands = [q for q in parts(asphalt) if q.area < 260 and q.within(plot.buffer(2))]
    if islands:
        paving = unary_union([paving] + [q.buffer(0.05) for q in islands])
        asphalt = asphalt.difference(unary_union(islands).buffer(0.05))

    mb = MeshBuilder()
    # ground far and wide: dry grass and dust, the roads on it
    mb.polygon_face(box(-1500, -1500, 1500, 1500).difference(REGION.buffer(-0.5)), -0.06, 'Ground')
    mb.polygon_face(REGION.buffer(-0.5).difference(unary_union([asphalt, lawn, paving, play, sport]).buffer(0.05)), -0.04, 'Ground')
    for q in parts(asphalt):
        mb.polygon_face(q, 0.0, 'Asphalt')
    raised(mb, paving.buffer(0.05), Z['paving'], 'Paving', 'Kerb')
    raised(mb, lawn, Z['lawn'], 'Lawn', 'Kerb')
    kerb_line(mb, lawn, Z['lawn'] - 0.02, 0.12, 0.08)
    for i, q in enumerate(parts(play)):
        raised(mb, q, Z['play'], 'Rubber orange' if i % 2 == 0 else 'Rubber yellow', 'Kerb')
    sm = mb.to_mesh('Ground', mats)
    make_object('Ground', sm, col)

    mb = MeshBuilder()
    labels, cars, people, trees = [], [], [], []
    # playgrounds and the pitch
    for q in parts(play):
        for p in play_set(mb, q, Z['play'], rnd):
            for k in range(rnd.randint(1, 3)):
                people.append([round(p.x + rnd.uniform(-2, 2), 2), round(p.y + rnd.uniform(-2, 2), 2), Z['play'], rnd.randrange(6)])
    for q in parts(sport):
        if q.area > 300:
            football(mb, q, Z['sport'])
    # kindergarten, hospital, ramps to the underground car park, substation
    wings = [Polygon(p).buffer(0) for p in raw.get('kinder', [])] or [g for g in cls['kindergarten'] if g.area > 150]
    kindergarten(mb, wings, labels, rnd)
    hosp = [g for g in blue if Point(116.6, -13.2).distance(g) < 5]
    for g in hosp:
        hospital(mb, g, labels)
    for g in blue:
        if g in hosp or not g.intersects(inside) or g.area > 400:
            continue
        r = g.minimum_rotated_rectangle
        mb.polygon_face(r, 0.02, 'Asphalt')
        ring = r.buffer(0.25, join_style='mitre').difference(r)
        mb.prism(ring, 0.0, 1.1, 'Stone white', 'Stone white')
        mb.prism(r.buffer(0.3, join_style='mitre'), 2.9, 3.05, 'Frame dark', 'Shop glass', 'Frame dark')
    for w in raw['words']:
        if w['t'] in ('ПС', '6'):
            x, y = w['p']
            mb.box(x, y, 0.0, 9.0 if w['t'] == 'ПС' else 5.0, 6.0 if w['t'] == 'ПС' else 4.0, 3.2, 'Stone white', rot=math.radians(27.5))
    school_fp = school(mb, labels)

    # houses across the roads (existing, "12"): plain five-storey blocks with drawn-on windows
    houses = []
    for g in polys_of(raw, 'podium') + polys_of(raw, 'building'):
        if g.intersects(inside) or g.area < 120:
            continue
        r = g.minimum_rotated_rectangle
        if r.area > 2500 or r.intersects(asphalt.buffer(2)):
            continue
        houses.append(r)
    for r in houses:
        mb.prism(r, 0.0, 15.0, 'Neighbour solid', 'Roof')

    # lamps along the paths and the roads, benches by the lawns (kept apart: one lamp per 15 m,
    # one bench per 9 m, whatever the outlines of the paved areas)
    lamps, benches = [], []

    def spaced(lst, p, gap):
        if any(math.dist(p, q) < gap for q in lst):
            return False
        lst.append(p)
        return True
    for q in parts(paving.intersection(inside)):
        if q.area < 60:
            continue
        for p in resample(ring_coords(q.buffer(-0.6)) if not q.buffer(-0.6).is_empty and q.buffer(-0.6).geom_type == 'Polygon' else ring_coords(q), 17.0):
            if built.buffer(2.5).contains(Point(p)) or not spaced(lamps, p, 15.0):
                continue
            lamp(mb, p[0], p[1], Z['paving'], 4.2)
    for q in parts(lawn.intersection(inside)):
        if q.area < 40:
            continue
        ring = ring_coords(q)
        for i, p in enumerate(resample(ring, 23.0)):
            pp = Point(p)
            if paving.distance(pp) > 0.6 or built.buffer(4).contains(pp) or not spaced(benches, p, 9.0):
                continue
            # face away from the lawn
            near = q.exterior.interpolate(q.exterior.project(pp))
            d = q.exterior.interpolate(q.exterior.project(pp) + 0.5)
            rot = math.atan2(d.y - near.y, d.x - near.x)
            ox, oy = math.sin(rot) * 0.8, -math.cos(rot) * 0.8
            bench(mb, p[0] + ox, p[1] + oy, Z['paving'], rot)
    # street lamps: along the road edges outside the plot, every 30 m
    verge = unary_union([lawn, paving])
    for q in parts(asphalt):
        if q.area < 2000:
            continue
        ext = q.exterior if q.exterior.is_ccw else LineString(list(q.exterior.coords)[::-1])
        for p in resample(list(ext.coords)[:-1], 32.0):
            pp = Point(p)
            if inside.buffer(-4).contains(pp) or verge.distance(pp) > 1.0 or not spaced(lamps, p, 24.0):
                continue
            n = ext.interpolate(ext.project(pp) + 0.5)
            ang = math.atan2(n.y - p[1], n.x - p[0])
            rot = ang + math.pi / 2  # into the road (CCW ring: road on the left)
            lamp(mb, p[0] - math.cos(rot) * 0.7, p[1] - math.sin(rot) * 0.7, 0.12, 9.0, street=True, rot=rot)

    # hedges along the plot edge facing the roads
    edge = plot.exterior
    for q in parts(lawn.intersection(plot.difference(plot.buffer(-6)))):
        if q.area < 20:
            continue
        line = q.exterior.intersection(edge.buffer(4))
        for l in getattr(line, 'geoms', [line]):
            if l.geom_type != 'LineString' or l.length < 3:
                continue
            c = list(l.coords)
            mb.tube(c, [Z['lawn']] * len(c), [Z['lawn'] + 0.9] * len(c), 0.8, 'Shrub')

    # car parks at the "8" marks
    blocked = unary_union([built, lawn, play, paving]).buffer(0.2)
    for w in raw['words']:
        if w['t'] == '8' and REGION.contains(Point(w['p'])):
            parking(mb, asphalt, w['p'], rnd, cars, blocked)
    # cars on the roads outside the plot: in the lanes, along the road
    road = asphalt.difference(inside)
    core = road.buffer(-3.2)
    for q in parts(core):
        x0, y0, x1, y1 = q.bounds
        n = int(q.area / 140)
        for k in range(n):
            p = Point(rnd.uniform(x0, x1), rnd.uniform(y0, y1))
            if not q.contains(p) or any(p.distance(Point(c[0], c[1])) < 9 for c in cars):
                continue
            # direction of the road here: the longer side of the local asphalt's rotated rectangle
            loc = road.intersection(p.buffer(14)).minimum_rotated_rectangle
            cc = list(loc.exterior.coords)
            e1 = (cc[1][0] - cc[0][0], cc[1][1] - cc[0][1])
            e2 = (cc[2][0] - cc[1][0], cc[2][1] - cc[1][1])
            e = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2
            rot = math.atan2(e[1], e[0]) + (math.pi if rnd.random() < 0.5 else 0)
            cars.append([round(p.x, 2), round(p.y, 2), 0.0, round(rot, 3), rnd.randrange(8)])

    # trees: the genplan's, then lawns filled in, then street trees along the verges
    def free(p, gap):
        return not built.buffer(3.5).contains(p) and not school_fp.buffer(2).contains(p) and all(
            p.distance(Point(t[0], t[1])) >= gap for t in trees)
    for x, y in raw['trees']:
        p = Point(x, y)
        if REGION.contains(p) and free(p, 2.5):
            trees.append([x, y, Z['lawn'], round(rnd.uniform(6.5, 9.5), 2), round(rnd.uniform(2.4, 3.4), 2), 'broad'])
    for q in parts(lawn):
        if q.area < 25:
            continue
        inner = q.buffer(-1.6)
        if inner.is_empty:
            continue
        x0, y0, x1, y1 = inner.bounds
        target = int(q.area / (75 if q.intersects(inside) else 110))
        tries = 0
        placed = 0
        while placed < target and tries < target * 30:
            tries += 1
            p = Point(rnd.uniform(x0, x1), rnd.uniform(y0, y1))
            if not inner.contains(p) or not free(p, 6.0):
                continue
            r = rnd.random()
            kind = 'conifer' if r < 0.18 else 'poplar' if r < 0.3 else 'small' if r < 0.45 else 'broad'
            h = {'conifer': (7, 11), 'poplar': (9, 14), 'small': (3.5, 5.5), 'broad': (6, 10)}[kind]
            trees.append([round(p.x, 2), round(p.y, 2), Z['lawn'], round(rnd.uniform(*h), 2), round(rnd.uniform(1.8, 3.4), 2), kind])
            placed += 1
    # people on the paths and plazas
    walk = paving.intersection(inside).difference(built.buffer(1.0))
    x0, y0, x1, y1 = walk.bounds
    n = 0
    while n < 140:
        p = Point(rnd.uniform(x0, x1), rnd.uniform(y0, y1))
        if walk.contains(p):
            people.append([round(p.x, 2), round(p.y, 2), Z['paving'], rnd.randrange(6)])
            n += 1
    for t in towers:
        c = Polygon(t['outline']).centroid
        labels.append(dict(x=round(c.x, 2), y=round(c.y, 2), z=t['top'] + 9, ru=t['label'], tj=t['tj'], kind='block', key=t['key']))

    om = mb.to_mesh('Site props', mats)
    make_object('Site props', om, col)
    return dict(trees=trees, cars=cars, people=people, labels=labels)
