"""The Ali Binokor complex: blocks, floors and where they stand (site metres: x east, y north on the
genplan sheet, origin at the middle of the plot; see tools/ab/site_map.py).

Block centres and turns were fitted to the footprints drawn on the genplan (ГП, 1:1000); the floor
plans (plans.json, tools/ab/extract_plan.py) are drawn in each block's own frame and turned by `rot`
(degrees, plan x-axis from east towards north). For the slab blocks the plan's +y side (punched
windows in brick, the stair halls) faces the street as on the renders, and the -y side (the row of
loggias) the courtyard.
There are no sections in the drawings: shops on floors 1-2 (4.5 m and 4.2 m), then 3.3 m per floor.
"""
import json
import os

PLANS_JSON = os.path.join(os.path.dirname(__file__), 'plans.json')

GROUND = 4.5      # floor 1 (shops)
SECOND = 4.2      # floor 2 (shops)
STOREY = 3.3      # apartment floors
SLAB = 0.25       # finished floor above the level datum (the viewer puts interiors on it)


def level(n):
    """height of floor n above the ground"""
    if n <= 1:
        return 0.0
    if n == 2:
        return GROUND
    return GROUND + SECOND + (n - 3) * STOREY


def height(n):
    return GROUND if n == 1 else SECOND if n == 2 else STOREY


BLOCKS = {
    # key: label, centre, rot, floors, plan per floor, facade style, sold (interiors) or only shown
    'A': dict(label='Блок А', tj='Блоки А', centre=(-99.0, -19.5), rot=26.0, floors=24, style='glass', sales=True,
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
