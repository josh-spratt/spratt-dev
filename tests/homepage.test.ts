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

test("Intro shows the role line, bio and Links including a mailto", () => {
  const intro = buildSite(fixtures).html("index.html").querySelector("header");
  assert.ok(intro);
  assert.match(intro.text, /Fixture role line/);
  assert.match(intro.text, /Fixture bio sentence one/);
  const hrefs = intro.querySelectorAll("a").map((a) => a.getAttribute("href"));
  assert.deepEqual(hrefs, [
    "https://github.com/fixture",
    "https://www.linkedin.com/in/fixture",
    "mailto:fixture@example.com",
  ]);
});

test("Homepage shows every Project with its link, after the Intro", () => {
  const html = buildSite(fixtures).html("index.html");
  const rows = html.querySelectorAll("section > ul > li");
  assert.equal(rows.length, 2);
  const [alpha, beta] = rows.map((r) => r.querySelector("a"));
  assert.equal(alpha?.getAttribute("href"), "https://example.com/alpha");
  assert.match(alpha?.text ?? "", /Fixture Alpha/);
  assert.match(alpha?.text ?? "", /First fixture project\./);
  assert.equal(beta?.getAttribute("href"), "https://example.com/beta");
  const body = html.querySelector("main")!.innerHTML;
  assert.ok(body.indexOf("Fixture bio") < body.indexOf("Fixture Alpha"));
});

test("Project tags render when present and not otherwise", () => {
  const rows = buildSite(fixtures).html("index.html").querySelectorAll("section > ul > li");
  assert.deepEqual(rows[0].querySelectorAll("[data-tag]").map((t) => t.text), ["Rust", "SQL"]);
  assert.equal(rows[1].querySelectorAll("[data-tag]").length, 0);
});

test("Building with a Project missing url fails", () => {
  assert.throws(
    () => buildSite({ contentDir: "tests/fixtures/invalid-project", mode: "production" }),
    /./,
  );
});

test("Real content has the launch Project and a real mailto", () => {
  const html = buildSite().html("index.html");
  const hrefs = html.querySelectorAll("section > ul > li > a").map((a) => a.getAttribute("href"));
  assert.deepEqual(hrefs, ["https://github.com/josh-spratt/marinaraDB"]);
  assert.ok(html.querySelector('a[href="mailto:josh@jspratt.dev"]'));
});

test("A Project's logo renders when it has one and not otherwise", () => {
  const rows = buildSite(fixtures).html("index.html").querySelectorAll("section > ul > li");
  assert.equal(rows[0].querySelector("img")?.getAttribute("src"), "/projects/alpha.png");
  assert.equal(rows[1].querySelector("img"), null);
});
