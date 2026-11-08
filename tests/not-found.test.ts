import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSite } from "./helpers.ts";

const site = buildSite({ contentDir: "tests/fixtures/content", mode: "production" });
const doc = site.html("404.html");

test("the 404 is an error dialog with the message", () => {
  assert.equal(doc.querySelector("[data-chrome=title]")?.text.trim(), "Error");
  assert.match(doc.querySelector("main")?.text ?? "", /The page you're looking for can't be found\./);
  assert.ok(doc.querySelector("[data-icon=warning]"), "a CSS-drawn warning icon");
});

test("the OK pill links to /", () => {
  const links = doc.querySelectorAll("main a");
  assert.equal(links.length, 1);
  assert.equal(links[0].text.trim(), "OK");
  assert.equal(links[0].getAttribute("href"), "/");
});

test("there is no big window behind the dialog, and the path isn't echoed", () => {
  assert.equal(doc.querySelectorAll(".window").length, 1);
  assert.ok(doc.querySelector(".window.dialog"));
  assert.equal(doc.querySelector("[data-chrome=status]"), null);
});

test("dialog chrome is aria-hidden and not focusable", () => {
  const chrome = doc.querySelectorAll("[data-chrome]");
  assert.ok(chrome.length >= 1);
  for (const el of chrome) {
    assert.equal(el.getAttribute("aria-hidden"), "true");
    assert.equal(el.querySelectorAll("a, button, input, select, textarea, [tabindex]").length, 0);
  }
  assert.equal(doc.querySelector("[data-icon=warning]")?.getAttribute("aria-hidden"), "true");
});

test("the 404 links the shared stylesheet and is not indexed as content", () => {
  assert.ok(doc.querySelector("title")?.text.includes("Not found"));
});
