// Cactus Boats' simulation: the rules of a Play, with no DOM, no canvas and
// no Math.random, so it runs headless in Node (tests/cactus-boats/).
//
//   newRun(seed, opts?) -> state      a fresh Play on a sea placed from the seed
//   step(state, intent, dt)           advances the Play one fixed tick (STEP)
//   summary(state) -> { survivedMs, sinks, score }
//   isSunk(state) -> true once the player's hull reaches zero; step then does nothing
//   broadsides(state) -> { port, stbd }  each side's { ready, reload, target }, for the firing arcs
//   maxSpawnedBy(survivedMs) -> the most enemies that can have been spawned by then
//   difficultyAt(seconds) -> { every, afloat, mix }  the spawn curve at that time survived
//
// intent is the input layer's output: { turn: -1..1, sail: ANCHOR|HALF|FULL,
// fire: null|'auto'|'port'|'stbd' }. Time passes only inside step, so a paused
// game (no step calls) never adds to survivedMs. All randomness comes from a
// seeded generator kept in the state, so a seed plus a list of intents replays
// a Play exactly, and the state is plain data (it survives structuredClone).
//
// For drawing, the state exposes state.sea { width, height },
// state.boat { x, y, h, spd, hp, maxHp, r, scraped, flash },
// state.islands [{ x, y, r }],
// state.enemies [{ id, x, y, h, spd, hp, maxHp, r, flash, entering, sunk, sinkT }],
// state.balls [{ x, y, vx, vy, life, max, from }], state.warnings [{ x, y, edge, at }],
// state.fx [{ kind, x, y, at, dir }] (kinds: smoke, hit, splash, thud, sink) and
// state.shake. Everything else in it is the simulation's own.
//
// Tuning lives in the named tables below (GUNS, PATROLS, TOKENS, SPAWN), so
// difficulty is changed in one place. The Score is in score.js.

import { scoreOf } from './score.js?v=2026-11-21-v5';

/** The fixed tick, in seconds. */
export const STEP = 1 / 60;

/** Sail settings: the intent's `sail`. */
export const ANCHOR = 0;
export const HALF = 1;
export const FULL = 2;

/** The sea is one screen: 216 px tall, and as wide as the player's screen allows. */
export const SEA_HEIGHT = 216;
export const SEA_WIDTHS = { min: 384, max: 468, default: 432 };

// Hull stats, from the Enemy AI prototype. The player sails a Sombrero;
// enemy patrols climb the ladder Prickly Pear, Sombrero, Saguaro (see SPAWN).
export const HULLS = {
  prickly: { hp: 80, spd: 50, turn: 1.6, guns: 2, r: 8 },
  sombrero: { hp: 120, spd: 45, turn: 1.4, guns: 3, r: 9 },
  saguaro: { hp: 160, spd: 47, turn: 1.4, guns: 3, r: 10 },
};

// The player's broadside guns, from the Combat Toy and Controls prototypes.
// Each side reloads on its own. A volley bends up to `assist` radians toward
// a target near the beam; `seek` is how far away and how far off the beam a
// boat can be and still count as on that side. Balls carry `carry` of the
// boat's own speed.
export const GUNS = {
  balls: 3, reload: 3, dmg: 8, speed: 140, range: 130, assist: (20 * Math.PI) / 180,
  seek: { range: 156, off: Math.PI / 2 }, spacing: 6, carry: 0.5,
};

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

// Arrivals, and how they get harder: a warning marker at an edge, then an
// enemy sails in from just outside it `warn` seconds later. The first warning
// is at `first` seconds. Each row of the curve takes over at `at` seconds
// survived: after a warning the next waits `every` seconds (eased from row to
// row), and only while fewer than `afloat` enemies are on the sea or on their
// way; `mix` weighs which hull the next one is. A hull first appears in the
// mix at its threshold, so the ladder goes Prickly Pear, Sombrero, Saguaro.
export const SPAWN = {
  first: 2, warn: 1.5, inset: 0.15,
  curve: [
    { at: 0, every: 9, afloat: 1, mix: { prickly: 1 } },
    { at: 30, every: 8, afloat: 2, mix: { prickly: 1 } },
    { at: 70, every: 7, afloat: 3, mix: { prickly: 3, sombrero: 1 } },
    { at: 120, every: 6, afloat: 4, mix: { prickly: 2, sombrero: 2 } },
    { at: 180, every: 5, afloat: 5, mix: { prickly: 2, sombrero: 2, saguaro: 1 } },
    { at: 260, every: 4, afloat: 6, mix: { prickly: 1, sombrero: 2, saguaro: 2 } },
    { at: 360, every: 3, afloat: 7, mix: { prickly: 1, sombrero: 2, saguaro: 3 } },
  ],
};

/** The spawn curve at `seconds` survived: the gap between arrivals, the cap afloat and the hull mix. */
export function difficultyAt(seconds) {
  const rows = SPAWN.curve;
  let i = 0;
  while (i + 1 < rows.length && seconds >= rows[i + 1].at) i++;
  const row = rows[i];
  const next = rows[i + 1];
  const k = next ? clamp((seconds - row.at) / (next.at - row.at), 0, 1) : 0;
  return { every: next ? row.every + (next.every - row.every) * k : row.every, afloat: row.afloat, mix: row.mix };
}

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
export function newRun(seed, { width = SEA_WIDTHS.default, islands, enemies = true, unsinkable = false } = {}) {
  const hull = HULLS.sombrero;
  const sea = { width: clamp(Math.round(width), SEA_WIDTHS.min, SEA_WIDTHS.max), height: SEA_HEIGHT };
  const state = {
    seed: seed >>> 0,
    rng: seed >>> 0,
    elapsed: 0,
    sea,
    boat: {
      x: sea.width / 2, y: sea.height / 2, h: -Math.PI / 2, spd: 0, hp: hull.hp, maxHp: hull.hp, r: hull.r,
      bump: 0, scraped: 0, flash: 0, reload: { port: 0, stbd: 0 },
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
    reload: Math.max(0, b.reload[sideKey(s)]) / GUNS.reload,
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

// Smart fire: of the loaded sides, the one with the best-lined-up target; with
// no target either side, the side facing the nearest enemy (or any loaded side).
function fire(state, want) {
  if (!['auto', 'port', 'stbd'].includes(want)) return;
  const b = state.boat;
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
  b.reload[sideKey(side)] = GUNS.reload;
  volley(state, b, side, sideTarget(state, side)?.e ?? null, PLAYER_VOLLEY, 'player');
  state.shake = Math.max(state.shake, HIT.recoil);
}

/**
 * The most enemies that can have been spawned (warned of, so arrived or on
 * their way) by `survivedMs`: the curve's arrivals with nothing ever holding
 * them back. The spawner never runs ahead of this, so no Play can sink more.
 * Counted to within a millisecond, since summary() rounds the time.
 */
export function maxSpawnedBy(survivedMs) {
  const t = Number(survivedMs) / 1000 + 0.001;
  if (!(t > 0)) return 0;
  if (t === Infinity) return Infinity;
  let n = 0;
  for (let at = SPAWN.first; at <= t; at += difficultyAt(at).every) n++;
  return n;
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
      const push = (min - t.d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
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
  };
  tick(state.boat);
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
