// Twenty Boats — the night of 14–15 April 1912, as a randomly drawn
// passenger. Text-first DOM in period style, a clock, and one ship
// silhouette over a deck plan of the boats, with short quiet sound cues
// (M mutes).
// mount(container, { onRequestClose }) -> destroy. onRequestClose runs when
// the player presses the jspratt.dev button in the corner.
//
// Screens: title (collected Endings) → Draw card → scenes → Ending and End
// card. Every run state lives inside mount, and a new Draw (or a Relive of
// the same card) makes a fresh run, so nothing carries from one run (or one
// mount) to the next.

import { drawIdentity } from './draw.js?v=2026-10-07-v1';
import { dealCard } from './cards.js?v=2026-10-07-v1';
import { newRun, relive, sceneOf, choose, endings, endCard, planOf } from './story.js?v=2026-10-07-v1';
import { sourceList } from './sources.js?v=2026-10-07-v1';
import { createShip } from './ship.js?v=2026-10-07-v1';
import { loadCollection, addToCollection } from './collection.js?v=2026-10-07-v1';
import { createPlan } from './plan.js?v=2026-10-07-v1';
import { createSound, cueFor } from './sound.js?v=2026-10-07-v1';

// Matches the ?v= on the imports above (and in ship.js and play.js). Bump them
// together when a deploy must beat a stale browser cache: there's no build
// step to hash the filenames.
const CACHE_BUST = '2026-10-07-v1';

const MUTE_KEY = 'twenty-boats:muted';
const CLASS_WORD = { 1: 'first', 2: 'second', 3: 'third' };
const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd' };

const DATA = ['map', 'boats', 'figures', 'survival', 'sources', 'names', 'beats'];

