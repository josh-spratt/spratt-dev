// The side view and the deck plan agree with the map: no open deck is drawn
// under the sea while the game still treats it as dry, and the plan's sea
// never covers a boat still loading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { minuteOf, END, boatWindow, floodedAt } from '../../public/games/twenty-boats/rules.js';
import { markerY, WATER_Y, BREAK_AT } from '../../public/games/twenty-boats/ship.js';
import { seaFrom, STATIONS } from '../../public/games/twenty-boats/plan.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'games', 'twenty-boats', 'data');
const load = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const map = load('map.json');
const boats = load('boats.json').boats;
const open = Object.entries(map.places).filter(([, p]) => p.open);

test('each open deck is drawn above the sea until it floods, and under it within two minutes after', () => {
  for (const [id, place] of open.filter(([, p]) => p.floodsAt)) {
    const floods = minuteOf(place.floodsAt);
    for (let m = 0; m < floods; m += 0.5) {
      assert.ok(markerY(m, place.at) < WATER_Y, `${id} drawn under at minute ${m}, floods ${place.floodsAt}`);
    }
    assert.ok(markerY(floods + 2, place.at) >= WATER_Y, `${id} still drawn dry two minutes after ${place.floodsAt}`);
  }
});

test('open decks that never flood stay above the sea until the break', () => {
  for (const [id, place] of open.filter(([, p]) => !p.floodsAt)) {
    for (let m = 0; m < BREAK_AT; m += 1) assert.ok(markerY(m, place.at) < WATER_Y, `${id} at minute ${m}`);
  }
});

test('the plan\'s sea never covers a boat still loading', () => {
  for (let m = 0; m <= END; m++) {
    const flooded = Object.keys(map.places).filter((id) => floodedAt(map.places[id], m));
    const x = seaFrom(flooded, map);
    for (const boat of boats) {
      const { opens, launch } = boatWindow(boat);
      if (m < opens || m >= launch) continue;
      assert.ok(STATIONS[boat.id][0] + 6 < x, `Boat ${boat.id} loading at minute ${m} under the sea (x ${x})`);
    }
  }
});
