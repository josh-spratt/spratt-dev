import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  END,
  CROWD_EXTRA,
  minuteOf,
  clockOf,
  linkCost,
  exitsFrom,
  boardingAt,
  boatWindow,
  earliestArrivals,
  boardableBoats,
  fullAt,
  fillAt,
  menOdds,
  MEN_LEAD,
  caughtEnding,
  waterRoll,
} from '../../public/games/twenty-boats/rules.js';
import { drawIdentity, drawable, startOf } from '../../public/games/twenty-boats/draw.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'games', 'twenty-boats', 'data');
const load = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const map = load('map.json');
const { boats } = load('boats.json');
const { groups } = load('survival.json');

const identities = drawable(groups).map(({ cls, sex, age }) => ({ cls, sex, age }));
const label = (id) => `class ${id.cls} ${id.sex} ${id.age}`;
// Every place a run can start, whatever the Draw rolls.
const starts = [...new Set(identities.flatMap((id) => [startOf(id, () => 0).place, startOf(id, () => 0.99).place]))];
const thirdMan = { cls: 3, sex: 'm', age: 'adult' };
const firstWoman = { cls: 1, sex: 'f', age: 'adult' };

test('the clock runs 23:40 to 02:20', () => {
  assert.equal(minuteOf('23:40'), 0);
  assert.equal(minuteOf('02:20'), END);
  assert.equal(clockOf(0), '23:40');
  assert.equal(clockOf(85), '01:05');
  assert.equal(clockOf(minuteOf('00:07')), '00:07');
});

test('every link and boat names a real place', () => {
  for (const link of map.links) {
    assert.ok(map.places[link.a], `link from missing place "${link.a}"`);
    assert.ok(map.places[link.b], `link to missing place "${link.b}"`);
  }
  for (const boat of boats) assert.ok(map.places[boat.loadAt], `boat ${boat.id} loads at missing "${boat.loadAt}"`);
  for (const start of starts) assert.ok(map.places[start], `start "${start}" is not a place`);
});

test('every place is reachable from every starting cabin', () => {
  const neighbours = (p) => map.links.flatMap((l) => (l.a === p ? [l.b] : l.b === p ? [l.a] : []));
  for (const start of starts) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) for (const n of neighbours(queue.shift())) if (!seen.has(n)) seen.add(n) && queue.push(n);
    for (const place of Object.keys(map.places)) assert.ok(seen.has(place), `${place} unreachable from ${start}`);
  }
});

test('twenty boats, each lowered inside the night', () => {
  assert.equal(boats.length, 20);
  assert.equal(new Set(boats.map((b) => b.id)).size, 20);
  for (const boat of boats) {
    const { opens, launch } = boatWindow(boat);
    assert.ok(opens >= 0 && opens < launch && launch <= END, `boat ${boat.id} window ${opens}-${launch}`);
    if (boat.alt) assert.ok(minuteOf(boat.alt) <= END, `boat ${boat.id} alt time`);
  }
});

test('the boat rule: women first everywhere, men only where the officer allowed it, late', () => {
  const seven = boats.find((b) => b.id === '7');
  const eight = boats.find((b) => b.id === '8');
  assert.equal(boardingAt(eight, firstWoman, minuteOf('00:55')), 'boards');
  assert.equal(boardingAt(eight, thirdMan, minuteOf('00:59')), 'refused');
  assert.equal(boardingAt(eight, { cls: 3, sex: 'm', age: 'child' }, minuteOf('00:59')), 'boards');
  assert.equal(boardingAt(seven, thirdMan, minuteOf('00:30')), 'refused');
  assert.equal(boardingAt(seven, thirdMan, minuteOf('00:38')), 'boards');
  assert.equal(boardingAt(seven, firstWoman, minuteOf('00:41')), 'gone');
  assert.equal(boardingAt(seven, firstWoman, minuteOf('00:10')), 'not-yet');
});

