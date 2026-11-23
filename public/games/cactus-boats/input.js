// Cactus Boats' input: keys and touch in, the simulation's intent out.
//
//   const input = createInput(stage, { onPause, onWake })
//   input.intent(heading) -> { turn, sail, fire }   once per frame
//   input.stick -> { dx, dy } | null    how far the touch stick is pulled from its centre, for drawing
//   input.touched -> true once a finger has been used
//   input.destroy()
//
// The Helm scheme from the Controls prototype: A/D or ←/→ turn relative to
// the bow, W/S or ↑/↓ step the sail Anchor/Half/Full and it stays there.
// Space or a click fires (what your boat fires: both broadsides, the bow
// cannon, or the Ram's Charge); on the Galleon J and L fire port and starboard
// alone, which reloads faster. On touch there's a pad drawn on screen (the
// `pad` option: { root, joy, fire, port, stbd } elements; port and stbd are
// shown only on the Galleon). The joystick is a compass: the boat turns toward the drag and the
// sail follows how far it is pulled (Half, then Full past the ring); letting go
// keeps sailing on that heading, and tapping the stick drops anchor. The Fire
// button, or a tap anywhere else on the sea, fires as Space does; Port and
// Stbd fire one side. Held down, each keeps firing as its guns reload.
// P calls onPause; losing focus or hiding the tab calls onPause(true). Any key
// or tap calls onWake first, so a paused game can carry on.

import { ANCHOR, HALF, FULL } from './sim.js?v=2026-11-22-v1';

// How far (in CSS px) a drag must go to steer, and to reach Full sail.
const STICK = { dead: 14, full: 52 };
const KEYS = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
};
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export function createInput(stage, { onPause = () => {}, onWake = () => {}, pad = null } = {}) {
  const held = new Set();
  const ctl = new AbortController();
  const on = (target, type, fn, opts) => target.addEventListener(type, fn, { signal: ctl.signal, ...opts });
  let sail = ANCHOR;
  let fire = null;
  let want = null; // a heading the stick asked for, held after letting go
  let stick = null;
  let stickId = null;
  let touched = false;
  let frames = 0;
  const holding = new Map(); // pointer id -> what the button it holds down fires

  on(window, 'keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const c = e.code;
    if (c === 'KeyP') {
      e.preventDefault();
      if (!e.repeat) onPause();
      return;
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) e.preventDefault();
    if (e.repeat) return;
    if (onWake()) return; // the key that wakes the game does nothing else
    held.add(c);
    if (KEYS.up.includes(c)) sail = Math.min(FULL, sail + 1);
    if (KEYS.down.includes(c)) sail = Math.max(ANCHOR, sail - 1);
    if (KEYS.left.includes(c) || KEYS.right.includes(c)) want = null;
    if (c === 'Space') fire = 'volley';
    if (c === 'KeyJ') fire = 'port';
    if (c === 'KeyL') fire = 'stbd';
  });
  on(window, 'keyup', (e) => held.delete(e.code));

  on(stage, 'pointerdown', (e) => {
    e.preventDefault();
    if (onWake()) return;
    if (e.pointerType === 'mouse') {
      if (e.button === 0) fire = 'volley';
      return;
    }
    touched = true;
    fire = 'volley';
  });

  if (pad) {
    for (const [button, what] of [[pad.fire, 'volley'], [pad.port, 'port'], [pad.stbd, 'stbd']]) {
      if (!button) continue;
      on(button, 'pointerdown', (e) => {
        e.preventDefault();
        touched = true;
        if (onWake()) return;
        fire = what;
        holding.set(e.pointerId, what); // held down, it keeps firing as the guns reload
      });
      const letGo = (e) => holding.delete(e.pointerId);
      on(button, 'pointerup', letGo);
      on(button, 'pointercancel', letGo);
    }
    on(pad.joy, 'pointerdown', (e) => {
      e.preventDefault();
      touched = true;
      if (onWake() || stickId !== null) return;
      const r = pad.joy.getBoundingClientRect();
      stickId = e.pointerId;
      stick = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, dx: 0, dy: 0, moved: false, at: performance.now() };
      try {
        pad.joy.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety; the stick still works without it.
      }
      drag(e);
    });
    const drag = (e) => {
      if (e.pointerId !== stickId) return;
      stick.dx = e.clientX - stick.cx;
      stick.dy = e.clientY - stick.cy;
      if (Math.hypot(stick.dx, stick.dy) > STICK.dead) stick.moved = true;
    };
    on(pad.joy, 'pointermove', drag);
    const release = (e) => {
      if (e.pointerId !== stickId) return;
      // A quick tap on the stick without pulling it drops anchor.
      if (e.type === 'pointerup' && !stick.moved && performance.now() - stick.at < 400) {
        sail = ANCHOR;
        want = null;
      }
      stickId = null;
      stick = null;
    };
    on(pad.joy, 'pointerup', release);
    on(pad.joy, 'pointercancel', release);
  }
  on(stage, 'contextmenu', (e) => e.preventDefault());
  if (pad) on(pad.root, 'contextmenu', (e) => e.preventDefault());
  on(document, 'gesturestart', (e) => e.preventDefault());

  const away = () => {
    held.clear();
    holding.clear();
    stickId = null;
    stick = null;
    onPause(true);
  };
  on(window, 'blur', away);
  on(document, 'visibilitychange', () => {
    if (document.hidden) away();
  });

  const has = (codes) => codes.some((c) => held.has(c));

  return {
    get stick() {
      return stick;
    },
    get touched() {
      return touched;
    },
    get sail() {
      return sail;
    },
    /** This frame's intent, given the boat's heading (for the compass stick). Fire is one-shot. */
    intent(heading) {
      if (stick) {
        const { dx, dy } = stick;
        const pull = Math.hypot(dx, dy);
        if (pull > STICK.dead) {
          want = Math.atan2(dy, dx);
          sail = pull >= STICK.full ? FULL : HALF;
        }
      }
      let turn = (has(KEYS.right) ? 1 : 0) - (has(KEYS.left) ? 1 : 0);
      if (!turn && want !== null) {
        const d = angDiff(want, heading);
        if (Math.abs(d) < 0.02 && !stick) want = null;
        else turn = Math.max(-1, Math.min(1, d * 4));
      }
      // Buttons held down take turns, frame by frame, so holding Port and Stbd fires each as it reloads.
      const pressed = [...holding.values()];
      const out = { turn, sail, fire: fire ?? (pressed.length ? pressed[frames++ % pressed.length] : null) };
      fire = null;
      return out;
    },
    destroy() {
      ctl.abort();
    },
  };
}
