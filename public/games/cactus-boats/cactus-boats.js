// Cactus Boats: an endless broadside shooter on a single-screen sea whose
// edges wrap. You sail a little wooden boat with a cactus for a mast, enemy
// patrols sail in from the edges, more and tougher the longer you last, and
// you fight them with broadsides. Sooner or later you're sunk; your Score is
// time survived plus boats sunk.
//
// mountCactusBoats(container, { homeHref, onEvent, leaderboard, seed }) -> destroy
//   homeHref    where the jspratt.dev link in the corner goes; without it the link is left out
//   onEvent     gets { event: 'play' } when a Play starts, and
//               { event: 'finish', ending: 'sunk', survived: false } when it's sunk
//   leaderboard { start, submit, top }, backed by the page (play.js); without it there's no board
//   seed        a fixed seed for the first Play's sea, else a random one
//
// A visit goes title screen → Play → Sunk! → Play → … The first key or tap
// starts; after being sunk, one key or tap goes again. The best Score on this
// browser is kept in localStorage, as a convenience: without it the game
// still plays, it just forgets.
//
// The Leaderboard: each Play asks leaderboard.start() for a run id. When
// you're sunk, a Score that makes the top 10 asks for Initials, arcade style
// (A–Z, remembered for next time, Esc or Skip to skip), and sends them with
// leaderboard.submit(); then the board shows with your entry highlighted, or
// how far off it you were. The title screen shows the board too. When the
// board can't be reached, there's no run (a preview), or the Worker refuses
// the Score (rude Initials, an implausible Score), the game says so ("not
// accepted" for a refusal) and carries on.
//
// The rules live in sim.js (headless, seeded, tested in tests/cactus-boats/),
// the Score in score.js, keys and touch in input.js, and the picture in
// draw.js. This module runs the fixed 1/60 s loop, the HUD and the screens,
// and pauses on P, blur and a hidden tab. Only stepped time is survival time,
// so nothing paused (or on a screen) counts.

import { newRun, step, summary, isSunk, STEP, ANCHOR, HALF, FULL } from './sim.js?v=2026-11-21-v6';
import { createInput } from './input.js?v=2026-11-21-v6';
import { createView, fitScreen } from './draw.js?v=2026-11-21-v6';

// Matches the ?v= on the imports above (and in the other modules and
// play.js). Bump them together when a deploy must beat a stale browser cache:
// there's no build step to hash the filenames.
const CACHE_BUST = '2026-11-21-v6';

const SAIL_NAMES = { [ANCHOR]: 'Anchor', [HALF]: 'Half', [FULL]: 'Full' };
const BEST_KEY = 'cactus-boats:best';
const INITIALS_KEY = 'cactus-boats:initials';
const BOARD_SIZE = 10;
// After being sunk, how long (ms) before a key or tap goes again, so a
// volley you were already firing doesn't skip the Sunk! screen.
const SETTLE_MS = 900;

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function randomSeed() {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  } catch {
    return Date.now() >>> 0;
  }
}

