"""The Ali Binokor complex: blocks, floors and where they stand (site metres: x east, y north on the
genplan sheet, origin at the middle of the plot; see tools/ab/site_map.py).

Block centres and turns were fitted to the footprints drawn on the genplan (ГП, 1:1000); the floor
plans (plans.json, tools/ab/extract_plan.py) are drawn in each block's own frame and turned by `rot`
(degrees, plan x-axis from east towards north). For the slab blocks the plan's +y side (punched
windows in brick, the stair halls) faces the street as on the renders, and the -y side (the row of
loggias) the courtyard.
There are no sections in the drawings; the heights are read off the client renders (tools/ab/calib.py
fits the renders' cameras to the band, window and cornice rows): two tall shop floors (6.2 m and 5.8 m:
floor 3 is 12.0 m over the street on renders 1 and 2, the tower and the slab blocks alike), then
3.5 m per floor on the slab blocks (render 1: 3.44 m on Б, 3.54 m on В, against the plans' 64.4 m
length) and 3.75 m on the glass tower A (renders 1 and 2 both give 3.74-3.75 m against the plan's
45.7 x 44.2 m curtain wall; 3.3 m misses the band rows by up to 42-49 px).
"""
import json
import os

PLANS_JSON = os.path.join(os.path.dirname(__file__), 'plans.json')

GROUND = 6.2      # floor 1 (shops)
SECOND = 5.8      # floor 2 (shops)
STOREY = 3.5      # apartment floors
SLAB = 0.25       # finished floor above the level datum (the viewer puts interiors on it)


def dims(b=None):
    """(floor 1, floor 2, apartment floor) heights of block b (a BLOCKS entry or its key)"""
    if isinstance(b, str):
        b = BLOCKS[b]
    if not b:
        return GROUND, SECOND, STOREY
    return b.get('ground', GROUND), b.get('second', SECOND), b.get('storey', STOREY)


def level(n, b=None):
    """height of floor n of block b above the ground"""
    g, s, st = dims(b)
    if n <= 1:
        return 0.0
    if n == 2:
        return g
    return g + s + (n - 3) * st


def height(n, b=None):
    g, s, st = dims(b)
    return g if n == 1 else s if n == 2 else st


def podium_top(b=None):
    """roof of the two shop floors = level of floor 3"""
    g, s, _ = dims(b)
    return g + s


BLOCKS = {
    # key: label, centre, rot, floors, plan per floor, facade style, sold (interiors) or only shown
    'A': dict(label='Блок А', tj='Блоки А', centre=(-99.0, -19.5), rot=26.0, floors=24, style='glass', sales=True,
              storey=3.75,
              plans={f: ('A_t' if f in (9, 10, 20, 21) else 'A') for f in range(3, 25)}),
    'B': dict(label='Блок Б', tj='Блоки Б', centre=(-33.6, -31.0), rot=205.2, floors=22, style='brick', sales=True,
              plans={f: ('BG_top' if f >= 19 else 'BG') for f in range(3, 23)}),
    'V': dict(label='Блок В', tj='Блоки В', centre=(44.2, -38.5), rot=205.4, floors=20, style='brick', sales=False,
              plans={f: ('BG_top' if f >= 19 else 'BG') for f in range(3, 21)}),
    'G': dict(label='Блок Г', tj='Блоки Г', centre=(45.37, 49.45), rot=117.5, floors=22, style='brick', sales=True,
              plans={f: ('BG_top' if f >= 19 else 'BG') for f in range(3, 23)}),
    'D': dict(label='Блок Д', tj='Блоки Д', centre=(108.45, 38.13), rot=207.5, floors=22, style='brick', sales=False,
              plans={f: ('BG_top' if f >= 19 else 'BG') for f in range(3, 23)}),
}
FIRST_FLAT_FLOOR = 3


def load_plans():
    return json.load(open(PLANS_JSON))
