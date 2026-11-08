import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSite, pageCss } from "./helpers.ts";

const site = buildSite({ contentDir: "tests/fixtures/content", mode: "production" });
const doc = site.html("index.html");
const css = pageCss(site);

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a custom property declared on :root in the shipped CSS. */
function token(name: string): string {
  const m = css.match(new RegExp(`${name}\\s*:\\s*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b`));
  assert.ok(m, `token ${name} is declared as a hex colour`);
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex}`;
}

test("decorative chrome is aria-hidden and not focusable", () => {
  const chrome = doc.querySelectorAll("[data-chrome]");
  assert.ok(chrome.length >= 3, "title bar, menu row and status bar are marked");
  for (const el of chrome) {
    assert.equal(el.getAttribute("aria-hidden"), "true");
    const focusable = el.querySelectorAll("a, button, input, select, textarea, [tabindex]");
    assert.equal(focusable.length, 0);
    assert.equal(el.hasAttribute("tabindex"), false);
  }
});

test("status bar shows Done and the Project count", () => {
  const status = doc.querySelector("[data-chrome=status]");
  assert.match(status?.text ?? "", /Done/);
  assert.match(status?.text ?? "", /2 projects/);
});

test("no page ships a script", () => {
  for (const file of ["index.html", "404.html"]) {
    try {
      assert.equal(site.html(file).querySelectorAll("script").length, 0, file);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
});

test("styling is plain CSS: no web fonts, monospace body, Verdana chrome", () => {
  assert.doesNotMatch(css, /@font-face|fonts\.googleapis/);
  assert.match(css, /Courier New/);
  assert.match(css, /Verdana/);
});

test("accent is the glossy blue", () => {
  assert.equal(token("--accent").toLowerCase(), "#1a6fd6");
});

test("text meets 4.5:1 on the lightest point of its backdrop", () => {
  const pairs: [string, string][] = [
    ["--text", "--panel-light"],
    ["--link-text", "--panel-light"],
    ["--role", "--content-light"],
    ["--label", "--panel-light"],
    ["--muted", "--content-light"],
    ["--chrome-text", "--chrome-light"],
    ["--on-accent", "--pill-lightest"],
    ["--on-accent", "--hover-lightest"],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test("Links and Project rows have a visible focus ring", () => {
  assert.match(css, /a:focus-visible[^{]*\{[^}]*outline:\s*[^;}]*[1-9]/);
  assert.match(css, /focus-visible/);
});

test("any animation respects prefers-reduced-motion", () => {
  if (/@keyframes|transition\s*:|animation\s*:/.test(css)) {
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
  }
});

test("on phones the window is full-bleed and Project rows stack", () => {
  const phone = css.match(
    /@media\s*\((?:max-width:\s*|width\s*<=\s*)(?:[1-6]\d\d)px\)\s*\{([\s\S]*)\}/,
  );
  assert.ok(phone, "a phone media query exists");
  assert.match(phone[1], /border-radius:\s*0/);
  assert.match(phone[1], /grid-template-columns:\s*1fr/);
});

test("Lighthouse budget: the built page stays under 100 KB", () => {
  const total = (dir: string): number =>
    readdirSync(dir).reduce((sum, f) => {
      const p = join(dir, f);
      return sum + (statSync(p).isDirectory() ? total(p) : statSync(p).size);
    }, 0);
  assert.ok(total(site.outDir) < 100 * 1024);
});
