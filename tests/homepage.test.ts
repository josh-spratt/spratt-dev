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
