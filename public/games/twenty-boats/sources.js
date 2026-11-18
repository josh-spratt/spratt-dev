// Twenty Boats — citations. Every fact in data/ carries citation keys; this
// resolves them to a title and URL for the Sources screen. No DOM, no imports.

export function resolveCite(key, sources) {
  const exact = sources.keys[key];
  if (exact) return exact;
  for (const p of sources.patterns) {
    const m = key.match(new RegExp(p.match));
    if (!m) continue;
    const arg = m[1] ?? '';
    const padded = p.pad ? arg.padStart(p.pad, '0') : arg;
    return { title: p.title.replace('$1', arg), url: p.url.replace('$1', padded) };
  }
  return null;
}

// Every citation key used anywhere in the game's data.
export function citesIn(world) {
  const keys = new Set();
  const add = (x) => x?.cite?.forEach((k) => keys.add(k));
  world.boats.forEach(add);
  Object.values(world.map.places).forEach(add);
  world.map.links.forEach(add);
  world.groups.forEach(add);
  (world.beats ?? []).forEach(add);
  for (const f of world.figures) {
    add(f);
    f.sightings.forEach(add);
  }
  return keys;
}

// The Sources screen: one entry per distinct document, with the keys that
// point at it (inquiry testimony collapses to one entry per day).
export function sourceList(world) {
  const byUrl = new Map();
  for (const key of citesIn(world)) {
    const src = resolveCite(key, world.sources);
    if (!src) continue;
    const entry = byUrl.get(src.url) ?? { title: src.title, url: src.url, keys: [] };
    entry.keys.push(key);
    byUrl.set(src.url, entry);
  }
  return [...byUrl.values()].sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true }));
}
