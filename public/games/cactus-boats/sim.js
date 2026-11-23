// Cactus Boats' simulation: the rules of a Play, with no DOM, no canvas and
// no Math.random, so it runs headless in Node (tests/cactus-boats/).
//
//   newRun(seed, opts?) -> state      a fresh Play on a sea placed from the seed
//   step(state, intent, dt)           advances the Play one fixed tick (STEP)
//   summary(state) -> { survivedMs, sinks, score }
//   isSunk(state) -> true once the player's hull reaches zero; step then does nothing
//   newRun's `boat` is one of BOAT_KINDS ('galleon', 'chaser', 'ram'): what you sail and how it fights
//   boatOf(state) -> that boat's BOATS entry
//   canFire(state) -> whether the fire button would do anything now
//   bowGun(state) -> { ready, reload }  the Bow Chaser's cannon, for the aim line
//   ramCharge(state) -> { ready, reload, charging }  the Ram's Charge
//   broadsides(state) -> { port, stbd }  each side's { ready, reload, target }, for the firing arcs
//   greekFire(state) -> seconds of Greek fire left
//   whirlStrength(state, whirl) -> 0..1, how open a whirlpool is
//   maxSpawnedBy(survivedMs) -> the most enemies that can have been spawned by then
//   difficultyAt(seconds) -> { every, afloat, mix }  the spawn curve at that time survived
//
// intent is the input layer's output: { turn: -1..1, sail: ANCHOR|HALF|FULL,
// fire: null|'volley'|'auto'|'port'|'stbd' }; 'volley' is the fire button, which
// does what your boat does (both broadsides, the bow cannon, or the Ram's
// Charge); the other three fire one of the Galleon's sides alone.
// Time passes only inside step, so a paused
// game (no step calls) never adds to survivedMs. All randomness comes from a
// seeded generator kept in the state, so a seed plus a list of intents replays
// a Play exactly, and the state is plain data (it survives structuredClone).
//
// For drawing, the state exposes state.sea { width, height },
// state.boat { x, y, h, spd, hp, maxHp, r, scraped, flash },
// state.islands [{ x, y, r }],
// state.enemies [{ id, x, y, h, spd, hp, maxHp, r, flash, entering, sunk, sinkT }],
// state.balls [{ x, y, vx, vy, life, max, from }], state.warnings [{ x, y, edge, at }],
// state.jars [{ x, y, at, until }] (Greek fire to grab), state.flames
// [{ x, y, life, max }], state.patches [{ x, y, at, until }] (fire on the water),
// state.whirls [{ x, y, at, spin }],
// state.fx [{ kind, x, y, at, dir }] (kinds: smoke, hit, splash, thud, sink) and
// state.shake. Everything else in it is the simulation's own.
//
// Tuning lives in the named tables below (BOATS, GUNS, RAM, GREEK, WHIRL, PATROLS, TOKENS) and the spawn
// curve in spawn.js (SPAWN), so difficulty is changed in one place. The Score
// is in score.js.

import { scoreOf } from './score.js?v=2026-11-22-v1';
import { SPAWN, difficultyAt, maxSpawnedBy } from './spawn.js?v=2026-11-22-v1';

export { SPAWN, difficultyAt, maxSpawnedBy };

/** The fixed tick, in seconds. */
export const STEP = 1 / 60;

/** Sail settings: the intent's `sail`. */
export const ANCHOR = 0;
export const HALF = 1;
export const FULL = 2;

/** The sea is one screen: 216 px tall, and as wide as the player's screen allows. */
export const SEA_HEIGHT = 216;
export const SEA_WIDTHS = { min: 384, max: 468, default: 432 };

// Enemy hull stats, from the Enemy AI prototype (the player's boats are in BOATS);
// enemy patrols climb the ladder Prickly Pear, Sombrero, Saguaro (see SPAWN).
export const HULLS = {
  prickly: { hp: 80, spd: 50, turn: 1.6, guns: 2, r: 8 },
  sombrero: { hp: 120, spd: 45, turn: 1.4, guns: 3, r: 9 },
  saguaro: { hp: 160, spd: 47, turn: 1.4, guns: 3, r: 10 },
};

// The boats you can pick, each with its own cactus for a mast and its own way
// to fight. The Galleon fires broadsides, the Bow Chaser a cannon in the bow,
// and the Ram has no guns at all: the fire button is a Charge, and it sinks
// boats by sailing into them bow first.
export const BOATS = {
  galleon: { name: 'Galleon', cactus: 'Saguaro', fights: 'broadsides', hp: 120, spd: 45, turn: 1.4, r: 9 },
  chaser: { name: 'Bow Chaser', cactus: 'Barrel cactus', fights: 'a bow cannon', hp: 100, spd: 52, turn: 1.6, r: 8 },
  ram: { name: 'Ram', cactus: 'Prickly pear', fights: 'a ram: crash into them', hp: 150, spd: 50, turn: 1.35, r: 10 },
};
export const BOAT_KINDS = Object.keys(BOATS);

