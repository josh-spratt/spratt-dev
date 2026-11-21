// Cactus Boats' drawing: the sea, islands and boats, from the simulation's
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
// the boat; the cactus mast stays upright. Animation runs on the Play's own
// clock (state.elapsed), so a paused game is a still picture.

import { SEA_HEIGHT, SEA_WIDTHS } from './sim.js?v=2026-11-21-v1';

// Every drawn pixel is one of these.
export const PAL = {
  ink: '#1b1420', deep: '#0e3c46', sea: '#15505c', wave: '#2a7480', foam: '#cfe8e0',
  sand: '#e2c27a', sandDk: '#b8954e',
  woodDk: '#5a3620', wood: '#8a5a33', woodLt: '#c08a55',
  cacDk: '#3d7a2a', cac: '#5fae3e', cacLt: '#a9dc6a',
  pink: '#ff6f91', pinkDk: '#b83a64', red: '#e8534a',
  plum: '#4a3550', plumLt: '#86648c', cream: '#f3ead2', gold: '#f2b134', iron: '#3a3a48',
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

function hullSprite() {
  const c = canvas(HULL.w, HULL.h);
  const g = c.getContext('2d');
  g.translate(HULL.ax, HULL.ay);
  g.fillStyle = PAL.wood;
  poly(g, [11, 0, 4, -5, -8, -5, -10, -3, -10, 3, -8, 5, 4, 5]);
  g.fillStyle = PAL.woodLt;
  poly(g, [8, 0, 3, -3, -7, -3, -8, -2, -8, 2, -7, 3, 3, 3]);
  g.fillStyle = PAL.woodDk;
  g.fillRect(-8, -2, 3, 4);
  g.fillStyle = PAL.iron;
  for (const x of [-5, -1, 3]) {
    g.fillRect(x, -5, 2, 1);
    g.fillRect(x, 4, 2, 1);
  }
  return crisp(c);
}

function mastSprite() {
  const c = canvas(MAST.w, MAST.h);
  const g = c.getContext('2d');
  const R = (col, x, y, w, h) => {
    g.fillStyle = PAL[col];
    g.fillRect(MAST.ax + x, MAST.ay + y, w, h);
  };
  R('cacDk', -1, -13, 3, 13); R('cac', -1, -13, 2, 13); R('cacLt', -1, -12, 1, 10);
  R('cacDk', -4, -8, 3, 2); R('cacDk', -4, -11, 2, 4); R('cac', -4, -11, 1, 4);
  R('cacDk', 2, -6, 3, 2); R('cacDk', 3, -10, 2, 5); R('cac', 3, -10, 1, 5);
  R('pink', -1, -15, 2, 2); R('pinkDk', 1, -14, 1, 1);
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
  const hull = hullSprite();
  const mast = mastSprite();
  let islands = { for: null, sprites: [] };
  let scale = 1;
  const wakes = [];
  let lastWake = null;

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
    const b = state.boat;
    const t = state.elapsed;
    if (b.spd > 6 && (!lastWake || t - lastWake >= 0.07)) {
      lastWake = t;
      const sx = b.x - Math.cos(b.h) * b.r;
      const sy = b.y - Math.sin(b.h) * b.r;
      // Foam peels off to both sides of the stern.
      const side = Math.sin(t * 40) > 0 ? 1 : -1;
      wakes.push({ x: sx + Math.cos(b.h + Math.PI / 2) * side * 2, y: sy + Math.sin(b.h + Math.PI / 2) * side * 2, born: t });
    }
    while (wakes.length && (t - wakes[0].born > 1.1 || wakes[0].born > t)) wakes.shift();
  }

  function draw(state) {
    const { width: W, height: H } = state.sea;
    if (off.width !== W) off.width = W;
    const t = state.elapsed;
    if (islands.for !== state.islands) islands = { for: state.islands, sprites: state.islands.map(islandSprite) };
    trackWake(state);

    g.fillStyle = PAL.sea;
    g.fillRect(0, 0, W, H);
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

    // The boat: the hull turns, the mast stands upright on it.
    const b = state.boat;
    const flash = b.bump > 0.6;
    wrapped(Math.round(b.x), Math.round(b.y), 16, W, H, (x, y) => {
      g.save();
      g.translate(x, y);
      g.rotate(b.h);
      g.drawImage(hull, -HULL.ax, -HULL.ay);
      g.restore();
      if (flash) {
        g.fillStyle = PAL.cream;
        g.fillRect(x - 1, y - 1, 3, 3);
      }
      g.drawImage(mast, x - MAST.ax, y + 1 - MAST.ay);
    });

    ctx.drawImage(off, 0, 0, screen.width, screen.height);
  }

  return { fit, draw };
}
