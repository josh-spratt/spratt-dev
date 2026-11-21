// Cactus Boats' simulation: the rules of a Play, with no DOM, no canvas and
// no Math.random, so it runs headless in Node (tests/cactus-boats/).
//
//   newRun(seed, opts?) -> state      a fresh Play on a sea placed from the seed
//   step(state, intent, dt)           advances the Play one fixed tick (STEP)
//   summary(state) -> { survivedMs, sinks }
//
// intent is the input layer's output: { turn: -1..1, sail: ANCHOR|HALF|FULL,
// fire: null|'auto'|'port'|'stbd' }. Time passes only inside step, so a paused
// game (no step calls) never adds to survivedMs. All randomness comes from a
// seeded generator kept in the state, so a seed plus a list of intents replays
// a Play exactly, and the state is plain data (it survives structuredClone).
//
// For drawing, the state exposes state.sea { width, height },
// state.boat { x, y, h, spd, hp, maxHp, r, scraped } and
// state.islands [{ x, y, r }]. Everything else in it is the simulation's own.

/** The fixed tick, in seconds. */
export const STEP = 1 / 60;

/** Sail settings: the intent's `sail`. */
export const ANCHOR = 0;
export const HALF = 1;
export const FULL = 2;

/** The sea is one screen: 216 px tall, and as wide as the player's screen allows. */
export const SEA_HEIGHT = 216;
export const SEA_WIDTHS = { min: 384, max: 468, default: 432 };

// Hull stats, from the Enemy AI prototype. The player sails a Sombrero.
export const HULLS = {
  sombrero: { hp: 120, spd: 45, turn: 1.4, r: 9 },
};

// The Helm scheme's handling, from the Controls prototype's tuned defaults.
// turnx scales the hull's turn rate; floor is the share of it left at a
// standstill, so the boat can always come about; accel and decel are px/s²;
// half is Half sail's share of top speed.
export const HANDLING = { turnx: 1.2, floor: 0.7, accel: 30, decel: 40, half: 0.55 };

// Ramming an island faster than this (px/s) scrapes the hull.
const SCRAPE = { speed: 18, damage: 4, cooldown: 0.8, keep: 0.4 };
// How close a boat's centre gets to an island's edge.
const SHORE = 5;

// Islands: how many, how big, and how far apart they keep.
const ISLANDS = { min: 2, max: 3, rMin: 12, rMax: 20, edge: 6, start: 56, apart: 28 };

// mulberry32: a small seeded generator. Its whole state is one integer.
function random(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (v, size) => ((v % size) + size) % size;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function placeIslands(state, count) {
  const { width, height } = state.sea;
  const start = state.boat;
  const islands = [];
  const want = count ?? ISLANDS.min + Math.floor(random(state) * (ISLANDS.max - ISLANDS.min + 1));
  for (let tries = 0; islands.length < want && tries < 500; tries++) {
    const r = Math.round(ISLANDS.rMin + random(state) * (ISLANDS.rMax - ISLANDS.rMin));
    const m = r + ISLANDS.edge;
    const isle = {
      x: Math.round(m + random(state) * (width - 2 * m)),
      y: Math.round(m + random(state) * (height - 2 * m)),
      r,
    };
    if (Math.hypot(isle.x - start.x, isle.y - start.y) < r + ISLANDS.start) continue;
    if (islands.some((o) => Math.hypot(isle.x - o.x, isle.y - o.y) < r + o.r + ISLANDS.apart)) continue;
    islands.push(isle);
  }
  return islands;
}

/**
 * A fresh Play. `width` is the sea's width (clamped to SEA_WIDTHS), picked by
 * the game from the screen. `islands` overrides how many islands there are
 * (the seed picks 2–3), for tests that want open water.
 */
export function newRun(seed, { width = SEA_WIDTHS.default, islands } = {}) {
  const hull = HULLS.sombrero;
  const sea = { width: clamp(Math.round(width), SEA_WIDTHS.min, SEA_WIDTHS.max), height: SEA_HEIGHT };
  const state = {
    seed: seed >>> 0,
    rng: seed >>> 0,
    elapsed: 0,
    sea,
    boat: { x: sea.width / 2, y: sea.height / 2, h: -Math.PI / 2, spd: 0, hp: hull.hp, maxHp: hull.hp, r: hull.r, bump: 0, scraped: 0 },
    islands: [],
  };
  state.islands = placeIslands(state, islands);
  return state;
}

function sail(boat, intent, dt) {
  const hull = HULLS.sombrero;
  const setting = [ANCHOR, HALF, FULL].includes(intent.sail) ? intent.sail : ANCHOR;
  const top = hull.spd * [0, HANDLING.half, 1][setting];
  boat.spd = Math.max(0, boat.spd + clamp(top - boat.spd, -HANDLING.decel * dt, HANDLING.accel * dt));
  const turn = clamp(Number(intent.turn) || 0, -1, 1);
  const rate = hull.turn * HANDLING.turnx * (HANDLING.floor + (1 - HANDLING.floor) * Math.min(1, boat.spd / (hull.spd * 0.6)));
  boat.h = wrapAngle(boat.h + turn * rate * dt);
  boat.x += Math.cos(boat.h) * boat.spd * dt;
  boat.y += Math.sin(boat.h) * boat.spd * dt;
}

// Islands sit wholly inside the sea, so a boat touching one never needs the wrap.
function ground(boat, islands, dt) {
  boat.bump = Math.max(0, boat.bump - dt);
  for (const isle of islands) {
    const dx = boat.x - isle.x;
    const dy = boat.y - isle.y;
    const d = Math.hypot(dx, dy) || 1;
    const min = isle.r + SHORE;
    if (d >= min) continue;
    boat.x = isle.x + (dx / d) * min;
    boat.y = isle.y + (dy / d) * min;
    if (boat.spd > SCRAPE.speed && boat.bump <= 0) {
      boat.hp = Math.max(0, boat.hp - SCRAPE.damage);
      boat.bump = SCRAPE.cooldown;
      boat.scraped += 1;
    }
    boat.spd *= SCRAPE.keep;
  }
}

/** Advance the Play by one tick. Mutates and returns `state`. */
export function step(state, intent, dt = STEP) {
  const boat = state.boat;
  sail(boat, intent ?? {}, dt);
  ground(boat, state.islands, dt);
  boat.x = wrap(boat.x, state.sea.width);
  boat.y = wrap(boat.y, state.sea.height);
  state.elapsed += dt;
  return state;
}

/** How the Play is going: time survived (only ever stepped time) and boats sunk. */
export function summary(state) {
  return { survivedMs: Math.round(state.elapsed * 1000), sinks: 0 };
}
