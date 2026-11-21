import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreOf } from '../../public/games/cactus-boats/score.js';

// A Score is 10 points for every whole second survived plus 250 for every boat sunk.

test('scoreOf matches the formula', () => {
  assert.equal(scoreOf(0, 0), 0);
  assert.equal(scoreOf(999, 0), 0, 'only whole seconds count');
  assert.equal(scoreOf(1000, 0), 10);
  assert.equal(scoreOf(61_500, 0), 610);
  assert.equal(scoreOf(0, 1), 250);
  assert.equal(scoreOf(95_250, 7), 950 + 1750);
});

test('scoreOf rises with time survived and with boats sunk', () => {
  for (const sinks of [0, 1, 5, 40]) {
    let last = -1;
    for (let ms = 0; ms <= 600_000; ms += 250) {
      const s = scoreOf(ms, sinks);
      assert.ok(s >= last, `never falls as time goes on (${ms} ms, ${sinks} sinks)`);
      last = s;
    }
    assert.ok(scoreOf(10_000, sinks) > scoreOf(9_000, sinks), 'another second adds to it');
  }
  for (const ms of [0, 12_345, 300_000]) {
    for (let sinks = 0; sinks < 30; sinks++) assert.ok(scoreOf(ms, sinks + 1) > scoreOf(ms, sinks), 'another sink adds to it');
  }
});
