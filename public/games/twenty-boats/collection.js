// Twenty Boats — the Endings you have reached, per browser. The only thing
// that outlives a run, and it only feeds the title screen: no run reads it.
// Storage can be missing or throw (private windows, blocked site data), so
// every access is guarded and the game plays the same without it.

const KEY = 'twenty-boats:endings';

export function loadCollection(storage, knownIds) {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id) => knownIds.has(id)) : []);
  } catch {
    return new Set();
  }
}

export function addToCollection(storage, collected, id) {
  collected.add(id);
  try {
    storage?.setItem(KEY, JSON.stringify([...collected]));
  } catch {
    // Not saved this time; the run still ends normally.
  }
  return collected;
}
