// A bot that plays Twenty Boats as well as someone who has memorised the
// night: it knows every boat's time, when each fills, and which officers
// let men in. Used to set the game's difficulty against the record.

import { earliestArrivals, boatWindow, boardsAsWoman, menFrom, exitsFrom } from '../../public/games/twenty-boats/rules.js';
import { newRun, sceneOf, choose, boatFullAt, endCard, knowsPlace, wayTo } from '../../public/games/twenty-boats/story.js';

// Seeded so a balance check gives the same answer every run.
export function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The minutes this run's player may try this boat: [from, to).
function window(state, boat) {
  const { opens, launch } = boatWindow(boat);
  const full = boatFullAt(state, boat);
  const to = Math.min(launch + 1, full);
  if (boat.floatsOff || boardsAsWoman(state.identity)) return { from: opens, to };
  if (!boat.menAdmitted || state.turnedBack.has(boat.id)) return null;
  return { from: menFrom(boat, full), to };
}

function target(state, world) {
  const arrive = earliestArrivals(world.map, state.place, state.identity, state.minute);
  let best = null;
  for (const boat of world.boats) {
    const w = window(state, boat);
    const t = arrive[boat.loadAt];
    if (!w || t === undefined || Math.max(t, w.from) >= w.to) continue;
    if (!best || w.to < best.w.to) best = { boat, w };
  }
  return best;
}

export function skilledRun(world, draw, rng) {
  const state = newRun(draw, { name: 'Bot' }, rng);
  while (!state.ending) {
    const ids = sceneOf(state, world).choices.map((c) => c.id);
    let pick = 'wait';
    const aim = target(state, world);
    if (!state.awake) pick = 'wake';
    else if (ids.includes('lifejacket')) pick = 'lifejacket';
    else if (aim && state.place !== aim.boat.loadAt) {
      let bestT = Infinity;
      for (const { to, minutes } of exitsFrom(world.map, state.place, state.minute, state.identity)) {
        const t = to === aim.boat.loadAt ? state.minute + minutes : earliestArrivals(world.map, to, state.identity, state.minute + minutes)[aim.boat.loadAt];
        if (t !== undefined && t < bestT) [bestT, pick] = [t, `go:${to}`];
      }
    } else if (aim && state.minute >= aim.w.from && ids.includes(`board:${aim.boat.id}`)) pick = `board:${aim.boat.id}`;
    choose(state, world, pick, rng);
  }
  return endCard(state, world).survived;
}

const DECKS = ['boat-deck-fwd-port', 'boat-deck-fwd-stbd', 'boat-deck-aft-port', 'boat-deck-aft-stbd'];

// A first-time player: gets up, follows a steward if one is leading people
// up, heads for the nearest lifeboat deck it knows by name (otherwise any
// way up it has not tried, then any way it has not tried), and tries any boat on offer. Knows nothing of the
// officers or the crowd.
export function casualRun(world, draw, rng) {
  const state = newRun(draw, { name: 'Bot' }, rng);
  while (!state.ending) {
    const choices = sceneOf(state, world).choices;
    const ids = choices.map((c) => c.id);
    let pick = ids.find((id) => id.startsWith('board:')) ?? ids.find((id) => id.startsWith('follow:')) ?? 'wait';
    if (!state.awake) pick = 'wake';
    else if (pick === 'wait' && !DECKS.includes(state.place)) {
      let bestT = Infinity;
      const known = DECKS.filter((d) => knowsPlace(state, world, d));
      for (const { to, minutes } of exitsFrom(world.map, state.place, state.minute, state.identity)) {
        if (!knowsPlace(state, world, to)) continue;
        const arrive = earliestArrivals(world.map, to, state.identity, state.minute + minutes);
        for (const deck of known) if (arrive[deck] !== undefined && arrive[deck] < bestT) [bestT, pick] = [arrive[deck], `go:${to}`];
      }
      if (pick === 'wait') {
        const fresh = choices.filter((c) => c.id.startsWith('go:') && !state.visited.has(c.id.slice(3)));
        const up = fresh.filter((c) => /^Up/.test(wayTo(world, state.place, c.id.slice(3))));
        const ways = up.length ? up : fresh;
        if (ways.length) pick = ways[Math.floor(rng() * ways.length)].id;
      }
    }
    choose(state, world, pick, rng);
  }
  return endCard(state, world).survived;
}
