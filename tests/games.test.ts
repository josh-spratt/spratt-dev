import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { buildSite } from "./helpers.ts";

// Each Game ships as plain modules from public/games/<name>/, with no bundler to
// catch a broken import. Its game logic is tested in tests/<name>/. Every check
// below runs once per Game: a Game is a folder in public/games/ with an entry in
// `games` saying what's particular to it.
interface Game {
  /** The page's <title>, before " | Josh Spratt". */
  title: string;
  /** The module that exports the Game's mount function; the page preloads it. */
  entry: string;
  /** Other modules the page must preload. */
  preloads: string[];
  /** At least this many modules ship, so the import checks can't pass on an empty folder. */
  minModules: number;
  /** Other files the Game needs in the build, e.g. its stylesheet. */
  files: string[];
  /** How many data files (from the entry module's `DATA` list) it loads and the page preloads. */
  dataFiles: number;
  /** Whether the entry module holds the cache key as a `CACHE_BUST` constant. */
  cacheBustConstant: boolean;
  /** The page's theme-color for dark and light schemes. */
  themeColours: { dark: string; light: string };
  /** Where play.js reports Plays and Finishes, or null before the Game is logged. */
  eventPath: string | null;
  /** Whether the Game has its own 1200×630 share card yet (else the site's). */
  card: boolean;
}

const games: Record<string, Game> = {
  "twenty-boats": {
    title: "Twenty Boats",
    entry: "twenty-boats.js",
    preloads: ["story.js"],
    minModules: 6,
    files: ["twenty-boats.css"],
    dataFiles: 7,
    cacheBustConstant: true,
    themeColours: { dark: "#1c1915", light: "#efe7d6" },
    eventPath: "/games/twenty-boats/event",
    card: true,
  },
  // The share card and Game logging arrive when it launches as a Project (#72).
  "cactus-boats": {
    title: "Cactus Boats",
    entry: "cactus-boats.js",
    preloads: ["sim.js", "input.js", "draw.js"],
    minModules: 5,
    files: ["cactus-boats.css"],
    dataFiles: 0,
    cacheBustConstant: true,
    themeColours: { dark: "#0b2e36", light: "#0b2e36" },
    eventPath: null,
    card: false,
  },
};

const site = buildSite({ mode: "production" });

/** Every file under a directory. */
function files(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
  );
}

