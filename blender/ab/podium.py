"""Floors 1-2 of every block: shops, and the two-storey podium round blocks A, Б and В (genplan "2-ош.").

The shop front follows the outline in bays of about 3.3 m: white stone portals two storeys high on
dark grey piers, clear glass on both floors with a dark signage band between them (renders 1 and 3).
Behind the glass the shops are fitted out so they read from the street: stone floor, ceiling with
light strips, partitions every 10-14 m, shelving, racks and counters, and people (the viewer draws
them from PEOPLE). Residential entrances on the courtyard side of the slab blocks get a canopy.
"""
import math
import random

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from complex.geom import MeshBuilder, make_object, resample, ring_coords

from .config import GROUND, SECOND

PEOPLE = []     # [x, y, z, kind] site metres, filled by build_base
TREES = []      # trees on the podium roof: [x, y, z, h, r, kind]
TOP = GROUND + SECOND   # 8.7: roof of the podium / level of floor 3
BAY = 3.3


def to_plan(b, pts):
    a = math.radians(b['rot'])
    ca, sa = math.cos(a), math.sin(a)
    cx, cy = b['centre']
    return [(ca * (x - cx) + sa * (y - cy), -sa * (x - cx) + ca * (y - cy)) for x, y in pts]


def to_site(b, x, y):
    a = math.radians(b['rot'])
    ca, sa = math.cos(a), math.sin(a)
    cx, cy = b['centre']
    return cx + ca * x - sa * y, cy + sa * x + ca * y


def poster(mb, a, b, z0, z1, nx, ny, off=0.06):
    """A lit poster panel (light box) between plan points a and b, facing out (n), UVs 0..1."""
    p0 = (a[0] + nx * off, a[1] + ny * off)
    p1 = (b[0] + nx * off, b[1] + ny * off)
    # p0 -> p1 runs left to right seen from outside; v is flipped for the canvas texture (flipY) of the viewer
    mb.face([(*p0, z0), (*p1, z0), (*p1, z1), (*p0, z1)], 'Poster', [(0, 1), (1, 1), (1, 0), (0, 0)])
    # white frame round it
    for q0, q1, za, zb in ((p0, p1, z0 - 0.12, z0), (p0, p1, z1, z1 + 0.12)):
        mb.face([(*q0, za), (*q1, za), (*q1, zb), (*q0, zb)], 'Stone white')


def shop_front(mb, outline, rnd):
    """Brick blocks (renders 1 and 3): bays of about 3.3 m; dark grey stone piers; in each bay a
    window two storeys high in a white stone portal, a thin transom at the second floor; a dark
    stone frieze over the portals with a white line; every fifth bay a dark wall with a poster."""
    pts = ring_coords(outline)
    k_all = 0
    for a, b in zip(pts, pts[1:] + pts[:1]):
        L = math.dist(a, b)
        if L < 0.3:
            continue
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, ny = uy, -ux
        rot = math.atan2(uy, ux)
        nb = max(1, round(L / BAY))
        w = L / nb
        for k in range(nb):
            k_all += 1
            s0, s1 = k * w, (k + 1) * w
            p0 = (a[0] + ux * s0, a[1] + uy * s0)
            p1 = (a[0] + ux * s1, a[1] + uy * s1)
            m = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
            pier = 0.6
            mb.box(p0[0] + ux * pier / 2, p0[1] + uy * pier / 2, 0.0, pier, 0.45, TOP, 'Stone dark', rot=rot)
            g0 = (p0[0] + ux * pier, p0[1] + uy * pier)
            gl = math.dist(g0, p1)
            if gl < 0.6:
                continue
            gm = ((g0[0] + p1[0]) / 2, (g0[1] + p1[1]) / 2)
            top = TOP - 1.25
            # frieze over the bay: dark stone with a white line
            mb.box(gm[0], gm[1], top, gl, 0.4, TOP - top, 'Stone dark', rot=rot)
            mb.box(gm[0] + nx * 0.2, gm[1] + ny * 0.2, TOP - 0.55, gl, 0.06, 0.08, 'Stone white', rot=rot)
            if gl > 2.0 and k_all % 5 == 3 and L > 12:
                # a dark wall with a poster on it
                i0 = (g0[0] + nx * 0.18, g0[1] + ny * 0.18)
                i1 = (p1[0] + nx * 0.18, p1[1] + ny * 0.18)
                mb.quad_wall(i0, i1, 0.0, top, 'Stone dark')
                e = 0.35
                poster(mb, (i0[0] + ux * e, i0[1] + uy * e), (i1[0] - ux * e, i1[1] - uy * e), 2.6, top - 0.5, nx, ny)
                continue
            # white portal round the window
            fr = 0.24
            for c0 in (g0, (p1[0] - ux * fr, p1[1] - uy * fr)):
                mb.box(c0[0] + ux * fr / 2 + nx * 0.06, c0[1] + uy * fr / 2 + ny * 0.06, 0.0, fr, 0.34, top, 'Stone white', rot=rot)
            mb.box(gm[0] + nx * 0.06, gm[1] + ny * 0.06, top - 0.24, gl, 0.34, 0.24, 'Stone white', rot=rot)
            # the window: clear glass set back, a thin transom at the second floor, a mullion
            i0 = (g0[0] + ux * fr - nx * 0.1, g0[1] + uy * fr - ny * 0.1)
            i1 = (p1[0] - ux * fr - nx * 0.1, p1[1] - uy * fr - ny * 0.1)
            mid = ((i0[0] + i1[0]) / 2, (i0[1] + i1[1]) / 2)
            gw = gl - 2 * fr
            mb.quad_wall(i0, i1, 0.0, top - 0.24, 'Shop glass')
            mb.box(mid[0], mid[1], 0.0, gw, 0.08, 0.08, 'Shop frame', rot=rot)
            mb.box(mid[0], mid[1], GROUND - 0.1, gw, 0.1, 0.12, 'Shop frame', rot=rot)
            mb.box(mid[0], mid[1], top - 0.32, gw, 0.08, 0.08, 'Shop frame', rot=rot)
            if k % 3 == 0:
                # glass doors
                for e in (-0.9, 0.9):
                    mb.box(mid[0] + ux * e, mid[1] + uy * e, 0.0, 0.06, 0.1, 2.5, 'Shop frame', rot=rot)
                mb.box(mid[0], mid[1], 2.5, 1.86, 0.1, 0.07, 'Shop frame', rot=rot)
            else:
                mb.box(mid[0], mid[1], 0.0, 0.05, 0.08, top - 0.24, 'Shop frame', rot=rot)


