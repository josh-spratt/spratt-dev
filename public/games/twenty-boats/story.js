// Twenty Boats — a run. Turns the clock, map and Boat rules into scenes and
// choices, and decides the Ending. Pure: no DOM. `world` is the parsed JSON
// in data/ ({ map, boats, figures, groups, beats? }).
//
// A run's state is one plain object made by newRun and changed only by
// choose. The runtime keeps one per mount, so nothing leaks between runs.

import {
  END,
  minuteOf,
  clockOf,
  floodedAt,
  caughtEnding,
  exitsFrom,
  linkCost,
  boatWindow,
  boardingAt,
  boardsAsWoman,
  boatsAt,
  fullAt,
  fillAt,
  menFrom,
  menOdds,
  FLOAT_ODDS,
  waterRoll,
} from './rules.js?v=2026-11-17-v1';
import { homeCabin } from './cards.js?v=2026-11-17-v1';

// By 01:00 the list is plain to anyone; before it, only a word from an
// officer or Andrews makes the first boats look worth getting into.
export const KNOWN_BY = minuteOf('01:00');
export const SLEEP = 15;
export const WAIT = 5;
export const WAKE = 2;
export const DRESS = 5;
export const LIFEJACKET = 3;
export const REFUSED = 1;
// How many minutes either way the crowd may fill a boat sooner or later than
// the usual, run to run.
export const FULL_JITTER = 4;

// When someone wakes the sleepers in each cabin. Forward, two seamen
// shouting "All up on deck!" (Buckley); elsewhere, the stewards.
const KNOCK = {
  'cabin-3-fwd': { at: minuteOf('23:50'), text: 'Two seamen come down the passage shouting, "All up on deck!"', cite: ['US D13 Buckley'] },
  default: { at: minuteOf('00:20'), text: 'A steward knocks and calls through the door: everyone is to dress, put on a lifebelt and go up on deck.', cite: ['US D9 Etches'] },
};

const OFFICER = {
  Murdoch: 'First Officer Murdoch',
  Lightoller: 'Second Officer Lightoller',
  Wilde: 'Chief Officer Wilde',
  Moody: 'Sixth Officer Moody',
  Lowe: 'Fifth Officer Lowe',
};

const CLASS_WORD = { 1: 'first', 2: 'second', 3: 'third' };

// `rng` rolls this night's crowd. Without it, every boat fills on the usual
// minute (the tests rely on that).
export function newRun({ identity, place, awake }, card, rng) {
  const state = {
    // The Draw as dealt, so the same night can be lived again.
    start: { identity, place, awake },
    identity,
    card,
    home: homeCabin(identity),
    place,
    awake,
    minute: 0,
    flags: new Set(),
    met: new Set(),
    knocked: false,
    seed: rng ? rng() : null,
    // Boats whose officer has put you back: he will not take you there again.
    turnedBack: new Set(),
    visited: new Set([place]),
    // Boats as you last saw them: id -> { status, at }.
    seen: {},
    // The boat a steward's group is being put into, if you went up with one.
    led: null,
    // Sightings whose full text has been on screen (see sightingKey).
    sighted: new Set(),
    // What the last choice did, and how long it took: the top of the next scene.
    outcome: null,
    notes: [],
    ending: null,
  };
  return state;
}

// Relive: the same card and start state, with the night's chance drawn
// fresh (a new crowd, new men's rolls, a new water roll).
export function relive(state, rng) {
  return newRun(state.start, state.card, rng);
}

// This run's minute the crowd fills a boat. Derived from the run's seed, so
// reading it changes nothing.
export function boatFullAt(state, boat) {
  if (state.seed === null) return fullAt(boat);
  let h = Math.floor(state.seed * 2147483647);
  for (const ch of boat.id) h = (h * 48271 + ch.charCodeAt(0)) % 2147483647;
  return fullAt(boat, Math.round(((h % 1000) / 999) * 2 * FULL_JITTER - FULL_JITTER));
}

// A move or action's cost as someone without a stopwatch would judge it.
export function costWord(minutes) {
  if (!minutes) return '';
  if (minutes <= 2) return 'a minute or two';
  if (minutes <= 4) return 'a few minutes';
  if (minutes <= 7) return 'a while';
  return 'a long time';
}

