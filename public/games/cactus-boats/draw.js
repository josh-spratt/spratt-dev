// Cactus Boats' drawing: the sea, islands, boats and the fight, from the simulation's
// state, on an offscreen canvas 216 px tall that's scaled up by a whole number
// of device pixels so the pixel art stays sharp.
//
//   fitScreen(cssWidth, cssHeight, dpr, seaWidth?) -> { width, scale }
//   const view = createView(canvas)
//   view.fit(cssWidth, cssHeight, dpr, seaWidth)   when the screen changes
//   view.draw(state)                                every frame
//
// Every sprite is drawn in code (the Sprite Lab prototype's variant A), then
// snapped to one fixed palette with a 1 px ink outline. The hull rotates with
// the boat; the cactus mast stays upright. Enemies are palette swaps with a
// pale cactus and a pennant, one per hull on the ladder: a plum Prickly Pear
// with two guns a side, a slate Sombrero in its hat, and a rust-red Saguaro
// under a gold pennant. Animation runs on the Play's own
// clock (state.elapsed), so a paused game is a still picture.

import { SEA_HEIGHT, SEA_WIDTHS, GUNS, FX, HULLS, broadsides } from './sim.js?v=2026-11-21-v6';

// Every drawn pixel is one of these.
export const PAL = {
  ink: '#1b1420', deep: '#0e3c46', sea: '#15505c', wave: '#2a7480', foam: '#cfe8e0',
  sand: '#e2c27a', sandDk: '#b8954e',
  woodDk: '#5a3620', wood: '#8a5a33', woodLt: '#c08a55',
  cacDk: '#3d7a2a', cac: '#5fae3e', cacLt: '#a9dc6a',
  pink: '#ff6f91', pinkDk: '#b83a64', red: '#e8534a',
  plum: '#4a3550', plumLt: '#86648c', cream: '#f3ead2', gold: '#f2b134', iron: '#3a3a48',
  slate: '#3a4a5a', slateLt: '#6d8296', rust: '#7a2f3a', rustLt: '#c25a66',
};

/** The sea's width and the whole-number scale that fits it on a screen. */
export function fitScreen(cssWidth, cssHeight, dpr, seaWidth) {
  const devW = Math.max(1, Math.round(cssWidth * dpr));
  const devH = Math.max(1, Math.round(cssHeight * dpr));
  if (seaWidth) return { width: seaWidth, scale: Math.max(1, Math.floor(Math.min(devH / SEA_HEIGHT, devW / seaWidth))) };
  const scale = Math.max(1, Math.floor(Math.min(devH / SEA_HEIGHT, devW / SEA_WIDTHS.min)));
  const width = Math.max(SEA_WIDTHS.min, Math.min(SEA_WIDTHS.max, Math.floor(devW / scale)));
  return { width, scale };
}

const RGB = Object.values(PAL).map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function nearest(r, g, b) {
  let best = RGB[0];
  let bd = Infinity;
  for (const p of RGB) {
    const d = (p[0] - r) ** 2 * 0.3 + (p[1] - g) ** 2 * 0.59 + (p[2] - b) ** 2 * 0.11;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

// Hard alpha, every pixel snapped to the palette, and an ink outline.
function crisp(c) {
  const g = c.getContext('2d');
  const im = g.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 110) {
      d[i + 3] = 0;
      continue;
    }
    const a = d[i + 3] / 255;
    const p = nearest(d[i] / a, d[i + 1] / a, d[i + 2] / a);
    d.set([p[0], p[1], p[2], 255], i);
  }
  const src = new Uint8ClampedArray(d);
  const on = (x, y) => x >= 0 && y >= 0 && x < c.width && y < c.height && src[(y * c.width + x) * 4 + 3];
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (on(x, y)) continue;
      if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) d.set([...RGB[0], 255], (y * c.width + x) * 4);
    }
  }
  g.putImageData(im, 0, 0);
  return c;
}

function poly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.closePath();
  g.fill();
}

// Sprite frames: the hull is 32×32 centred on (16,16), bow pointing east;
// the mast is 16×18 with the trunk's foot at (8,17).
const HULL = { w: 32, h: 32, ax: 16, ay: 16 };
const MAST = { w: 16, h: 18, ax: 8, ay: 17 };

