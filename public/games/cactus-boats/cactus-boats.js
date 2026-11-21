// Cactus Boats: an endless broadside shooter on a single-screen sea whose
// edges wrap. This slice is the sailing skeleton: you sail a little wooden
// boat with a cactus for a mast around a few islands, with no enemies yet.
//
// mountCactusBoats(container, { homeHref, onEvent, leaderboard, seed }) -> destroy
//   homeHref    where the jspratt.dev link in the corner goes; without it the link is left out
//   onEvent     gets { event: 'play' } when a Play starts
//   leaderboard { start, submit, top }, backed by the page; unused until the Leaderboard lands
//   seed        a fixed seed for the Play's sea, else a random one
//
// The rules live in sim.js (headless, seeded, tested in tests/cactus-boats/),
// keys and touch in input.js, and the picture in draw.js. This module runs
// the fixed 1/60 s loop and the HUD, and pauses on P, blur and a hidden tab.

import { newRun, step, STEP, ANCHOR, HALF, FULL } from './sim.js?v=2026-11-21-v1';
import { createInput } from './input.js?v=2026-11-21-v1';
import { createView, fitScreen } from './draw.js?v=2026-11-21-v1';

// Matches the ?v= on the imports above (and in the other modules and
// play.js). Bump them together when a deploy must beat a stale browser cache:
// there's no build step to hash the filenames.
const CACHE_BUST = '2026-11-21-v1';

const SAIL_NAMES = { [ANCHOR]: 'Anchor', [HALF]: 'Half', [FULL]: 'Full' };

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

export async function mountCactusBoats(container, opts = {}) {
  const { homeHref, onEvent } = opts;
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
  const hud = h('div', { class: 'cb-hud', 'aria-hidden': 'true' },
    h('span', { class: 'cb-hull' }, hullFill),
    h('span', { class: 'cb-sails' }, ...sails),
  );
  const shelf = homeHref ? h('a', { class: 'cb-shelf', href: homeHref, text: 'jspratt.dev' }) : null;
  const hint = h('p', { class: 'cb-hint' });
  const message = h('div', { class: 'cb-msg', role: 'status', hidden: true });
  const stickBase = h('span', { class: 'cb-stick', hidden: true });
  const stickKnob = h('span', { class: 'cb-knob', hidden: true });
  const root = h('div', { class: 'cb' }, stage, hud, shelf, hint, stickBase, stickKnob, message);
  container.append(root);

  const view = createView(screen);
  const dpr = () => window.devicePixelRatio || 1;
  const box = stage.getBoundingClientRect();
  const { width } = fitScreen(box.width, box.height, dpr());
  const state = newRun(opts.seed ?? randomSeed(), { width });
  view.fit(box.width, box.height, dpr(), state.sea.width);
  const resize = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    view.fit(r.width, r.height, dpr(), state.sea.width);
    showHint();
  });
  resize.observe(stage);

  let paused = false;
  let help = true;
  // Touch wording from the start on a phone, and from the first touch anywhere else.
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touchy = () => coarse || input.touched;
  function setPaused(on) {
    paused = on;
    message.hidden = !on;
    message.replaceChildren(
      h('strong', { text: 'Paused' }),
      h('span', { text: touchy() ? 'Tap to carry on.' : 'Press P or any key to carry on.' }),
    );
  }
  const input = createInput(stage, {
    onPause: (away) => setPaused(away ? true : !paused),
    onWake: () => {
      if (!paused) return false;
      setPaused(false);
      return true;
    },
  });
  if (document.hidden) setPaused(true);

  function showHint() {
    const tall = window.innerHeight > window.innerWidth;
    hint.textContent = touchy()
      ? tall ? 'Turn your phone sideways for a bigger sea' : 'Drag on the left half to steer'
      : 'A D turn · W S sail · P pause';
  }
  showHint();

  onEvent?.({ event: 'play' });

  let last = performance.now();
  let acc = 0;
  let frame = 0;
  let shownHull = null;
  let shownSail = null;
  let wasTouched = false;
  function tick(now) {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (paused) acc = 0;
    else {
      // Read the controls once a frame that steps, so a shot fires on its first tick only.
      acc += dt;
      let intent = acc >= STEP ? input.intent(state.boat.h) : { turn: 0, sail: input.sail, fire: null };
      while (acc >= STEP) {
        step(state, intent, STEP);
        intent = { ...intent, fire: null };
        acc -= STEP;
      }
      if (help && state.elapsed > 1 && (state.boat.spd > 0 || intent.turn)) {
        help = false;
        setTimeout(() => hint.classList.add('cb-hint-gone'), 6000);
      }
    }
    view.draw(state);

    const hull = Math.ceil(state.boat.hp);
    if (hull !== shownHull) {
      shownHull = hull;
      hullFill.style.width = `${(100 * state.boat.hp) / state.boat.maxHp}%`;
    }
    if (input.sail !== shownSail) {
      shownSail = input.sail;
      sails.forEach((s, i) => s.classList.toggle('cb-on', i === input.sail));
    }
    if (input.touched !== wasTouched) {
      wasTouched = input.touched;
      showHint();
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
