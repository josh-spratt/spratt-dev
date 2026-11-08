import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSite } from "./helpers.ts";

const site = buildSite({ contentDir: "tests/fixtures/content", mode: "production" });
const doc = site.html("404.html");

test("the 404 screen shows the warning triangle and the message", () => {
  assert.match(doc.querySelector("main")?.text ?? "", /That page doesn't exist/);
  const icon = doc.querySelector("main [data-icon=warning]");
  assert.ok(icon, "a CSS-drawn warning icon");
  assert.equal(icon.getAttribute("aria-hidden"), "true");
});

test("the screen has one Go home key, linking to /", () => {
  const links = doc.querySelectorAll("main a");
  assert.equal(links.length, 1);
  assert.equal(links[0].text.trim(), "Go home");
  assert.equal(links[0].getAttribute("href"), "/");
});

test("the 404 is the handheld, not the old error dialog, and the path isn't echoed", () => {
  assert.ok(doc.querySelector("[data-handheld]"));
  assert.equal(doc.querySelector(".window, .dialog"), null);
  assert.doesNotMatch(doc.querySelector("main")?.text ?? "", /\//);
});

test("the 404 is titled Not found", () => {
  assert.ok(doc.querySelector("title")?.text.includes("Not found"));
});
