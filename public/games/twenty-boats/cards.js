// Twenty Boats — the Draw card. Gives the drawn Identity an invented name,
// an age, a cabin and a port. No DOM, no imports.

const CLASS_LABEL = { 1: 'First class', 2: 'Second class', 3: 'Third class' };
const CLASS_WORD = { 1: 'First', 2: 'Second', 3: 'Third' };

// The cabin you sleep in. Matches draw.js: third-class single men forward,
// everyone else of third class aft.
export function homeCabin(identity) {
  if (identity.cls === 1) return 'cabin-1';
  if (identity.cls === 2) return 'cabin-2';
  return identity.sex === 'm' && identity.age === 'adult' ? 'cabin-3-fwd' : 'cabin-3-aft';
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function cabinLabel(home, rng) {
  const n = (lo, span) => lo + Math.floor(rng() * span);
  if (home === 'cabin-1') return `Stateroom C-${n(10, 120)}`;
  if (home === 'cabin-2') return `Cabin D-${n(20, 40)}`;
  if (home === 'cabin-3-fwd') return 'A shared bunk room, G deck, at the front';
  return 'A shared cabin, E deck, at the back';
}

export function dealCard({ identity }, names, rng) {
  const group = pick(names.classes[identity.cls], rng);
  const given = pick(group[identity.sex], rng);
  const surname = pick(group.surnames, rng);
  const age = 18 + Math.floor(rng() * 45);
  // Sex decides most of the night, and a period given name does not say it
  // to everyone, so the card does: a title as the passenger lists gave it,
  // and a plain word.
  const man = identity.sex === 'm';
  const title = man ? 'Mr' : age < 30 ? 'Miss' : 'Mrs';
  return {
    name: `${title} ${given} ${surname}`,
    title,
    surname,
    sex: identity.sex,
    sexLabel: man ? 'Man' : 'Woman',
    // Short, for the clock bar through the night: "Third-class man".
    who: `${CLASS_WORD[identity.cls]}-class ${man ? 'man' : 'woman'}`,
    age,
    classLabel: CLASS_LABEL[identity.cls],
    cabin: cabinLabel(homeCabin(identity), rng),
    embarked: group.embarked,
    travelling: 'Travelling alone',
  };
}