// Colours for each kind of boat. `flash` is the all-cream frame shown when hit.
const LOOKS = {
  player: { hull: 'wood', deck: 'woodLt', stern: 'woodDk', guns: 'iron', cac: 'cac', cacDk: 'cacDk', cacLt: 'cacLt', top: 'pink', topDk: 'pinkDk', flag: null },
  prickly: { hull: 'plum', deck: 'plumLt', stern: 'ink', guns: 'ink', cac: 'cacLt', cacDk: 'cac', cacLt: 'cream', top: 'ink', topDk: 'ink', flag: 'red' },
  sombrero: { hull: 'slate', deck: 'slateLt', stern: 'ink', guns: 'ink', cac: 'cacLt', cacDk: 'cac', cacLt: 'cream', top: 'ink', topDk: 'ink', flag: 'red', hat: 'gold' },
  saguaro: { hull: 'rust', deck: 'rustLt', stern: 'ink', guns: 'ink', cac: 'cacLt', cacDk: 'cac', cacLt: 'cream', top: 'ink', topDk: 'ink', flag: 'gold' },
  flash: { hull: 'cream', deck: 'cream', stern: 'cream', guns: 'cream' },
};

function hullSprite(look, guns = 3) {
  const c = canvas(HULL.w, HULL.h);
  const g = c.getContext('2d');
  g.translate(HULL.ax, HULL.ay);
  g.fillStyle = PAL[look.hull];
  poly(g, [11, 0, 4, -5, -8, -5, -10, -3, -10, 3, -8, 5, 4, 5]);
  g.fillStyle = PAL[look.deck];
  poly(g, [8, 0, 3, -3, -7, -3, -8, -2, -8, 2, -7, 3, 3, 3]);
  g.fillStyle = PAL[look.stern];
  g.fillRect(-8, -2, 3, 4);
  g.fillStyle = PAL[look.guns];
  for (const x of guns === 2 ? [-3, 2] : [-5, -1, 3]) {
    g.fillRect(x, -5, 2, 1);
    g.fillRect(x, 4, 2, 1);
  }
  return crisp(c);
}

function mastSprite(look) {
  const c = canvas(MAST.w, MAST.h);
  const g = c.getContext('2d');
  const R = (col, x, y, w, h) => {
    g.fillStyle = PAL[look[col]];
    g.fillRect(MAST.ax + x, MAST.ay + y, w, h);
  };
  R('cacDk', -1, -13, 3, 13); R('cac', -1, -13, 2, 13); R('cacLt', -1, -12, 1, 10);
  R('cacDk', -4, -8, 3, 2); R('cacDk', -4, -11, 2, 4); R('cac', -4, -11, 1, 4);
  R('cacDk', 2, -6, 3, 2); R('cacDk', 3, -10, 2, 5); R('cac', 3, -10, 1, 5);
  R('top', -1, -15, 2, 2); R('topDk', 1, -14, 1, 1);
  if (look.flag) R('flag', 1, -16, 4, 2);
  if (look.hat) {
    R('hat', -4, -14, 8, 1);
    R('hat', -2, -16, 4, 2);
  }
  return crisp(c);
}

// A small, stable hash, so scenery looks the same every frame without randomness.
function hash(a, b) {
  let h = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); // mix, or grid-aligned inputs leave the low bits even
  return (h ^ (h >>> 12)) >>> 0;
}

