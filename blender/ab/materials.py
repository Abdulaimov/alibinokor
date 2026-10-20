"""Materials of the Ali Binokor model: the shared set (complex/materials.py) plus the facades of the
renders. Names are what the web viewer looks up (src/materials.js), keep them stable."""
from complex import materials as base

AB_SPECS = {
    # facades (renders 1-3): tan facing brick, dark grey brick, white stone, glass tower
    'Brick tan': ('#b98559', 0.9, 0.0, {}),
    'Brick dark': ('#46484c', 0.9, 0.0, {}),
    'Stone white': ('#ece7de', 0.6, 0.0, {}),
    'Stone dark': ('#3a3c40', 0.6, 0.0, {}),
    'Frame dark': ('#2b2e32', 0.4, 0.3, {}),
    'Frame light': ('#c9cdd0', 0.4, 0.5, {}),
    'Tower glass': ('#3f5866', 0.05, 0.0, {}),
    'Mesh screen': ('#cfd4d6', 0.5, 0.6, {'alpha': 0.55}),
    'Roof': ('#8d8c88', 0.95, 0.0, {}),
    'Plant room': ('#d9d6d0', 0.8, 0.0, {}),
    # shops behind the glass
    'Shop glass': ('#9fb4bb', 0.03, 0.0, {'alpha': 0.25}),
    'Shop floor': ('#d9d3c8', 0.4, 0.0, {}),
    'Shop ceiling': ('#f6efe4', 0.8, 0.0, {'emission': ('#ffe9c8', 0.5)}),
    'Shop wall': ('#efece6', 0.8, 0.0, {}),
    'Shop light': ('#ffffff', 0.5, 0.0, {'emission': ('#fff7e8', 6.0)}),
    'Shelf': ('#e9e4da', 0.6, 0.0, {}),
    'Counter': ('#7a5a42', 0.5, 0.0, {}),
    'Goods red': ('#c0392b', 0.6, 0.0, {}),
    'Goods blue': ('#2e5c9e', 0.6, 0.0, {}),
    'Goods yellow': ('#e3b23c', 0.6, 0.0, {}),
    'Goods white': ('#f1efe9', 0.6, 0.0, {}),
    'Goods green': ('#3f8a4f', 0.6, 0.0, {}),
    'Sign white': ('#f7f5f0', 0.4, 0.0, {'emission': ('#ffffff', 1.2)}),
    'Sign warm': ('#f0c070', 0.4, 0.0, {'emission': ('#ffcf7a', 1.2)}),
    'Sign blue': ('#3d8fe8', 0.4, 0.0, {'emission': ('#3a8cff', 1.0)}),
    'Sign green': ('#3cba6e', 0.4, 0.0, {'emission': ('#3cd27a', 1.0)}),
    'Sign red': ('#e04848', 0.4, 0.0, {'emission': ('#ff4a4a', 1.0)}),
    # context
    'Kinder wall': ('#f3eee5', 0.8, 0.0, {}),
    'Kinder red': ('#d9483b', 0.6, 0.0, {}),
    'Kinder yellow': ('#f2c230', 0.6, 0.0, {}),
    'Kinder blue': ('#3a7bd5', 0.6, 0.0, {}),
    'Kinder green': ('#4caf50', 0.6, 0.0, {}),
    'Hospital wall': ('#eef1f2', 0.7, 0.0, {}),
    'Hospital accent': ('#2f7fb6', 0.5, 0.0, {}),
    'School wall': ('#e9dccb', 0.8, 0.0, {}),
    'School accent': ('#b04a3a', 0.7, 0.0, {}),
    'Label': ('#ffffff', 0.4, 0.0, {'emission': ('#ffffff', 0.4)}),
    'Mountain': ('#9a9488', 1.0, 0.0, {}),
    'Snow': ('#f2f4f6', 0.8, 0.0, {}),
    'Sport green': ('#3f9a3a', 0.9, 0.0, {}),
    'Track red': ('#b4543c', 0.9, 0.0, {}),
    'Fence': ('#3f4a44', 0.5, 0.5, {}),
    'Rubber orange': ('#e0863a', 0.95, 0.0, {}),
    'Rubber yellow': ('#e8c547', 0.95, 0.0, {}),
    'Gravel': ('#c7bfb2', 1.0, 0.0, {}),
    'Lamp dark': ('#2f3337', 0.45, 0.6, {}),
    'Ground': ('#9c9473', 1.0, 0.0, {}),
    'Stone beige': ('#e0c08e', 0.7, 0.0, {}),
    'Screen dark': ('#3a3c40', 0.6, 0.4, {}),
    'Poster': ('#ffffff', 0.5, 0.0, {}),
    'Stair glass': ('#3d6f86', 0.05, 0.0, {}),
}


def build_materials():
    base.SPECS.update(AB_SPECS)
    return base.build_materials()
