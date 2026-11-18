import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { minuteOf, END } from '../../public/games/twenty-boats/rules.js';
import { newRun, sceneOf, choose, endings, endCard, wayTo, KNOWN_BY, boatFullAt, planOf } from '../../public/games/twenty-boats/story.js';
import { cueFor, CUES } from '../../public/games/twenty-boats/sound.js';
import { dealCard, homeCabin } from '../../public/games/twenty-boats/cards.js';
import { resolveCite, citesIn } from '../../public/games/twenty-boats/sources.js';

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
const names = load('names.json');

const firstWoman = { cls: 1, sex: 'f', age: 'adult' };
const firstMan = { cls: 1, sex: 'm', age: 'adult' };
const thirdMan = { cls: 3, sex: 'm', age: 'adult' };
const never = () => 0.99;

function run(identity, place, awake) {
  return newRun({ identity, place, awake }, { name: 'Test' });
}

// Play a list of choice ids, failing loudly if one is not on offer.
function play(state, ids, rng = never) {
  for (const id of ids) {
    const offered = sceneOf(state, world).choices.map((c) => c.id);
    assert.ok(offered.includes(id), `${id} not offered at ${sceneOf(state, world).clock} in ${state.place}: ${offered}`);
    choose(state, world, id, rng);
  }
  return state;
}

function waitUntil(state, hhmm) {
  while (!state.ending && state.minute < minuteOf(hhmm)) choose(state, world, 'wait', never);
  return state;
}

test('a run starts at 23:40 with no flags and no ending', () => {
  const s = run(firstWoman, 'cabin-1', false);
  const scene = sceneOf(s, world);
  assert.equal(scene.clock, '23:40');
  assert.equal(s.flags.size, 0);
  assert.equal(s.ending, null);
  assert.deepEqual(scene.choices.map((c) => c.id).sort(), ['sleep', 'wake']);
});

test('going back to sleep in the forward third-class berths is an Ending at 00:15', () => {
  const s = run(thirdMan, 'cabin-3-fwd', false);
  while (!s.ending) choose(s, world, 'sleep', never);
  assert.equal(s.ending, 'went-down');
  assert.ok(s.minute >= minuteOf('00:15') && s.minute < minuteOf('00:30'));
  assert.ok(s.met.has('buckley'), 'Buckley is in the cabin at 23:40');
});

test('a steward wakes sleepers elsewhere', () => {
  const s = run(firstWoman, 'cabin-1', false);
  for (let i = 0; i < 4 && !s.awake; i++) choose(s, world, 'sleep', never);
  assert.equal(s.awake, true);
  assert.equal(s.ending, null);
});

test('dressing and a lifejacket cost minutes, only in your own cabin', () => {
  const s = play(run(firstWoman, 'cabin-1', false), ['wake', 'dress', 'lifejacket']);
  assert.deepEqual([...s.flags].sort(), ['dressed', 'lifejacket']);
  assert.equal(s.minute, 2 + 5 + 3);
  play(s, ['go:grand-staircase']);
  const ids = sceneOf(s, world).choices.map((c) => c.id);
  assert.ok(!ids.includes('dress') && !ids.includes('lifejacket'));
  assert.equal(homeCabin(thirdMan), 'cabin-3-fwd');
});

test('overhearing Andrews tells you it is serious, and he joins the people you met', () => {
  const s = play(run(firstWoman, 'cabin-1', true), ['go:grand-staircase']);
  waitUntil(s, '00:15');
  assert.ok(s.flags.has('knows'));
  assert.ok(s.met.has('andrews'));
});