// The same, as a sentence after an outcome: "A few minutes pass."
function passed(minutes) {
  const word = costWord(minutes) || 'a moment';
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} ${word === 'a few minutes' ? 'pass' : 'passes'}.`;
}

function inWindow(minute, from, to) {
  return minute >= minuteOf(from) && minute <= minuteOf(to);
}

// One sighting of one figure: its full text is shown once, then a short line.
function sightingKey(figure, sighting) {
  return `${figure.id}@${sighting.place}@${sighting.from}`;
}

// "Thomas Andrews is still here." The name up to any comma.
function stillHere(figure) {
  const short = figure.name.split(',')[0];
  return `${short} ${/ and /.test(short) ? 'are' : 'is'} still here.`;
}

export function sightingsAt(world, place, minute) {
  const out = [];
  for (const figure of world.figures) {
    for (const s of figure.sightings) {
      if (s.place === place && inWindow(minute, s.from, s.to)) out.push({ figure, sighting: s });
    }
  }
  return out;
}

export function beatsAt(world, place, minute) {
  const open = world.map.places[place].open;
  return (world.beats ?? []).filter((b) => {
    if (!inWindow(minute, b.from, b.to)) return false;
    if (b.where === 'any') return true;
    if (b.where === 'open') return open;
    if (b.where === 'below') return !open;
    return b.where.includes(place);
  });
}

// Whether you know a place by name and the way to it: your class's own
// spaces, your cabin, and anywhere you have been.
export function knowsPlace(state, world, id) {
  return id === state.home || state.visited.has(id) || (world.map.places[id].knownTo ?? []).includes(state.identity.cls);
}

export function placeName(state, world, id) {
  const place = world.map.places[id];
  return id === state.home || !place.alias ? place.name : place.alias;
}

// A move to somewhere you do not know: which way it goes, and what you would
// notice at the top: which side of the ship, or the open air.
function vagueLabel(world, way, from, to) {
  const { side, open } = world.map.places[to];
  const tail = side && !/across/i.test(way) ? `, out on the ${side === 'port' ? 'left' : 'right'} side` : open && !world.map.places[from].open ? ', out into the open air' : '';
  return `Go ${way.charAt(0).toLowerCase()}${way.slice(1)}${tail}`;
}

// Decks bottom to top. A move's direction is read off the places' deck, their
// x on the silhouette (bow to the right) and their side.
const DECKS = ['G', 'F', 'E', 'D', 'C', 'B', 'A', 'Boat'];
const ALONG = 30;

// Which way a move goes, in plain words: "Up 3 decks, towards the front".
export function wayTo(world, fromId, toId) {
  const from = world.map.places[fromId];
  const to = world.map.places[toId];
  const parts = [];
  const rise = DECKS.indexOf(to.deck) - DECKS.indexOf(from.deck);
  if (rise) parts.push(`${rise > 0 ? 'Up' : 'Down'} ${Math.abs(rise)} deck${Math.abs(rise) === 1 ? '' : 's'}`);
  const along = to.at[0] - from.at[0];
  if (Math.abs(along) >= ALONG) parts.push(along > 0 ? 'towards the front' : 'towards the back');
  if (from.side && to.side && from.side !== to.side) parts.push(`across to the ${to.side === 'port' ? 'left' : 'right'} side`);
  if (!parts.length) return 'Same deck, close by';
  const way = parts.join(', ');
  return way.charAt(0).toUpperCase() + way.slice(1);
}

export function boatName(boat) {
  return /^\d+$/.test(boat.id) ? `Boat ${boat.id}` : `Collapsible ${boat.id}`;
}

function knows(state) {
  return state.flags.has('knows') || state.minute >= KNOWN_BY;
}

// What the player sees and may do now. Pure: reading the scene changes
// nothing.
export function sceneOf(state, world) {
  const { minute, place, identity } = state;
  const lines = [...state.notes];
  const figures = state.awake ? sightingsAt(world, place, minute) : [];
  const choices = [];
  const lowered = [];

  if (!state.ending) {
    if (!state.awake) {
      choices.push({ id: 'wake', label: 'Get up', minutes: WAKE });
      choices.push({ id: 'sleep', label: 'Go back to sleep', minutes: SLEEP });
    } else {
      for (const b of beatsAt(world, place, minute)) lines.push(b.text);
      boatChoices(state, world, lines, choices, lowered);
      if (place === state.home) {
        if (!state.flags.has('dressed')) choices.push({ id: 'dress', label: 'Dress warmly: coat, hat, gloves', minutes: DRESS });
        if (!state.flags.has('lifejacket')) choices.push({ id: 'lifejacket', label: 'Put on your lifebelt (life jacket)', minutes: LIFEJACKET });
      }
      for (const { figure, sighting } of figures) {
        if (sighting.leads && boardsAsWoman(identity) && minuteOf(sighting.leads.arrive) > minute) {
          choices.push({ id: `follow:${figure.id}`, label: `Go up with ${figure.name.split(' ').slice(-1)[0]}'s group`, minutes: minuteOf(sighting.leads.arrive) - minute, way: 'Slow, but he knows where he is taking you' });
        }
      }
      for (const { to, minutes, link } of exitsFrom(world.map, place, minute, identity)) {
        const held = link.barrier && linkCost(link, minute, identity) > linkCost(link, minute, { ...identity, cls: 0 });
        const way = wayTo(world, place, to);
        const known = knowsPlace(state, world, to);
        choices.push({
          id: `go:${to}`,
          label: known ? `Go to ${placeName(state, world, to).replace(/^(The|Your) /, (w) => w.toLowerCase())}` : vagueLabel(world, way, place, to),
          minutes,
          way: known ? way : 'You have not been this way',
          note: held ? `${link.barrier.what} is holding ${CLASS_WORD[identity.cls]} class back` : undefined,
        });
      }
      choices.push({ id: 'wait', label: 'Stay where you are', minutes: WAIT });
      if (place === state.home) choices.push({ id: 'sleep', label: 'Go back to bed', minutes: SLEEP });
    }
  }

  return {
    clock: clockOf(minute),
    minute,
    place,
    placeName: placeName(state, world, place),
    about: world.map.places[place].about,
    awake: state.awake,
    lines,
    // What your last choice did, set apart from the scene itself.
    outcome: state.outcome,
    figures: figures.map(({ figure, sighting }) => {
      const again = state.sighted.has(sightingKey(figure, sighting));
      return { id: figure.id, name: figure.name, text: again ? stillHere(figure) : sighting.text, again, secondary: !again && !!sighting.secondary };
    }),
    choices: choices.map((c) => ({ ...c, cost: costWord(c.minutes) })),
    // For sound: the beats on show that carry a cue, and boats seen pulling away.
    sounds: state.awake && !state.ending ? beatsAt(world, place, minute).map((b) => b.sound).filter(Boolean) : [],
    lowered,
  };
}

