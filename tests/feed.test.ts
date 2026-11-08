import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "node-html-parser";
import { buildSite } from "./helpers.ts";

const posts = (mode: "production" | "preview") =>
  ({ contentDir: "tests/fixtures/posts/content", mode }) as const;
const many = { contentDir: "tests/fixtures/many/content", mode: "production" } as const;
const zero = { contentDir: "tests/fixtures/zero/content", mode: "production" } as const;

const rssLink = 'link[rel="alternate"][type="application/rss+xml"]';

test("The feed is well-formed RSS with full content, newest first", () => {
  const xml = buildSite(posts("production")).read("writing/rss.xml");
  const feed = parse(xml, { comment: false });
  assert.ok(xml.startsWith("<?xml"));
  const items = feed.querySelectorAll("item");
  assert.equal(items.length, 2);
  assert.match(items[0].querySelector("title")!.text, /Newer Post/);
  assert.match(xml, /<link>https:\/\/jspratt\.dev\/writing\/newer-post\/<\/link>/);
  assert.match(xml, /Hello newer\./);
  assert.match(xml, /content:encoded/);
});

test("The feed builds with zero Posts", () => {
  const xml = buildSite(zero).read("writing/rss.xml");
  assert.equal(parse(xml).querySelectorAll("item").length, 0);
});

test("The RSS alternate link appears only when Posts exist", () => {
  const withPosts = buildSite(posts("production"));
  for (const page of ["index.html", "writing/index.html", "writing/newer-post/index.html"]) {
    const link = withPosts.html(page).querySelector(rssLink);
    assert.ok(link, page);
    assert.equal(link.getAttribute("href"), "/writing/rss.xml");
  }
  const none = buildSite(zero);
  assert.equal(none.html("index.html").querySelector(rssLink), null);
  assert.equal(none.html("writing/index.html").querySelector(rssLink), null);
});

test("Recent writing is absent with zero published Posts", () => {
  const html = buildSite(zero).html("index.html");
  assert.equal(html.querySelector("#recent-writing"), null);
  assert.doesNotMatch(html.text, /Recent writing/);
});

test("Recent writing shows the latest three Posts, newest first", () => {
  const panel = buildSite(many).html("index.html").querySelector("section.recent-writing");
  assert.ok(panel);
  assert.equal(panel.querySelector("h2")?.text, "Recent writing");
  const links = panel.querySelectorAll("li a");
  assert.deepEqual(links.map((a) => a.getAttribute("href")), [
    "/writing/post-4/",
    "/writing/post-3/",
    "/writing/post-2/",
  ]);
});

test("A Draft is absent from the feed and Recent writing in production, present in preview", () => {
  const prod = buildSite(posts("production"));
  assert.doesNotMatch(prod.read("writing/rss.xml"), /Secret Draft/);
  assert.doesNotMatch(prod.read("index.html"), /Secret Draft/);
  const preview = buildSite(posts("preview"));
  assert.match(preview.read("writing/rss.xml"), /Secret Draft/);
  assert.match(preview.read("index.html"), /Secret Draft/);
});
