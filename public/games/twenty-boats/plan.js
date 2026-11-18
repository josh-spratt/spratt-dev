// Twenty Boats — the deck plan. The boat deck from above, bow to the right
// like the side view, port (left) along the top and starboard (right) along
// the bottom. Every boat sits at its real station and shows what it was
// doing when you last saw it. Draws from story.js's planOf.
//
// Stations (BR-Boats): odd numbers starboard, even port, running forward to
// aft from the emergency cutters 1 and 2; C and D inboard of 1 and 2; A and
// B on the roof of the officers' quarters.

const SVG = 'http://www.w3.org/2000/svg';
const MID = 46;
const PORT_Y = 25;
const STBD_Y = 67;

// x along the ship (same scale as map.json's `at`), and which row.
export const STATIONS = {
  1: [318, 'stbd'], 3: [304, 'stbd'], 5: [290, 'stbd'], 7: [276, 'stbd'],
  2: [318, 'port'], 4: [304, 'port'], 6: [290, 'port'], 8: [276, 'port'],
  9: [150, 'stbd'], 11: [136, 'stbd'], 13: [122, 'stbd'], 15: [108, 'stbd'],
  10: [150, 'port'], 12: [136, 'port'], 14: [122, 'port'], 16: [108, 'port'],
  C: [318, 'stbd-in'], D: [318, 'port-in'],
  A: [304, 'stbd-roof'], B: [304, 'port-roof'],
};
const ROW_Y = { port: PORT_Y, stbd: STBD_Y, 'port-in': 33, 'stbd-in': 59, 'port-roof': 39, 'stbd-roof': 53 };
const OUTER = new Set(['port', 'stbd']);

// Where the sea starts on the plan (x; 400 for none): over the front of the
// boat deck once the boat deck there is under. Only the boat deck's own
// flooding counts, so the sea never covers a station still loading.
export function seaFrom(flooded, map) {
  const under = flooded.map((id) => map.places[id]).filter((p) => p.deck === 'Boat');
  return under.length ? Math.min(...under.map((p) => p.at[0])) - 12 : 400;
}

function el(name, attrs, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

export function createPlan(boats) {
  const svg = el('svg', { viewBox: '0 0 400 92', class: 'tb-plan', role: 'img' });
  el('path', {
    d: `M372,${MID} C350,33 320,29 290,29 L60,29 C40,29 24,35 22,${MID} C24,57 40,63 60,63 L290,63 C320,63 350,59 372,${MID} Z`,
    class: 'tb-plan-hull',
  }, svg);
  el('rect', { x: 84, y: 37, width: 210, height: 18, class: 'tb-plan-house' }, svg);
  for (const x of [244, 204, 164, 120]) el('ellipse', { cx: x, cy: MID, rx: 5, ry: 4, class: 'tb-plan-funnel' }, svg);
  const label = (x, y, text, anchor = 'middle') => {
    const t = el('text', { x, y, class: 'tb-plan-label', 'text-anchor': anchor }, svg);
    t.textContent = text;
  };
  label(6, 11, 'Left side (port)', 'start');
  label(6, 89, 'Right side (starboard)', 'start');
  label(394, 89, 'Front →', 'end');

  const sea = el('rect', { x: 400, y: 0, width: 0, height: 92, class: 'tb-plan-sea' }, svg);

  const slots = {};
  for (const boat of boats) {
    const [x, row] = STATIONS[boat.id];
    const y = ROW_Y[row];
    const g = el('g', { class: 'tb-plan-boat' }, svg);
    const w = /^\d+$/.test(boat.id) ? 11 : 9;
    el('rect', { x: x - w / 2, y: y - 2.5, width: w, height: 5, rx: 2.5 }, g);
    if (OUTER.has(row)) {
      const t = el('text', { x, y: row === 'port' ? 18 : 78, class: 'tb-plan-num', 'text-anchor': 'middle' }, g);
      t.textContent = boat.id;
    } else {
      const t = el('text', { x: x + 7, y: y + 2, class: 'tb-plan-num', 'text-anchor': 'start' }, g);
      t.textContent = boat.id;
    }
    slots[boat.id] = g;
  }
  const you = el('circle', { r: 3.4, class: 'tb-plan-you' }, svg);

  // `plan` is planOf(state, world); `map` gives where each flooded place is.
  function show(plan, map) {
    for (const b of plan.boats) slots[b.id].setAttribute('data-status', b.status);
    const x = seaFrom(plan.flooded, map);
    sea.setAttribute('x', x);
    sea.setAttribute('width', 400 - x);
    const onDeck = plan.you.deck === 'Boat';
    you.setAttribute('cx', plan.you.x);
    you.setAttribute('cy', onDeck ? (plan.you.side === 'port' ? 33 : 59) : MID);
    you.setAttribute('class', onDeck ? 'tb-plan-you' : 'tb-plan-you tb-plan-you--below');
    const known = plan.boats.length - plan.unseen;
    svg.setAttribute('aria-label', `Boat deck from above. ${plan.left} of ${plan.boats.length} boats not yet seen to leave; ${known} seen so far.`);
  }

  return { svg, show };
}