def glass_front(mb, outline, rnd):
    """Block A's podium (render 3): continuous glazing on both floors with slim mullions, dark grey
    panels in some bays, and thick white bands at the second floor and the roof, rounded at the
    corners and standing out over the pavement."""
    ring = ring_coords(outline)
    pts = resample(ring, 1.6)
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        L = math.dist(a, b)
        if L < 0.05:
            continue
        ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, ny = uy, -ux
        rot = math.atan2(uy, ux)
        i0 = (a[0] - nx * 0.25, a[1] - ny * 0.25)
        i1 = (b[0] - nx * 0.25, b[1] - ny * 0.25)
        dark = i % 9 in (4, 5)
        for z0, z1 in ((0.0, GROUND - 0.35), (GROUND + 0.45, TOP - 0.9)):
            mb.quad_wall(i0, i1, z0, z1, 'Stone dark' if dark else 'Shop glass')
            if not dark:
                mb.box(i0[0], i0[1], z0, 0.05, 0.1, z1 - z0, 'Shop frame', rot=rot)
        if not dark:
            m = ((i0[0] + i1[0]) / 2, (i0[1] + i1[1]) / 2)
            mb.box(m[0], m[1], 2.7, L, 0.08, 0.06, 'Shop frame', rot=rot)
    soft = outline.buffer(-1.5, join_style='round').buffer(1.5, join_style='round')
    for z0, z1, out in ((GROUND - 0.35, GROUND + 0.45, 0.7), (TOP - 0.9, TOP + 0.25, 1.0)):
        bandp = soft.buffer(out, join_style='round').difference(outline.buffer(-0.3, join_style='mitre'))
        mb.prism(bandp, z0, z1, 'White band', 'White band', 'White band')


SIGNS = ['Sign white', 'Sign warm', 'Sign blue', 'Sign green', 'Sign red']