test('before 01:00 a boat is not offered to someone who does not know it is serious', () => {
  const s = run(firstWoman, 'smoking-room', true);
  play(s, ['go:boat-deck-aft-stbd']);
  waitUntil(s, '00:30');
  play(s, ['go:boat-deck-fwd-stbd']);
  // Murdoch is loading here: overhearing him is enough.
  assert.ok(s.flags.has('knows'));
  assert.ok(sceneOf(s, world).choices.some((c) => c.id === 'board:7'));

  const blind = run(firstWoman, 'smoking-room', true);
  blind.place = 'boat-deck-fwd-stbd';
  blind.minute = minuteOf('00:30');
  blind.met.clear();
  // Asked directly, without the overheard cue: no boat choice yet.
  const offered = sceneOf(blind, world).choices.map((c) => c.id);
  assert.ok(!offered.some((id) => id.startsWith('board:')), offered.join());
  assert.ok(KNOWN_BY <= minuteOf('01:00'));
});

test('a woman boards Boat 7 and the run ends there', () => {
  const s = play(run(firstWoman, 'cabin-1', true), ['go:grand-staircase', 'go:boat-deck-fwd-stbd']);
  waitUntil(s, '00:30');
  play(s, ['board:7']);
  assert.equal(s.ending, 'boat-7');
});

test('a man is turned away at a port boat; the turn-away is a branch, not an Ending', () => {
  const s = run(firstMan, 'smoking-room', true);
  play(s, ['go:grand-staircase', 'go:boat-deck-fwd-port']);
  waitUntil(s, '00:50');
  const before = s.minute;
  play(s, ['board:8']);
  assert.equal(s.ending, null);
  assert.ok(s.minute > before);
  assert.match(sceneOf(s, world).outcome, /women and children/i);
});

test('a man gets into a starboard boat in its last minutes', () => {
  const s = run(firstMan, 'smoking-room', true);
  play(s, ['go:grand-staircase', 'go:boat-deck-fwd-stbd']);
  waitUntil(s, '00:36');
  play(s, ['board:7'], () => 0);
  assert.equal(s.ending, 'boat-7');
});

test('a man put back once is not taken at that boat again, but the officer\'s other boats stay open', () => {
  const s = run(firstMan, 'smoking-room', true);
  play(s, ['go:grand-staircase', 'go:boat-deck-fwd-stbd']);
  waitUntil(s, '00:36');
  play(s, ['board:7']);
  assert.equal(s.ending, null);
  assert.ok(s.turnedBack.has('7'));
  assert.match(sceneOf(s, world).outcome, /puts you back from Boat 7/);
  let scene = sceneOf(s, world);
  assert.ok(!scene.choices.some((c) => c.id === 'board:7'), 'Boat 7 not offered again');
  assert.match(scene.lines.join(' '), /put you back from Boat 7 once already/);
  assert.equal(planOf(s, world).boats.find((b) => b.id === '7').status, 'turned');
  // Murdoch's next boat here still takes a try.
  waitUntil(s, '00:41');
  scene = sceneOf(s, world);
  assert.ok(scene.choices.some((c) => c.id === 'board:5'), scene.choices.map((c) => c.id).join());
});

test('asking a boat that takes men, before it does, closes nothing', () => {
  const s = run(firstMan, 'smoking-room', true);
  play(s, ['go:grand-staircase', 'go:boat-deck-fwd-stbd']);
  waitUntil(s, '00:30');
  const before = s.minute;
  play(s, ['board:7']);
  assert.equal(s.ending, null);
  assert.equal(s.minute, before + 1);
  assert.equal(s.turnedBack.size, 0);
  assert.match(sceneOf(s, world).outcome, /Not yet\. Women first\. Stand back\./);
  assert.ok(sceneOf(s, world).choices.some((c) => c.id === 'board:7'));
});

test('a women-and-children boat that turns a man away closes only that boat', () => {
  const s = run(firstMan, 'smoking-room', true);
  play(s, ['go:grand-staircase', 'go:boat-deck-fwd-port']);
  waitUntil(s, '00:50');
  play(s, ['board:8']);
  assert.deepEqual([...s.turnedBack], ['8']);
  assert.ok(!sceneOf(s, world).choices.some((c) => c.id === 'board:8'));
});

