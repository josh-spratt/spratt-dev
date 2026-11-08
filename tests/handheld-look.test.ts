import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { buildSite, pageCss } from "./helpers.ts";

// The posts fixture has Projects and Posts, so every kind of page is built.
const site = buildSite({ contentDir: "tests/fixtures/posts/content", mode: "production" });
const css = pageCss(site);

/** Every built .html file under a directory, relative to the build. */
function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? htmlFiles(join(dir, e.name))
      : e.name.endsWith(".html")
        ? [relative(site.outDir, join(dir, e.name))]
        : [],
  );
}

const pages = htmlFiles(site.outDir);

test("every kind of page is built", () => {
  for (const p of ["index.html", "404.html", "writing/index.html", "writing/newer-post/index.html"]) {
    assert.ok(pages.includes(p), `${p} is built`);
  }
});

test("every page uses the handheld and shows the three Links", () => {
  for (const page of pages) {
    const doc = site.html(page);
    assert.equal(doc.querySelectorAll("[data-handheld]").length, 1, `${page} has one handheld`);
    const links = doc.querySelectorAll('nav[aria-label="Links"] a').map((a) => a.getAttribute("href"));
    assert.deepEqual(
      links,
      ["https://github.com/fixture", "https://www.linkedin.com/in/fixture", "mailto:fixture@example.com"],
      `${page} shows the Links`,
    );
  }
});

test("the name is the h1 on the Homepage and a link to / everywhere else", () => {
  const home = site.html("index.html");
  assert.equal(home.querySelector("[data-name]")?.tagName, "H1");
  assert.equal(home.querySelector("[data-name]")?.text, "Fixture Person");
  for (const page of pages.filter((p) => p !== "index.html")) {
    const name = site.html(page).querySelector("[data-name]");
    assert.equal(name?.tagName, "A", `${page}: the name is a link`);
    assert.equal(name?.getAttribute("href"), "/");
    assert.equal(name?.text, "Fixture Person");
  }
});

test("decorative chrome is aria-hidden and contains nothing focusable, on every page", () => {
  for (const page of pages) {
    const chrome = site.html(page).querySelectorAll("[data-chrome]");
    assert.ok(chrome.length > 0, `${page} has chrome`);
    for (const el of chrome) {
      assert.equal(el.getAttribute("aria-hidden"), "true", `${page}: chrome is aria-hidden`);
      assert.equal(el.hasAttribute("tabindex"), false);
      assert.equal(
        el.querySelectorAll("a, button, input, select, textarea, summary, [tabindex], [contenteditable]").length,
        0,
        `${page}: chrome has nothing focusable`,
      );
    }
  }
});

test("the LCD readout shows Done and the Project count", () => {
  assert.match(site.html("index.html").querySelector(".lcd")?.text ?? "", /^Done · 2 projects$/);
});

test("the Links come before the Project rows in source order", () => {
  const html = site.read("index.html");
  const links = html.indexOf('aria-label="Links"');
  const firstRow = html.indexOf('href="https://example.com/alpha"');
  assert.ok(links > -1 && firstRow > -1);
  assert.ok(links < firstRow);
});

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

/** The raw value of a custom property declared in the shipped CSS. */
function declared(name: string): string {
  const m = css.match(new RegExp(`${name}\\s*:\\s*([^;}]+)`));
  assert.ok(m, `token ${name} is declared`);
  return m[1].trim().toLowerCase();
}

/** A custom property declared as a hex colour, expanded to #rrggbb. */
function token(name: string): string {
  const value = declared(name);
  const m = value.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/);
  assert.ok(m, `token ${name} is a hex colour, got ${value}`);
  return m[1].length === 3 ? `#${[...m[1]].map((c) => c + c).join("")}` : value;
}