def interior(mb, outline, tower_base, rnd, b, people):
    """Shops behind the glass: floors, ceilings with light strips, partitions, shelves, people."""
    deep = outline.buffer(-7.5, join_style='mitre')
    shell = outline.buffer(-0.15, join_style='mitre')
    zone = shell.difference(deep) if not deep.is_empty else shell
    for z0, z1 in ((0.0, GROUND), (GROUND, TOP)):
        mb.polygon_face(shell, z0 + 0.02, 'Shop floor')
        mb.polygon_face(shell, z1 - 0.45, 'Shop ceiling', up=False)
        # back wall: the shops are 7.5 m deep, then a white wall
        if not deep.is_empty:
            mb.prism(deep, z0, z1 - 0.45, 'Shop wall')
    # light strips: a rectangle of lines inside the zone, both floors
    for z in (GROUND - 0.47, TOP - 0.47):
        for d in (1.6, 4.2, 6.4):
            ring = outline.buffer(-d, join_style='mitre')
            if ring.is_empty:
                continue
            for g in getattr(ring, 'geoms', [ring]):
                cs = ring_coords(g)
                for a, c in zip(cs, cs[1:] + cs[:1]):
                    L = math.dist(a, c)
                    n = int(L // 2.4)
                    for k in range(n):
                        t = (k + 0.5) / n
                        p = (a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t)
                        mb.box(p[0], p[1], z, 1.2, 0.18, 0.02, 'Shop light', rot=math.atan2(c[1] - a[1], c[0] - a[0]), top=False, bottom=True)
    # partitions every 10-14 m along the front, shelving on them, racks and counters, people
    pts = ring_coords(shell)
    for a, c in zip(pts, pts[1:] + pts[:1]):
        L = math.dist(a, c)
        if L < 6:
            continue
        ux, uy = (c[0] - a[0]) / L, (c[1] - a[1]) / L
        nx, ny = -uy, ux   # inwards (CCW ring)
        rot = math.atan2(uy, ux)
        s = 0.0
        while s < L - 4:
            w = min(L - s, rnd.uniform(10, 14))
            p = (a[0] + ux * (s + w), a[1] + uy * (s + w))
            for z0, z1 in ((0.0, GROUND), (GROUND, TOP)):
                if s + w < L - 1:
                    mb.box(p[0] + nx * 3.7, p[1] + ny * 3.7, z0, 0.15, 7.4, z1 - z0 - 0.45, 'Shop wall', rot=rot)
                    # shelving along the partition
                    for side in (-0.45, 0.45):
                        q = (p[0] + nx * 4.0 - ux * side, p[1] + ny * 4.0 - uy * side)
                        mb.box(q[0], q[1], z0, 0.6, 5.5, 2.1, 'Shelf', rot=rot)
                        for lvl in (0.5, 1.0, 1.5):
                            mb.box(q[0], q[1], z0 + lvl, 0.5, 5.2, 0.28, rnd.choice(GOODS), rot=rot)
                # racks / tables in the middle of the shop, a counter at the back
                for k in range(rnd.randint(1, 3)):
                    t = s + rnd.uniform(2.0, w - 2.0)
                    d = rnd.uniform(2.2, 5.0)
                    q = (a[0] + ux * t + nx * d, a[1] + uy * t + ny * d)
                    kind = rnd.random()
                    if kind < 0.4:
                        mb.box(q[0], q[1], z0, 1.6, 0.8, 0.85, 'Shelf', rot=rot)
                        mb.box(q[0], q[1], z0 + 0.85, 1.4, 0.6, 0.12, rnd.choice(GOODS), rot=rot)
                    elif kind < 0.75:
                        mb.box(q[0], q[1], z0 + 1.45, 1.6, 0.05, 0.05, 'Metal', rot=rot)
                        for e in (-0.75, 0.75):
                            mb.box(q[0] + ux * e, q[1] + uy * e, z0, 0.05, 0.4, 1.5, 'Metal', rot=rot)
                        for e in range(6):
                            mb.box(q[0] + ux * (-0.6 + e * 0.24), q[1] + uy * (-0.6 + e * 0.24), z0 + 0.55, 0.08, 0.5, 0.85,
                                   rnd.choice(CLOTHES), rot=rot)
                    else:
                        mb.box(q[0], q[1], z0, 0.6, 0.6, 1.0, 'Shelf', rot=rot)
                        mb.blob(q[0], q[1], z0 + 1.35, 0.45, 0.45, 0.5, 'Leaves light', subdiv=1)
                cq = (a[0] + ux * (s + w / 2) + nx * 6.4, a[1] + uy * (s + w / 2) + ny * 6.4)
                mb.box(cq[0], cq[1], z0, 2.4, 0.7, 1.05, 'Counter', rot=rot)
                # people: a few per shop, standing or walking between the fittings
                for k in range(rnd.randint(2, 4)):
                    t = s + rnd.uniform(1.2, w - 1.2)
                    d = rnd.uniform(1.2, 5.6)
                    x, y = a[0] + ux * t + nx * d, a[1] + uy * t + ny * d
                    if zone.contains(Point(x, y)):
                        sx, sy = to_site(b, x, y)
                        people.append([round(sx, 2), round(sy, 2), round(z0 + 0.04, 2), rnd.randrange(6)])
            s += w


GOODS = ['Goods red', 'Goods blue', 'Goods yellow', 'Goods white', 'Goods green']
CLOTHES = ['Goods red', 'Goods blue', 'Goods white', 'Car dark', 'Goods yellow', 'Lounger']


def entrances(mb, b, plan, base):
    """Canopies over the residential entrances: where a stair / lift hall reaches the courtyard face."""
    common = [Polygon(c).buffer(0) for c in plan['common']]
    x0, y0, x1, y1 = base.bounds
    for c in common:
        if c.area < 20:
            continue
        cx = c.centroid.x
        # courtyard face: -y for the slab blocks (the loggia side)
        y = y0
        mb.box(cx, y - 1.4, 3.3, 4.6, 3.0, 0.22, 'Stone white', rot=0.0)
        for e in (-2.0, 2.0):
            mb.box(cx + e, y - 2.7, 0.0, 0.12, 0.12, 3.3, 'Frame dark')
        mb.box(cx, y - 0.02, 0.0, 2.2, 0.12, 2.5, 'Shop frame')
        mb.box(cx, y + 0.02, 0.05, 1.9, 0.14, 2.35, 'Shop glass')
        mb.box(cx, y - 0.08, 2.75, 3.0, 0.1, 0.4, 'Sign white')


def build_base(key, b, plan, mats, col, put, podium_site=None):
    rnd = random.Random(hash(key) & 0xffff)
    enc = Polygon(plan['enclosure']).buffer(0)
    base = enc.buffer(-0.1, join_style='mitre')
    outline = base
    if podium_site is not None and not podium_site.is_empty:
        pod = Polygon(to_plan(b, list(podium_site.exterior.coords))).buffer(0)
        outline = unary_union([base, pod]).buffer(0.3, join_style='mitre').buffer(-0.3, join_style='mitre')
        if outline.geom_type != 'Polygon':
            outline = max(outline.geoms, key=lambda g: g.area)
    from complex.geom import ccw
    outline = ccw(outline.simplify(0.15))
    mb = MeshBuilder()
    (glass_front if b['style'] == 'glass' else shop_front)(mb, outline, rnd)
    people = []
    interior(mb, outline, base, rnd, b, people)
    PEOPLE.extend(people)
    # podium roof (where it reaches beyond the tower): deck, parapet, planters
    roof = outline.difference(enc.buffer(-0.05, join_style='mitre'))
    mb.prism(outline.buffer(0.05, join_style='mitre'), TOP - 0.45, TOP, 'Stone dark', None, 'Shop ceiling')
    mb.polygon_face(roof, TOP + 0.01, 'Deck paving')
    edge = outline.exterior
    cs = list(edge.coords)
    if b['style'] == 'glass':
        mb.ribbon(cs, TOP + 0.25, TOP + 1.25, 'Railing glass', closed=True, double=True)
    else:
        mb.tube(cs, [TOP] * len(cs), [TOP + 0.45] * len(cs), 0.3, 'Stone dark', closed=True)
        mb.ribbon(cs, TOP + 0.45, TOP + 1.15, 'Railing glass', closed=True, double=True)
    if roof.area > 80:
        inner = roof.buffer(-2.0)
        for g in getattr(inner, 'geoms', [inner]):
            if g.geom_type != 'Polygon' or g.area < 6:
                continue
            for p in resample(ring_coords(g.buffer(-0.5) if not g.buffer(-0.5).is_empty else g), 6.0):
                mb.box(p[0], p[1], TOP, 1.4, 1.4, 0.55, 'Planter')
                mb.blob(p[0], p[1], TOP + 0.85, 0.6, 0.6, 0.45, 'Shrub', subdiv=1)
                if rnd.random() < 0.45:
                    sx, sy = to_site(b, p[0], p[1])
                    TREES.append([round(sx, 2), round(sy, 2), TOP + 0.5, 4.5, 1.7, 'small'])
            # a few sail umbrellas and tables on the A podium terrace (render 3)
            if b['style'] == 'glass':
                for p in resample(ring_coords(g), 9.0)[::2]:
                    mb.box(p[0], p[1], TOP, 0.08, 0.08, 2.4, 'Metal')
                    mb.box(p[0], p[1], TOP + 2.35, 2.6, 2.6, 0.06, 'Umbrella sand')
                    mb.box(p[0], p[1], TOP, 0.9, 0.9, 0.75, 'Lounger')
    if b['style'] == 'brick':
        entrances(mb, b, plan, base)
    put(make_object(f'{key} shops', mb.to_mesh(f'{key} shops', mats), col))
    return outline