function readBest() {
  try {
    const n = Number.parseInt(localStorage.getItem(BEST_KEY) ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveBest(score) {
  try {
    localStorage.setItem(BEST_KEY, String(score));
  } catch {
    // Storage is a nicety; the best Score just isn't remembered.
  }
}

function readInitials() {
  try {
    const saved = localStorage.getItem(INITIALS_KEY) ?? '';
    return /^[A-Z]{3}$/.test(saved) ? saved : null;
  } catch {
    return null;
  }
}

function saveInitials(initials) {
  try {
    localStorage.setItem(INITIALS_KEY, initials);
  } catch {
    // As above: next time just starts from AAA.
  }
}

/** Whether `score` would get onto the board `top` (null when it couldn't be read: worth asking). */
function makesBoard(top, score) {
  if (score <= 0) return false;
  if (!top) return true;
  return top.length < BOARD_SIZE || score > top[BOARD_SIZE - 1].score;
}

/** How many more points `score` needed to get onto a full board. */
const pointsOff = (top, score) => (top?.length >= BOARD_SIZE ? top[BOARD_SIZE - 1].score - score + 1 : 0);

const ordinal = (n) => {
  const v = n % 100;
  return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th');
};

const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const points = (n) => n.toLocaleString('en-GB');

export async function mountCactusBoats(container, opts = {}) {
  const { homeHref, onEvent, leaderboard } = opts;
  // The stylesheet goes in first and the game waits for it, so the first frame
  // is never unstyled. A stylesheet that fails still lets the game run.
  const link = h('link', { rel: 'stylesheet', href: new URL(`./cactus-boats.css?v=${CACHE_BUST}`, import.meta.url).href });
  const styled = new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
  });
  container.append(link);
  await styled;

  const screen = h('canvas', { class: 'cb-screen', 'aria-label': 'Cactus Boats: a cactus boat on a wrapping sea' });
  const stage = h('div', { class: 'cb-stage' }, screen);
  const hullFill = h('span', { class: 'cb-hull-fill' });
  const sails = [ANCHOR, HALF, FULL].map((s) => h('span', { class: 'cb-sail', text: SAIL_NAMES[s] }));
  const timeShown = h('span', { class: 'cb-time' });
  const sinksShown = h('span', { class: 'cb-sinks' });
  const scoreShown = h('span', { class: 'cb-score' });
  const hud = h('div', { class: 'cb-hud', 'aria-hidden': 'true', hidden: true },
    h('span', { class: 'cb-hull' }, hullFill),
    h('span', { class: 'cb-sails' }, ...sails),
    timeShown,
    sinksShown,
    scoreShown,
  );
  const shelf = homeHref ? h('a', { class: 'cb-shelf', href: homeHref, text: 'jspratt.dev' }) : null;
  const hint = h('p', { class: 'cb-hint', hidden: true });
  const message = h('div', { class: 'cb-msg', role: 'status' });
  const stickBase = h('span', { class: 'cb-stick', hidden: true });
  const stickKnob = h('span', { class: 'cb-knob', hidden: true });
  const root = h('div', { class: 'cb' }, stage, hud, shelf, hint, stickBase, stickKnob, message);
  container.append(root);

  const view = createView(screen);
  const dpr = () => window.devicePixelRatio || 1;
  const box = stage.getBoundingClientRect();
  const { width } = fitScreen(box.width, box.height, dpr());
  let state = newRun(opts.seed ?? randomSeed(), { width });
  view.fit(box.width, box.height, dpr(), state.sea.width);
  const resize = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    view.fit(r.width, r.height, dpr(), state.sea.width);
    showHint();
  });
  resize.observe(stage);

  // 'title' → 'playing' → 'sunk' → 'playing' … Only 'playing' steps the sea.
  let mode = 'title';
  let paused = false;
  let help = true;
  let best = readBest();
  let sunkAt = 0;
  let frameAt = 0;
  // The board as last read: undefined while loading, null when it can't be reached.
  let top;
  // This Play's run id, once leaderboard.start() answers (null: none, so no sending).
  let run = Promise.resolve(null);
  // Touch wording from the start on a phone, and from the first touch anywhere else.
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touchy = () => coarse || input.touched;

  function show(...children) {
    const shown = children.filter(Boolean);
    message.hidden = shown.length === 0;
    message.replaceChildren(...shown);
  }

  function showTitle() {
    const touch = touchy();
    const how = touch
      ? [['Drag left', 'steer'], ['Pull further', 'more sail'], ['Tap right', 'fire a broadside']]
      : [['A D', 'turn'], ['W S', 'sail: anchor, half, full'], ['Space', 'fire the side that bears'], ['J L', 'fire port, starboard'], ['P', 'pause']];
    show(
      h('strong', { class: 'cb-title', text: 'Cactus Boats' }),
      h('span', { text: 'Survive the patrols. Sink what you can.' }),
      h('div', { class: 'cb-split' },
        h('div', { class: 'cb-panel' },
          h('dl', { class: 'cb-how' }, ...how.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
          best ? h('span', { class: 'cb-best', text: `Your best ${points(best)}` }) : null,
        ),
        boardPanel(top === undefined ? 'Reading the board…' : top === null ? 'The Leaderboard can’t be reached right now.' : null),
      ),
      h('span', { class: 'cb-go', text: touch ? 'Tap to set sail' : 'Press any key to set sail' }),
    );
  }

  /** The top 10, `mine` (an index) highlighted, with a line under it; nothing without a Leaderboard. */
  function boardPanel(note, mine = -1) {
    if (!leaderboard) return null;
    const rows = top?.length
      ? h('ol', { class: 'cb-board' }, ...top.map((e, i) =>
        h('li', { class: i === mine ? 'cb-mine' : null },
          h('span', { text: String(i + 1) }),
          h('span', { class: 'cb-ini', text: e.initials }),
          h('span', { class: 'cb-pts', text: points(e.score) }),
          h('span', { text: clock(e.survivedMs) }),
          h('span', { text: `${e.sinks} sunk` }),
        )))
      : top ? h('span', { class: 'cb-note', text: 'No Scores yet. Be the first.' }) : null;
    return h('div', { class: 'cb-panel' },
      h('span', { class: 'cb-head', text: 'Leaderboard' }),
      rows,
      note ? h('span', { class: 'cb-note', text: note }) : null,
    );
  }

  async function readBoard() {
    if (!leaderboard) return;
    let read = null;
    try {
      read = await leaderboard.top();
    } catch {
      // Unreachable: said so on the title screen.
    }
    top = Array.isArray(read) ? read : null;
    if (mode === 'title') showTitle();
  }

  // The Play just sunk, its tally, and whether it was a new best.
  let sunk = null;

  /** The Sunk! screen: the tally, then the Leaderboard part (`board`), then how to go again. */
  function showSunk(board, go = touchy() ? 'Tap to sail again' : 'Press any key to sail again') {
    const { survivedMs, sinks, score, record } = sunk;
    show(
      h('strong', { text: 'Sunk!' }),
      h('div', { class: 'cb-split' },
        h('div', {},
          h('dl', { class: 'cb-tally' },
            h('dt', { text: 'Survived' }), h('dd', { text: clock(survivedMs) }),
            h('dt', { text: 'Boats sunk' }), h('dd', { text: String(sinks) }),
            h('dt', { text: 'Score' }), h('dd', { text: points(score) }),
          ),
          h('span', { class: 'cb-best', text: record ? 'A new best!' : `Your best ${points(best)}` }),
        ),
        board,
      ),
      go ? h('span', { class: 'cb-go', text: go }) : null,
    );
  }

  /** Being sunk: the tally at once, then, once the run id is in, Initials or the board. */
  async function onSunk() {
    const tally = summary(state);
    const record = tally.score > best;
    if (record) {
      best = tally.score;
      saveBest(best);
    }
    const play = (sunk = { ...tally, record });
    if (!leaderboard) return showSunk(null);
    showSunk(boardPanel('…'));
    const id = await run;
    if (sunk !== play || mode !== 'sunk') return; // already sailing again
    if (id && makesBoard(top, play.score)) return askInitials(id);
    const off = pointsOff(top, play.score);
    showSunk(boardPanel(
      !id
        ? top === null ? 'The Leaderboard can’t be reached, so this Score stays here.' : 'Scores are only kept on jspratt.dev, so this one wasn’t sent.'
        : play.score <= 0 ? 'Score some points to get on the board.' : `${points(off)} ${off === 1 ? 'point' : 'points'} off the board.`,
    ));
  }

  /**
   * Arcade-style Initials: type letters (or ↑ ↓ through them, ← → between
   * them, or tap ▲ ▼), Enter or Send to send, Esc or Skip to skip. The
   * last Initials used start it off, so sending again is one key.
   */
  function askInitials(id) {
    mode = 'initials';
    const play = sunk;
    const letters = (readInitials() ?? 'AAA').split('');
    let at = 0;
    let sending = false;
    const keys = new AbortController();
    const spin = (d) => {
      letters[at] = String.fromCharCode(((letters[at].charCodeAt(0) - 65 + d + 26) % 26) + 65);
    };
    const button = (props, fn) => {
      const b = h('button', { type: 'button', ...props });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (sending) return;
        fn();
        render();
      });
      return b;
    };
    const slots = letters.map((_, i) => {
      const ch = button({ class: 'cb-ch', 'aria-label': `Letter ${i + 1}` }, () => (at = i));
      return {
        ch,
        box: h('span', { class: 'cb-slot' },
          button({ class: 'cb-spin', 'aria-label': `Letter ${i + 1}: next`, text: '▲' }, () => ((at = i), spin(1))),
          ch,
          button({ class: 'cb-spin', 'aria-label': `Letter ${i + 1}: previous`, text: '▼' }, () => ((at = i), spin(-1))),
        ),
      };
    });
    function render() {
      slots.forEach(({ ch }, i) => {
        ch.textContent = letters[i];
        ch.classList.toggle('cb-at', i === at);
      });
    }
    render();
    const entry = h('div', { class: 'cb-panel cb-entry' },
      h('span', { class: 'cb-head', text: 'You made the board!' }),
      h('span', { class: 'cb-note', text: 'Your Initials' }),
      h('span', { class: 'cb-slots' }, ...slots.map((s) => s.box)),
      h('span', { class: 'cb-acts' },
        button({ class: 'cb-act', text: 'Send' }, () => send()),
        button({ class: 'cb-act cb-quiet', text: 'Skip' }, () => skip()),
      ),
    );
    showSunk(entry, touchy() ? 'Tap ▲ ▼ to choose' : 'Type your Initials · Enter to send · Esc to skip');

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || sending) return;
      if (/^[a-z]$/i.test(e.key)) {
        letters[at] = e.key.toUpperCase();
        at = Math.min(2, at + 1);
      } else if (e.key === 'Backspace' || e.key === 'ArrowLeft') at = Math.max(0, at - 1);
      else if (e.key === 'ArrowRight') at = Math.min(2, at + 1);
      else if (e.key === 'ArrowUp') spin(1);
      else if (e.key === 'ArrowDown') spin(-1);
      else if (e.key === 'Enter') send();
      else if (e.key === 'Escape') skip();
      else return;
      e.preventDefault();
      render();
    }, { signal: keys.signal });

    // Back to the Sunk! screen, ready for one key or tap to go again.
    function finish(board) {
      keys.abort();
      mode = 'sunk';
      sunkAt = frameAt;
      showSunk(board);
    }
    function skip() {
      finish(boardPanel('Not sent.'));
    }
    async function send() {
      if (sending) return;
      sending = true;
      const initials = letters.join('');
      saveInitials(initials);
      showSunk(boardPanel('Sending…'), null);
      let sent = null;
      try {
        sent = await leaderboard.submit({ run: id, initials, survivedMs: play.survivedMs, sinks: play.sinks, score: play.score });
      } catch {
        // Unreachable: said so below.
      }
      if (sunk !== play) return;
      if (sent?.refused) {
        finish(boardPanel('Your Score was not accepted.'));
        return;
      }
      if (!sent || !Array.isArray(sent.top)) {
        finish(boardPanel('Your Score couldn’t be sent: the Leaderboard can’t be reached right now.'));
        return;
      }
      top = sent.top;
      const mine = sent.rank <= BOARD_SIZE ? sent.rank - 1 : -1;
      finish(boardPanel(mine >= 0
        ? `${initials}, you’re ${ordinal(sent.rank)}!`
        : `${ordinal(sent.rank)}: ${points(pointsOff(top, play.score))} points off the board.`, mine));
    }
  }

  function setPaused(on) {
    if (mode !== 'playing') return;
    paused = on;
    if (on) show(h('strong', { text: 'Paused' }), h('span', { text: touchy() ? 'Tap to carry on.' : 'Press P or any key to carry on.' }));
    else show();
  }

  function setSail() {
    if (mode === 'sunk') state = newRun(randomSeed(), { width: state.sea.width });
    if (leaderboard) {
      run = Promise.resolve()
        .then(() => leaderboard.start())
        .then((started) => (Number.isInteger(started?.run) ? started.run : null), () => null);
      readBoard(); // fresh, to know on being sunk whether the Score makes it
    }
    mode = 'playing';
    paused = false;
    hud.hidden = false;
    hint.hidden = false;
    show();
    onEvent?.({ event: 'play' });
  }

  const input = createInput(stage, {
    onPause: (away) => setPaused(away ? true : !paused),
    onWake: () => {
      // The key or tap that changes screens does nothing else.
      if (mode === 'title') {
        setSail();
        return true;
      }
      if (mode === 'sunk') {
        if (frameAt - sunkAt >= SETTLE_MS) setSail();
        return true;
      }
      if (mode === 'initials') return true; // the Initials take the keys
      if (!paused) return false;
      setPaused(false);
      return true;
    },
  });
  showTitle();
  readBoard();
  if (document.hidden) setPaused(true);

  function showHint() {
    const tall = window.innerHeight > window.innerWidth;
    hint.textContent = touchy()
      ? tall ? 'Turn your phone sideways for a bigger sea' : 'Drag left to steer · tap right to fire'
      : 'A D turn · W S sail · Space fire · J L port stbd · P pause';
  }
  showHint();

  let last = performance.now();
  let acc = 0;
  let frame = 0;
  let shown = {};
  let wasTouched = false;
  function tick(now) {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frameAt = now;
    if (mode !== 'playing' || paused) acc = 0;
    else {
      // Read the controls once a frame that steps, so a shot fires on its first tick only.
      acc += dt;
      let intent = acc >= STEP ? input.intent(state.boat.h) : { turn: 0, sail: input.sail, fire: null };
      while (acc >= STEP && !isSunk(state)) {
        step(state, intent, STEP);
        intent = { ...intent, fire: null };
        acc -= STEP;
      }
      if (help && state.elapsed > 1 && (state.boat.spd > 0 || intent.turn)) {
        help = false;
        setTimeout(() => hint.classList.add('cb-hint-gone'), 6000);
      }
      if (isSunk(state)) {
        mode = 'sunk';
        sunkAt = now;
        hint.hidden = true;
        onSunk();
        // Every Play ends sunk; the Score is the interesting part.
        onEvent?.({ event: 'finish', ending: 'sunk', survived: false });
      }
    }
    view.draw(state);

    // The HUD, touched only when something on it changes.
    const { survivedMs, sinks, score } = summary(state);
    const next = { hull: Math.ceil(state.boat.hp), time: clock(survivedMs), sinks, score, sail: input.sail };
    if (next.hull !== shown.hull) hullFill.style.width = `${(100 * state.boat.hp) / state.boat.maxHp}%`;
    if (next.time !== shown.time) timeShown.textContent = next.time;
    if (next.sinks !== shown.sinks) sinksShown.textContent = `Sunk ${sinks}`;
    if (next.score !== shown.score) scoreShown.textContent = points(score);
    if (next.sail !== shown.sail) sails.forEach((s, i) => s.classList.toggle('cb-on', i === input.sail));
    shown = next;
    if (input.touched !== wasTouched) {
      wasTouched = input.touched;
      showHint();
      if (mode === 'title') showTitle();
    }
    const s = input.stick;
    stickBase.hidden = stickKnob.hidden = !s;
    if (s) {
      const dx = s.x - s.ox;
      const dy = s.y - s.oy;
      const k = Math.min(1, 48 / (Math.hypot(dx, dy) || 1));
      stickBase.style.transform = `translate(${s.ox}px, ${s.oy}px)`;
      stickKnob.style.transform = `translate(${s.ox + dx * k}px, ${s.oy + dy * k}px)`;
    }
  }
  frame = requestAnimationFrame(tick);

  return function destroy() {
    cancelAnimationFrame(frame);
    resize.disconnect();
    input.destroy();
    root.remove();
    link.remove();
  };
}