async function loadWorld() {
  const parts = await Promise.all(
    DATA.map(async (name) => {
      const res = await fetch(new URL(`./data/${name}.json?v=${CACHE_BUST}`, import.meta.url));
      if (!res.ok) throw new Error(`twenty-boats: ${name}.json ${res.status}`);
      return res.json();
    }),
  );
  const [map, boats, figures, survival, sources, names, beats] = parts;
  return {
    world: { map, boats: boats.boats, figures: figures.figures, groups: survival.groups, sources, beats: beats.beats },
    names,
  };
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

// Mute is a player preference, not run state, so it outlives a remount.
function readMuted(storage) {
  try {
    return storage?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(storage, on) {
  try {
    storage?.setItem(MUTE_KEY, on ? '1' : '0');
  } catch {
    // Not remembered; it still applies for this visit.
  }
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function mountTwentyBoats(container, opts = {}) {
  const { onRequestClose } = opts;
  const { world, names } = await loadWorld();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const storage = safeStorage();
  const allEndings = endings(world);
  const collected = loadCollection(storage, new Set(allEndings.map((e) => e.id)));
  const sources = sourceList(world);

  const link = h('link', { rel: 'stylesheet', href: new URL(`./twenty-boats.css?v=${CACHE_BUST}`, import.meta.url).href });
  const root = h('div', { class: 'tb' });
  const page = h('main', { class: 'tb-page', tabindex: '-1', 'aria-live': 'polite' });
  const sound = createSound({ muted: readMuted(storage) });
  const soundBtn = h('button', { type: 'button', class: 'tb-sound', onclick: () => toggleMute() });
  const shelf = h('button', { type: 'button', class: 'tb-shelf', text: 'jspratt.dev', onclick: () => onRequestClose?.() });
  root.append(h('div', { class: 'tb-corner' }, soundBtn, shelf), page);
  showMuted();
  container.append(link, root);

  const ship = createShip(world.map);
  const plan = createPlan(world.boats);
  const planCaption = h('p', { class: 'tb-plan-caption' });
  const planFigure = h('figure', { class: 'tb-plan-fig' },
    plan.svg,
    h('figcaption', {},
      planCaption,
      h('ul', { class: 'tb-legend', 'aria-hidden': 'true' },
        [['loading', 'Loading'], ['turned', 'Turned away'], ['full', 'Full'], ['hanging', 'Not ready'], ['gone', 'Gone'], ['unknown', 'Not seen']].map(([k, t]) =>
          h('li', {}, h('span', { class: 'tb-key-boat', 'data-status': k }), t)))));
  let run = null;
  // The last scene shown, for working out which sound a new one plays.
  let lastScene = null;
  let lastRocket = -Infinity;
  let heard = null; // the run whose Ending has been played
  let keyChoices = [];
  // When the current scene went up. A tap this soon after is a second tap
  // meant for the scene before, which would land on a renumbered choice.
  let shownAt = -Infinity;
  const TAP_GUARD = 350;

  function screen(...children) {
    keyChoices = [];
    ship.stop();
    page.className = 'tb-page';
    page.replaceChildren(...children.filter((c) => c !== null && c !== undefined));
    page.scrollTop = 0;
    root.scrollTop = 0;
    page.focus({ preventScroll: true });
  }

  function button(label, onclick, cls = 'tb-btn') {
    return h('button', { type: 'button', class: cls, onclick }, label);
  }

  // --- title ---

  function showTitle() {
    run = null;
    const boats = allEndings.filter((e) => e.boat);
    const others = allEndings.filter((e) => !e.boat);
    const got = boats.filter((e) => collected.has(e.id)).length;
    const tile = (e) =>
      h(
        'li',
        { class: `tb-tile${collected.has(e.id) ? ' tb-tile--got' : ''}`, title: collected.has(e.id) ? e.title : 'Not yet reached' },
        h('span', { class: 'tb-tile-name', text: e.boat ?? '·' }),
        h('span', { class: 'tb-sr', text: `${e.title}: ${collected.has(e.id) ? 'reached' : 'not yet reached'}` }),
      );
    screen(
      h('header', { class: 'tb-masthead' },
        h('p', { class: 'tb-kicker', text: 'Titanic · 14–15 April 1912' }),
        h('h1', { class: 'tb-title', text: 'Twenty Boats' }),
        h('p', { class: 'tb-lede', text: '23:40. Twenty boats, 2,200 aboard. Who you are decides most of it; where you stand decides the rest.' }),
      ),
      h('div', { class: 'tb-actions' }, button('Draw a passenger', showDraw, 'tb-btn tb-btn--main'), button('Sources', showSources)),
      h('section', { class: 'tb-collection', 'aria-labelledby': 'tb-coll-h' },
        h('h2', { id: 'tb-coll-h', text: `The boats you have reached: ${got} of ${boats.length}` }),
        h('ol', { class: 'tb-tiles' }, boats.map(tile)),
        h('h3', { text: 'Other Endings' }),
        h('ul', { class: 'tb-others' }, others.map((e) =>
          h('li', { class: collected.has(e.id) ? 'tb-got' : '' }, collected.has(e.id) ? e.title : 'Not yet reached'))),
      ),
      h('p', { class: 'tb-fine', text: 'Every passenger you play is invented. Everyone else you meet was aboard, and does what the record says they did.' }),
    );
  }

  // --- Draw card ---

  function showDraw() {
    const draw = drawIdentity(world.groups, Math.random);
    const card = dealCard(draw, names, Math.random);
    run = newRun(draw, card, Math.random);
    lastScene = null;
    lastRocket = -Infinity;
    sound.deal();
    const row = (k, v) => [h('dt', { text: k }), h('dd', { text: v })];
    screen(
      h('article', { class: 'tb-card' },
        h('p', { class: 'tb-kicker', text: 'Passenger' }),
        h('h1', { class: 'tb-card-name', text: card.name }),
        h('dl', {},
          row('Sex', card.sexLabel),
          row('Age', String(card.age)),
          row('Class', card.classLabel),
          row('Cabin', card.cabin),
          row('Embarked', card.embarked),
          row('', card.travelling)),
      ),
      h('p', { class: 'tb-lede', text: draw.awake ? 'You are still up.' : 'You are asleep.' }),
      h('div', { class: 'tb-actions' }, button('Sunday, 14 April, 23:40', () => showScene({ animate: false }), 'tb-btn tb-btn--main')),
    );
  }

  // --- scenes ---

  function showScene({ animate = !reduceMotion } = {}) {
    if (run.ending) return showEnding();
    const scene = sceneOf(run, world);
    const flags = [run.flags.has('lifejacket') && 'Lifebelt on', run.flags.has('dressed') && 'Dressed warmly'].filter(Boolean);
    const list = h('ol', { class: 'tb-choices' },
      scene.choices.map((c, i) =>
        h('li', {},
          h('button', { type: 'button', class: 'tb-choice', onclick: () => pick(c.id) },
            h('span', { class: 'tb-key', 'aria-hidden': 'true', text: i < 9 ? String(i + 1) : '' }),
            h('span', { class: 'tb-choice-label', text: c.label }),
            h('span', { class: 'tb-cost', text: c.cost }),
            c.way ? h('span', { class: 'tb-way', text: c.way }) : null,
            c.note ? h('span', { class: 'tb-note', text: c.note }) : null))));
    // Where you are stays in view (pinned) while you read and choose. On
    // phones only the clock and the ship are pinned; the plan follows the
    // choices.
    const where = h('div', { class: 'tb-scene-where' },
      h('div', { class: 'tb-pin' },
        h('header', { class: 'tb-bar' },
          h('p', { class: 'tb-clock', 'aria-label': `Time ${scene.clock}`, text: scene.clock }),
          h('div', { class: 'tb-bar-right' },
            h('p', { class: 'tb-where', text: scene.awake ? scene.placeName : `${scene.placeName}, asleep` }),
            h('p', { class: 'tb-who', text: `${run.card.title} ${run.card.surname} · ${run.card.who}` }))),
        ship.svg),
      planFigure);
    const what = h('div', { class: 'tb-scene-what' },
      scene.outcome ? h('p', { class: 'tb-outcome', role: 'status', text: scene.outcome }) : null,
      scene.awake && scene.about ? h('p', { class: 'tb-about', text: scene.about }) : null,
      h('section', { class: 'tb-text' },
        scene.lines.map((t) => h('p', { text: t })),
        scene.figures.map((f) => h('p', { class: f.again ? 'tb-figure tb-figure--again' : 'tb-figure' }, f.text, f.secondary ? h('span', { class: 'tb-secondary', text: ' (secondary account)' }) : null)),
        !scene.awake && !scene.lines.length ? h('p', { text: run.minute === 0 ? 'Something wakes you: a jar, a long shudder somewhere below, then quiet.' : 'You lie still in the dark.' }) : null),
      list,
      flags.length ? h('p', { class: 'tb-flags', text: flags.join(' · ') }) : null);
    screen(h('div', { class: 'tb-scene' }, where, what));
    page.classList.add('tb-page--scene');
    keyChoices = scene.choices;
    shownAt = performance.now();
    ship.show(run.minute, run.place, { animate });
    showPlan();
    playCue(scene);
  }

  function showPlan() {
    const p = planOf(run, world);
    const where = p.you.deck === 'Boat' ? 'You are on the boat deck.' : `You are on ${p.you.deck} deck, below the boats.`;
    const unseen = p.unseen ? ` ${p.unseen} you have not seen yet.` : '';
    planCaption.textContent = `${where} Boats left, as far as you know: ${p.left} of ${p.boats.length}.${unseen}`;
    plan.show(p, world.map);
  }

  function playCue(scene) {
    if (!lastScene && run.minute === 0) sound.world('grind', { asleep: !run.awake });
    const cue = lastScene ? cueFor(lastScene, scene, lastRocket) : null;
    if (cue === 'rocket') lastRocket = scene.minute;
    if (cue) sound.world(cue);
    lastScene = scene;
  }

  function pick(id) {
    if (performance.now() - shownAt < TAP_GUARD) return;
    sound.click();
    choose(run, world, id, Math.random);
    if (id.startsWith('board:') && !run.ending) sound.refused();
    showScene();
  }

  // --- Ending and End card ---

  // Live the same night again: same card and start, fresh chance.
  function liveAgain() {
    run = relive(run, Math.random);
    lastScene = null;
    lastRocket = -Infinity;
    showScene({ animate: false });
  }

  function showEnding() {
    const card = endCard(run, world);
    addToCollection(storage, collected, card.ending.id);
    // Once per run: coming back from Sources is silent.
    if (heard !== run) sound.ending(card.ending.id);
    heard = run;
    const g = card.group;
    const who = `${CLASS_WORD[run.identity.cls]}-class ${run.identity.sex === 'f' ? 'women' : 'men'}`;
    const et = g.et && g.et.percent !== g.percent ? `A modern recount of the manifest (Encyclopedia Titanica) gives ${g.et.saved} of ${g.et.aboard}, ${g.et.percent}%.` : g.et ? `A modern recount gives ${g.et.saved} of ${g.et.aboard}: the same ${g.et.percent}%.` : '';
    screen(
      h('header', { class: 'tb-bar' },
        h('p', { class: 'tb-clock', text: sceneOf(run, world).clock }),
        h('p', { class: 'tb-where', text: run.card.name })),
      ship.svg,
      h('article', { class: 'tb-ending' },
        h('p', { class: 'tb-kicker', text: card.survived ? 'You lived' : 'You did not live' }),
        h('h1', { class: 'tb-title', text: card.ending.title }),
        h('p', { text: card.ending.text })),
      h('div', { class: 'tb-stack' },
        button('Live this night again', liveAgain, 'tb-btn tb-btn--main'),
        button('Draw again', showDraw, 'tb-btn tb-btn--main')),
      h('section', { class: 'tb-strip', 'aria-labelledby': 'tb-strip-h' },
        h('p', { id: 'tb-strip-h', class: 'tb-rate' }, h('strong', { text: `${g.percent}%` }), ` of ${who} were saved.`),
        h('ol', { class: 'tb-groups', 'aria-label': 'Adults saved, by class and sex, by the British inquiry\'s count' },
          card.strip.map((r) =>
            h('li', { class: r.mine ? 'tb-group tb-group--mine' : 'tb-group' },
              h('span', { class: 'tb-group-pct', text: `${r.percent}%` }),
              h('span', { class: 'tb-group-label', text: `${ORDINAL[r.cls]} class ${r.sex === 'f' ? 'women' : 'men'}` }),
              r.mine ? h('span', { class: 'tb-sr', text: ' (your group)' }) : null)))),
      h('details', { class: 'tb-more' },
        h('summary', { text: 'The count, and the people you saw' }),
        h('p', { class: 'tb-foot', text: `${g.saved} of ${g.aboard} adult ${who} were saved, by the British inquiry's count.${et ? ` ${et}` : ''}` }),
        card.met.length
          ? [h('h3', { text: 'The people you saw' }), h('ul', { class: 'tb-met' }, card.met.map((f) => h('li', {}, h('strong', { text: f.name }), ` — ${f.fate}`)))]
          : h('p', { class: 'tb-foot', text: 'You met none of the people the record names.' })),
      h('p', { class: 'tb-links' },
        button('Sources', showSources, 'tb-link'),
        ' · ',
        button('Title', showTitle, 'tb-link')),
    );
    // The ship's last pose: where she is when your night closes.
    ship.show(run.minute, null, { animate: false });
  }

  // --- Sources ---

  function showSources() {
    const back = run?.ending ? showEnding : showTitle;
    screen(
      h('h1', { class: 'tb-title', text: 'Sources' }),
      h('p', { text: 'Every boat, flood, barrier, survival figure and person in the game carries a citation to one of these. Inquiry testimony is grouped by day; question numbers are in the game\'s data files.' }),
      h('ul', { class: 'tb-sources' }, sources.map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title })))),
      h('p', { class: 'tb-fine', text: 'Not affiliated with any film, exhibition or shipping line.' }),
      h('div', { class: 'tb-actions' }, button('Back', back)),
    );
  }

  function showMuted() {
    soundBtn.textContent = sound.muted ? 'Sound off' : 'Sound on';
    soundBtn.setAttribute('aria-pressed', String(!sound.muted));
  }

  function toggleMute() {
    sound.setMuted(!sound.muted);
    writeMuted(storage, sound.muted);
    showMuted();
    if (!sound.muted) sound.click();
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleMute();
      return;
    }
    const n = Number(e.key);
    if (run && !run.ending && n >= 1 && n <= 9 && keyChoices[n - 1]) {
      e.preventDefault();
      pick(keyChoices[n - 1].id);
    }
  }
  window.addEventListener('keydown', onKey);

  showTitle();

  return function destroy() {
    ship.stop();
    sound.close();
    window.removeEventListener('keydown', onKey);
    root.remove();
    link.remove();
    run = null;
  };
}
