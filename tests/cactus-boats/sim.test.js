import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { newRun, step, summary, STEP, ANCHOR, HALF, FULL } from '../../public/games/cactus-boats/sim.js';

// The simulation is driven only through newRun, step and summary. It exposes
// state.sea, state.boat and state.islands for drawing, and these tests read
// them the same way the drawing does.

const hold = { turn: 0, sail: ANCHOR, fire: null };
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Step `seconds` of Play with the same intent, calling `each` after every step. */
function run(state, intent, seconds, each = () => {}) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    step(state, intent, STEP);
    each(state);
  }
  return state;
}

/** Turn on the spot (at Anchor) until the bow points along `heading`. */
function pointAt(state, heading) {
  for (let i = 0; i < 60 * 10 && Math.abs(angDiff(heading, state.boat.h)) > 0.02; i++) {
    const d = angDiff(heading, state.boat.h);
    step(state, { turn: Math.max(-1, Math.min(1, d * 8)), sail: ANCHOR, fire: null }, STEP);
  }
  assert.ok(Math.abs(angDiff(heading, state.boat.h)) <= 0.02, 'the boat came round');
}

/** A seeded list of intents, like a player wandering about. */
function wander(seed, n) {
  let s = seed;
  const next = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, () => ({ turn: Math.round(next() * 2 - 1), sail: Math.floor(next() * 3), fire: null }));
}

test('the same seed and the same intents give the same Play', () => {
  const intents = wander(7, 60 * 30);
  const a = newRun(1234);
  const b = newRun(1234);
  for (const intent of intents) {
    step(a, intent, STEP);
    step(b, intent, STEP);
  }
  assert.deepEqual(a, b);
  assert.deepEqual(summary(a), summary(b));
  assert.notDeepEqual(newRun(1234).islands, newRun(1235).islands, 'another seed gives another sea');
});

test('no time passes without a step', async () => {
  const state = newRun(9);
  const before = structuredClone(state);
  await sleep(40);
  assert.deepEqual(state, before);
  assert.equal(summary(state).survivedMs, 0);
  run(state, { turn: 1, sail: FULL, fire: null }, 2);
  const after = structuredClone(state);
  await sleep(40);
  assert.deepEqual(state, after, 'nothing moves between steps either');
  assert.equal(summary(state).survivedMs, 2000);
  assert.equal(summary(state).sinks, 0);
});

test('the sail steps Anchor, Half, Full and sets how fast the boat goes', () => {
  const speeds = [ANCHOR, HALF, FULL].map((sail) => {
    const state = run(newRun(3, { islands: 0 }), { turn: 0, sail, fire: null }, 4);
    return state.boat.spd;
  });
  assert.equal(speeds[0], 0, 'at Anchor the boat stays put');
  assert.ok(speeds[1] > 0 && speeds[2] > speeds[1], speeds.join(', '));
  // Dropping anchor brings the boat to a stop.
  const state = run(newRun(3, { islands: 0 }), { turn: 0, sail: FULL, fire: null }, 4);
  run(state, hold, 3);
  assert.equal(state.boat.spd, 0);
});

test('the boat can come about from a standstill', () => {
  const state = newRun(5, { islands: 0 });
  const start = state.boat.h;
  let turned = 0;
  let last = start;
  run(state, { turn: 1, sail: ANCHOR, fire: null }, 3, (s) => {
    turned += angDiff(s.boat.h, last);
    last = s.boat.h;
  });
  assert.ok(turned >= Math.PI, `turned ${turned.toFixed(2)} rad in 3 s at Anchor`);
  assert.equal(state.boat.spd, 0);
});

test('turn is clamped to the helm and an unknown sail is held as Anchor', () => {
  const wild = run(newRun(5, { islands: 0 }), { turn: 50, sail: 9, fire: null }, 1);
  const hard = run(newRun(5, { islands: 0 }), { turn: 1, sail: ANCHOR, fire: null }, 1);
  assert.deepEqual(wild.boat, hard.boat);
});