// The player's broadside guns, from the Combat Toy and Controls prototypes.
// Each side reloads on its own: both at once (the fire button) takes `reload`,
// but one side alone (J/L, or the side buttons) only `single`, so working one
// side and then the other keeps the guns busy. A volley bends up to `assist`
// radians toward a target near the beam; `seek` is how far away and how far
// off the beam a boat can be and still count as on that side. Balls carry
// `carry` of the boat's own speed.
export const GUNS = {
  balls: 3, reload: 3, single: 1.8, dmg: 8, speed: 140, range: 130, assist: (20 * Math.PI) / 180,
  seek: { range: 156, off: Math.PI / 2 }, spacing: 6, carry: 0.5,
};

// The Bow Chaser's cannon: one heavy ball straight ahead along the heading,
// further and faster than a broadside, on a short reload.
export const BOW = { dmg: 14, speed: 210, range: 190, reload: 1.1 };

// The Ram: hitting a boat within `arc` of dead ahead at more than `min` px/s
// does `per` damage for every px/s, once per boat every `cooldown` s, shoves
// it `knock` px and keeps `keep` of the Ram's speed, and the Ram takes
// `recoil` itself. The Charge lifts top speed by `boost` (and acceleration
// by `kick`) for `burst` s, every `reload` s.
export const RAM = { arc: 0.9, min: 14, per: 0.55, cooldown: 0.7, knock: 6, keep: 0.45, recoil: 5, boost: 1.6, kick: 5, burst: 1.1, reload: 5 };

// Greek fire: a jar floats up now and then (first after `first` s, then every
// `every` s or so, for `lasts` s, never more than one). Sail over it and the
// bow sprays fire for `burns` s: a flame every `rate` s that flies `speed`
// px/s for `life` s, burning each boat it passes once for `dmg`. Every
// `patchEvery`-th flame that dies on the water leaves a burning patch of
// radius `patchR` for `patch` s, which burns any boat on it, yours too, every
// `pulse` s (`hurtsYou` a pulse to you, `hurtsThem` to them).
export const GREEK = {
  first: 22, every: 32, jitter: 14, lasts: 14, grab: 7, burns: 15,
  rate: 0.05, speed: 115, life: 0.5, spread: 0.2, dmg: 1.6, hitR: 3,
  patchEvery: 3, patchR: 6, patch: 6, patches: 45, pulse: 0.5, hurtsYou: 3, hurtsThem: 5,
};

// Whirlpools: one opens now and then (first after `first` s, then every
// `every` s or so) somewhere open, at least `clear` px from you. It takes
// `grow` s to open, spins for `lasts` s, and `shrink` s to close. Inside `r`
// it pulls boats toward the eye (`pull` px/s at the eye, `edge` of that at
// the rim) and swirls them round (`swirl` px/s); in the eye, radius `eye`, it
// does `dmg` a pulse. Full sail gets you out; Half sail near the eye doesn't.
export const WHIRL = { first: 38, every: 42, jitter: 20, clear: 110, grow: 2, lasts: 12, shrink: 1.5, r: 62, eye: 9, pull: 36, edge: 0.3, swirl: 18, dmg: 6 };

// How each patrol hull fights, from the Enemy AI prototype: it closes in,
// orbits at orbitR, and fires a broadside when a side bears and you're inside
// fireR. The prototype had no patrol Saguaro, so it fights like a Sombrero
// that hits harder and reaches further. PATROL holds what all hulls share: how
// close to the beam counts as bearing, and breaking off once below `breakOff`
// of the hull, for `breakFor` s.
export const PATROLS = {
  prickly: { orbitR: 70, fireR: 95, throttle: 0.95, reload: 4.0, dmg: 5, spread: 0.16, assist: 0.15, range: 130, speed: 140 },
  sombrero: { orbitR: 105, fireR: 125, throttle: 0.7, reload: 4.5, dmg: 5, spread: 0.16, assist: 0.15, range: 130, speed: 140 },
  saguaro: { orbitR: 115, fireR: 135, throttle: 0.75, reload: 4.5, dmg: 6, spread: 0.14, assist: 0.15, range: 145, speed: 140 },
};
const PATROL = { closeIn: 70, bears: 0.35, breakOff: 0.3, breakFor: 4, flip: 9, avoid: 26 };
// Enemy boats handle like the prototypes' AI boats, not the player's helm.
const ENEMY_HANDLING = { accel: 16, decel: 26, floor: 0.35 };

// Attack tokens: only `attackers` enemies attack at once, and the tokens go
// to the nearest again every `every` seconds. The rest circle wide and hold fire.
export const TOKENS = { attackers: 2, every: 2, wideR: 175, wideThrottle: 0.55 };

// Hits: how long a boat flashes, how much being hit (and firing) shakes the
// screen and how fast that settles, and how long a sunk boat takes to go under.
const HIT = { flash: 0.12, shake: 2.5, recoil: 1.5, settle: 10, sink: 1.6 };
// How long each effect lasts, in seconds (the drawing fades them over the same time).
export const FX = { smoke: 0.45, hit: 0.35, splash: 0.5, thud: 0.35, sink: 1.2 };

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
const angDiff = (a, b) => wrapAngle(a - b);

