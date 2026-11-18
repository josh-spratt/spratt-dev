// Difficulty, measured. Two bots play many seeded nights per Draw group: one
// who knows the night by heart, one playing it for the first time. The game
// should be learnable (the first beats the second) and never trivial for a
// man (even perfect play loses a good share of nights). For a first-timer,
// class shows through what you know of the ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { drawable, startOf } from '../../public/games/twenty-boats/draw.js';
import { skilledRun, casualRun, seeded } from './bot.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'games', 'twenty-boats', 'data');
const load = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const world = {
  map: load('map.json'),
  boats: load('boats.json').boats,
  figures: load('figures.json').figures,
  groups: load('survival.json').groups,
  beats: load('beats.json').beats,
};
const NIGHTS = 300;

function rate(play, identity, seed) {
  const rng = seeded(seed);
  let lived = 0;
  for (let i = 0; i < NIGHTS; i++) if (play(world, { identity, ...startOf(identity, rng) }, rng)) lived++;
  return lived / NIGHTS;
}

const groups = drawable(world.groups).map(({ cls, sex, age }) => ({ cls, sex, age }));

test('a man who knows the night by heart still loses a good share of them', () => {
  for (const id of groups.filter((g) => g.sex === 'm')) {
    const r = rate(skilledRun, id, 1);
    assert.ok(r > 0.4 && r < 0.75, `class ${id.cls} man, perfect play: ${Math.round(r * 100)}%`);
  }
});

test('a man playing it for the first time mostly dies, as most men did', () => {
  for (const id of groups.filter((g) => g.sex === 'm')) {
    const r = rate(casualRun, id, 2);
    assert.ok(r < 0.3, `class ${id.cls} man, first play: ${Math.round(r * 100)}%`);
  }
});

test('women first: a first- or second-class woman almost always lives', () => {
  for (const id of groups.filter((g) => g.sex === 'f' && g.cls < 3)) {
    const r = rate(casualRun, id, 3);
    assert.ok(r > 0.9, `class ${id.cls} woman: ${Math.round(r * 100)}%`);
  }
});

test('class: a third-class woman who does not know the way often does not find it', () => {
  const r = rate(casualRun, { cls: 3, sex: 'f', age: 'adult' }, 4);
  assert.ok(r > 0.3 && r < 0.75, `class 3 woman, first play: ${Math.round(r * 100)}%`);
  // Knowing the ship closes the gap: that is what class bought.
  assert.ok(rate(skilledRun, { cls: 3, sex: 'f', age: 'adult' }, 5) > 0.9);
});
