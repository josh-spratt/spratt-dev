import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { buildSite } from "./helpers.ts";

// Twenty Boats ships as plain modules from public/games/twenty-boats/, with no
// bundler to catch a broken import. Its game logic is tested in tests/twenty-boats/.
const site = buildSite({ mode: "production" });
const page = "games/twenty-boats/index.html";
const dir = join(site.outDir, "games", "twenty-boats");

/** Every file under a directory. */
function files(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
  );
}

test("Twenty Boats has its own page that starts the game", () => {
  const doc = site.html(page);
  assert.equal(doc.querySelector("title")?.text, "Twenty Boats | Josh Spratt");
  assert.ok(doc.querySelector("#game"), "the game has somewhere to mount");
  assert.ok(doc.querySelector("#game-status[role=status]"), "it says it's loading");
  const start = doc.querySelector("script[data-game-script]");
  assert.equal(start?.getAttribute("type"), "module");
  assert.match(start?.getAttribute("src") ?? "", /^\/games\/twenty-boats\/play\.js\?v=/);
  assert.equal(doc.querySelector("header.site-header"), null, "the game fills the screen");
});

test("Twenty Boats shares its own 1200×630 card", async () => {
  const doc = site.html(page);
  const og = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  assert.equal(og, "https://jspratt.dev/games/twenty-boats/card.png");
  assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), "https://jspratt.dev/games/twenty-boats/");
  const { width, height } = await sharp(join(dir, "card.png")).metadata();
  assert.deepEqual([width, height], [1200, 630]);
});

test("every module import and data file the game loads is in the build", () => {
  const modules = files(dir).filter((f) => f.endsWith(".js"));
  assert.ok(modules.length > 5);
  for (const file of modules) {
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\()'([^']+)'/g)) {
      assert.ok(spec.startsWith("./"), `${relative(dir, file)} imports ${spec}: keep imports relative`);
      const target = join(dirname(file), spec.replace(/\?.*$/, ""));
      assert.ok(existsSync(target), `${relative(dir, file)} imports ${spec}, which isn't built`);
    }
  }
  const main = readFileSync(join(dir, "twenty-boats.js"), "utf8");
  const data = main.match(/const DATA = \[([^\]]+)\]/)?.[1].match(/'([^']+)'/g) ?? [];
  assert.ok(data.length > 0);
  for (const name of data) assert.ok(existsSync(join(dir, "data", `${name.slice(1, -1)}.json`)), `${name}.json is built`);
  assert.ok(existsSync(join(dir, "twenty-boats.css")));
});

test("the game stays under 300 KB, not counting its share card", () => {
  const bytes = files(dir)
    .filter((f) => !f.endsWith("card.png"))
    .reduce((sum, f) => sum + statSync(f).size, 0);
  assert.ok(bytes < 300 * 1024, `${(bytes / 1024).toFixed(0)} KB`);
});

test("every ?v= cache key in the game and its page is the same", () => {
  const sources = [site.read(page), ...files(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8"))];
  const keys = new Set(sources.flatMap((s) => [...s.matchAll(/\?v=([\w-]+)/g)].map((m) => m[1])));
  const main = readFileSync(join(dir, "twenty-boats.js"), "utf8");
  keys.add(main.match(/const CACHE_BUST = '([^']+)'/)?.[1] ?? "missing");
  assert.equal(keys.size, 1, [...keys].join(", "));
});

test("the game reports Plays and Finishes to an address the Worker runs for", () => {
  const play = readFileSync(join(dir, "play.js"), "utf8");
  assert.match(play, /fetch\('\/games\/twenty-boats\/event'/);
  const config = readFileSync("wrangler.jsonc", "utf8");
  for (const path of ["/games/twenty-boats/", "/games/twenty-boats/event"]) {
    assert.ok(config.includes(`"${path}"`), `${path} is in run_worker_first`);
  }
});

test("the page preloads every module and data file the game loads", () => {
  const doc = site.html(page);
  const modules = doc.querySelectorAll('link[rel="modulepreload"]').map((l) => l.getAttribute("href"));
  assert.ok(modules.some((h) => /^\/games\/twenty-boats\/twenty-boats\.js\?v=/.test(h ?? "")), "the game's entry module");
  assert.ok(modules.some((h) => /^\/games\/twenty-boats\/story\.js\?v=/.test(h ?? "")));
  for (const href of modules) assert.ok(existsSync(join(site.outDir, href!.replace(/\?.*$/, ""))), `${href} is built`);
  const data = doc.querySelectorAll('link[rel="preload"][as="fetch"]');
  assert.equal(data.length, 7);
  for (const l of data) {
    assert.equal(l.getAttribute("crossorigin"), "anonymous", "matches fetch()'s mode, or the preload is wasted");
    assert.ok(existsSync(join(site.outDir, l.getAttribute("href")!.replace(/\?.*$/, ""))));
  }
});

test("the game page loads none of the site's styles and sets the game's own colours", () => {
  const doc = site.html(page);
  assert.equal(doc.querySelectorAll('link[rel="stylesheet"]').length, 0, "no site stylesheet to restyle the game");
  assert.doesNotMatch(doc.querySelector("style")?.text ?? "", /(^|[\s,}])(main|ul|h1|h2|a)\s*[{,]/, "no element rules that reach into the game");
  const colours = doc.querySelectorAll('meta[name="theme-color"]');
  assert.deepEqual(
    colours.map((m) => [m.getAttribute("media") ?? null, m.getAttribute("content")]),
    [["(prefers-color-scheme: dark)", "#1c1915"], [null, "#efe7d6"]],
  );
});

test("games are served without being stored, so a deploy is live on the next load", () => {
  assert.match(readFileSync(join(site.outDir, "_headers"), "utf8"), /^\/games\/\*\n\s+Cache-Control: no-store$/m);
});
