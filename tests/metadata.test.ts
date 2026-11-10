import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSite } from "./helpers.ts";

const site = buildSite({ contentDir: "tests/fixtures/posts/content", mode: "production" });

const meta = (doc: ReturnType<typeof site.html>, selector: string) =>
  doc.querySelector(selector)?.getAttribute("content");

const pages = [
  {
    file: "index.html",
    url: "https://jspratt.dev/",
    title: "Fixture Person — Fixture role line",
    description: "Fixture homepage description.",
    type: "website",
  },
  {
    file: "writing/index.html",
    url: "https://jspratt.dev/writing/",
    title: "Writing — Fixture Person",
    description: "Writing by Fixture Person.",
    type: "website",
  },
  {
    file: "writing/newer-post/index.html",
    url: "https://jspratt.dev/writing/newer-post/",
    title: "Newer Post — Fixture Person",
    description: "The newer one.",
    type: "article",
  },
  {
    file: "404.html",
    url: undefined, // served at any URL, so there is nothing to canonicalise
    title: "Not found — Fixture Person",
    description: undefined,
    type: "website",
  },
];

for (const p of pages) {
  test(`${p.file} has title, canonical, Open Graph, Twitter, lang and theme-color`, () => {
    const doc = site.html(p.file);
    assert.equal(doc.querySelector("title")?.text, p.title);
    assert.equal(doc.querySelector("html")?.getAttribute("lang"), "en");
    assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), p.url);
    assert.equal(meta(doc, 'meta[name="theme-color"]'), "#f2c230");
    assert.equal(meta(doc, 'meta[property="og:title"]'), p.title);
    assert.equal(meta(doc, 'meta[property="og:url"]'), p.url);
    assert.equal(meta(doc, 'meta[property="og:type"]'), p.type);
    assert.equal(meta(doc, 'meta[property="og:image"]'), "https://jspratt.dev/social.png");
    assert.ok(meta(doc, 'meta[property="og:image:alt"]'));
    assert.equal(meta(doc, 'meta[name="twitter:card"]'), "summary_large_image");
    assert.equal(doc.querySelector('meta[name="twitter:site"]'), null);
    assert.equal(meta(doc, 'meta[name="description"]'), p.description);
    assert.equal(meta(doc, 'meta[property="og:description"]'), p.description);
  });
}

test("icons are present and referenced", () => {
  for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png", "social.png"]) {
    assert.ok(existsSync(join(site.outDir, f)), `${f} exists`);
  }
  const doc = site.html("index.html");
  assert.equal(doc.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute("href"), "/favicon.svg");
  assert.equal(doc.querySelector('link[rel="icon"][sizes="32x32"]')?.getAttribute("href"), "/favicon.ico");
  assert.equal(doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"), "/apple-touch-icon.png");
  assert.equal(doc.querySelector('link[rel="manifest"]'), null);
});

test("robots.txt points at the sitemap, which lists pages but not Drafts", () => {
  assert.match(site.read("robots.txt"), /^Sitemap: https:\/\/jspratt\.dev\/sitemap-index\.xml$/m);
  const index = site.read("sitemap-index.xml");
  assert.match(index, /sitemap-0\.xml/);
  const map = site.read("sitemap-0.xml");
  assert.match(map, /https:\/\/jspratt\.dev\/writing\/newer-post\//);
  assert.doesNotMatch(map, /secret-draft/);
});
