// Bots that play Cactus Boats headless, through newRun and step alone, to
// measure how hard it is. They read the state the way the drawing does.

import { newRun, step, summary, isSunk, broadsides, STEP, ANCHOR, HALF, FULL, GUNS } from '../../public/games/cactus-boats/sim.js';

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// The shortest way from a to b on the wrapping sea.
function toward(sea, a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  dx -= Math.round(dx / sea.width) * sea.width;
  dy -= Math.round(dy / sea.height) * sea.height;
  return { dx, dy, d: Math.hypot(dx, dy) };
}

function nearest(state) {
  let best = null;
  for (const e of state.enemies) {
    if (e.sunk || e.entering) continue;
    const t = toward(state.sea, state.boat, e);
    if (!best || t.d < best.t.d) best = { e, t };
  }
  return best;
}

/** Sits at Anchor and never fires. */
export const idle = () => ({ turn: 0, sail: ANCHOR, fire: null });

// Smart fire, but only once a loaded side bears on a boat the balls can reach.
function lined(state) {
  const guns = broadsides(state);
  return [guns.port, guns.stbd].some((g) => g.ready && g.target && toward(state.sea, state.boat, g.target).d < GUNS.range * 0.9);
}

/**
 * A captain who turns to keep the nearest enemy on the beam, sails at Half,
 * and fires a smart broadside when one bears. The kind of Play a person has.
 */
export function captain(state) {
  const near = nearest(state);
  let turn = 0;
  if (near) {
    const bearing = Math.atan2(near.t.dy, near.t.dx);
    const side = angDiff(bearing, state.boat.h) > 0 ? 1 : -1;
    turn = Math.max(-1, Math.min(1, angDiff(bearing - (side * Math.PI) / 2, state.boat.h) * 4));
  }
  return { turn, sail: HALF, fire: lined(state) ? 'auto' : null };
}

/**
 * A captain who keeps way on at Full sail and fights at the edge of the guns'
 * reach: in too close, she bears away; too far, she closes; in between, she
 * turns the nearest enemy onto the beam. Smart fire when a side bears.
 */
// How close the sailor lets the nearest enemy come, and how far she lets it go.
export const KITE = { near: 100, far: 125 };

export function sailor(state) {
  const b = state.boat;
  const near = nearest(state);
  let want = b.h;
  if (near) {
    const bearing = Math.atan2(near.t.dy, near.t.dx);
    const side = angDiff(bearing, b.h) > 0 ? 1 : -1;
    const beam = bearing - (side * Math.PI) / 2;
    if (near.t.d < KITE.near) want = beam - side * 0.8;
    else if (near.t.d > KITE.far) want = beam + side * 0.6;
    else want = beam;
  }
  for (const isle of state.islands) {
    const t = toward(state.sea, b, isle);
    const off = angDiff(Math.atan2(t.dy, t.dx), b.h);
    if (t.d < isle.r + 28 && Math.abs(off) < 1.2) want = b.h - Math.sign(off || 1) * 1.5;
  }
  const turn = Math.max(-1, Math.min(1, angDiff(want, b.h) * 4));
  return { turn, sail: FULL, fire: lined(state) ? 'auto' : null };
}

/**
 * Play one seeded Play with `brain` until sunk or `limit` seconds pass, calling
 * `each(state)` after every tick. Returns the summary and whether it was sunk.
 */
export function play(seed, brain, limit = 900, each = () => {}) {
  const state = newRun(seed);
  for (let i = 0; i < Math.round(limit / STEP) && !isSunk(state); i++) {
    step(state, brain(state), STEP);
    each(state);
  }
  return { ...summary(state), sunk: isSunk(state), state };
}