test("every Game in public/games/ says what's particular to it", () => {
  const folders = readdirSync("public/games", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(folders.sort(), Object.keys(games).sort(), "add the Game to `games` in tests/games.test.ts");
});

for (const [name, game] of Object.entries(games)) {
  const page = `games/${name}/index.html`;
  const dir = join(site.outDir, "games", name);
  const base = `/games/${name}/`;
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const main = () => readFileSync(join(dir, game.entry), "utf8");
  const dataNames = () => [...(main().match(/const DATA = \[([^\]]+)\]/)?.[1].matchAll(/'([^']+)'/g) ?? [])].map((m) => m[1]);

  test(`${game.title} has its own page that starts the game`, () => {
    const doc = site.html(page);
    assert.equal(doc.querySelector("title")?.text, `${game.title} | Josh Spratt`);
    assert.ok(doc.querySelector("#game"), "the game has somewhere to mount");
    assert.ok(doc.querySelector("#game-status[role=status]"), "it says it's loading");
    const start = doc.querySelector("script[data-game-script]");
    assert.equal(start?.getAttribute("type"), "module");
    assert.match(start?.getAttribute("src") ?? "", new RegExp(`^${escaped(base)}play\\.js\\?v=`));
    assert.equal(doc.querySelector("header.site-header"), null, "the game fills the screen");
    assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), `https://jspratt.dev${base}`);
  });

  test(`${game.title} shares its own 1200×630 card`, { skip: !game.card && "no share card until it launches" }, async () => {
    const doc = site.html(page);
    const og = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
    assert.equal(og, `https://jspratt.dev${base}card.png`);
    const { width, height } = await sharp(join(dir, "card.png")).metadata();
    assert.deepEqual([width, height], [1200, 630]);
  });

  test(`every module import and data file ${game.title} loads is in the build`, () => {
    const modules = files(dir).filter((f) => f.endsWith(".js"));
    assert.ok(modules.length >= game.minModules, `${modules.length} modules`);
    for (const file of modules) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\()'([^']+)'/g)) {
        assert.ok(spec.startsWith("./"), `${relative(dir, file)} imports ${spec}: keep imports relative`);
        const target = join(dirname(file), spec.replace(/\?.*$/, ""));
        assert.ok(existsSync(target), `${relative(dir, file)} imports ${spec}, which isn't built`);
      }
    }
    const data = dataNames();
    assert.equal(data.length, game.dataFiles, "data files in the entry module's DATA list");
    for (const d of data) assert.ok(existsSync(join(dir, "data", `${d}.json`)), `${d}.json is built`);
    for (const f of [game.entry, ...game.files]) assert.ok(existsSync(join(dir, f)), `${f} is built`);
  });

  test(`${game.title} stays under 300 KB, not counting its share card`, () => {
    const bytes = files(dir)
      .filter((f) => !f.endsWith("card.png"))
      .reduce((sum, f) => sum + statSync(f).size, 0);
    assert.ok(bytes < 300 * 1024, `${(bytes / 1024).toFixed(0)} KB`);
  });

  test(`every ?v= cache key in ${game.title} and its page is the same`, () => {
    const sources = [site.read(page), ...files(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8"))];
    const keys = new Set(sources.flatMap((s) => [...s.matchAll(/\?v=([\w-]+)/g)].map((m) => m[1])));
    const constant = main().match(/const CACHE_BUST = '([^']+)'/)?.[1];
    if (game.cacheBustConstant) keys.add(constant ?? "missing");
    else assert.equal(constant, undefined, "set cacheBustConstant: the entry module has a CACHE_BUST");
    assert.equal(keys.size, 1, [...keys].join(", "));
  });

  test(`${game.title} reports Plays and Finishes to an address the Worker runs for`, { skip: !game.eventPath && "not logged until it launches" }, () => {
    const eventPath = game.eventPath!;
    const play = readFileSync(join(dir, "play.js"), "utf8");
    assert.match(play, new RegExp(`fetch\\('${escaped(eventPath)}'`));
    const config = readFileSync("wrangler.jsonc", "utf8");
    for (const path of [base, eventPath]) {
      assert.ok(config.includes(`"${path}"`), `${path} is in run_worker_first`);
    }
  });

  test(`the ${game.title} page preloads every module and data file the game loads`, () => {
    const doc = site.html(page);
    const modules = doc.querySelectorAll('link[rel="modulepreload"]').map((l) => l.getAttribute("href"));
    for (const m of [game.entry, ...game.preloads]) {
      assert.ok(modules.some((h) => new RegExp(`^${escaped(base + m)}\\?v=`).test(h ?? "")), `${m} is preloaded`);
    }
    for (const href of modules) assert.ok(existsSync(join(site.outDir, href!.replace(/\?.*$/, ""))), `${href} is built`);
    const data = doc.querySelectorAll('link[rel="preload"][as="fetch"]');
    assert.equal(data.length, game.dataFiles);
    for (const l of data) {
      assert.equal(l.getAttribute("crossorigin"), "anonymous", "matches fetch()'s mode, or the preload is wasted");
      assert.ok(existsSync(join(site.outDir, l.getAttribute("href")!.replace(/\?.*$/, ""))));
    }
  });

  test(`the ${game.title} page loads none of the site's styles and sets the game's own colours`, () => {
    const doc = site.html(page);
    assert.equal(doc.querySelectorAll('link[rel="stylesheet"]').length, 0, "no site stylesheet to restyle the game");
    assert.doesNotMatch(doc.querySelector("style")?.text ?? "", /(^|[\s,}])(main|ul|h1|h2|a)\s*[{,]/, "no element rules that reach into the game");
    const colours = doc.querySelectorAll('meta[name="theme-color"]');
    assert.deepEqual(
      colours.map((m) => [m.getAttribute("media") ?? null, m.getAttribute("content")]),
      [["(prefers-color-scheme: dark)", game.themeColours.dark], [null, game.themeColours.light]],
    );
  });
}

test("games are served without being stored, so a deploy is live on the next load", () => {
  assert.match(readFileSync(join(site.outDir, "_headers"), "utf8"), /^\/games\/\*\n\s+Cache-Control: no-store$/m);
});
