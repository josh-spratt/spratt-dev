import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GamePreloads {
  /** Where the Game is served, e.g. `/games/twenty-boats/`. */
  base: string;
  /** The Game's `?v=` cache key. */
  version: string;
  /** Every module the Game's modules import, as served paths with their `?v=`. */
  modules: string[];
  /** Every data file the entry module fetches (from its `DATA` list), with `?v=`. */
  data: string[];
}

/**
 * What a Game page should preload, so the Game's modules and data arrive in
 * parallel rather than one import at a time. Read from the Game's own source in
 * `public/games/<name>/`, so the list can't drift from what it actually requests.
 *
 * The cache key is the entry module's `CACHE_BUST` constant if it has one, else
 * the `?v=` on its imports. A Game with no `DATA` list preloads no data.
 */
export function gamePreloads(name: string, entry: string): GamePreloads {
  const base = `/games/${name}/`;
  const dir = join("public", base);
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
  const modules = [...new Set(sources.flatMap((s) => [...s.matchAll(/(?:from\s+|import\()'\.\/([^']+)'/g)].map((m) => base + m[1])))];
  const main = readFileSync(join(dir, entry), "utf8");
  const version = main.match(/const CACHE_BUST = '([^']+)'/)?.[1] ?? sources.join("\n").match(/\?v=([\w-]+)/)?.[1];
  if (!version) throw new Error(`${name}/${entry}: couldn't find a CACHE_BUST or ?v= cache key`);
  const dataNames = [...(main.match(/const DATA = \[([^\]]+)\]/)?.[1].matchAll(/'([^']+)'/g) ?? [])].map((m) => m[1]);
  const data = dataNames.map((d) => `${base}data/${d}.json?v=${version}`);
  return { base, version, modules, data };
}