test('late boats fill before they are lowered; a woman who comes late finds them full', () => {
  const s = run(firstWoman, 'smoking-room', true);
  play(s, ['go:boat-deck-aft-stbd']);
  waitUntil(s, '01:36');
  const scene = sceneOf(s, world);
  assert.ok(!scene.choices.some((c) => c.id === 'board:15'), 'Boat 15 is full by 01:36');
  assert.match(scene.lines.join(' '), /(Boat 15 is|Boats [0-9, and]*15[0-9, and]* are) full/);
});

test('the scene gives no launch times and no minute counts', () => {
  const s = play(run(firstWoman, 'cabin-1', true), ['go:grand-staircase', 'go:boat-deck-fwd-stbd']);
  waitUntil(s, '00:30');
  const scene = sceneOf(s, world);
  assert.ok(scene.choices.some((c) => c.id === 'board:7'));
  assert.doesNotMatch(scene.lines.join(' '), /\d\d:\d\d/);
  for (const c of scene.choices) assert.doesNotMatch(c.cost, /\d/);
});

test('a scramble for a collapsible can end in the sea', () => {
  const s = run(firstMan, 'smoking-room', true);
  s.place = 'boat-deck-fwd-port';
  s.minute = minuteOf('02:06');
  s.flags.add('knows');
  play(s, ['board:B'], () => 0.99);
  assert.equal(s.ending, 'water-lost');
});

test('each run rolls its own crowd, and the roll is fixed for that run', () => {
  const fifteen = world.boats.find((b) => b.id === '15');
  const fulls = new Set();
  for (const seed of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const s = newRun({ identity: firstWoman, place: 'cabin-1', awake: true }, { name: 'Test' }, () => seed);
    assert.equal(boatFullAt(s, fifteen), boatFullAt(s, fifteen));
    fulls.add(boatFullAt(s, fifteen));
  }
  assert.ok(fulls.size > 1);
});

test('02:20 below decks: went down with the ship. On deck: the water roll', () => {
  const below = run(firstMan, 'smoking-room', true);
  waitUntil(below, '02:20');
  assert.equal(below.ending, 'went-down');

  const deck = run(firstMan, 'smoking-room', true);
  deck.place = 'stern';
  waitUntil(deck, '02:20');
  assert.equal(deck.ending, 'water-lost');
  assert.ok(deck.minute <= END);

  const lucky = run(firstMan, 'smoking-room', true);
  lucky.place = 'stern';
  lucky.minute = minuteOf('02:15');
  while (!lucky.ending) choose(lucky, world, 'wait', () => 0);
  assert.equal(lucky.ending, 'water-saved');
});

test('the Endings: twenty boats, then three more, every one with text', () => {
  const all = endings(world);
  assert.equal(all.filter((e) => e.boat).length, 20);
  assert.deepEqual(all.filter((e) => !e.boat).map((e) => e.id), ['water-saved', 'water-lost', 'went-down']);
  for (const e of all) assert.ok(e.title && e.text, e.id);
  const seven = all.find((e) => e.id === 'boat-7');
  assert.match(seven.text, /00:40/);
  assert.match(seven.text, /about 28/);
});

test('the End card: your group\'s real survival rate and the Real figures you met', () => {
  const s = play(run(firstWoman, 'cabin-1', true), ['go:grand-staircase', 'go:boat-deck-fwd-stbd']);
  waitUntil(s, '00:30');
  play(s, ['board:7']);
  const card = endCard(s, world);
  assert.equal(card.ending.id, 'boat-7');
  assert.equal(card.group.aboard, 144);
  assert.equal(card.group.saved, 140);
  assert.equal(card.group.percent, 97);
  assert.deepEqual(card.group.et, { aboard: 143, saved: 139, percent: 97 });
  assert.ok(card.met.some((f) => f.id === 'murdoch' && /Lost/.test(f.fate)));
});

test('every citation in the game data resolves to a source with a URL', () => {
  const keys = citesIn(world);
  assert.ok(keys.size > 30);
  for (const key of keys) {
    const src = resolveCite(key, world.sources);
    assert.ok(src?.url?.startsWith('https://'), `unresolved citation: ${key}`);
  }
  assert.equal(resolveCite('US D7 Hogg', world.sources).url, 'https://www.titanicinquiry.org/USInq/AmInq07header.php');
});

