// Twenty Boats — the Draw. Picks an Identity weighted by who was really
// aboard (data/survival.json), and where that person was at 23:40. Names
// come later. No DOM, no imports.

// Third class slept at the ends of the ship: single men forward, women,
// couples and families aft (Hart BI Q9853-9877). Some first-class men were
// still up in the smoking room; everyone else starts in their cabin.
export function startOf(identity, rng) {
  if (identity.cls === 1) {
    const up = identity.sex === 'm' && identity.age === 'adult' && rng() < 0.5;
    return { place: up ? 'smoking-room' : 'cabin-1', awake: up };
  }
  if (identity.cls === 2) return { place: 'cabin-2', awake: false };
  const forward = identity.sex === 'm' && identity.age === 'adult';
  return { place: forward ? 'cabin-3-fwd' : 'cabin-3-aft', awake: false };
}

// Children wait for families: a child alone almost never happened, and v1
// is solo. Their rows stay in survival.json for the End card.
export function drawable(groups) {
  return groups.filter((g) => g.age === 'adult');
}

export function drawIdentity(allGroups, rng) {
  const groups = drawable(allGroups);
  const total = groups.reduce((sum, g) => sum + g.aboard, 0);
  let pick = rng() * total;
  for (const g of groups) {
    pick -= g.aboard;
    if (pick < 0) {
      const identity = { cls: g.cls, sex: g.sex, age: g.age };
      return { identity, ...startOf(identity, rng) };
    }
  }
  throw new Error('drawIdentity: empty groups');
}