for (const [edge, heading] of [
  ['top', -Math.PI / 2],
  ['bottom', Math.PI / 2],
  ['left', Math.PI],
  ['right', 0],
]) {
  test(`sailing off the ${edge} edge brings the boat in on the opposite edge`, () => {
    const state = newRun(11, { islands: 0 });
    const { width, height } = state.sea;
    pointAt(state, heading);
    let wrapped = false;
    let prev = { ...state.boat };
    run(state, { turn: 0, sail: FULL, fire: null }, 12, (s) => {
      const b = s.boat;
      assert.ok(b.x >= 0 && b.x < width && b.y >= 0 && b.y < height, `on the sea at ${b.x}, ${b.y}`);
      if (Math.abs(b.x - prev.x) > width / 2 || Math.abs(b.y - prev.y) > height / 2) {
        wrapped = true;
        if (edge === 'top') assert.ok(prev.y < 5 && b.y > height - 5);
        if (edge === 'bottom') assert.ok(prev.y > height - 5 && b.y < 5);
        if (edge === 'left') assert.ok(prev.x < 5 && b.x > width - 5);
        if (edge === 'right') assert.ok(prev.x > width - 5 && b.x < 5);
      }
      prev = { ...b };
    });
    assert.ok(wrapped, `the boat wrapped at the ${edge}`);
  });
}

test('islands are placed from the seed, inside the sea, apart, and away from the start', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const state = newRun(seed);
    const { width, height } = state.sea;
    const start = state.boat;
    assert.deepEqual(state.islands, newRun(seed).islands);
    assert.ok(state.islands.length >= 2 && state.islands.length <= 3, `seed ${seed}: ${state.islands.length} islands`);
    for (const [i, isle] of state.islands.entries()) {
      // Fully inside, so an island never straddles a wrapping edge.
      assert.ok(isle.x - isle.r > 0 && isle.x + isle.r < width && isle.y - isle.r > 0 && isle.y + isle.r < height, `seed ${seed}: island ${i} is on the sea`);
      assert.ok(dist(isle, start) > isle.r + 50, `seed ${seed}: island ${i} is away from the start`);
      for (const other of state.islands.slice(i + 1)) {
        assert.ok(dist(isle, other) > isle.r + other.r + 24, `seed ${seed}: islands leave room to sail between`);
      }
    }
  }
});

test('islands stop the boat and scrape the hull when rammed at speed', () => {
  for (const seed of [2, 17, 40]) {
    const state = newRun(seed);
    const isle = state.islands[0];
    const hull = state.boat.hp;
    let closest = Infinity;
    // Keep the bow on the island at Full sail for ten seconds.
    for (let i = 0; i < 60 * 10; i++) {
      const want = Math.atan2(isle.y - state.boat.y, isle.x - state.boat.x);
      const d = angDiff(want, state.boat.h);
      step(state, { turn: Math.max(-1, Math.min(1, d * 8)), sail: FULL, fire: null }, STEP);
      closest = Math.min(closest, dist(state.boat, isle));
    }
    assert.ok(closest >= isle.r, `seed ${seed}: the boat never sails into the island (${closest.toFixed(1)} < ${isle.r})`);
    assert.ok(dist(state.boat, isle) < isle.r + 12, `seed ${seed}: it's pressed against the shore`);
    assert.ok(state.boat.hp < hull, `seed ${seed}: ramming scraped the hull`);
    assert.ok(state.boat.hp > 0, `seed ${seed}: but didn't sink it`);
  }
});

test('all randomness comes from the seed', () => {
  const real = Math.random;
  Math.random = () => {
    throw new Error('the simulation called Math.random');
  };
  try {
    run(newRun(21), { turn: 1, sail: FULL, fire: 'auto' }, 5);
  } finally {
    Math.random = real;
  }
});
