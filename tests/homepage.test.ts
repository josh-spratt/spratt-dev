import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSite } from "./helpers.ts";

test("Homepage shows the name from the content location", () => {
  const site = buildSite({
    contentDir: "tests/fixtures/content",
    mode: "production",
  });
  assert.equal(site.html("index.html").querySelector("h1")?.text, "Fixture Person");
});

test("Homepage builds from the real content by default", () => {
  const site = buildSite();
  assert.equal(site.html("index.html").querySelector("h1")?.text, "Josh Spratt");
});

const fixtures = { contentDir: "tests/fixtures/content", mode: "production" } as const;

test("Intro shows the role line, bio and Links, each a Click out", () => {
  const html = buildSite(fixtures).html("index.html");
  const screen = html.querySelector("main");
  assert.ok(screen);
  assert.match(screen.text, /Fixture role line/);
  assert.match(screen.text, /Fixture bio sentence one/);
  const hrefs = html.querySelectorAll('nav[aria-label="Links"] a').map((a) => a.getAttribute("href"));
  assert.deepEqual(hrefs, ["/out/github/", "/out/linkedin/", "/out/email/"]);
});

test("every Click out name is on the build's list, with a plain page that goes on to the real address", () => {
  const built = buildSite(fixtures);
  assert.deepEqual(JSON.parse(built.read("out/links.json")), {
    github: "https://github.com/fixture",
    linkedin: "https://www.linkedin.com/in/fixture",
    email: "mailto:fixture@example.com",
    "fixture-alpha": "https://example.com/alpha",
    "fixture-beta": "https://example.com/beta",
  });
  const page = built.html("out/fixture-alpha/index.html");
  assert.equal(page.querySelector('meta[name="robots"]')?.getAttribute("content"), "noindex");
  assert.equal(page.querySelector('meta[http-equiv="refresh"]')?.getAttribute("content"), "0; url=https://example.com/alpha");
  assert.equal(page.querySelector("a")?.getAttribute("href"), "https://example.com/alpha");
  assert.doesNotMatch(built.read("sitemap-0.xml"), /\/out\//, "Click outs aren't in the sitemap");
});

const projectRows = 'section[aria-labelledby="projects"] > ul > li';
const gameRows = 'section[aria-labelledby="games"] > ul > li';

test("Homepage shows every Project with its link, after the Intro", () => {
  const html = buildSite(fixtures).html("index.html");
  const rows = html.querySelectorAll(projectRows);
  assert.equal(rows.length, 2);
  const [alpha, beta] = rows.map((r) => r.querySelector("a"));
  assert.equal(alpha?.getAttribute("href"), "/out/fixture-alpha/");
  assert.match(alpha?.text ?? "", /Fixture Alpha/);
  assert.match(alpha?.text ?? "", /First fixture project\./);
  assert.equal(beta?.getAttribute("href"), "/out/fixture-beta/");
  const body = html.querySelector("main")!.innerHTML;
  assert.ok(body.indexOf("Fixture bio") < body.indexOf("Fixture Alpha"));
});

test("Project tags render when present and not otherwise", () => {
  const rows = buildSite(fixtures).html("index.html").querySelectorAll(projectRows);
  assert.deepEqual(rows[0].querySelectorAll("[data-tag]").map((t) => t.text), ["Rust", "SQL"]);
  assert.equal(rows[1].querySelectorAll("[data-tag]").length, 0);
});

test("Building with a Project missing url fails", () => {
  assert.throws(
    () => buildSite({ contentDir: "tests/fixtures/invalid-project", mode: "production" }),
    /./,
  );
});

test("Real content has the Projects, the Games apart from them, and a real mailto", () => {
  const built = buildSite();
  const html = built.html("index.html");
  const hrefs = (block: string) =>
    html.querySelectorAll(`section[aria-labelledby="${block}"] li > a`).map((a) => a.getAttribute("href"));
  assert.deepEqual(hrefs("projects"), ["/out/marinaradb/"]);
  assert.deepEqual(hrefs("games"), ["/games/cactus-boats/", "/games/twenty-boats/"]);
  const out = JSON.parse(built.read("out/links.json"));
  assert.equal(out.marinaradb, "https://github.com/josh-spratt/marinaraDB");
  assert.equal(out.email, "mailto:josh@jspratt.dev");
});

test("Homepage shows the Games block, each Game leading to its own page, between the Intro and Projects", () => {
  const html = buildSite(fixtures).html("index.html");
  const block = html.querySelector('section[aria-labelledby="games"]');
  assert.equal(block?.querySelector("h2")?.text, "Games");
  const rows = html.querySelectorAll(gameRows);
  assert.equal(rows.length, 2);
  const [first, second] = rows.map((r) => r.querySelector("a"));
  assert.equal(first?.getAttribute("href"), "/games/fixture-game/");
  assert.match(first?.text ?? "", /Fixture Game/);
  assert.match(first?.text ?? "", /First fixture game\./);
  assert.equal(rows[0].querySelector("img")?.getAttribute("src"), "/game-thumbs/fixture-game.webp");
  assert.deepEqual(rows[0].querySelectorAll("[data-tag]").map((t) => t.text), ["Arcade"]);
  assert.equal(second?.getAttribute("href"), "/games/other-game/");
  assert.equal(rows[1].querySelector("img"), null);
  assert.equal(rows[1].querySelectorAll("[data-tag]").length, 0);
  assert.equal(block?.querySelector(".more"), null, "every Game is already shown");
  const body = html.querySelector("main")!.innerHTML;
  assert.ok(body.indexOf("Fixture bio") < body.indexOf("Fixture Game"));
  assert.ok(body.indexOf("Fixture Game") < body.indexOf("Fixture Alpha"));
});

test("Homepage shows the first three Games and links to the Games page for the rest", () => {
  const html = buildSite({ contentDir: "tests/fixtures/many/content", mode: "production" }).html("index.html");
  assert.deepEqual(html.querySelectorAll(gameRows).map((r) => r.querySelector("a")?.getAttribute("href")), [
    "/games/game-1/",
    "/games/game-2/",
    "/games/game-3/",
  ]);
  assert.equal(html.querySelector('section[aria-labelledby="games"] .more a')?.getAttribute("href"), "/games/");
});

test("Without games.json there's no Games block or Games link", () => {
  const html = buildSite({ contentDir: "tests/fixtures/zero/content", mode: "production" }).html("index.html");
  assert.equal(html.querySelector('section[aria-labelledby="games"]'), null);
  assert.equal(html.querySelector('a[href="/games/"]'), null);
});

test("Building with a Game whose slug isn't a page name fails", () => {
  assert.throws(() => buildSite({ contentDir: "tests/fixtures/invalid-game", mode: "production" }), /./);
});

test("The Games page lists every Game in the site's layout, not full screen", () => {
  const site = buildSite(fixtures);
  const doc = site.html("games/index.html");
  assert.equal(doc.querySelector("title")?.text, "Games | Fixture Person");
  assert.equal(doc.querySelector("h1")?.text, "Games");
  assert.ok(doc.querySelector("header.site-header"), "it has the site's header");
  assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), "https://jspratt.dev/games/");
  const rows = doc.querySelectorAll("main ul.games > li");
  assert.deepEqual(rows.map((r) => r.querySelector("a")?.getAttribute("href")), ["/games/fixture-game/", "/games/other-game/"]);
  assert.match(rows[0].text, /Fixture Game/);
  assert.match(rows[0].text, /First fixture game\./);
  assert.equal(rows[0].querySelector("img")?.getAttribute("src"), "/game-thumbs/fixture-game.webp");
  assert.deepEqual(rows[0].querySelectorAll("[data-tag]").map((t) => t.text), ["Arcade"]);
});

test("A Project's logo renders when it has one and not otherwise", () => {
  const rows = buildSite(fixtures).html("index.html").querySelectorAll(projectRows);
  assert.equal(rows[0].querySelector("img")?.getAttribute("src"), "/projects/alpha.png");
  assert.equal(rows[1].querySelector("img"), null);
});
