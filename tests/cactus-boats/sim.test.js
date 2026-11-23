import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { newRun, step, summary, isSunk, maxSpawnedBy, STEP, ANCHOR, HALF, FULL, GUNS, BOW, RAM, GREEK, WHIRL, BOATS, TOKENS, canFire } from '../../public/games/cactus-boats/sim.js';

// The simulation is driven only through newRun, step and summary. It exposes
// state.sea, state.boat, state.islands, state.enemies and state.balls for
// drawing, and these tests read them the same way the drawing does.

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
  const fires = [null, null, null, null, null, null, 'auto', 'port', 'stbd'];
  return Array.from({ length: n }, () => ({ turn: Math.round(next() * 2 - 1), sail: Math.floor(next() * 3), fire: fires[Math.floor(next() * fires.length)] }));
}

test('the same seed and the same intents give the same Play', () => {
  const intents = wander(7, 60 * 60);
  const a = newRun(1234);
  const b = newRun(1234);
  for (const intent of intents) {
    step(a, intent, STEP);
    step(b, intent, STEP);
  }
  assert.ok(a.enemies.length > 0 || summary(a).sinks > 0, 'enemies were in play');
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
    const state = run(newRun(3, { islands: 0, enemies: false }), { turn: 0, sail, fire: null }, 4);
    return state.boat.spd;
  });
  assert.equal(speeds[0], 0, 'at Anchor the boat stays put');
  assert.ok(speeds[1] > 0 && speeds[2] > speeds[1], speeds.join(', '));
  // Dropping anchor brings the boat to a stop.
  const state = run(newRun(3, { islands: 0, enemies: false }), { turn: 0, sail: FULL, fire: null }, 4);
  run(state, hold, 3);
  assert.equal(state.boat.spd, 0);
});

test('the boat can come about from a standstill', () => {
  const state = newRun(5, { islands: 0, enemies: false });
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
  const wild = run(newRun(5, { islands: 0, enemies: false }), { turn: 50, sail: 9, fire: null }, 1);
  const hard = run(newRun(5, { islands: 0, enemies: false }), { turn: 1, sail: ANCHOR, fire: null }, 1);
  assert.deepEqual(wild.boat, hard.boat);
});

