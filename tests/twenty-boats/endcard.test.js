// The End card: the group strip, and Relive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newRun, relive, choose, endCard, groupStrip, survivedEnding } from '../../public/games/twenty-boats/story.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'games', 'twenty-boats', 'data');
const load = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const world = {
  map: load('map.json'),
  boats: load('boats.json').boats,
  figures: load('figures.json').figures,
  groups: load('survival.json').groups,
  sources: load('sources.json'),
  beats: load('beats.json').beats,
};

function seeded(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function ended(identity, ending) {
  const s = newRun({ identity, place: 'cabin-1', awake: true }, { name: 'Test' });
  s.ending = ending;
  return s;
}

test('the group strip: six adult groups, yours marked, rates from the British inquiry', () => {
  const s = ended({ cls: 3, sex: 'm', age: 'adult' }, 'water-lost');
  const strip = groupStrip(s, world);
  assert.equal(strip.length, 6);
  assert.equal(strip.filter((r) => r.mine).length, 1);
  assert.deepEqual(strip.find((r) => r.mine), { cls: 3, sex: 'm', percent: 16, mine: true });
  for (const r of strip) {
    const g = world.groups.find((x) => x.cls === r.cls && x.sex === r.sex && x.age === 'adult');
    assert.equal(r.percent, Math.round((g.saved / g.aboard) * 100));
  }
});

test('a boat or a pickup from the water is a survival; anything else is not', () => {
  assert.equal(survivedEnding('boat-7'), true);
  assert.equal(survivedEnding('boat-A'), true);
  assert.equal(survivedEnding('water-saved'), true);
  assert.equal(survivedEnding('water-lost'), false);
  assert.equal(survivedEnding('went-down'), false);
});

test('the End card carries the verdict and the strip', () => {
  const s = ended({ cls: 3, sex: 'f', age: 'adult' }, 'water-lost');
  const card = endCard(s, world);
  assert.equal(card.survived, false);
  assert.equal(card.strip.length, 6);
  assert.equal(card.group.percent, 46);
});

// --- Relive ---

test('Relive: the same card and start, the night begun again', () => {
  const identity = { cls: 1, sex: 'm', age: 'adult' };
  const card = { name: 'Edwin Test', age: 40, cabin: 'Stateroom C-40' };
  const s = newRun({ identity, place: 'smoking-room', awake: true }, card, seeded(3));
  for (const id of ['go:grand-staircase', 'go:boat-deck-fwd-stbd', 'wait', 'wait']) choose(s, world, id, seeded(5));
  while (!s.ending) choose(s, world, 'wait', seeded(9));
  assert.ok(s.minute > 0 && s.met.size && s.visited.size > 1);

  const again = relive(s, seeded(11));
  assert.equal(again.card, card);
  assert.deepEqual(again.identity, identity);
  assert.equal(again.place, 'smoking-room');
  assert.equal(again.awake, true);
  assert.equal(again.minute, 0);
  assert.equal(again.ending, null);
  assert.equal(again.flags.size, 0);
  assert.equal(again.met.size, 0);
  assert.deepEqual([...again.visited], ['smoking-room']);
  assert.deepEqual(again.seen, {});
  // A Relive of a Relive still starts from the original Draw.
  choose(again, world, 'go:grand-staircase', seeded(1));
  assert.equal(relive(again, seeded(2)).place, 'smoking-room');
});

test('Relive draws the night\'s chance fresh', () => {
  const s = newRun({ identity: { cls: 3, sex: 'm', age: 'adult' }, place: 'cabin-3-fwd', awake: false }, { name: 'Test' }, seeded(1));
  const rng = seeded(99);
  const a = relive(s, rng);
  const b = relive(s, rng);
  assert.notEqual(a.seed, b.seed);
  assert.notEqual(a.seed, s.seed);
});
