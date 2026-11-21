// Difficulty, measured. Bots play many seeded Plays: one who sits at anchor
// and never fires, and captains who sail and fire smart broadsides. The game
// should be learnable (a captain lasts a good deal longer and sinks boats),
// endless but not infinite (even a captain is sunk in the end), and harder the
// longer you last (more enemies afloat, arriving faster, tougher hulls later).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, summary, isSunk, maxSpawnedBy, difficultyAt, SPAWN, STEP } from '../../public/games/cactus-boats/sim.js';
import { scoreOf } from '../../public/games/cactus-boats/score.js';
import { play, idle, captain, sailor } from './bot.js';

const SEEDS = Array.from({ length: 16 }, (_, i) => 1000 + i * 7919);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const secs = (r) => r.survivedMs / 1000;


test('a boat that sits at anchor and never fires is sunk, and soon', () => {
  const runs = SEEDS.map((seed) => play(seed, idle, 600));
  for (const [i, r] of runs.entries()) {
    assert.ok(r.sunk, `seed ${SEEDS[i]}: sunk`);
    assert.ok(secs(r) < 150, `seed ${SEEDS[i]}: sunk after ${secs(r)} s`);
    assert.equal(r.sinks, 0);
  }
  assert.ok(mean(runs.map(secs)) < 100, `on average after ${mean(runs.map(secs)).toFixed(0)} s`);
});

test('a captain who sails and fires lasts much longer and sinks boats, but is sunk in the end', () => {
  const lazy = SEEDS.map((seed) => play(seed, idle, 600));
  const lazyLasted = mean(lazy.map(secs));
  for (const [name, brain, longer] of [['a captain holding the beam', captain, 1.2], ['a sailor keeping her distance', sailor, 2.5]]) {
    const runs = SEEDS.map((seed) => play(seed, brain, 1200));
    for (const [i, r] of runs.entries()) assert.ok(r.sunk, `${name}, seed ${SEEDS[i]}: still afloat after ${secs(r)} s`);
    const lasted = mean(runs.map(secs));
    const sank = mean(runs.map((r) => r.sinks));
    assert.ok(lasted > lazyLasted * longer, `${name} lasts ${lasted.toFixed(0)} s on average, an idle boat ${lazyLasted.toFixed(0)} s`);
    assert.ok(sank >= 1, `${name} sinks ${sank.toFixed(1)} boats on average`);
    assert.ok(runs.filter((r) => r.sinks > 0).length >= runs.length * 0.75, `${name} sinks a boat in most Plays`);
    assert.ok(mean(runs.map((r) => r.score)) > 1.5 * mean(lazy.map((r) => r.score)), `${name} Scores far more`);
  }
});

test('the summary carries the Score for its time and sinks', () => {
  for (const seed of SEEDS.slice(0, 4)) {
    const r = play(seed, captain, 1200);
    assert.equal(r.score, scoreOf(r.survivedMs, r.sinks));
  }
});

// The curve, watched on boats that can't be sunk, so it plays out in full.
const LONG = 540;
function watch(seed, brain) {
  const state = newRun(seed, { unsinkable: true });
  const arrived = new Map(); // id -> { at, hull }
  const afloat = [];
  for (let i = 0; i < Math.round(LONG / STEP); i++) {
    step(state, brain(state), STEP);
    for (const e of state.enemies) if (!arrived.has(e.id)) arrived.set(e.id, { at: state.elapsed, hull: e.hull });
    if (i % 60 === 0) afloat.push({ at: state.elapsed, n: state.enemies.filter((e) => !e.sunk).length });
    const ms = summary(state).survivedMs;
    const spawned = arrived.size + state.warnings.length;
    assert.ok(spawned <= maxSpawnedBy(ms), `seed ${seed}: ${spawned} spawned by ${ms} ms, more than ${maxSpawnedBy(ms)}`);
  }
  assert.ok(!isSunk(state));
  return { arrived: [...arrived.values()], afloat, state };
}
let seen;
const watched = () => (seen ??= SEEDS.slice(0, 6).map((seed) => ({ idle: watch(seed, idle), captain: watch(seed, captain) })));
const within = (xs, from, to) => xs.filter((x) => x.at >= from && x.at < to);

test('more enemies are afloat the longer you last', () => {
  for (const w of watched()) {
    const early = Math.max(...within(w.idle.afloat, 0, 60).map((x) => x.n));
    const late = Math.max(...within(w.idle.afloat, 420, LONG).map((x) => x.n));
    assert.ok(late >= early + 3, `${early} afloat at most in the first minute, ${late} late on`);
  }
});

test('enemies arrive faster the longer you last', () => {
  // A full sea holds arrivals back until a boat is sunk, so in any one Play the
  // gaps follow the sinking. Across Plays, the shortest gap shows the curve.
  const gaps = (xs) => xs.slice(1).map((x, i) => x.at - xs[i].at);
  const shortest = (from, to) => Math.min(...watched().flatMap((w) => gaps(within(w.captain.arrived, from, to))));
  const early = shortest(0, 120);
  const late = shortest(360, LONG);
  assert.ok(late < early * 0.6, `${early.toFixed(1)} s apart at best in the first two minutes, ${late.toFixed(1)} s after 6:00`);
  // And the curve itself: arrivals come quicker and the sea holds more, never the other way.
  let last = difficultyAt(0);
  for (let t = 1; t <= 900; t++) {
    const now = difficultyAt(t);
    assert.ok(now.every <= last.every && now.afloat >= last.afloat, `the curve eases off at ${t} s`);
    last = now;
  }
  assert.ok(difficultyAt(360).every <= difficultyAt(0).every / 2, 'by six minutes they come twice as fast');
});

test('tougher hulls join only after their threshold, in order', () => {
  const from = (hull) => SPAWN.curve.find((row) => row.mix[hull]).at;
  assert.ok(from('prickly') < from('sombrero') && from('sombrero') < from('saguaro'), 'Prickly Pear, then Sombrero, then Saguaro');
  const hulls = new Set();
  for (const w of watched()) {
    for (const a of [...w.idle.arrived, ...w.captain.arrived]) {
      // An arrival comes SPAWN.warn after its warning, which is when its hull is chosen.
      assert.ok(a.at - SPAWN.warn >= from(a.hull) - STEP, `a ${a.hull} arrived at ${a.at.toFixed(1)} s, before ${from(a.hull)} s`);
      hulls.add(a.hull);
    }
  }
  assert.deepEqual([...hulls].sort(), ['prickly', 'saguaro', 'sombrero'], 'every hull on the ladder turns up');
});

test('the most that could have spawned by a time bounds what the spawner spawns', () => {
  // watch() checks the bound against the spawner after every tick of every Play.
  for (const w of watched()) assert.ok(w.captain.arrived.length > 20, 'over plenty of arrivals');
  assert.equal(maxSpawnedBy(0), 0);
  assert.equal(maxSpawnedBy(SPAWN.first * 1000 - 5), 0);
  assert.equal(maxSpawnedBy(SPAWN.first * 1000), 1, 'the first is spawned on time');
  let prev = 0;
  const quickest = Math.min(...SPAWN.curve.map((row) => row.every));
  for (let ms = 0; ms <= 3 * 3600_000; ms += 1000) {
    const n = maxSpawnedBy(ms);
    assert.ok(n >= prev, 'it never goes down');
    assert.ok(n <= 1 + ms / 1000 / quickest, `and never counts faster than the quickest arrivals (${n} by ${ms} ms)`);
    prev = n;
  }
});