for (const [edge, heading] of [
  ['top', -Math.PI / 2],
  ['bottom', Math.PI / 2],
  ['left', Math.PI],
  ['right', 0],
]) {
  test(`sailing off the ${edge} edge brings the boat in on the opposite edge`, () => {
    const state = newRun(11, { islands: 0, enemies: false });
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
    const state = newRun(seed, { enemies: false });
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

// ---- Combat ----

const wdist = (a, b, sea) => {
  const dx = Math.abs(a.x - b.x) % sea.width;
  const dy = Math.abs(a.y - b.y) % sea.height;
  return Math.hypot(Math.min(dx, sea.width - dx), Math.min(dy, sea.height - dy));
};

/**
 * A captain who turns to keep the nearest enemy on the beam, sails at Half,
 * and fires a smart broadside whenever asked. The kind of Play a person has.
 */
function captain(state) {
  const b = state.boat;
  let near = null;
  for (const e of state.enemies) {
    if (e.sunk || e.entering) continue;
    if (!near || wdist(b, e, state.sea) < wdist(b, near, state.sea)) near = e;
  }
  let turn = 0;
  if (near) {
    let dx = near.x - b.x;
    let dy = near.y - b.y;
    dx -= Math.round(dx / state.sea.width) * state.sea.width;
    dy -= Math.round(dy / state.sea.height) * state.sea.height;
    const bearing = Math.atan2(dy, dx);
    const side = angDiff(bearing, b.h) > 0 ? 1 : -1;
    turn = Math.max(-1, Math.min(1, angDiff(bearing - side * Math.PI / 2, b.h) * 4));
  }
  return { turn, sail: HALF, fire: 'auto' };
}

/** Play until `until(state)` or `seconds` run out, watching every enemy that goes down. */
function fight(state, brain, seconds, until = () => false) {
  const sunk = new Set();
  const seen = new Set();
  let last = 0;
  for (let i = 0; i < Math.round(seconds / STEP) && !until(state); i++) {
    step(state, brain(state), STEP);
    for (const e of state.enemies) {
      seen.add(e.id);
      if (e.sunk) sunk.add(e.id);
    }
    const { sinks } = summary(state);
    assert.ok(sinks >= last, 'the sink count never goes down');
    assert.equal(sinks, sunk.size, `at ${state.elapsed.toFixed(2)} s every sunk boat is counted once`);
    last = sinks;
  }
  return { sunk, seen };
}

test('enemies keep arriving, from the edges, after a warning', () => {
  const state = newRun(31, { islands: 0, unsinkable: true });
  const arrived = new Map();
  let warned = 0;
  run(state, { turn: 1, sail: HALF, fire: null }, 100, (s) => {
    warned = Math.max(warned, s.warnings.length);
    for (const e of s.enemies) {
      if (arrived.has(e.id)) continue;
      arrived.set(e.id, { x: e.x, y: e.y });
      const { width, height } = s.sea;
      const outside = e.x < 0 || e.x >= width || e.y < 0 || e.y >= height;
      assert.ok(outside, `enemy ${e.id} arrives just outside an edge (${e.x.toFixed(0)}, ${e.y.toFixed(0)})`);
    }
    assert.ok(arrived.size <= maxSpawnedBy(s.elapsed * 1000), `no more than ${maxSpawnedBy(s.elapsed * 1000)} by ${s.elapsed.toFixed(1)} s`);
  });
  assert.ok(warned > 0, 'a warning marker went up');
  assert.ok(arrived.size >= 3, `${arrived.size} enemies arrived in 100 s`);
});

test('no more than two enemies attack at once', () => {
  for (const seed of [4, 8, 15]) {
    const state = newRun(seed);
    const counted = new WeakSet();
    const shooters = new Map(); // token period -> enemies that fired in it
    run(state, { turn: 0.3, sail: HALF, fire: null }, 90, (s) => {
      for (const ball of s.balls) {
        if (counted.has(ball)) continue;
        counted.add(ball);
        if (ball.from === 'player') continue;
        const period = Math.floor((s.elapsed - STEP / 2) / TOKENS.every);
        if (!shooters.has(period)) shooters.set(period, new Set());
        shooters.get(period).add(ball.from);
      }
    });
    assert.ok(shooters.size > 0, `seed ${seed}: the enemies fought back`);
    for (const [period, who] of shooters) {
      assert.ok(who.size <= TOKENS.attackers, `seed ${seed}: ${who.size} enemies fired between ${period * TOKENS.every} s and ${(period + 1) * TOKENS.every} s`);
    }
  }
});

test('you can sink enemies, and each sink counts exactly once', () => {
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const state = newRun(seed);
    // fight() checks after every tick that the count matches the boats seen going down.
    const { sunk } = fight(state, captain, 120, isSunk);
    total += sunk.size;
  }
  assert.ok(total >= 5, `the captain sank ${total} boats over five Plays`);
});

test('enemy fire and islands wear the hull down, and a Play stops when it reaches zero', () => {
  const state = newRun(12);
  run(state, hold, 600, () => {});
  assert.ok(isSunk(state), 'an anchored boat that never fires is sunk');
  assert.equal(state.boat.hp, 0);
  const after = structuredClone(state);
  run(state, { turn: 1, sail: FULL, fire: 'auto' }, 5);
  assert.deepEqual(state, after, 'nothing happens once you are sunk');
  assert.ok(summary(state).survivedMs < 600 * 1000, `sunk after ${summary(state).survivedMs} ms`);
});

test('each side reloads on its own', () => {
  const state = newRun(6, { islands: 0, enemies: false });
  const balls = () => state.balls.length;
  step(state, { turn: 0, sail: ANCHOR, fire: 'port' }, STEP);
  assert.equal(balls(), GUNS.balls, 'port fires a volley');
  step(state, { turn: 0, sail: ANCHOR, fire: 'port' }, STEP);
  assert.equal(balls(), GUNS.balls, 'port is reloading');
  step(state, { turn: 0, sail: ANCHOR, fire: 'stbd' }, STEP);
  assert.equal(balls(), GUNS.balls * 2, 'starboard is still loaded');
  step(state, { turn: 0, sail: ANCHOR, fire: 'auto' }, STEP);
  assert.equal(balls(), GUNS.balls * 2, 'with both sides reloading, smart fire does nothing');
  run(state, hold, GUNS.reload);
  step(state, { turn: 0, sail: ANCHOR, fire: 'auto' }, STEP);
  assert.equal(balls(), GUNS.balls, 'after the reload a side fires again');
});

test('port fires to the left of the bow and starboard to the right', () => {
  for (const [fire, side] of [['port', -1], ['stbd', 1]]) {
    const state = newRun(6, { islands: 0, enemies: false });
    const b = { ...state.boat };
    step(state, { turn: 0, sail: ANCHOR, fire }, STEP);
    const beam = b.h + side * Math.PI / 2;
    for (const ball of state.balls) {
      const off = Math.abs(angDiff(Math.atan2(ball.vy, ball.vx), beam));
      assert.ok(off < 0.05, `${fire} fires out of its own side (${off.toFixed(3)} rad off the beam)`);
    }
  }
});

test('smart fire picks the side with an enemy on it', () => {
  for (const seed of [2, 9, 23, 41]) {
    const state = newRun(seed, { islands: 0 });
    // Wait for an enemy to be on the sea, and near.
    run(state, { turn: 0, sail: ANCHOR, fire: null }, 30, () => {});
    const b = state.boat;
    const near = state.enemies.filter((e) => !e.sunk && !e.entering).sort((p, q) => wdist(b, p, state.sea) - wdist(b, q, state.sea))[0];
    if (!near || wdist(b, near, state.sea) > GUNS.range) continue;
    const before = new Set(state.balls);
    step(state, { turn: 0, sail: ANCHOR, fire: 'auto' }, STEP);
    const mine = state.balls.filter((x) => !before.has(x) && x.from === 'player');
    if (!mine.length) continue; // both sides happened to be reloading
    let dx = near.x - b.x;
    let dy = near.y - b.y;
    dx -= Math.round(dx / state.sea.width) * state.sea.width;
    dy -= Math.round(dy / state.sea.height) * state.sea.height;
    const want = angDiff(Math.atan2(dy, dx), b.h) > 0 ? 1 : -1;
    const went = angDiff(Math.atan2(mine[0].vy, mine[0].vx), b.h) > 0 ? 1 : -1;
    assert.equal(went, want, `seed ${seed}: the broadside went out of the side facing the enemy`);
    return;
  }
  assert.fail('no seed put an enemy in range to test against');
});

test('cannonballs wrap at the edges like boats', () => {
  const state = newRun(11, { islands: 0, enemies: false });
  const { width, height } = state.sea;
  pointAt(state, 0); // bow east, so port faces north, off the top edge
  step(state, { turn: 0, sail: ANCHOR, fire: 'port' }, STEP);
  const ball = state.balls[0];
  let prev = { x: ball.x, y: ball.y };
  let wrapped = false;
  run(state, hold, 2, (s) => {
    if (!s.balls.includes(ball)) return;
    assert.ok(ball.x >= 0 && ball.x < width && ball.y >= 0 && ball.y < height, `on the sea at ${ball.x}, ${ball.y}`);
    if (prev.y < 10 && ball.y > height - 10) wrapped = true;
    prev = { x: ball.x, y: ball.y };
  });
  assert.ok(wrapped, 'the ball went off the top and came in at the bottom');
});

test('islands block cannonballs', () => {
  let tried = 0;
  for (let seed = 1; seed <= 200 && tried < 5; seed++) {
    const state = newRun(seed, { enemies: false });
    const b = state.boat;
    // An island the guns can reach.
    const isle = state.islands.find((i) => dist(i, b) - i.r < GUNS.range * 0.6);
    if (!isle) continue;
    tried++;
    // Turn so the starboard beam points at it, then fire.
    pointAt(state, Math.atan2(isle.y - b.y, isle.x - b.x) - Math.PI / 2);
    step(state, { turn: 0, sail: ANCHOR, fire: 'stbd' }, STEP);
    const fired = [...state.balls];
    assert.equal(fired.length, GUNS.balls);
    let thuds = 0;
    run(state, hold, 2, (s) => {
      for (const ball of fired) {
        if (!s.balls.includes(ball)) continue;
        assert.ok(dist(ball, isle) >= isle.r, `seed ${seed}: a ball sailed into the island`);
      }
      thuds = Math.max(thuds, s.fx.filter((f) => f.kind === 'thud').length);
    });
    assert.ok(fired.every((x) => !state.balls.includes(x)), 'every ball has landed');
    assert.ok(thuds > 0, `seed ${seed}: the island took the shot`);
  }
  assert.ok(tried >= 3, `found ${tried} seeds with an island in range`);
});

test('boats shove apart rather than overlap', () => {
  const state = newRun(19);
  let worst = Infinity;
  run(state, { turn: 0, sail: HALF, fire: null }, 60, (s) => {
    const boats = [s.boat, ...s.enemies.filter((e) => !e.sunk && !e.entering)];
    for (let i = 0; i < boats.length; i++) {
      for (let j = i + 1; j < boats.length; j++) {
        worst = Math.min(worst, wdist(boats[i], boats[j], s.sea) / (boats[i].r + boats[j].r));
      }
    }
  });
  assert.ok(worst > 0.8, `boats overlapped to ${(worst * 100).toFixed(0)}% of their radii`);
});


test('the fire button shoots both broadsides at once, and only the loaded sides', () => {
  const state = newRun(6, { islands: 0, enemies: false });
  const volley = { turn: 0, sail: ANCHOR, fire: 'volley' };
  step(state, volley, STEP);
  assert.equal(state.balls.length, GUNS.balls * 2, 'both sides fire together');
  const sides = new Set(state.balls.map((b) => Math.sign(angDiff(Math.atan2(b.vy, b.vx), state.boat.h))));
  assert.deepEqual([...sides].sort(), [-1, 1], 'one volley to each side of the bow');
  step(state, volley, STEP);
  assert.equal(state.balls.length, GUNS.balls * 2, 'both sides are reloading');
  step(state, { turn: 0, sail: ANCHOR, fire: 'stbd' }, STEP);
  run(state, hold, GUNS.reload);
  step(state, volley, STEP);
  assert.equal(state.balls.length, GUNS.balls * 2, 'after the reload both fire again');
});

test('a side fired alone reloads faster, and the other side is still loaded', () => {
  const state = newRun(6, { islands: 0, enemies: false });
  step(state, { turn: 0, sail: ANCHOR, fire: 'stbd' }, STEP);
  assert.equal(state.balls.length, GUNS.balls);
  step(state, { turn: 0, sail: ANCHOR, fire: 'port' }, STEP);
  assert.equal(state.balls.length, GUNS.balls * 2, 'the other side fires straight after');
  assert.ok(GUNS.single < GUNS.reload);
  run(state, hold, GUNS.single);
  assert.ok(canFire(state) && state.boat.reload.stbd === 0 && state.boat.reload.port === 0, 'both reloaded in the single time');
  // A both-sides volley takes the full reload.
  step(state, { turn: 0, sail: ANCHOR, fire: 'volley' }, STEP);
  run(state, hold, GUNS.single);
  assert.equal(canFire(state), false, 'a volley is still reloading');
});

test('the Bow Chaser shoots one ball straight along the heading, on its own reload', () => {
  const state = newRun(6, { islands: 0, enemies: false, boat: 'chaser' });
  const volley = { turn: 0, sail: ANCHOR, fire: 'volley' };
  step(state, volley, STEP);
  assert.equal(state.balls.length, 1);
  const [ball] = state.balls;
  assert.ok(Math.abs(angDiff(Math.atan2(ball.vy, ball.vx), state.boat.h)) < 1e-9, 'straight ahead');
  assert.equal(ball.dmg, BOW.dmg);
  step(state, volley, STEP);
  assert.equal(state.balls.length, 1, 'the bow cannon is reloading');
  step(state, { turn: 0, sail: ANCHOR, fire: 'port' }, STEP);
  assert.equal(state.balls.length, 1, 'it has no broadsides');
  run(state, hold, BOW.reload);
  assert.ok(canFire(state), 'reloaded');
  step(state, volley, STEP);
  assert.equal(canFire(state), false, 'and fired again');
  assert.equal(state.boat.hp, BOATS.chaser.hp);
});

test('an unknown boat sails as the Galleon', () => {
  assert.equal(newRun(6, { boat: 'banana' }).boat.kind, 'galleon');
  assert.equal(newRun(6).boat.maxHp, BOATS.galleon.hp);
});

/** A Play with one patrol boat of `hull` placed `d` px dead ahead of the player, who points east. */
function faceOff(boat, d, hull = 'sombrero') {
  const state = newRun(21, { islands: 0, enemies: false, hazards: false, boat });
  state.boat.h = 0;
  const b = state.boat;
  state.enemies.push({
    id: 99, hull, x: b.x + d, y: b.y, h: Math.PI / 2, spd: 0, hp: 120, maxHp: 120, r: 9, reload: { port: 9, stbd: 9 },
    flash: 0, bump: 0, entering: false, sunk: false, sinkT: 0, ai: { state: 'circle wide', stateT: 0, orbit: 1, t: 0, brokeOff: false },
  });
  state.tokens.at = Infinity; // no tokens: it holds fire
  return state;
}

test('the Ram has no guns, Charges, and sinks boats by sailing into them bow first', () => {
  const state = faceOff('ram', 60);
  step(state, { turn: 0, sail: FULL, fire: 'volley' }, STEP);
  assert.equal(state.balls.length, 0, 'no guns');
  assert.ok(state.boat.charging > 0 && !canFire(state), 'charging, and the Charge reloads');
  let top = 0;
  run(state, { turn: 0, sail: FULL, fire: null }, 1.2, (s) => (top = Math.max(top, s.boat.spd)));
  assert.ok(top > BOATS.ram.spd * 1.4, `a Charge goes faster than Full sail: ${top.toFixed(0)} px/s`);
  const hp = state.enemies[0].hp;
  assert.ok(hp <= 120 - RAM.per * BOATS.ram.spd, `a charging ram hits hard: ${hp.toFixed(0)} hp left`);
  assert.ok(state.boat.spd < top, 'and the Ram loses way');
  assert.ok(state.boat.hp >= BOATS.ram.hp - 2 * RAM.recoil, 'and takes a knock itself');
  // Side on, or too slow, it only shoves.
  const slow = faceOff('ram', 30);
  run(slow, { turn: 0, sail: HALF, fire: null }, 0.6);
  assert.equal(slow.enemies[0].hp, 120, 'slow bumps do nothing');
});

test('Greek fire: a jar floats up, grabbing it sprays fire from the bow that burns boats and the water', () => {
  const state = newRun(8, { islands: 0, enemies: false });
  run(state, hold, GREEK.first + STEP * 2);
  assert.equal(state.jars.length, 1, 'a jar is on the sea');
  const jar = state.jars[0];
  assert.ok(dist(jar, state.boat) >= 60, 'not on top of you');
  state.boat.x = jar.x;
  state.boat.y = jar.y;
  step(state, hold, STEP);
  assert.equal(state.jars.length, 0, 'grabbed');
  assert.ok(Math.abs(state.boat.fire - GREEK.burns) < 0.1);
  run(state, hold, 1);
  assert.ok(state.flames.length > 4, 'flames stream out');
  for (const f of state.flames) assert.ok(Math.abs(angDiff(Math.atan2(f.vy, f.vx), state.boat.h)) <= GREEK.spread + 1e-9, 'ahead of the bow');
  assert.ok(state.patches.length > 0, 'and the water burns');
  run(state, hold, GREEK.burns);
  assert.equal(state.boat.fire, 0, 'it runs out');
  run(state, hold, GREEK.patch + GREEK.life + 0.1);
  assert.equal(state.flames.length + state.patches.length, 0, 'and the fire goes out');

  // The stream burns a boat in front; the fire on the water burns you too.
  const duel = faceOff('galleon', 30);
  duel.boat.fire = 3;
  run(duel, hold, 2);
  assert.ok(duel.enemies[0].hp < 120 - 30, `burned to ${duel.enemies[0].hp.toFixed(0)}`);
  const own = newRun(8, { islands: 0, enemies: false, hazards: false });
  own.patches.push({ x: own.boat.x, y: own.boat.y, at: 0, until: 3 });
  run(own, hold, 2);
  assert.ok(own.boat.hp < BOATS.galleon.hp, 'sailing over burning water hurts');
});

test('a whirlpool opens away from you, pulls boats in, and Full sail gets out', () => {
  const state = newRun(4, { islands: 0, enemies: false });
  run(state, hold, WHIRL.first + STEP * 2);
  assert.equal(state.whirls.length, 1, 'a whirlpool opened');
  const w = state.whirls[0];
  assert.ok(dist(w, state.boat) >= WHIRL.clear);
  run(state, hold, WHIRL.grow);
  // A boat at Anchor near the rim is drawn in to the eye, and hurt there.
  state.boat.x = w.x + WHIRL.r * 0.8;
  state.boat.y = w.y;
  run(state, hold, 4);
  assert.ok(dist(state.boat, w) < WHIRL.eye, `pulled to ${dist(state.boat, w).toFixed(1)} px from the eye`);
  assert.ok(state.boat.hp < BOATS.galleon.hp, 'the eye hurts');
  // From halfway in, Full sail straight out escapes.
  state.boat.x = w.x + WHIRL.r * 0.5;
  state.boat.y = w.y;
  state.boat.h = 0;
  state.boat.spd = BOATS.galleon.spd;
  run(state, { turn: 0, sail: FULL, fire: null }, 3);
  assert.ok(dist(state.boat, w) > WHIRL.r, 'sailed clear');
  run(state, hold, WHIRL.lasts + WHIRL.shrink);
  assert.equal(state.whirls.length, 0, 'and it closes');
});