test("the plastic, screen and buttons use the chosen values", () => {
  assert.equal(declared("--accent"), "#2a3fb0");
  // rgba(118, 78, 196, .58); the minifier may ship it as 8-digit hex.
  assert.match(declared("--plastic"), /^(rgba\(118, ?78, ?196, ?0?\.58\)|#764ec494)$/);
  assert.equal(declared("--button-light"), "#f0473c");
  assert.equal(declared("--button-dark"), "#b0161b");
  assert.equal(declared("--button-side"), "#6a0c10");
  assert.equal(declared("--screen-top"), "#f4f7ff");
  assert.equal(declared("--screen-bottom"), "#e6edff");
  assert.equal(declared("--page"), "#dfe3f7");
  assert.match(css, /--dots:[^;]*16px 16px/);
});

test("text meets 4.5:1 on the band it sits on", () => {
  const pairs: [string, string][] = [
    // On the screen; its darkest band is the bottom of the gradient.
    ["--ink", "--screen-bottom"],
    ["--ink-soft", "--screen-bottom"],
    ["--link", "--screen-bottom"],
    ["--role", "--screen-bottom"],
    // On a lit row.
    ["--ink", "--row-lit-bottom"],
    ["--ink-soft", "--row-lit-bottom"],
    ["--link", "--row-lit-bottom"],
    // In a Post's code block.
    ["--ink", "--code-bottom"],
    ["--astro-code-foreground", "--code-bottom"],
    ["--astro-code-token-comment", "--code-bottom"],
    ["--astro-code-token-constant", "--code-bottom"],
    ["--astro-code-token-function", "--code-bottom"],
    ["--astro-code-token-keyword", "--code-bottom"],
    ["--astro-code-token-link", "--code-bottom"],
    ["--astro-code-token-parameter", "--code-bottom"],
    ["--astro-code-token-punctuation", "--code-bottom"],
    ["--astro-code-token-string", "--code-bottom"],
    ["--astro-code-token-string-expression", "--code-bottom"],
    // The 404's Go home key.
    ["--on-key", "--key"],
    ["--on-key", "--key-hover"],
    // On the plastic: plain, over a background dot, and in the tray behind the buttons.
    ["--label", "--plastic-solid"],
    ["--label", "--plastic-dot"],
    ["--label", "--tray"],
    // The pinned phone strip, over whatever scrolls beneath it.
    ["--strip-label", "--strip-over-screen"],
    ["--strip-label", "--strip-over-bezel"],
    ["--strip-label", "--strip-over-page"],
    // The bezel and the LCD readout.
    ["--bezel-label", "--bezel-solid"],
    ["--ink", "--lcd-bottom"],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test("the large name's outline meets 3:1 on the plastic", () => {
  for (const [fg, bg] of [
    ["--name-stroke", "--plastic-solid"],
    ["--name-stroke", "--plastic-dot"],
  ]) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= 3, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test("type is plain CSS: no web fonts, Trebuchet MS body, Verdana labels", () => {
  assert.doesNotMatch(css, /@font-face|fonts\.googleapis/);
  assert.match(declared("--font-body"), /^"trebuchet ms"/);
  assert.match(declared("--font-label"), /^verdana, tahoma/);
  assert.match(declared("--font-mono"), /monospace$/);
});

/** The bodies of every @media block whose condition matches, joined. */
function mediaBlocks(condition: RegExp): string {
  const bodies: string[] = [];
  for (const m of css.matchAll(/@media([^{]*)\{/g)) {
    if (!condition.test(m[1])) continue;
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; depth > 0 && i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    bodies.push(css.slice(start, i - 1));
  }
  return bodies.join("\n");
}

/** The declarations of `selector`'s rule inside a block of CSS. */
function rule(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = block.match(new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${selector} has a rule`);
  return m[1];
}

test("upright phones pin the buttons to the bottom of the screen and stack the rows", () => {
  const phone = mediaBlocks(/\(\s*max-width:\s*600px\s*\)|\(\s*width\s*<=\s*600px\s*\)/);
  assert.ok(phone, "a ≤600px media query exists");
  const controls = rule(phone, ".controls");
  assert.match(controls, /position:\s*sticky/);
  assert.match(controls, /bottom:\s*0/);
  assert.match(controls, /env\(safe-area-inset-bottom\)/);
  assert.match(rule(phone, ".buttons i"), /width:\s*44px/);
  assert.match(phone, /\.rows a[^{]*\{[^}]*grid-template-columns:\s*1fr/);
});

test("sideways phones move the buttons into a strip down the right side", () => {
  const side = mediaBlocks(/orientation:\s*landscape\)\s*and\s*\(\s*(?:max-height:\s*|height\s*<=\s*)500px/);
  assert.ok(side, "a short landscape media query exists");
  assert.match(rule(side, ".handheld"), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*112px/);
  const controls = rule(side, ".controls");
  // The right-hand column; the minifier may fold grid-row/grid-column into grid-area.
  assert.match(controls, /grid-column:\s*2\b|grid-area:\s*[^/;]+\/\s*2\b/);
  assert.match(controls, /position:\s*sticky/);
  assert.match(rule(side, ".buttons i"), /width:\s*44px/);
});

test("the pages ask for the full screen so the safe-area insets apply", () => {
  assert.match(site.html("index.html").querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "", /viewport-fit=cover/);
});

test("any animation respects prefers-reduced-motion", () => {
  assert.match(css, /@keyframes/, "the power LED pulses");
  const reduced = mediaBlocks(/prefers-reduced-motion:\s*reduce/);
  assert.match(rule(reduced, ".led"), /animation:\s*none/);
});

test("every Link and row has a focus ring that shows up on the band behind it", () => {
  // On the screen: the accent. On the plastic (the name, the desktop buttons): the plastic's label ink.
  assert.match(rule(css, "a:focus-visible"), /outline:\s*3px solid var\(--accent\)/);
  assert.match(css, /\.name:focus-visible[^{]*\{[^}]*outline-color:\s*var\(--label\)/);
  assert.match(css, /\.buttons a:focus-visible[^{]*\{[^}]*outline-color:\s*var\(--label\)/);
  // On the pinned strips, white like the labels.
  for (const strip of [
    mediaBlocks(/\(\s*max-width:\s*600px\s*\)|\(\s*width\s*<=\s*600px\s*\)/),
    mediaBlocks(/orientation:\s*landscape\)\s*and\s*\(\s*(?:max-height:\s*|height\s*<=\s*)500px/),
  ]) {
    assert.match(rule(strip, ".buttons a:focus-visible"), /outline-color:\s*var\(--strip-label\)/);
  }
  // Lit like hover.
  assert.match(css, /\.buttons a:is\(:hover,\s*:focus-visible\)/);
  assert.match(css, /\.rows a:is\(:hover,\s*:focus-visible\)/);
});

test("no page ships a script, apart from the analytics beacon", () => {
  const beacon = /^https:\/\/static\.cloudflareinsights\.com\//;
  for (const page of pages) {
    for (const s of site.html(page).querySelectorAll("script")) {
      assert.match(s.getAttribute("src") ?? "", beacon, `${page} ships a script`);
    }
  }
});

test("Lighthouse budget: the built site stays under 100 KB", () => {
  // The social image is only fetched by link-preview crawlers, never by a page load.
  const total = (dir: string): number =>
    readdirSync(dir).reduce((sum, f) => {
      const p = join(dir, f);
      if (f === "social.png") return sum;
      return sum + (statSync(p).isDirectory() ? total(p) : statSync(p).size);
    }, 0);
  assert.ok(total(site.outDir) < 100 * 1024);
});