test('every Real figure and every sighting carries a citation and a real place', () => {
  for (const f of world.figures) {
    assert.ok(f.cite?.length && f.fate, f.id);
    for (const s of f.sightings) {
      assert.ok(s.cite?.length, `${f.id} at ${s.place}`);
      assert.ok(world.map.places[s.place], `${f.id}: no place ${s.place}`);
      assert.ok(minuteOf(s.from) <= minuteOf(s.to) && minuteOf(s.to) <= END, `${f.id} ${s.from}-${s.to}`);
    }
  }
});

test('the Draw card: invented name, adult age, a cabin, travelling alone, and no Real figure\'s name', () => {
  const real = new Set(world.figures.flatMap((f) => f.name.split(/[ ,]+/)).filter((w) => /^[A-Z][a-z]{3,}$/.test(w)));
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const identity of [firstWoman, firstMan, thirdMan, { cls: 2, sex: 'f', age: 'adult' }, { cls: 3, sex: 'f', age: 'adult' }]) {
    for (let i = 0; i < 50; i++) {
      const card = dealCard({ identity, place: homeCabin(identity) }, names, rng);
      assert.ok(card.age >= 18 && card.age <= 65);
      assert.ok(card.cabin && card.embarked && card.classLabel);
      assert.equal(card.travelling, 'Travelling alone');
      assert.ok(!real.has(card.surname), `${card.name} shares a surname with a Real figure`);
    }
  }
});

test('the Draw card says plainly whether you are a man or a woman', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const identity of [firstWoman, firstMan, thirdMan, { cls: 3, sex: 'f', age: 'adult' }]) {
    for (let i = 0; i < 20; i++) {
      const card = dealCard({ identity, place: homeCabin(identity) }, names, rng);
      const man = identity.sex === 'm';
      assert.equal(card.sexLabel, man ? 'Man' : 'Woman');
      assert.match(card.name, man ? /^Mr / : /^(Mrs|Miss) /);
      assert.ok(card.name.startsWith(`${card.title} `) && card.name.endsWith(` ${card.surname}`));
      assert.match(card.who, man ? /-class man$/ : /-class woman$/);
    }
  }
});

test('the ship trims by the head as the clock runs, and breaks at 02:18', async () => {
  const { poseAt, BREAK_AT } = await import('../../public/games/twenty-boats/ship.js');
  let last = -1;
  for (let m = 0; m < BREAK_AT; m += 5) {
    const p = poseAt(m);
    assert.ok(!p.broken && p.angle >= last, `trim at ${m}`);
    last = p.angle;
  }
  assert.equal(BREAK_AT, minuteOf('02:18'));
  const end = poseAt(END);
  assert.ok(end.broken && end.aft.angle < 0 && end.fore.angle > 13, 'stern up, bow down');
});

test('every place reads in plain words: a description, a deck and a spot on the ship', () => {
  for (const [id, place] of Object.entries(world.map.places)) {
    assert.ok(place.about, `${id} has no about line`);
    assert.ok(['G', 'F', 'E', 'D', 'C', 'B', 'A', 'Boat'].includes(place.deck), `${id} deck ${place.deck}`);
    assert.ok(Array.isArray(place.at) && place.at.length === 2, `${id} has no spot`);
  }
});

test('every move says which way it goes', () => {
  assert.equal(wayTo(world, 'cabin-1', 'grand-staircase'), 'Up 1 deck');
  assert.equal(wayTo(world, 'grand-staircase', 'smoking-room'), 'Up 1 deck, towards the back');
  assert.equal(wayTo(world, 'boat-deck-fwd-port', 'boat-deck-fwd-stbd'), 'Across to the right side');
  assert.equal(wayTo(world, 'cabin-3-fwd', 'scotland-road'), 'Up 2 decks, towards the back');
  const s = run({ cls: 1, sex: 'f', age: 'adult' }, 'cabin-1', true);
  for (const c of sceneOf(s, world).choices.filter((x) => x.id.startsWith('go:'))) assert.ok(c.way, c.id);
});