// The shortest way from a to b on a sea whose edges wrap.
function toward(sea, a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  dx -= Math.round(dx / sea.width) * sea.width;
  dy -= Math.round(dy / sea.height) * sea.height;
  return { dx, dy, d: Math.hypot(dx, dy) };
}

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
 * (the seed picks 2–3), for tests that want open water; `enemies: false`
 * keeps enemies away, for tests of sailing and gunnery alone; `unsinkable`
 * keeps the player's hull above zero, for tests that watch the whole curve.
 */
export function newRun(seed, { width = SEA_WIDTHS.default, islands, enemies = true, hazards = true, unsinkable = false, boat = 'galleon' } = {}) {
  const kind = BOATS[boat] ? boat : 'galleon';
  const hull = BOATS[kind];
  const sea = { width: clamp(Math.round(width), SEA_WIDTHS.min, SEA_WIDTHS.max), height: SEA_HEIGHT };
  const state = {
    seed: seed >>> 0,
    rng: seed >>> 0,
    elapsed: 0,
    sea,
    boat: {
      kind, x: sea.width / 2, y: sea.height / 2, h: -Math.PI / 2, spd: 0, hp: hull.hp, maxHp: hull.hp, r: hull.r,
      bump: 0, scraped: 0, flash: 0, reload: { port: 0, stbd: 0, bow: 0 }, loads: { port: GUNS.reload, stbd: GUNS.reload },
      charging: 0, fire: 0, flameAt: 0,
    },
    islands: [],
    enemies: [],
    balls: [],
    warnings: [],
    fx: [],
    shake: 0,
    sinks: 0,
    sunk: false,
    unsinkable: unsinkable === true,
    // `at` is when the next warning may go up; `bound` is the earliest it
    // could under the curve alone, as maxSpawnedBy counts it.
    spawn: { on: enemies !== false, at: SPAWN.first, bound: SPAWN.first, made: 0, next: 1 },
    tokens: { at: 0, held: [] },
    // Greek fire and whirlpools; `at` is when the next one comes.
    hazards: { on: hazards !== false, jarAt: GREEK.first, whirlAt: WHIRL.first, burnAt: 0, flames: 0 },
    jars: [],
    flames: [],
    patches: [],
    whirls: [],
  };
  state.islands = placeIslands(state, islands);
  return state;
}

function sail(boat, intent, dt) {
  const hull = BOATS[boat.kind];
  const setting = [ANCHOR, HALF, FULL].includes(intent.sail) ? intent.sail : ANCHOR;
  const charge = boat.charging > 0;
  const top = hull.spd * (charge ? RAM.boost : [0, HANDLING.half, 1][setting]);
  const accel = HANDLING.accel * (charge ? RAM.kick : 1);
  boat.spd = Math.max(0, boat.spd + clamp(top - boat.spd, -HANDLING.decel * dt, accel * dt));
  const turn = clamp(Number(intent.turn) || 0, -1, 1);
  const rate = hull.turn * HANDLING.turnx * (HANDLING.floor + (1 - HANDLING.floor) * Math.min(1, boat.spd / (hull.spd * 0.6)));
  boat.h = wrapAngle(boat.h + turn * rate * dt);
  boat.x += Math.cos(boat.h) * boat.spd * dt;
  boat.y += Math.sin(boat.h) * boat.spd * dt;
}

// Islands sit wholly inside the sea, so a boat touching one never needs the wrap.
function ground(state, boat, dt) {
  boat.bump = Math.max(0, boat.bump - dt);
  for (const isle of state.islands) {
    const dx = boat.x - isle.x;
    const dy = boat.y - isle.y;
    const d = Math.hypot(dx, dy) || 1;
    const min = isle.r + SHORE;
    if (d >= min) continue;
    boat.x = isle.x + (dx / d) * min;
    boat.y = isle.y + (dy / d) * min;
    if (boat.spd > SCRAPE.speed && boat.bump <= 0) {
      boat.bump = SCRAPE.cooldown;
      boat.scraped = (boat.scraped ?? 0) + 1;
      hurt(state, boat, SCRAPE.damage);
    }
    boat.spd *= SCRAPE.keep;
  }
}

function addFx(state, kind, x, y, dir = 0) {
  state.fx.push({ kind, x, y, at: state.elapsed, dir });
}

// Damage a boat. The player's hull reaching zero ends the Play; an enemy's
// sinks it, and it's counted here, once, because a sunk boat takes no more.
function hurt(state, boat, dmg) {
  const player = boat === state.boat;
  if (player ? state.sunk : boat.sunk) return;
  boat.hp = Math.max(player && state.unsinkable ? 1 : 0, boat.hp - dmg);
  boat.flash = HIT.flash;
  if (player) {
    state.shake = Math.max(state.shake, HIT.shake);
    if (boat.hp <= 0) {
      state.sunk = true;
      boat.flash = 0; // the Play stops here, so don't leave the hull mid-flash
    }
    return;
  }
  if (boat.hp <= 0) {
    boat.sunk = true;
    boat.sinkT = 0;
    state.sinks += 1;
    addFx(state, 'sink', boat.x, boat.y);
  }
}