// An island, drawn once per sea: foam, sand, and a few cacti.
function islandSprite(isle, index) {
  const pad = 4;
  const size = (isle.r + pad) * 2;
  const c = canvas(size, size + 16);
  const g = c.getContext('2d');
  const cx = size / 2;
  const cy = size / 2 + 16;
  g.fillStyle = PAL.sandDk;
  g.beginPath();
  g.arc(cx, cy, isle.r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = PAL.sand;
  g.beginPath();
  g.arc(cx - 1, cy - 2, isle.r - 3, 0, Math.PI * 2);
  g.fill();
  const cacti = 1 + Math.floor(isle.r / 7);
  for (let k = 0; k < cacti; k++) {
    const h = hash(index * 31 + k, isle.r);
    const a = (h % 628) / 100;
    const reach = (isle.r - 6) * (((h >>> 10) % 100) / 100);
    const x = Math.round(cx + Math.cos(a) * reach);
    const y = Math.round(cy + Math.sin(a) * reach * 0.6);
    const tall = 6 + ((h >>> 16) % 8);
    g.fillStyle = PAL.cacDk;
    g.fillRect(x, y - tall, 3, tall);
    if (tall > 8) {
      g.fillRect(x - 3, y - tall + 4, 3, 2);
      g.fillRect(x - 3, y - tall + 1, 2, 4);
    }
    g.fillStyle = PAL.cac;
    g.fillRect(x, y - tall, 2, tall);
  }
  return { c: crisp(c), ax: cx, ay: cy };
}

export function createView(screen) {
  const ctx = screen.getContext('2d');
  const off = canvas(SEA_WIDTHS.default, SEA_HEIGHT);
  const g = off.getContext('2d');
  const sprites = {
    player: { hull: hullSprite(LOOKS.player), flash: hullSprite(LOOKS.flash), mast: mastSprite(LOOKS.player) },
  };
  for (const hull of ['prickly', 'sombrero', 'saguaro']) {
    const guns = HULLS[hull].guns;
    sprites[hull] = { hull: hullSprite(LOOKS[hull], guns), flash: hullSprite(LOOKS.flash, guns), mast: mastSprite(LOOKS[hull]) };
  }
  let islands = { for: null, sprites: [] };
  let scale = 1;
  let wakes = [];
  const lastWake = new Map();

  function fit(cssWidth, cssHeight, dpr, seaWidth) {
    const f = fitScreen(cssWidth, cssHeight, dpr, seaWidth);
    scale = f.scale;
    off.width = f.width;
    off.height = SEA_HEIGHT;
    screen.width = f.width * scale;
    screen.height = SEA_HEIGHT * scale;
    screen.style.width = `${screen.width / dpr}px`;
    screen.style.height = `${screen.height / dpr}px`;
    ctx.imageSmoothingEnabled = false;
    g.imageSmoothingEnabled = false;
    return f;
  }

  // Draw `fn(x, y)` at the boat's place and, near an edge, where it pokes in on the far side.
  function wrapped(x, y, reach, W, H, fn) {
    for (const dx of [0, -W, W]) {
      for (const dy of [0, -H, H]) {
        const px = x + dx;
        const py = y + dy;
        if (px < -reach || px > W + reach || py < -reach - 16 || py > H + reach) continue;
        fn(px, py);
      }
    }
  }

  function trackWake(state) {
    const t = state.elapsed;
    const boats = [['player', state.boat], ...state.enemies.filter((e) => !e.sunk && !e.entering).map((e) => [e.id, e])];
    for (const [key, b] of boats) {
      const last = lastWake.get(key);
      if (b.spd <= 6 || (last !== undefined && t - last < 0.07 && last <= t)) continue;
      lastWake.set(key, t);
      const sx = b.x - Math.cos(b.h) * b.r;
      const sy = b.y - Math.sin(b.h) * b.r;
      // Foam peels off to both sides of the stern.
      const side = Math.sin(t * 40) > 0 ? 1 : -1;
      wakes.push({ x: sx + Math.cos(b.h + Math.PI / 2) * side * 2, y: sy + Math.sin(b.h + Math.PI / 2) * side * 2, born: t });
    }
    wakes = wakes.filter((w) => t - w.born <= 1.1 && w.born <= t);
  }

  // A boat: the hull turns, the mast stands upright on it. Sunk boats settle and fade.
  function drawBoat(b, look, W, H, wreck = false) {
    const s = sprites[look] ?? sprites.prickly;
    let sink = 0;
    // The player's boat stops where it's sunk (the Play is over), so it's shown as a wreck.
    if (wreck) {
      g.globalAlpha = 0.5;
      sink = 2;
    } else if (b.sunk) {
      g.globalAlpha = Math.max(0, 1 - b.sinkT / 1.6);
      sink = Math.round(b.sinkT * 5);
    }
    const one = (x, y) => {
      g.save();
      g.translate(x, y + sink);
      g.rotate(b.h);
      g.drawImage(b.flash > 0 ? s.flash : s.hull, -HULL.ax, -HULL.ay);
      g.restore();
      if (!b.sunk && !wreck) g.drawImage(s.mast, x - MAST.ax, y + 1 - MAST.ay);
      if (look !== 'player' && !b.sunk) {
        // A small hull bar under each enemy.
        const w = 14;
        const f = b.hp / b.maxHp;
        g.fillStyle = PAL.ink;
        g.fillRect(x - w / 2, y + b.r + 1, w, 2);
        g.fillStyle = f > 0.35 ? PAL.cacLt : PAL.red;
        g.fillRect(x - w / 2, y + b.r + 1, Math.ceil(w * f), 2);
      }
    };
    if (b.entering) one(Math.round(b.x), Math.round(b.y));
    else wrapped(Math.round(b.x), Math.round(b.y), 16, W, H, one);
    g.globalAlpha = 1;
  }

  // Faint arcs on each side, bright when that side is loaded and has a target.
  function drawArcs(state) {
    const b = state.boat;
    const guns = broadsides(state);
    for (const [side, gun] of [[-1, guns.port], [1, guns.stbd]]) {
      const dir = b.h + (side * Math.PI) / 2;
      const lit = gun.ready && gun.target;
      g.strokeStyle = lit ? PAL.gold : gun.ready ? PAL.cream : PAL.ink;
      g.globalAlpha = lit ? 0.55 : 0.14;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(b.x, b.y);
      g.arc(b.x, b.y, GUNS.range, dir - GUNS.assist, dir + GUNS.assist);
      g.closePath();
      g.stroke();
      g.globalAlpha = 1;
      if (lit) bracket(gun.target.x, gun.target.y, gun.target.r + 3);
    }
  }

  function bracket(x, y, r) {
    g.fillStyle = PAL.gold;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = Math.round(x + sx * r);
      const py = Math.round(y + sy * r);
      g.fillRect(px - (sx > 0 ? 2 : 0), py, 3, 1);
      g.fillRect(px, py - (sy > 0 ? 2 : 0), 1, 3);
    }
  }

  // A blinking arrow at the edge where an enemy is about to sail in.
  function drawWarnings(state) {
    const t = state.elapsed;
    for (const w of state.warnings) {
      if (Math.floor(t * 6) % 2) continue;
      const inward = [Math.PI / 2, Math.PI, -Math.PI / 2, 0][w.edge];
      g.save();
      g.translate(Math.round(w.x + Math.cos(inward) * 4), Math.round(w.y + Math.sin(inward) * 4));
      g.rotate(inward);
      g.fillStyle = PAL.ink;
      poly(g, [5, 0, -2, -5, -2, 5]);
      g.fillStyle = PAL.red;
      poly(g, [4, 0, -1, -3, -1, 3]);
      g.restore();
    }
  }

  // Cannonballs with a little lob, and a shadow on the water under them.
  function drawBalls(state) {
    for (const ball of state.balls) {
      const k = 1 - ball.life / ball.max;
      const lift = Math.round(Math.sin(k * Math.PI) * 5);
      const x = Math.round(ball.x);
      const y = Math.round(ball.y);
      g.globalAlpha = 0.35;
      g.fillStyle = PAL.deep;
      g.fillRect(x, y, 2, 1);
      g.globalAlpha = 1;
      g.fillStyle = PAL.ink;
      g.fillRect(x, y - lift - 1, 2, 2);
    }
  }

  // Splashes, sparks, puffs and smoke, each fading over its life in the simulation.
  function drawFx(state, under) {
    const t = state.elapsed;
    for (const [i, f] of state.fx.entries()) {
      if ((f.kind === 'splash' || f.kind === 'sink') !== under) continue;
      const age = Math.min(1, Math.max(0, (t - f.at) / FX[f.kind]));
      const x = Math.round(f.x);
      const y = Math.round(f.y);
      g.globalAlpha = 1 - age * 0.7;
      if (f.kind === 'splash') {
        const r = Math.round(age * 4);
        g.fillStyle = PAL.foam;
        g.fillRect(x - r, y, 1, 1);
        g.fillRect(x + r, y, 1, 1);
        g.fillRect(x, y - r - 1, 1, 2);
      } else if (f.kind === 'sink') {
        // A ring of foam and drops thrown up around the wreck.
        g.fillStyle = PAL.foam;
        g.beginPath();
        g.arc(x, y, 3 + age * 9, 0, Math.PI * 2);
        g.lineWidth = 1;
        g.strokeStyle = PAL.foam;
        g.stroke();
        for (let k = 0; k < 14; k++) {
          const h = hash(Math.round(f.at * 1000) + k, i);
          const a = (h % 628) / 100;
          const reach = 4 + ((h >>> 9) % 10) * age;
          const up = Math.round(Math.sin(age * Math.PI) * ((h >>> 14) % 6));
          g.fillRect(Math.round(x + Math.cos(a) * reach), Math.round(y + Math.sin(a) * reach * 0.6) - up, 1, 1);
        }
      } else if (f.kind === 'hit') {
        g.fillStyle = age < 0.4 ? PAL.cream : PAL.gold;
        const r = Math.round(age * 5) + 1;
        g.fillRect(x - r, y, r * 2, 1);
        g.fillRect(x, y - r, 1, r * 2);
      } else {
        // Smoke drifts out from the gun; a thud throws up sand.
        g.fillStyle = f.kind === 'thud' ? PAL.sand : PAL.cream;
        const drift = f.kind === 'smoke' ? age * 6 : 0;
        const r = Math.round(age * 3) + 1;
        g.fillRect(Math.round(x + Math.cos(f.dir) * drift) - r, Math.round(y + Math.sin(f.dir) * drift) - r, r * 2, r * 2);
      }
    }
    g.globalAlpha = 1;
  }

  function draw(state) {
    const { width: W, height: H } = state.sea;
    if (off.width !== W) off.width = W;
    const t = state.elapsed;
    if (islands.for !== state.islands) islands = { for: state.islands, sprites: state.islands.map(islandSprite) };
    trackWake(state);

    // Being hit shakes the picture a pixel or two, on the Play's own clock.
    const shake = state.shake > 0.5 ? state.shake : 0;
    const jig = hash(Math.round(t * 60), 7);
    const sx = shake ? Math.round(((jig % 100) / 100 - 0.5) * shake) : 0;
    const sy = shake ? Math.round((((jig >>> 8) % 100) / 100 - 0.5) * shake) : 0;
    g.setTransform(1, 0, 0, 1, sx, sy);

    g.fillStyle = PAL.sea;
    g.fillRect(-4, -4, W + 8, H + 8);
    // Sea texture: wave dashes on a grid that shimmer on the Play's clock.
    const tick = Math.floor(t * 1.5);
    g.fillStyle = PAL.wave;
    for (let y = 0; y < H; y += 12) {
      for (let x = 0; x < W; x += 16) {
        const h = hash(x, y);
        if ((h + tick) % 6 === 0) g.fillRect(x + (h % 11), y + ((h >>> 8) % 9), 4, 1);
      }
    }

    // Islands: a foam ring that breathes, then the island.
    for (const [i, isle] of state.islands.entries()) {
      g.fillStyle = PAL.foam;
      g.beginPath();
      g.arc(isle.x, isle.y, isle.r + 2 + (Math.sin(t * 2 + i) > 0 ? 1 : 0), 0, Math.PI * 2);
      g.fill();
    }
    for (const [i, isle] of state.islands.entries()) {
      const s = islands.sprites[i];
      g.drawImage(s.c, Math.round(isle.x - s.ax), Math.round(isle.y - s.ay));
    }

    // Foam wakes behind the boat.
    g.fillStyle = PAL.foam;
    for (const w of wakes) {
      const age = (t - w.born) / 1.1;
      if (age > 0.7 && (Math.floor(w.born * 100) % 2)) continue;
      g.globalAlpha = age < 0.5 ? 0.9 : 0.5;
      g.fillRect(Math.round(w.x), Math.round(w.y), age < 0.3 ? 2 : 1, 1);
    }
    g.globalAlpha = 1;

    drawFx(state, true);
    drawWarnings(state);
    if (!state.sunk) drawArcs(state);
    for (const e of state.enemies) drawBoat(e, e.hull, W, H);
    drawBoat(state.boat, 'player', W, H, state.sunk);
    drawBalls(state);
    drawFx(state, false);
    g.setTransform(1, 0, 0, 1, 0, 0);

    ctx.drawImage(off, 0, 0, screen.width, screen.height);
  }

  return { fit, draw };
}