test('third class does not know the upper ship by name until it has been there', () => {
  const s = play(run(thirdMan, 'cabin-3-fwd', true), ['go:scotland-road']);
  const toStairs = sceneOf(s, world).choices.find((c) => c.id === 'go:stairs-2');
  assert.match(toStairs.label, /^Go up \d decks?/);
  assert.equal(toStairs.way, 'You have not been this way');
  play(s, ['go:stairs-2', 'go:scotland-road']);
  assert.match(sceneOf(s, world).choices.find((c) => c.id === 'go:stairs-2').label, /second-class stairs/i);
  // First class knows its own ship.
  const first = run(firstWoman, 'cabin-1', true);
  assert.match(sceneOf(first, world).choices.find((c) => c.id === 'go:grand-staircase').label, /Grand Staircase/);
});

test('a third-class woman can go up with Steward Hart, and his group is put into the boat', () => {
  const thirdWoman = { cls: 3, sex: 'f', age: 'adult' };
  const s = run(thirdWoman, 'cabin-3-aft', true);
  waitUntil(s, '00:30');
  assert.ok(sceneOf(s, world).choices.some((c) => c.id === 'follow:hart'));
  play(s, ['follow:hart']);
  assert.equal(s.place, 'boat-deck-fwd-port');
  assert.equal(s.minute, minuteOf('00:57'));
  assert.ok(s.visited.has('grand-staircase'), 'his route counts as somewhere you have been');
  play(s, ['board:8']);
  assert.equal(s.ending, 'boat-8');
  // His second group reaches Boat 15 after it looks full to anyone else.
  const late = run(thirdWoman, 'cabin-3-aft', true);
  waitUntil(late, '01:05');
  play(late, ['follow:hart']);
  play(late, ['board:15']);
  assert.equal(late.ending, 'boat-15');
  // Men are kept back.
  const man = run(thirdMan, 'cabin-3-aft', true);
  waitUntil(man, '00:30');
  assert.ok(!sceneOf(man, world).choices.some((c) => c.id.startsWith('follow:')));
});

test('the deck plan shows boats as last seen, and counts the ones you saw go', () => {
  const s = run(firstWoman, 'smoking-room', true);
  let p = planOf(s, world);
  assert.equal(p.unseen, 20);
  assert.equal(p.left, 20);
  play(s, ['go:boat-deck-aft-stbd']);
  waitUntil(s, '01:25');
  p = planOf(s, world);
  const status = (id) => p.boats.find((b) => b.id === id).status;
  assert.equal(status('16'), 'gone');
  assert.equal(status('7'), 'unknown', 'forward boats out of sight from aft');
  assert.ok(['loading', 'full'].includes(status('9')));
  assert.equal(p.left, 20 - p.boats.filter((b) => b.status === 'gone').length);
  // Below decks nothing updates.
  play(s, ['go:smoking-room']);
  waitUntil(s, '02:00');
  assert.equal(planOf(s, world).boats.find((b) => b.id === '9').status, status('9'));
});

test('sound: at most one cue a scene, and nothing repeats while it lasts', () => {
  const at = (minute, place, sounds, lowered = []) => ({ minute, place, sounds, lowered });
  assert.equal(cueFor(at(60, 'stern', []), at(65, 'stern', ['rocket'])), 'rocket');
  assert.equal(cueFor(at(70, 'stern', ['rocket']), at(72, 'stern', ['rocket']), 70), null, 'rockets spaced out');
  assert.equal(cueFor(at(95, 'grand-staircase', ['band']), at(100, 'grand-staircase', ['band'])), null, 'the band is heard on arrival only');
  assert.equal(cueFor(at(95, 'boat-deck-fwd-port', ['band']), at(97, 'grand-staircase', ['band'])), 'band');
  assert.equal(cueFor(at(155, 'stern', ['rocket']), at(157, 'stern', ['funnel', 'parting', 'rocket'])), 'parting');
  assert.equal(cueFor(at(60, 'boat-deck-fwd-port', []), at(62, 'boat-deck-fwd-port', [], ['8'])), 'lowered');
  assert.equal(cueFor(at(62, 'boat-deck-fwd-port', [], ['8']), at(64, 'boat-deck-fwd-port', [], ['8'])), null);
  for (const b of world.beats) if (b.sound) assert.ok(CUES.includes(b.sound), `${b.from}: ${b.sound}`);
});

