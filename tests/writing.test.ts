import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSite } from "./helpers.ts";

const fixtures = (mode: "production" | "preview") =>
  ({ contentDir: "tests/fixtures/posts/content", mode }) as const;

test("A Post is served at /writing/<slug>/ from its filename", () => {
  const page = buildSite(fixtures("production")).html("writing/newer-post/index.html");
  assert.equal(page.querySelector("h1")?.text, "Newer Post");
  assert.match(page.text, /Hello newer\./);
});

test("/writing lists published Posts newest first with title link, date and description", () => {
  const rows = buildSite(fixtures("production")).html("writing/index.html").querySelectorAll("main li");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector("a")?.getAttribute("href"), "/writing/newer-post/");
  assert.equal(rows[0].querySelector("a")?.text, "Newer Post");
  assert.ok(rows[0].querySelector("time")?.getAttribute("datetime")?.startsWith("2026-03-10"));
  assert.match(rows[0].text, /The newer one\./);
  assert.equal(rows[1].querySelector("a")?.text, "Older Post");
});

test("An updated date is shown only when set", () => {
  const site = buildSite(fixtures("production"));
  const withUpdate = site.html("writing/newer-post/index.html");
  assert.ok(withUpdate.querySelector('time[data-updated]'));
  assert.ok(withUpdate.querySelector('time[data-updated]')!.getAttribute("datetime")!.startsWith("2026-04-01"));
  assert.equal(site.html("writing/older-post/index.html").querySelector("time[data-updated]"), null);
});

test("A Draft is absent from its route and /writing in production", () => {
  const site = buildSite(fixtures("production"));
  assert.equal(existsSync(join(site.outDir, "writing/secret-draft/index.html")), false);
  assert.doesNotMatch(site.read("writing/index.html"), /Secret Draft/);
});

test("A Draft is present in preview", () => {
  const site = buildSite(fixtures("preview"));
  assert.match(site.html("writing/secret-draft/index.html").text, /Draft body\./);
  assert.match(site.read("writing/index.html"), /Secret Draft/);
});

test("A Post missing title, description or date fails the build", () => {
  assert.throws(
    () => buildSite({ contentDir: "tests/fixtures/posts-invalid/content", mode: "production" }),
    /./,
  );
});

test("/writing builds with zero Posts", () => {
  const site = buildSite({ contentDir: "tests/fixtures/zero/content", mode: "production" });
  assert.equal(site.html("writing/index.html").querySelectorAll("main li").length, 0);
});

test("Code blocks are highlighted at build time with no client JS", () => {
  const page = buildSite(fixtures("production")).html("writing/newer-post/index.html");
  assert.ok(page.querySelector("pre.astro-code"));
  assert.equal(page.querySelectorAll("script:not([data-cf-beacon])").length, 0);
});

test("Homepage does not link to /writing when there are no Posts", () => {
  const html = buildSite({ contentDir: "tests/fixtures/zero/content", mode: "production" }).read("index.html");
  assert.doesNotMatch(html, /href="\/writing/);
});

test("A Post's thumbnail shows on /writing and in Recent writing when it has one and not otherwise", () => {
  const site = buildSite(fixtures("production"));
  for (const rows of [
    site.html("writing/index.html").querySelectorAll("main li"),
    site.html("index.html").querySelectorAll("section.recent-writing li"),
  ]) {
    const img = rows[0].querySelector("img");
    assert.equal(img?.getAttribute("src"), "/writing/newer-post.png");
    assert.equal(img?.getAttribute("alt"), "", "it is decorative; the title names the Post");
    assert.equal(rows[1].querySelector("img"), null);
  }
});

test("A Post ends with share links carrying its canonical URL, and ships no script", () => {
  const page = buildSite(fixtures("production")).html("writing/newer-post/index.html");
  const links = page.querySelectorAll(".share a");
  const href = (name: string) => links.find((a) => a.text.trim() === name)?.getAttribute("href");
  const url = encodeURIComponent("https://jspratt.dev/writing/newer-post/");
  assert.equal(href("LinkedIn"), `https://www.linkedin.com/sharing/share-offsite/?url=${url}`);
  assert.equal(href("X"), `https://x.com/intent/post?url=${url}&text=Newer%20Post`);
  assert.equal(href("Bluesky"), `https://bsky.app/intent/compose?text=Newer%20Post%20${url}`);
  assert.equal(href("Email"), `mailto:?subject=Newer%20Post&body=${url}`);
  for (const a of links.filter((a) => a.text.trim() !== "Email")) {
    assert.equal(a.getAttribute("target"), "_blank");
    assert.equal(a.getAttribute("rel"), "noopener");
  }
  // The production analytics beacon is the only script.
  const scripts = page.querySelectorAll("script").map((s) => s.getAttribute("src"));
  assert.deepEqual(scripts, ["https://static.cloudflareinsights.com/beacon.min.js"]);
});
