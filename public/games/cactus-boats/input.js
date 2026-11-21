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
// Space or a click fires the smart broadside, J and L fire port and starboard.
// On touch there's a pad drawn on screen (the `pad` option: { joy, port, stbd }
// elements). The joystick is a compass: the boat turns toward the drag and the
// sail follows how far it is pulled (Half, then Full past the ring); letting go
// keeps sailing on that heading, and tapping the stick drops anchor. The Port
// and Starboard buttons fire that side; a tap anywhere else on the sea fires
// whichever side bears.
// P calls onPause; losing focus or hiding the tab calls onPause(true). Any key
// or tap calls onWake first, so a paused game can carry on.

import { ANCHOR, HALF, FULL } from './sim.js?v=2026-11-21-v7';

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
    if (c === 'Space') fire = 'auto';
    if (c === 'KeyJ') fire = 'port';
    if (c === 'KeyL') fire = 'stbd';
  });
  on(window, 'keyup', (e) => held.delete(e.code));

  on(stage, 'pointerdown', (e) => {
    e.preventDefault();
    if (onWake()) return;
    if (e.pointerType === 'mouse') {
      if (e.button === 0) fire = 'auto';
      return;
    }
    touched = true;
    fire = 'auto';
  });

  if (pad) {
    const buttons = [[pad.port, 'port'], [pad.stbd, 'stbd']];
    for (const [el, side] of buttons) {
      on(el, 'pointerdown', (e) => {
        e.preventDefault();
        touched = true;
        if (onWake()) return;
        fire = side;
      });
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
      const out = { turn, sail, fire };
      fire = null;
      return out;
    },
    destroy() {
      ctl.abort();
    },
  };
}