test('every boat has a station on the deck plan', async () => {
  const { STATIONS } = await import('../../public/games/twenty-boats/plan.js');
  for (const b of world.boats) assert.ok(STATIONS[b.id], b.id);
  assert.equal(Object.keys(STATIONS).length, 20);
});

test('no place offers two moves that read the same, known or not', () => {
  for (const cls of [1, 2, 3]) {
    for (const place of Object.keys(world.map.places)) {
      const s = run({ cls, sex: 'f', age: 'adult' }, place, true);
      s.visited.clear();
      const labels = sceneOf(s, world).choices.filter((c) => c.id.startsWith('go:')).map((c) => c.label);
      assert.equal(new Set(labels).size, labels.length, `class ${cls} at ${place}: ${labels.join(' / ')}`);
    }
  }
});

test('boats in the same state share one line', () => {
  const s = run(firstWoman, 'smoking-room', true);
  play(s, ['go:boat-deck-aft-port']);
  waitUntil(s, '00:51');
  const lines = sceneOf(s, world).lines.filter((l) => /not ready/.test(l));
  assert.deepEqual(lines, ['Boats 16, 14, 12 and 10 are not ready yet: seamen are still uncovering them and swinging them out. No one is getting in.']);
});

test('every choice opens the next scene with a line saying what it did', () => {
  const outcome = (state, id, rng = never) => {
    play(state, [id], rng);
    return sceneOf(state, world).outcome;
  };
  const s = run(firstMan, 'cabin-1', false);
  assert.equal(sceneOf(s, world).outcome, null, 'nothing done yet');
  assert.match(outcome(s, 'wake'), /You get up/);
  assert.match(outcome(s, 'dress'), /^You dress warmly.*A while passes\.$/);
  assert.match(outcome(s, 'lifejacket'), /^You tie on your lifebelt\. A few minutes pass\.$/);
  assert.match(outcome(s, 'wait'), /^You stay where you are and wait\. A while passes\.$/);
  assert.match(outcome(s, 'go:grand-staircase'), /^You make your way to the Grand Staircase\. A few minutes pass\.$/);
  assert.match(outcome(s, 'go:cabin-1'), /^You make your way back to your cabin/);
  assert.match(outcome(s, 'sleep'), /^You close your eyes/);

  // A refusal is the outcome, not a line of the scene.
  const m = run(firstMan, 'smoking-room', true);
  play(m, ['go:grand-staircase', 'go:boat-deck-fwd-port']);
  waitUntil(m, '00:50');
  const refused = outcome(m, 'board:8');
  assert.match(refused, /turns you away from Boat 8/);
  assert.ok(!sceneOf(m, world).lines.some((l) => /turns you away/.test(l)));

  // The steward's knock that wakes you is the outcome of sleeping.
  const sleeper = run(firstWoman, 'cabin-1', false);
  for (let i = 0; i < 4 && !sleeper.awake; i++) choose(sleeper, world, 'sleep', never);
  assert.match(sceneOf(sleeper, world).outcome, /steward knocks/);
});

test('a sighting reads in full once, then as a short line', () => {
  const s = play(run(firstWoman, 'cabin-1', true), ['go:grand-staircase']);
  waitUntil(s, '00:15');
  const first = sceneOf(s, world).figures.find((f) => f.id === 'andrews');
  assert.ok(first && !first.again, 'Andrews in full on first sight');
  play(s, ['wait']);
  const again = sceneOf(s, world).figures.find((f) => f.id === 'andrews');
  assert.ok(again?.again, 'Andrews again');
  assert.notEqual(again.text, first.text);
  assert.equal(again.text, 'Thomas Andrews is still here.');
});
