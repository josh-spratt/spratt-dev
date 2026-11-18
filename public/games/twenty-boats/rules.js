// Twenty Boats — the clock, the map and the Boat rules. Pure functions over
// the JSON in data/, shared by the runtime and the tests. No DOM, no imports:
// node --test loads this file directly.
//
// Time is minutes since 23:40 (impact). The ship is gone at END (02:20).

export const END = 160;
// After this the boat deck and stairs are crowded and crowded links cost more.
export const CROWDED_FROM = minuteOf('01:30');
export const CROWD_EXTRA = 3;
// A boat starts taking people this long before it is lowered, and never
// before the order for women and children (~00:30, BR-Boats).
export const LOADING_LEAD = 15;
export const LOADING_EARLIEST = minuteOf('00:25');
// Men get into a men-admitted boat only in its last minutes, once the women
// near it have gone (see menFrom).
export const MEN_LEAD = 5;

export function minuteOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h * 60 + m - (23 * 60 + 40) + 24 * 60) % (24 * 60);
}

export function clockOf(minute) {
  const t = (23 * 60 + 40 + minute) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// Children of either sex board with the women.
export function boardsAsWoman(identity) {
  return identity.sex === 'f' || identity.age === 'child';
}

export function floodedAt(place, minute) {
  return place.floodsAt !== undefined && minute >= minuteOf(place.floodsAt);
}

// Caught by the water here: on an open deck you go in; below, you go down.
export function caughtEnding(place) {
  return place.open ? 'water' : 'went-down';
}

// Minutes to cross a link leaving at `minute`. A barrier holds its classes
// until it opens, but never longer than holdMax: someone always gets through.
export function linkCost(link, minute, identity) {
  let cost = link.minutes;
  if (link.crowded && minute >= CROWDED_FROM) cost += CROWD_EXTRA;
  const bar = link.barrier;
  if (bar && bar.classes.includes(identity.cls)) {
    const opens = minuteOf(bar.holdUntil[boardsAsWoman(identity) ? 'women' : 'men']);
    if (minute < opens) cost += Math.min(bar.holdMax, opens - minute);
  }
  return cost;
}

// Links out of a place at a time, with their cost. A link into a place that
// will have flooded by arrival is left out.
export function exitsFrom(map, placeId, minute, identity) {
  const exits = [];
  for (const link of map.links) {
    const to = link.a === placeId ? link.b : link.b === placeId ? link.a : null;
    if (!to) continue;
    const minutes = linkCost(link, minute, identity);
    if (floodedAt(map.places[to], minute + minutes)) continue;
    exits.push({ to, minutes, link });
  }
  return exits;
}

export function boatWindow(boat) {
  const launch = minuteOf(boat.launch);
  const opens = boat.opens ? minuteOf(boat.opens) : Math.max(launch - LOADING_LEAD, LOADING_EARLIEST);
  return { opens, launch };
}

// Others fill a boat over its loading window. The early boats went down
// half-empty because few believed the ship would sink; from 01:00 a crowd
// pressed at every boat, and the late ones were full well before they were
// lowered. A boat full before launch takes no one else.
export const RUSH_FROM = minuteOf('01:00');
export const RUSH_FULL = minuteOf('01:45');
export const RUSH_MAX = 0.7;

// How hard the crowd presses at a boat lowered at `launch`: 0 to 1.
export function rushAt(launch) {
  return Math.min(1, Math.max(0, (launch - RUSH_FROM) / (RUSH_FULL - RUSH_FROM)));
}

export function fullAt(boat, jitter = 0) {
  const { opens, launch } = boatWindow(boat);
  if (boat.floatsOff) return launch;
  const full = Math.round(launch - (launch - opens) * RUSH_MAX * rushAt(launch)) + jitter;
  return Math.min(launch, Math.max(opens + 2, full));
}

// How full a boat is at a minute, 0 to 1. Early boats never reach 1.
export function fillAt(boat, minute, full = fullAt(boat)) {
  const { opens, launch } = boatWindow(boat);
  if (full >= launch) return Math.min(0.6, Math.max(0, (minute - opens) / (launch - opens)) * 0.6);
  return Math.min(1, Math.max(0, (minute - opens) / (full - opens)));
}

// Whether this Identity can get into this boat at this minute, and if not,
// why: 'not-yet' (still being readied), 'gone', 'full', 'refused' (men
// turned away). 'boards' for a man is only a chance: see menOdds.
export function boardingAt(boat, identity, minute, full = fullAt(boat)) {
  const { opens, launch } = boatWindow(boat);
  if (minute > launch) return 'gone';
  if (minute < opens) return 'not-yet';
  if (full < launch && minute >= full) return 'full';
  if (boat.floatsOff || boardsAsWoman(identity)) return 'boards';
  if (boat.menAdmitted && minute >= menFrom(boat, full)) return 'boards';
  return 'refused';
}

// Men are let in only in the last minutes before a boat fills or is lowered.
export function menFrom(boat, full = fullAt(boat)) {
  return Math.min(boatWindow(boat).launch, full) - MEN_LEAD;
}

// A man at a men-admitted boat in its last minutes gets in only if the
// officer looks round and sees no more women. Early, the deck was nearly
// empty; late, it was packed. Game odds, not a historical rate. Low per
// try, because a lost try closes only that boat and a man may try every one
// that takes men (tests/twenty-boats/balance.test.js holds the bands).
export const MEN_EARLY = 0.12;
export const MEN_LATE = 0.04;

export function menOdds(boat) {
  return MEN_EARLY + (MEN_LATE - MEN_EARLY) * rushAt(boatWindow(boat).launch);
}

// Collapsibles A and B floated off as the water came up the deck. Getting a
// hold of one before the wave took you was a scramble; most who tried went
// into the sea. Game odds.
export const FLOAT_ODDS = 0.25;

export function boatsAt(boats, placeId) {
  return boats.filter((b) => b.loadAt === placeId);
}

// The water roll. Almost no one taken by the
// water lived; a lifejacket and warm clothes help a little. Game odds, not a
// historical rate.
export const WATER_BASE = 0.02;
export const WATER_LIFEJACKET = 0.03;
export const WATER_DRESSED = 0.03;

export function waterOdds(flags) {
  return WATER_BASE + (flags.has('lifejacket') ? WATER_LIFEJACKET : 0) + (flags.has('dressed') ? WATER_DRESSED : 0);
}

export function waterRoll(flags, rng) {
  return rng() < waterOdds(flags) ? 'water-saved' : 'water-lost';
}

// Earliest minute this Identity can reach each place, setting out from
// `start` at `from`. Costs never let a later start arrive sooner, so plain
// Dijkstra is exact.
export function earliestArrivals(map, start, identity, from = 0) {
  const best = { [start]: from };
  const open = new Set([start]);
  while (open.size) {
    let here = null;
    for (const p of open) if (here === null || best[p] < best[here]) here = p;
    open.delete(here);
    for (const { to, minutes } of exitsFrom(map, here, best[here], identity)) {
      const t = best[here] + minutes;
      if (t <= END && (best[to] === undefined || t < best[to])) {
        best[to] = t;
        open.add(to);
      }
    }
  }
  return best;
}

// Boats this Identity could get into from `start`, playing perfectly.
export function boardableBoats(map, boats, start, identity) {
  const arrive = earliestArrivals(map, start, identity);
  return boats.filter((boat) => {
    const t = arrive[boat.loadAt];
    if (t === undefined) return false;
    const from = boat.floatsOff || boardsAsWoman(identity) ? boatWindow(boat).opens : menFrom(boat);
    return boardingAt(boat, identity, Math.max(t, from)) === 'boards';
  });
}
