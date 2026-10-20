// Fixed cameras for screenshots (scene metres: x east, y up, z south; site origin in the middle of the plot).
// The start view of the site (src/main.js HOME_WIDE).
export const HOME = { pos: [-150, 165, 285], target: [5, 22, -5] };

export const VIEWS = {
  // the start view, with the sales UI
  aerial: { ...HOME, ui: true },
  aerial_clean: { ...HOME },
  // like render 1: blocks Б and В from the street to the south
  // the camera of render 1 (from the park south of the avenue) and of render 2 (from the south-west)
  render1: { pos: [-10, 24, 250], target: [-22, 30, 0], noCity: true },
  render2: { pos: [-330, 12, -40], target: [-40, 40, 0], noCity: true },
  a_west: { pos: [-234, 40, 85.5], target: [-99, 40, 19.5] },
  a_south: { pos: [-99 + 0.44 * 150, 40, 19.5 + 0.9 * 150], target: [-99, 40, 19.5] },
  a_north: { pos: [-99 - 0.44 * 150, 40, 19.5 - 0.9 * 150], target: [-99, 40, 19.5] },
  a_east: { pos: [-99 + 0.9 * 150, 40, 19.5 - 0.44 * 150], target: [-99, 40, 19.5] },
  // render 3: the shop front of block Б from the pavement, block A's podium in the distance
  render3: { pos: [-5, 2.2, 70], target: [-45, 9, 48], noCity: true },
  poster: { pos: [-22, 4, 62], target: [-30, 4, 46], noCity: true },
  // the user's screenshot of 20.10: from the north-west over the kindergarten
  user_nw: { pos: [-210, 95, -190], target: [-40, 25, -10] },
  mid_stripe: { pos: [-20, 40, 120], target: [-30, 40, 30], noCity: true },
  // block Б's street face straight on, like render 1 (camera on the avenue, 1.7 m up... raised to see the top)
  b_front: { pos: [-33.6 + 0.42 * 190, 40, 31 + 0.906 * 190], target: [-33.6, 38, 31], noCity: true },
  win_close: { pos: [-20, 30, 55], target: [-28, 30, 30] },
  street: { pos: [10, 9, 120], target: [5, 38, 20] },
  // like render 2: from the south-west, the glass tower in front
  southwest: { pos: [-240, 30, 150], target: [-60, 45, 0] },
  tower_a: { pos: [-150, 20, 60], target: [-99, 40, 19] },
  shops: { pos: [-20, 4, 75], target: [-35, 6, 40] },
  courtyard: { pos: [10, 40, 10], target: [40, 0, -40] },
  playground: { pos: [150, 45, 20], target: [80, 0, -80] },
  kindergarten: { pos: [-40, 30, 10], target: [-8, 3, -29] },
  hospital: { pos: [150, 30, 60], target: [117, 8, 14] },
  school: { pos: [60, 60, -60], target: [118, 5, -150] },
  north: { pos: [80, 140, -300], target: [0, 20, 0] },
  // cut-away floor, an apartment's card, walking inside
  floor_b10: { floor: ['B', 10], ui: true, from: HOME, wait: 2500 },
  apt_b10: { floor: ['B', 10], apt: 'B10-3', ui: true, from: HOME, wait: 2500 },
  floor_a12: { floor: ['A', 12], ui: true, from: HOME, wait: 2500 },
  apt_g12: { floor: ['G', 12], apt: 'G12-4', ui: true, from: HOME, wait: 2500 },
  floor_g20: { floor: ['G', 20], ui: true, from: HOME },
};