// Boats in the same state share one line: "Boats 16, 14 and 12 are full."
function together(boats, one, many) {
  if (!boats.length) return null;
  if (boats.length === 1) return `${boatName(boats[0])} ${one}`;
  const numbered = boats.every((b) => /^\d+$/.test(b.id));
  const names = numbered ? boats.map((b) => b.id) : boats.map(boatName);
  const list = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${numbered ? 'Boats ' : ''}${list} ${many}`;
}

function boatChoices(state, world, lines, choices, lowered) {
  const { minute, identity } = state;
  const gone = [];
  const full = [];
  const notReady = [];
  const folded = [];
  const loading = [];
  for (const boat of boatsAt(world.boats, state.place)) {
    const { opens, launch } = boatWindow(boat);
    const name = boatName(boat);
    if (minute > launch) {
      if (minute - launch <= 10 && !boat.floatsOff) {
        gone.push(boat);
        lowered.push(boat.id);
      }
      continue;
    }
    if (minute < opens) {
      if (!boat.floatsOff && minute >= minuteOf('00:05')) (/^\d+$/.test(boat.id) ? notReady : folded).push(boat);
      continue;
    }
    if (boat.floatsOff) {
      lines.push(`${name} is still lashed down on deck. Men are trying to free it.`);
      choices.push({ id: `board:${boat.id}`, label: `Climb onto ${name}`, minutes: 0 });
      continue;
    }
    if (!knows(state)) {
      lines.push(`${name} is swung out and taking people, but few go. The ship feels steadier than a small boat hanging over black water.`);
      continue;
    }
    const fullAt = boatFullAt(state, boat);
    if (boardingAt(boat, identity, minute, fullAt) === 'full' && state.led !== boat.id) {
      full.push(boat);
      continue;
    }
    const fill = fillAt(boat, minute, fullAt);
    const phase = minute >= menFrom(boat, fullAt)
      ? 'The officer is looking round, calling for any more women.'
      : Math.min(launch, fullAt) - minute <= 8
        ? 'The crew are readying the ropes to lower it.'
        : 'Seamen are handing people in.';
    const room = fill < 0.35 ? 'There is plenty of room in it.' : fill < 0.75 ? 'It is filling.' : 'Only a few places are left.';
    loading.push(`${name} is loading. ${phase} ${room}`);
    if (!boardsAsWoman(identity) && state.turnedBack.has(boat.id)) {
      loading.push(`${OFFICER[boat.officer] ?? boat.officer} has put you back from ${name} once already. There is no use asking him again there.`);
    } else {
      choices.push({ id: `board:${boat.id}`, label: `Get into ${name}`, minutes: 0 });
    }
  }
  // Gone and full first, what you can still try next, what is not ready last.
  lines.push(...[
    together(gone, 'is already down in the water, pulling away.', 'are already down in the water, pulling away.'),
    together(full, 'is full. Seamen hold the crowd back from the rail.', 'are full. Seamen hold the crowd back from the rail.'),
    ...loading,
    together(notReady, 'is not ready yet: seamen are still uncovering it and swinging it out. No one is getting in.', 'are not ready yet: seamen are still uncovering them and swinging them out. No one is getting in.'),
    together(folded, 'is not ready yet: it is still folded flat on the deck. No one is getting in.', 'are not ready yet: still folded flat on the deck. No one is getting in.'),
  ].filter(Boolean));
}

// Bring the run up to `to` minutes at the current place: sleepers may be
// woken, and a flood or 02:20 can end it partway.
function advance(state, world, to, rng) {
  const place = world.map.places[state.place];
  let stop = Math.min(to, END);
  if (place.floodsAt !== undefined) {
    const f = minuteOf(place.floodsAt);
    if (f > state.minute && f < stop) stop = f;
  }
  state.minute = stop;
  if (floodedAt(place, stop) || stop >= END) {
    const how = caughtEnding(place);
    state.ending = how === 'water' ? waterRoll(state.flags, rng) : how;
  }
}

// What a boat is doing at a minute, as anyone on deck could see it.
export function boatStatus(state, boat, minute) {
  const { opens, launch } = boatWindow(boat);
  if (minute > launch) return 'gone';
  if (minute < opens) return boat.floatsOff ? 'stowed' : 'hanging';
  return boardingAt(boat, { sex: 'f' }, minute, boatFullAt(state, boat)) === 'full' ? 'full' : 'loading';
}

function look(state, world) {
  if (state.ending || !state.awake) return;
  const sees = world.map.places[state.place].sees;
  if (sees) {
    for (const boat of world.boats) {
      if (world.map.places[boat.loadAt].sees === sees) state.seen[boat.id] = { status: boatStatus(state, boat, state.minute), at: state.minute };
    }
  }
  for (const { figure, sighting } of sightingsAt(world, state.place, state.minute)) {
    state.met.add(figure.id);
    if (sighting.serious) state.flags.add('knows');
  }
}

function knock(state) {
  const k = KNOCK[state.place] ?? KNOCK.default;
  return state.place === state.home && !state.knocked ? k : null;
}

// Apply one choice. Returns the same state, changed.
export function choose(state, world, id, rng = Math.random) {
  if (state.ending) return state;
  // The sightings on the screen just left have now been read in full.
  if (state.awake) for (const { figure, sighting } of sightingsAt(world, state.place, state.minute)) state.sighted.add(sightingKey(figure, sighting));
  state.notes = [];
  state.outcome = null;
  const [verb, arg] = id.split(':');
  const from = state.minute;

  if (verb === 'sleep') {
    state.awake = false;
    const k = knock(state);
    const wakeAt = k && k.at > state.minute ? k.at : Infinity;
    advance(state, world, Math.min(state.minute + SLEEP, wakeAt), rng);
    state.outcome = `You close your eyes. ${passed(state.minute - from)}`;
    if (!state.ending && state.minute >= wakeAt) {
      state.awake = true;
      state.knocked = true;
      state.outcome = k.text;
    }
  } else if (verb === 'wake') {
    state.awake = true;
    advance(state, world, state.minute + WAKE, rng);
    state.outcome = `You get up and find your feet. ${passed(WAKE)}`;
  } else if (verb === 'dress') {
    advance(state, world, state.minute + DRESS, rng);
    if (!state.ending) state.flags.add('dressed');
    state.outcome = `You dress warmly: coat, hat, gloves. ${passed(DRESS)}`;
  } else if (verb === 'lifejacket') {
    advance(state, world, state.minute + LIFEJACKET, rng);
    if (!state.ending) state.flags.add('lifejacket');
    state.outcome = `You tie on your lifebelt. ${passed(LIFEJACKET)}`;
  } else if (verb === 'wait') {
    advance(state, world, state.minute + WAIT, rng);
    state.outcome = `You stay where you are and wait. ${passed(WAIT)}`;
  } else if (verb === 'go') {
    const exit = exitsFrom(world.map, state.place, state.minute, state.identity).find((e) => e.to === arg);
    if (!exit) throw new Error(`no way to ${arg} from ${state.place}`);
    const back = state.visited.has(arg);
    state.place = arg;
    state.visited.add(arg);
    advance(state, world, state.minute + exit.minutes, rng);
    const there = placeName(state, world, arg).replace(/^(The|Your) /, (w) => w.toLowerCase());
    state.outcome = `${back ? 'You make your way back to' : 'You make your way to'} ${there}. ${passed(state.minute - from)}`;
  } else if (verb === 'follow') {
    const found = sightingsAt(world, state.place, state.minute).find((x) => x.figure.id === arg && x.sighting.leads);
    if (!found || !boardsAsWoman(state.identity)) throw new Error(`no one to follow: ${arg}`);
    const { leads } = found.sighting;
    state.place = leads.to;
    for (const id of [...(leads.via ?? []), leads.to]) state.visited.add(id);
    state.led = leads.boat;
    state.flags.add('knows');
    state.outcome = `${found.figure.name.split(' ').slice(-1)[0]} takes you up the long way, stopping for stragglers. At the top he makes for ${boatName(world.boats.find((b) => b.id === leads.boat))}.`;
    advance(state, world, minuteOf(leads.arrive), rng);
  } else if (verb === 'board') {
    board(state, world, arg, rng);
  } else {
    throw new Error(`unknown choice ${id}`);
  }

  if (!state.ending && state.minute >= KNOWN_BY && !state.flags.has('knows')) {
    state.flags.add('knows');
    if (state.awake) state.notes.push('No one needs telling any more. The ship is going down front first.');
  }
  look(state, world);
  return state;
}

function board(state, world, id, rng) {
  const boat = world.boats.find((b) => b.id === id);
  const raw = boardingAt(boat, state.identity, state.minute, boatFullAt(state, boat));
  // A steward's group is put in together, however full the boat looks.
  const result = raw === 'full' && state.led === boat.id ? 'boards' : raw;
  const officer = OFFICER[boat.officer] ?? boat.officer;
  const name = boatName(boat);
  if (result === 'boards' && boat.floatsOff) {
    // The scramble for a collapsible: a hold, or the wave takes you.
    state.ending = rng() < FLOAT_ODDS ? `boat-${boat.id}` : waterRoll(state.flags, rng);
    return;
  }
  if (result === 'boards' && (boardsAsWoman(state.identity) || rng() < menOdds(boat))) {
    state.ending = `boat-${boat.id}`;
    return;
  }
  // A lost chance or a women-only boat closes that boat to you. Asking a
  // boat that will take men, before it does, closes nothing.
  if (result === 'boards') {
    state.turnedBack.add(boat.id);
    state.outcome = `${officer} looks past you to a woman pushing through behind, and puts you back from ${name}. He will not take you in this one.`;
  } else if (result === 'refused' && boat.menAdmitted) {
    state.outcome = `${officer} at ${name}: "Not yet. Women first. Stand back."`;
  } else if (result === 'refused') {
    state.turnedBack.add(boat.id);
    state.outcome = `${officer} turns you away from ${name}. Women and children only.`;
  } else if (result === 'full') {
    state.outcome = `${name} filled while you pushed towards it. The seamen will not take one more.`;
  } else {
    state.outcome = `${name} is not taking anyone now.`;
  }
  state.outcome += ` ${passed(REFUSED)}`;
  advance(state, world, state.minute + REFUSED, rng);
}

// The deck plan: every boat as you last saw it, and where you are. Boats
// you have not seen are 'unknown'; a loading boat that has turned you away
// is 'turned'; "left" counts every boat you have not seen go.
export function planOf(state, world) {
  const statusOf = (b) => {
    const status = state.seen[b.id]?.status ?? 'unknown';
    return status === 'loading' && state.turnedBack.has(b.id) && !boardsAsWoman(state.identity) ? 'turned' : status;
  };
  const boats = world.boats.map((b) => ({ id: b.id, status: statusOf(b), at: state.seen[b.id]?.at ?? null }));
  const place = world.map.places[state.place];
  return {
    boats,
    left: boats.filter((b) => b.status !== 'gone').length,
    unseen: boats.filter((b) => b.status === 'unknown').length,
    you: { place: state.place, deck: place.deck, x: place.at[0], side: place.side ?? null },
    flooded: Object.keys(world.map.places).filter((id) => floodedAt(world.map.places[id], state.minute)),
  };
}

const OTHER_ENDINGS = [
  {
    id: 'water-saved',
    title: 'In the water, picked up',
    text: 'The cold drives the breath out of you. You keep your head up, and a boat comes back through the dark and hauls you in. Of the hundreds in the water at 02:20, only a handful were taken out alive.',
  },
  {
    id: 'water-lost',
    title: 'In the water, lost',
    text: 'The cold drives the breath out of you. The cries carry a long way over the flat sea, and for a long time no boat comes back. Of the hundreds in the water at 02:20, only a handful were taken out alive.',
  },
  {
    id: 'went-down',
    title: 'Went down with the ship',
    text: 'You were below decks when the water came. The ship went down at 02:20 with more than 1,500 people still aboard her or in the sea around her.',
  },
];

function sentence(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Every Ending, boats in launch order first. A boat's text names its real
// launch time and real headcount.
export function endings(world) {
  const boats = [...world.boats].sort((a, b) => minuteOf(a.launch) - minuteOf(b.launch));
  const boatEndings = boats.map((boat) => {
    const name = boatName(boat);
    const side = boat.side === 'port' ? 'Left (port)' : 'Right (starboard)';
    const text = boat.floatsOff
      ? `${name} floated off the deck at about ${boat.launch} as the front of the ship went under. ${sentence(boat.headcount)}. Carpathia reached the boats from 04:10.`
      : `${side} side, loaded under ${OFFICER[boat.officer] ?? boat.officer}. Lowered at ${boat.launch} with ${boat.headcount} aboard. Carpathia reached the boats from 04:10.`;
    return { id: `boat-${boat.id}`, boat: boat.id, title: name, text, cite: boat.cite };
  });
  return [...boatEndings, ...OTHER_ENDINGS];
}

function percent(saved, aboard) {
  return Math.round((saved / aboard) * 100);
}

// A boat, or picked up out of the water. Everything else is lost.
export function survivedEnding(endingId) {
  return endingId.startsWith('boat-') || endingId === 'water-saved';
}

// The six adult groups by the British inquiry's count, yours marked.
export function groupStrip(state, world) {
  const { cls, sex } = state.identity;
  return world.groups
    .filter((g) => g.age === 'adult')
    .map((g) => ({ cls: g.cls, sex: g.sex, percent: percent(g.saved, g.aboard), mine: g.cls === cls && g.sex === sex }));
}

// The run set against the record: your group's survival rate (British
// report, with the modern recount where it differs), every adult group's
// rate, and the Real figures you met, with how their night ended.
export function endCard(state, world) {
  const ending = endings(world).find((e) => e.id === state.ending);
  const { cls, sex, age } = state.identity;
  const g = world.groups.find((x) => x.cls === cls && x.sex === sex && x.age === age);
  const group = { aboard: g.aboard, saved: g.saved, percent: percent(g.saved, g.aboard), cite: g.cite };
  if (g.et) group.et = { aboard: g.et.aboard, saved: g.et.saved, percent: percent(g.et.saved, g.et.aboard) };
  const met = world.figures.filter((f) => state.met.has(f.id)).map((f) => ({ id: f.id, name: f.name, fate: f.fate, cite: f.cite }));
  return { ending, group, met, survived: survivedEnding(ending.id), strip: groupStrip(state, world) };
}