// Which side of `boat` (-1 port, 1 starboard) `target` is on.
function sideOf(state, boat, target) {
  const t = toward(state.sea, boat, target);
  return angDiff(Math.atan2(t.dy, t.dx), boat.h) > 0 ? 1 : -1;
}

const afloat = (e) => !e.sunk && !e.entering;

function nearestEnemy(state) {
  let best = null;
  let bd = Infinity;
  for (const e of state.enemies) {
    if (!afloat(e)) continue;
    const { d } = toward(state.sea, state.boat, e);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

// The best-lined-up enemy on one side of the player's boat, and how far off the beam it is.
function sideTarget(state, side) {
  const b = state.boat;
  const beam = b.h + (side * Math.PI) / 2;
  let best = null;
  let bo = Infinity;
  for (const e of state.enemies) {
    if (!afloat(e)) continue;
    const t = toward(state.sea, b, e);
    if (t.d > GUNS.seek.range) continue;
    const off = Math.abs(angDiff(Math.atan2(t.dy, t.dx), beam));
    if (off < GUNS.seek.off && off < bo) {
      bo = off;
      best = e;
    }
  }
  return best ? { e: best, off: bo } : null;
}

const sideKey = (side) => (side < 0 ? 'port' : 'stbd');

/** Each side's guns: loaded or not, how much reload is left (0..1), and what they'd aim at. */
export function broadsides(state) {
  const b = state.boat;
  const side = (s) => ({
    ready: b.reload[sideKey(s)] <= 0,
    reload: Math.max(0, b.reload[sideKey(s)]) / b.loads[sideKey(s)],
    target: sideTarget(state, s)?.e ?? null,
  });
  return { port: side(-1), stbd: side(1) };
}

// Where to aim to meet a boat sailing on its heading, for a ball at `speed`.
function lead(state, from, target, speed) {
  let { dx, dy } = toward(state.sea, from, target);
  const vx = Math.cos(target.h) * target.spd;
  const vy = Math.sin(target.h) * target.spd;
  const ox = dx;
  const oy = dy;
  for (let i = 0; i < 3; i++) {
    const time = Math.hypot(dx, dy) / speed;
    dx = ox + vx * time;
    dy = oy + vy * time;
  }
  return Math.atan2(dy, dx);
}

// One broadside out of `side` of `boat`, bent toward `target` by up to o.assist.
function volley(state, boat, side, target, o, from) {
  const { width, height } = state.sea;
  let dir = boat.h + (side * Math.PI) / 2;
  if (target) {
    const t = toward(state.sea, boat, target);
    if (t.d < o.range * 1.2) {
      const aim = o.leads ? lead(state, boat, target, o.speed) : Math.atan2(t.dy, t.dx);
      dir += clamp(angDiff(aim, dir), -o.assist, o.assist);
    }
  }
  const fwd = { x: Math.cos(boat.h), y: Math.sin(boat.h) };
  const gap = Math.min(GUNS.spacing, 18 / o.balls);
  for (let i = 0; i < o.balls; i++) {
    const along = (i - (o.balls - 1) / 2) * gap;
    const d = dir + (o.spread ? (random(state) - 0.5) * o.spread : 0);
    state.balls.push({
      x: wrap(boat.x + fwd.x * along + Math.cos(dir) * boat.r * 0.7, width),
      y: wrap(boat.y + fwd.y * along + Math.sin(dir) * boat.r * 0.7, height),
      vx: Math.cos(d) * o.speed + fwd.x * boat.spd * GUNS.carry,
      vy: Math.sin(d) * o.speed + fwd.y * boat.spd * GUNS.carry,
      life: o.range / o.speed,
      max: o.range / o.speed,
      dmg: o.dmg,
      from,
    });
  }
  addFx(state, 'smoke', boat.x + Math.cos(dir) * boat.r, boat.y + Math.sin(dir) * boat.r, dir);
}

const PLAYER_VOLLEY = { balls: GUNS.balls, dmg: GUNS.dmg, speed: GUNS.speed, range: GUNS.range, assist: GUNS.assist, leads: true };

/** The player's boat's stats (BOATS), from its kind. */
export const boatOf = (state) => BOATS[state.boat.kind];

/** The bow cannon (the Bow Chaser's): loaded or not, and how much reload is left (0..1). */
export function bowGun(state) {
  const r = state.boat.reload.bow;
  return { ready: r <= 0, reload: Math.max(0, r) / BOW.reload };
}

/** The Ram's Charge: ready or not, how much of its reload is left (0..1), and whether it's charging now. */
export function ramCharge(state) {
  const r = state.boat.reload.bow;
  return { ready: r <= 0, reload: Math.max(0, r) / RAM.reload, charging: state.boat.charging > 0 };
}

/** Whether the fire button would do anything right now, whichever boat you sail. */
export function canFire(state) {
  const b = state.boat;
  return b.kind === 'galleon' ? b.reload.port <= 0 || b.reload.stbd <= 0 : b.reload.bow <= 0;
}

/** Seconds of Greek fire left (0 when none). */
export const greekFire = (state) => Math.max(0, state.boat.fire);

// The fire button: both broadsides at once (each side that is loaded, bent
// toward what it can reach), one ball from the bow straight ahead, or the
// Ram's Charge.
function fireVolley(state) {
  const b = state.boat;
  if (b.kind === 'ram') {
    if (b.reload.bow > 0) return;
    b.reload.bow = RAM.reload;
    b.charging = RAM.burst;
    addFx(state, 'smoke', b.x - Math.cos(b.h) * b.r, b.y - Math.sin(b.h) * b.r, b.h + Math.PI);
    return;
  }
  if (b.kind === 'chaser') {
    if (b.reload.bow > 0) return;
    b.reload.bow = BOW.reload;
    volley(state, b, 0, null, { balls: 1, dmg: BOW.dmg, speed: BOW.speed, range: BOW.range, assist: 0 }, 'player');
    state.shake = Math.max(state.shake, HIT.recoil);
    return;
  }
  let fired = false;
  for (const side of [-1, 1]) {
    if (b.reload[sideKey(side)] > 0) continue;
    b.reload[sideKey(side)] = b.loads[sideKey(side)] = GUNS.reload;
    volley(state, b, side, sideTarget(state, side)?.e ?? null, PLAYER_VOLLEY, 'player');
    fired = true;
  }
  if (fired) state.shake = Math.max(state.shake, HIT.recoil);
}

// One side alone (the Galleon's): smart fire picks, of the loaded sides, the
// one with the best-lined-up target; with no target either side, the side
// facing the nearest enemy (or any loaded side). A side fired alone reloads
// in GUNS.single.
function fire(state, want) {
  if (want === 'volley') return fireVolley(state);
  if (!['auto', 'port', 'stbd'].includes(want)) return;
  const b = state.boat;
  if (b.kind !== 'galleon') return;
  const ready = (s) => b.reload[sideKey(s)] <= 0;
  let side = want === 'port' ? -1 : want === 'stbd' ? 1 : 0;
  if (!side) {
    const lined = [-1, 1].filter(ready).map((s) => ({ s, t: sideTarget(state, s) })).filter((x) => x.t);
    lined.sort((p, q) => p.t.off - q.t.off);
    if (lined.length) side = lined[0].s;
    else {
      const near = nearestEnemy(state);
      side = near ? sideOf(state, b, near) : ready(1) ? 1 : -1;
      if (!ready(side) && ready(-side)) side = -side;
    }
  }
  if (!ready(side)) return;
  b.reload[sideKey(side)] = b.loads[sideKey(side)] = GUNS.single;
  volley(state, b, side, sideTarget(state, side)?.e ?? null, PLAYER_VOLLEY, 'player');
  state.shake = Math.max(state.shake, HIT.recoil);
}

// Pick a hull from a mix of weights.
function pickHull(state, mix) {
  const hulls = Object.keys(mix);
  let r = random(state) * hulls.reduce((sum, h) => sum + mix[h], 0);
  for (const h of hulls) {
    r -= mix[h];
    if (r < 0) return h;
  }
  return hulls[hulls.length - 1];
}

// Edges: 0 top, 1 right, 2 bottom, 3 left. Each warning marks where an enemy will sail in.
function arrivals(state) {
  const sp = state.spawn;
  if (!sp.on) return;
  const { width, height } = state.sea;
  for (const w of state.warnings) {
    if (state.elapsed < w.at) continue;
    const hull = HULLS[w.hull];
    const off = hull.r + 4;
    const place = [
      { x: w.x, y: -off, h: Math.PI / 2 },
      { x: width + off, y: w.y, h: Math.PI },
      { x: w.x, y: height + off, h: -Math.PI / 2 },
      { x: -off, y: w.y, h: 0 },
    ][w.edge];
    state.enemies.push({
      id: sp.next++, hull: w.hull, ...place, spd: hull.spd * 0.6, hp: hull.hp, maxHp: hull.hp, r: hull.r,
      reload: { port: 0, stbd: 0 }, flash: 0, bump: 0, entering: true, sunk: false, sinkT: 0,
      ai: { state: 'close in', stateT: 0, orbit: random(state) < 0.5 ? 1 : -1, t: random(state) * 4, brokeOff: false },
    });
  }
  state.warnings = state.warnings.filter((w) => state.elapsed < w.at);

  const now = difficultyAt(state.elapsed);
  const coming = state.enemies.filter((e) => !e.sunk).length + state.warnings.length;
  if (state.elapsed + 1e-9 < sp.at || coming >= now.afloat) return;
  const edge = Math.floor(random(state) * 4);
  const along = SPAWN.inset + random(state) * (1 - 2 * SPAWN.inset);
  const x = edge === 1 ? width - 1 : edge === 3 ? 0 : Math.round(along * width);
  const y = edge === 0 ? 0 : edge === 2 ? height - 1 : Math.round(along * height);
  state.warnings.push({ x, y, edge, at: state.elapsed + SPAWN.warn, hull: pickHull(state, now.mix) });
  // Never sooner than the curve's own schedule, so maxSpawnedBy stays a bound
  // even when a full sea held this one back.
  sp.bound += difficultyAt(sp.bound).every;
  sp.at = Math.max(state.elapsed + now.every, sp.bound);
  sp.made += 1;
}

// Hand the attack tokens to the nearest enemies, every TOKENS.every seconds.
function giveTokens(state) {
  if (state.elapsed + 1e-6 < state.tokens.at) return;
  state.tokens.at += TOKENS.every;
  const ranked = state.enemies
    .filter(afloat)
    .map((e) => ({ id: e.id, d: toward(state.sea, e, state.boat).d }))
    .sort((p, q) => p.d - q.d);
  state.tokens.held = ranked.slice(0, TOKENS.attackers).map((x) => x.id);
}

function setAi(e, s) {
  if (e.ai.state === s) return;
  e.ai.state = s;
  e.ai.stateT = 0;
}

// Steer round an island on whichever side the boat was already heading.
function avoid(state, e, want) {
  let w = want;
  for (const isle of state.islands) {
    const t = toward(state.sea, isle, e);
    if (t.d < isle.r + PATROL.avoid) {
      const away = Math.atan2(t.dy, t.dx);
      w = away + (angDiff(want, away) > 0 ? 1 : -1) * 1.1;
    }
  }
  return w;
}

// The patrol brain: close in, orbit at the hull's range, broadside when a side
// bears, break off once when badly hurt. Without an attack token, circle wide
// and hold fire. Returns the heading to steer for and the throttle.
function patrol(state, e) {
  const cfg = PATROLS[e.hull];
  const ai = e.ai;
  const p = state.boat;
  const t = toward(state.sea, e, p);
  const engaged = state.tokens.held.includes(e.id);
  if (ai.state === 'break off') {
    if (ai.stateT > PATROL.breakFor) setAi(e, 'orbit');
  } else if (e.hp < e.maxHp * PATROL.breakOff && !ai.brokeOff) {
    ai.brokeOff = true;
    setAi(e, 'break off');
  } else if (!engaged) setAi(e, 'circle wide');
  else setAi(e, t.d > cfg.orbitR + PATROL.closeIn ? 'close in' : 'orbit');

  let r = cfg.orbitR;
  let throttle = cfg.throttle;
  if (ai.state === 'circle wide') {
    r = TOKENS.wideR;
    throttle = TOKENS.wideThrottle;
  }
  if (ai.state === 'break off') {
    r = cfg.orbitR * 2;
    throttle = 1;
  }
  if (ai.state === 'close in') throttle = 1;

  if (engaged && t.d < cfg.fireR) {
    const off = Math.abs(Math.abs(angDiff(Math.atan2(t.dy, t.dx), e.h)) - Math.PI / 2);
    const side = sideOf(state, e, p);
    if (off < PATROL.bears && e.reload[sideKey(side)] <= 0) {
      e.reload[sideKey(side)] = cfg.reload;
      volley(state, e, side, p, { balls: HULLS[e.hull].guns, leads: true, ...cfg }, e.id);
    }
  }
  if (ai.t > PATROL.flip) {
    ai.orbit *= -1;
    ai.t = 0;
  }
  const ang = Math.atan2(-t.dy, -t.dx) + ai.orbit * 0.7;
  return { want: Math.atan2(t.dy + Math.sin(ang) * r, t.dx + Math.cos(ang) * r), throttle };
}

function steerEnemy(e, want, throttle, dt) {
  const hull = HULLS[e.hull];
  e.spd = Math.max(0, e.spd + clamp(hull.spd * throttle - e.spd, -ENEMY_HANDLING.decel * dt, ENEMY_HANDLING.accel * dt));
  const f = ENEMY_HANDLING.floor;
  const rate = hull.turn * (f + (1 - f) * Math.min(1, e.spd / (hull.spd * 0.6)));
  e.h = wrapAngle(e.h + clamp(angDiff(want, e.h), -rate * dt, rate * dt));
  e.x += Math.cos(e.h) * e.spd * dt;
  e.y += Math.sin(e.h) * e.spd * dt;
}

function enemies(state, dt) {
  const { width, height } = state.sea;
  for (const e of state.enemies) {
    if (e.sunk) continue;
    e.ai.t += dt;
    e.ai.stateT += dt;
    if (e.entering) {
      // Sail straight in, unwrapped, until it's wholly on the sea.
      steerEnemy(e, e.h, 1, dt);
      if (e.x >= e.r && e.x < width - e.r && e.y >= e.r && e.y < height - e.r) e.entering = false;
      continue;
    }
    const { want, throttle } = patrol(state, e);
    steerEnemy(e, avoid(state, e, want), throttle, dt);
    ground(state, e, dt);
  }
}

// Boats shove apart rather than overlap.
function shove(state) {
  const boats = [state.boat, ...state.enemies.filter(afloat)];
  for (let i = 0; i < boats.length; i++) {
    for (let j = i + 1; j < boats.length; j++) {
      const a = boats[i];
      const b = boats[j];
      const t = toward(state.sea, a, b);
      const min = a.r + b.r;
      if (t.d >= min) continue;
      const nx = t.d ? t.dx / t.d : 1;
      const ny = t.d ? t.dy / t.d : 0;
      if (i === 0) ram(state, b, t, nx, ny);
      const push = (min - t.d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
    }
  }
}

// The Ram's bow meeting enemy boat `e` (the way to it is `t`, n its unit vector).
function ram(state, e, t, nx, ny) {
  const b = state.boat;
  if (b.kind !== 'ram' || b.spd < RAM.min || (e.rammed ?? 0) > 0) return;
  if (Math.abs(angDiff(Math.atan2(t.dy, t.dx), b.h)) > RAM.arc) return;
  e.rammed = RAM.cooldown;
  hurt(state, e, b.spd * RAM.per);
  hurt(state, b, RAM.recoil);
  e.x += nx * RAM.knock;
  e.y += ny * RAM.knock;
  b.spd *= RAM.keep;
  addFx(state, 'hit', b.x + nx * b.r, b.y + ny * b.r);
  state.shake = Math.max(state.shake, HIT.shake);
}

// Somewhere open on the sea for a jar or a whirlpool: off the islands by
// `shore` and at least `clear` from the player. Null if nowhere was found.
function openWater(state, shore, clear) {
  const { width, height } = state.sea;
  for (let tries = 0; tries < 40; tries++) {
    const p = { x: Math.round(16 + random(state) * (width - 32)), y: Math.round(16 + random(state) * (height - 32)) };
    if (toward(state.sea, p, state.boat).d < clear) continue;
    if (state.islands.some((isle) => Math.hypot(p.x - isle.x, p.y - isle.y) < isle.r + shore)) continue;
    return p;
  }
  return null;
}

// How open a whirlpool is right now, 0..1: it grows, spins, then closes.
export function whirlStrength(state, w) {
  const age = state.elapsed - w.at;
  const end = WHIRL.grow + WHIRL.lasts;
  if (age < 0) return 0;
  if (age < WHIRL.grow) return age / WHIRL.grow;
  if (age < end) return 1;
  return Math.max(0, 1 - (age - end) / WHIRL.shrink);
}

// Jars of Greek fire and whirlpools come and go; boats in a whirlpool are
// pulled and spun; flames fly, burn, and leave fire on the water.
function hazards(state, dt) {
  const hz = state.hazards;
  const b = state.boat;
  const t = state.elapsed;
  if (hz.on) {
    state.jars = state.jars.filter((j) => t < j.until);
    if (t >= hz.jarAt) {
      hz.jarAt = t + GREEK.every + random(state) * GREEK.jitter;
      const p = !state.jars.length && openWater(state, 12, 60);
      if (p) state.jars.push({ ...p, at: t, until: t + GREEK.lasts });
    }
    state.whirls = state.whirls.filter((w) => whirlStrength(state, w) > 0 || t - w.at < WHIRL.grow);
    if (t >= hz.whirlAt) {
      hz.whirlAt = t + WHIRL.every + random(state) * WHIRL.jitter;
      const p = !state.whirls.length && openWater(state, WHIRL.r * 0.5, WHIRL.clear);
      if (p) state.whirls.push({ ...p, at: t, spin: random(state) < 0.5 ? 1 : -1 });
    }
  }

  // Sail over a jar to grab it.
  state.jars = state.jars.filter((j) => {
    if (toward(state.sea, b, j).d > b.r + GREEK.grab) return true;
    b.fire = GREEK.burns;
    addFx(state, 'hit', j.x, j.y);
    return false;
  });

  // Whirlpools pull boats toward the eye and spin them round it.
  const { width, height } = state.sea;
  const pulse = t >= hz.burnAt;
  if (pulse) hz.burnAt = t + GREEK.pulse;
  for (const w of state.whirls) {
    const s = whirlStrength(state, w);
    for (const boat of [b, ...state.enemies.filter(afloat)]) {
      const to = toward(state.sea, boat, w);
      if (to.d >= WHIRL.r || to.d < 0.5) {
        if (to.d < 0.5 && pulse) hurt(state, boat, WHIRL.dmg * s);
        continue;
      }
      const near = 1 - to.d / WHIRL.r;
      const nx = to.dx / to.d;
      const ny = to.dy / to.d;
      const pull = Math.min(to.d, WHIRL.pull * (WHIRL.edge + (1 - WHIRL.edge) * near) * s * dt);
      const swirl = WHIRL.swirl * near * s * dt * w.spin;
      boat.x = wrap(boat.x + nx * pull - ny * swirl, width);
      boat.y = wrap(boat.y + ny * pull + nx * swirl, height);
      if (to.d < WHIRL.eye && pulse) hurt(state, boat, WHIRL.dmg * s);
    }
  }

  // The bow sprays Greek fire while it lasts.
  b.fire = Math.max(0, b.fire - dt);
  if (b.fire > 0) {
    b.flameAt -= dt;
    while (b.flameAt <= 0) {
      b.flameAt += GREEK.rate;
      const d = b.h + (random(state) - 0.5) * GREEK.spread * 2;
      state.flames.push({
        x: wrap(b.x + Math.cos(b.h) * (b.r + 2), width), y: wrap(b.y + Math.sin(b.h) * (b.r + 2), height),
        vx: Math.cos(d) * GREEK.speed + Math.cos(b.h) * b.spd, vy: Math.sin(d) * GREEK.speed + Math.sin(b.h) * b.spd,
        life: GREEK.life, max: GREEK.life, hit: [],
      });
    }
  } else b.flameAt = 0;
  state.flames = state.flames.filter((f) => {
    f.x = wrap(f.x + f.vx * dt, width);
    f.y = wrap(f.y + f.vy * dt, height);
    f.life -= dt;
    for (const e of state.enemies) {
      if (!afloat(e) || f.hit.includes(e.id) || toward(state.sea, f, e).d > e.r + GREEK.hitR) continue;
      f.hit.push(e.id);
      hurt(state, e, GREEK.dmg);
    }
    if (state.islands.some((isle) => toward(state.sea, f, isle).d < isle.r)) return false;
    if (f.life > 0) return true;
    hz.flames += 1;
    if (hz.flames % GREEK.patchEvery === 0) state.patches.push({ x: f.x, y: f.y, at: t, until: t + GREEK.patch });
    return false;
  });

  // Fire on the water burns whoever sails through it.
  state.patches = state.patches.filter((p) => t < p.until).slice(-GREEK.patches);
  if (pulse && state.patches.length) {
    for (const boat of [b, ...state.enemies.filter(afloat)]) {
      if (!state.patches.some((p) => toward(state.sea, p, boat).d < GREEK.patchR + boat.r * 0.5)) continue;
      hurt(state, boat, boat === b ? GREEK.hurtsYou : GREEK.hurtsThem);
    }
  }
}

// Cannonballs fly, wrap, and stop at the first boat or island they reach.
function balls(state, dt) {
  const { width, height } = state.sea;
  state.balls = state.balls.filter((ball) => {
    ball.x = wrap(ball.x + ball.vx * dt, width);
    ball.y = wrap(ball.y + ball.vy * dt, height);
    ball.life -= dt;
    const targets = ball.from === 'player' ? state.enemies.filter(afloat) : [state.boat];
    for (const b of targets) {
      if (toward(state.sea, ball, b).d < b.r) {
        hurt(state, b, ball.dmg);
        addFx(state, 'hit', ball.x, ball.y);
        return false;
      }
    }
    for (const isle of state.islands) {
      if (toward(state.sea, ball, isle).d < isle.r) {
        addFx(state, 'thud', ball.x, ball.y);
        return false;
      }
    }
    if (ball.life <= 0) {
      addFx(state, 'splash', ball.x, ball.y);
      return false;
    }
    return true;
  });
}

function timers(state, dt) {
  const tick = (b) => {
    b.flash = Math.max(0, b.flash - dt);
    b.reload.port = Math.max(0, b.reload.port - dt);
    b.reload.stbd = Math.max(0, b.reload.stbd - dt);
    b.reload.bow = Math.max(0, (b.reload.bow ?? 0) - dt);
    b.rammed = Math.max(0, (b.rammed ?? 0) - dt);
  };
  tick(state.boat);
  state.boat.charging = Math.max(0, state.boat.charging - dt);
  for (const e of state.enemies) {
    tick(e);
    if (e.sunk) e.sinkT += dt;
  }
  state.enemies = state.enemies.filter((e) => !e.sunk || e.sinkT < HIT.sink);
  state.shake = Math.max(0, state.shake - dt * HIT.settle);
  state.fx = state.fx.filter((f) => state.elapsed - f.at < FX[f.kind]);
}

/** Advance the Play by one tick. Mutates and returns `state`. Once sunk, nothing moves. */
export function step(state, intent, dt = STEP) {
  if (state.sunk) return state;
  const { width, height } = state.sea;
  const boat = state.boat;
  intent ??= {};
  sail(boat, intent, dt);
  ground(state, boat, dt);
  fire(state, intent.fire);
  arrivals(state);
  giveTokens(state);
  enemies(state, dt);
  hazards(state, dt);
  shove(state);
  for (const b of [boat, ...state.enemies.filter(afloat)]) {
    b.x = wrap(b.x, width);
    b.y = wrap(b.y, height);
  }
  balls(state, dt);
  timers(state, dt);
  state.elapsed += dt;
  return state;
}

/** True once the player's hull has reached zero. */
export function isSunk(state) {
  return state.sunk;
}

/** How the Play is going: time survived (only ever stepped time), boats sunk, and the Score for them. */
export function summary(state) {
  const survivedMs = Math.round(state.elapsed * 1000);
  return { survivedMs, sinks: state.sinks, score: scoreOf(survivedMs, state.sinks) };
}
