// Cactus Boats' spawn curve: when enemies arrive, and the most that can have
// arrived by a given time survived. No imports and no DOM, so the Worker
// (worker/stats.ts) imports maxSpawnedBy for the Leaderboard's sink cap and
// the two can never disagree. sim.js runs the spawner itself and re-exports these.
//
//   SPAWN                               the curve, as a table
//   difficultyAt(seconds) -> { every, afloat, mix }  the spawn curve at that time survived
//   maxSpawnedBy(survivedMs) -> the most enemies that can have been spawned by then

// Arrivals, and how they get harder: a warning marker at an edge, then an
// enemy sails in from just outside it `warn` seconds later. The first warning
// is at `first` seconds. Each row of the curve takes over at `at` seconds
// survived: after a warning the next waits `every` seconds (eased from row to
// row), and only while fewer than `afloat` enemies are on the sea or on their
// way; `mix` weighs which hull the next one is. A hull first appears in the
// mix at its threshold, so the ladder goes Prickly Pear, Sombrero, Saguaro.
export const SPAWN = {
  first: 2, warn: 1.5, inset: 0.15,
  curve: [
    { at: 0, every: 9, afloat: 1, mix: { prickly: 1 } },
    { at: 30, every: 8, afloat: 2, mix: { prickly: 1 } },
    { at: 70, every: 7, afloat: 3, mix: { prickly: 3, sombrero: 1 } },
    { at: 120, every: 6, afloat: 4, mix: { prickly: 2, sombrero: 2 } },
    { at: 180, every: 5, afloat: 5, mix: { prickly: 2, sombrero: 2, saguaro: 1 } },
    { at: 260, every: 4, afloat: 6, mix: { prickly: 1, sombrero: 2, saguaro: 2 } },
    { at: 360, every: 3, afloat: 7, mix: { prickly: 1, sombrero: 2, saguaro: 3 } },
  ],
};

/** The spawn curve at `seconds` survived: the gap between arrivals, the cap afloat and the hull mix. */
export function difficultyAt(seconds) {
  const rows = SPAWN.curve;
  let i = 0;
  while (i + 1 < rows.length && seconds >= rows[i + 1].at) i++;
  const row = rows[i];
  const next = rows[i + 1];
  const k = next ? clamp((seconds - row.at) / (next.at - row.at), 0, 1) : 0;
  return { every: next ? row.every + (next.every - row.every) * k : row.every, afloat: row.afloat, mix: row.mix };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The most enemies that can have been spawned (warned of, so arrived or on
 * their way) by `survivedMs`: the curve's arrivals with nothing ever holding
 * them back. The spawner never runs ahead of this, so no Play can sink more.
 * Counted to within a millisecond, since summary() rounds the time.
 */
export function maxSpawnedBy(survivedMs) {
  const t = Number(survivedMs) / 1000 + 0.001;
  if (!(t > 0)) return 0;
  if (t === Infinity) return Infinity;
  let n = 0;
  for (let at = SPAWN.first; at <= t; at += difficultyAt(at).every) n++;
  return n;
}