test('the crowd: early boats never fill, late ones fill before they are lowered', () => {
  const seven = boats.find((b) => b.id === '7');
  const fifteen = boats.find((b) => b.id === '15');
  assert.equal(fullAt(seven), boatWindow(seven).launch);
  assert.ok(fillAt(seven, boatWindow(seven).launch) < 1, 'Boat 7 went down half-empty');
  assert.ok(fullAt(fifteen) < boatWindow(fifteen).launch - MEN_LEAD);
  assert.equal(boardingAt(fifteen, firstWoman, fullAt(fifteen)), 'full');
  // Men are let in just before a boat fills.
  assert.equal(boardingAt(fifteen, thirdMan, fullAt(fifteen) - 1), 'boards');
  assert.equal(boardingAt(fifteen, thirdMan, fullAt(fifteen) - MEN_LEAD - 1), 'refused');
  assert.ok(menOdds(seven) > menOdds(fifteen));
});

test('a barrier holds third class back, but never past holdMax', () => {
  const gate = map.links.find((l) => l.barrier?.what.startsWith('stewards'));
  assert.equal(linkCost(gate, minuteOf('00:10'), firstWoman), gate.minutes);
  assert.equal(linkCost(gate, minuteOf('01:00'), thirdMan), gate.minutes + gate.barrier.holdMax);
  // Past 01:30 the companion is crowded too.
  assert.equal(linkCost(gate, minuteOf('01:35'), thirdMan), gate.minutes + CROWD_EXTRA + 5);
  assert.equal(linkCost(gate, minuteOf('01:00'), { cls: 3, sex: 'f', age: 'adult' }), gate.minutes);
});

test('no link leads into a flooded place', () => {
  const late = exitsFrom(map, 'boat-deck-aft-stbd', minuteOf('02:14'), firstWoman).map((e) => e.to);
  assert.ok(!late.includes('boat-deck-fwd-stbd'));
  assert.equal(earliestArrivals(map, 'cabin-1', firstWoman, minuteOf('02:16'))['grand-staircase'], undefined);
});

test('every Draw group can reach at least one boat: hard, never impossible', () => {
  for (const id of identities) {
    for (const start of new Set([startOf(id, () => 0).place, startOf(id, () => 0.99).place])) {
      const reachable = boardableBoats(map, boats, start, id);
      assert.ok(reachable.length > 0, `${label(id)} from ${start} can reach no boat`);
    }
  }
});

test('every Ending is reachable', () => {
  const reached = new Set();
  for (const id of identities) {
    for (const start of starts) for (const b of boardableBoats(map, boats, start, id)) reached.add(`boat-${b.id}`);
  }
  for (const boat of boats) assert.ok(reached.has(`boat-${boat.id}`), `no one can reach boat ${boat.id}`);
  // Staying below, or standing on an open deck at 02:20.
  assert.equal(caughtEnding(map.places['cabin-2']), 'went-down');
  assert.equal(caughtEnding(map.places['stern']), 'water');
  assert.equal(waterRoll(new Set(['lifejacket', 'dressed']), () => 0), 'water-saved');
  assert.equal(waterRoll(new Set(), () => 0.5), 'water-lost');
});

test('the Draw is weighted by who was aboard', () => {
  assert.equal(groups.reduce((sum, g) => sum + g.aboard, 0), 1316);
  const total = drawable(groups).reduce((sum, g) => sum + g.aboard, 0);
  assert.equal(total, 1207, 'adults only until families');
  assert.deepEqual(drawIdentity(groups, () => 0).identity, { cls: 1, sex: 'm', age: 'adult' });
  assert.deepEqual(drawIdentity(groups, () => 0.999).identity, { cls: 3, sex: 'f', age: 'adult' });
  // Third-class men are well over a third of every draw.
  const thirdMen = groups.find((g) => g.cls === 3 && g.sex === 'm' && g.age === 'adult').aboard / total;
  assert.ok(thirdMen > 0.36 && thirdMen < 0.40);
});

test('every boat, flood, barrier and survival row carries a citation', () => {
  const cited = (x) => Array.isArray(x.cite) && x.cite.length > 0;
  for (const boat of boats) assert.ok(cited(boat), `boat ${boat.id}`);
  for (const [id, place] of Object.entries(map.places)) if (place.floodsAt) assert.ok(cited(place), `flood at ${id}`);
  for (const link of map.links) if (link.barrier) assert.ok(cited(link), `barrier ${link.a}-${link.b}`);
  for (const g of groups) assert.ok(cited(g), label(g));
});
