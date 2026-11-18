// Twenty Boats — the side-on silhouette. Bow to the right. Her trim by the
// head and her waterline follow the clock; at ~02:18 she breaks between the
// third and fourth funnels and the stern rises (the record the inquiries
// missed, and the wreck confirmed). The pure part (poseAt) is tested; the
// rest builds SVG.

import { minuteOf } from './rules.js?v=2026-11-17-v2';

const SVG = 'http://www.w3.org/2000/svg';
export const WATER_Y = 78;
export const BREAK_X = 140;
export const BREAK_AT = minuteOf('02:18');
const STERN = [28, 70];

// [minute, degrees bow-down, pixels sunk]. Gentle for two hours, then
// faster. Tuned so each open deck's marker reaches the sea line on the
// minute map.json floods it: the forward well deck at 02:00, the A-deck
// promenade at 02:05, the front of the boat deck at 02:15 (see markerY and
// its test). Then the plunge to the break, the back of the boat deck still
// clear of the sea.
const TRIM = [
  [0, 0, 0],
  [20, 0.3, 1],
  [80, 1.5, 2.5],
  [115, 2.6, 3.5],
  [140, 3.37, 4],
  [145, 4.66, 5],
  [155, 4.97, 7],
  [BREAK_AT, 13, 5],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// The ship's pose at a (fractional) minute.
export function poseAt(minute) {
  if (minute >= BREAK_AT) {
    const t = Math.min(1, (minute - BREAK_AT) / 2);
    return { broken: true, angle: 13, sink: 5, fore: { angle: lerp(13, 40, t), sink: lerp(5, 70, t) }, aft: { angle: lerp(13, -55, t), sink: lerp(5, 40, t) } };
  }
  for (let i = 1; i < TRIM.length; i++) {
    const [m1, a1, s1] = TRIM[i];
    if (minute <= m1) {
      const [m0, a0, s0] = TRIM[i - 1];
      const t = (minute - m0) / (m1 - m0);
      return { broken: false, angle: lerp(a0, a1, t), sink: lerp(s0, s1, t) };
    }
  }
  return { broken: false, angle: 13, sink: 5 };
}

// Where a marker drawn at `at` ([x, y], unbroken hull) sits on screen at a
// minute, before the break: the same rotate-then-translate the SVG applies.
export function markerY(minute, [x, y]) {
  const { angle, sink } = poseAt(Math.min(minute, BREAK_AT - 0.001));
  const t = (angle * Math.PI) / 180;
  return STERN[1] + (x - STERN[0]) * Math.sin(t) + (y - STERN[1]) * Math.cos(t) + sink;
}

function el(name, attrs, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

function drawHalf(g, fore) {
  // Hull: sheer line rising slightly to bow and stern, keel flat.
  const hull = fore
    ? `M${BREAK_X},58 L330,57 L362,52 L372,52 L366,86 L${BREAK_X},86 Z`
    : `M${BREAK_X},58 L60,57 L30,54 L22,56 L28,72 L40,86 L${BREAK_X},86 Z`;
  el('path', { d: hull, class: 'tb-hull' }, g);
  el('rect', fore ? { x: BREAK_X, y: 50, width: 160, height: 8, class: 'tb-house' } : { x: 84, y: 50, width: BREAK_X - 84, height: 8, class: 'tb-house' }, g);
  // Funnels: four, raked aft. The break falls between the third and fourth.
  const funnels = fore ? [158, 198, 238] : [114];
  for (const x of funnels) el('path', { d: `M${x},50 L${x - 4},26 L${x + 8},26 L${x + 12},50 Z`, class: 'tb-funnel' }, g);
  el('line', fore ? { x1: 340, y1: 57, x2: 344, y2: 14, class: 'tb-mast' } : { x1: 60, y1: 57, x2: 64, y2: 18, class: 'tb-mast' }, g);
}

// `map` is data/map.json: each place's `at` is where the marker sits.
export function createShip(map) {
  const svg = el('svg', { viewBox: '0 0 400 112', class: 'tb-ship', role: 'img', 'aria-label': 'The ship, side on, front to the right' });
  el('rect', { x: 0, y: 0, width: 400, height: 112, class: 'tb-sky' }, svg);
  const aft = el('g', {}, svg);
  const fore = el('g', {}, svg);
  drawHalf(aft, false);
  drawHalf(fore, true);
  const marker = el('circle', { r: 3.2, class: 'tb-you' });
  el('rect', { x: 0, y: WATER_Y, width: 400, height: 112 - WATER_Y, class: 'tb-sea' }, svg);
  el('line', { x1: 0, y1: WATER_Y, x2: 400, y2: WATER_Y, class: 'tb-sea-line' }, svg);
  // Plain words for which end is which; the sea band never moves.
  el('text', { x: 6, y: 106, class: 'tb-end-label' }, svg).textContent = '← Back (stern)';
  el('text', { x: 394, y: 106, class: 'tb-end-label', 'text-anchor': 'end' }, svg).textContent = 'Front (bow) →';

  let shown = null;
  let raf = 0;

  function apply(minute, place) {
    const p = poseAt(minute);
    const foreP = p.broken ? p.fore : p;
    const aftP = p.broken ? p.aft : p;
    const foreCenter = p.broken ? `${BREAK_X},70` : STERN.join(',');
    const aftCenter = p.broken ? `${BREAK_X},70` : STERN.join(',');
    fore.setAttribute('transform', `translate(0 ${foreP.sink}) rotate(${foreP.angle} ${foreCenter})`);
    aft.setAttribute('transform', `translate(0 ${aftP.sink}) rotate(${aftP.angle} ${aftCenter})`);
    const spot = map.places[place]?.at;
    marker.remove();
    if (spot) {
      marker.setAttribute('cx', spot[0]);
      marker.setAttribute('cy', spot[1]);
      (spot[0] >= BREAK_X ? fore : aft).append(marker);
    }
  }

  // Ease from the last pose to the new one. Reduced motion jumps.
  function show(minute, place, { animate = true } = {}) {
    cancelAnimationFrame(raf);
    const from = shown ?? minute;
    shown = minute;
    if (!animate || from === minute) return apply(minute, place);
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 700);
      apply(from + (minute - from) * (1 - (1 - t) ** 3), place);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  return { svg, show, stop: () => cancelAnimationFrame(raf) };
}
