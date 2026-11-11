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

test("every page has the header with Writing and the three Links", () => {
  for (const page of pages) {
    const doc = site.html(page);
    const header = doc.querySelector("header.site-header");
    assert.ok(header, `${page} has the header`);
    assert.equal(header.querySelector('nav[aria-label="Site"] a')?.getAttribute("href"), "/writing/", `${page} links to Writing`);
    const links = header.querySelectorAll('nav[aria-label="Links"] a').map((a) => a.getAttribute("href"));
    assert.deepEqual(
      links,
      ["https://github.com/fixture", "https://www.linkedin.com/in/fixture", "mailto:fixture@example.com"],
      `${page} shows the Links`,
    );
  }
});

test("Writing is marked as the current page on /writing and its Posts only", () => {
  const current = (page: string) => site.html(page).querySelector('nav[aria-label="Site"] a')?.getAttribute("aria-current");
  assert.equal(current("writing/index.html"), "page");
  assert.equal(current("writing/newer-post/index.html"), "page");
  assert.equal(current("index.html"), undefined);
});

test("the name is the first h1 on the Homepage and a header link to / everywhere else", () => {
  const home = site.html("index.html");
  const names = home.querySelectorAll("[data-name]");
  assert.equal(names.length, 1, "the header leaves the name out on the Homepage");
  assert.equal(names[0].tagName, "H1");
  assert.equal(names[0].text, "Fixture Person");
  assert.ok(home.querySelector("main")?.innerHTML.trimStart().includes("Fixture Person"));
  for (const page of pages.filter((p) => p !== "index.html")) {
    const name = site.html(page).querySelector("header [data-name]");
    assert.equal(name?.tagName, "A", `${page}: the name is a link`);
    assert.equal(name?.getAttribute("href"), "/");
    assert.equal(name?.text.trim(), "Fixture Person");
  }
});

test("the main content scrolls with the page, with a skip link to it", () => {
  for (const page of pages) {
    const doc = site.html(page);
    assert.equal(doc.querySelector("main")?.getAttribute("id"), "content", page);
    assert.equal(doc.querySelector("a.skip")?.getAttribute("href"), "#content", page);
  }
  assert.doesNotMatch(css, /overflow-y:\s*auto/, "nothing scrolls inside a box");
});

test("the Homepage links to all writing only when there are more Posts than it shows", () => {
  // The fixture has two Posts and Recent writing shows three.
  assert.equal(site.html("index.html").querySelector(".more"), null);
  const many = buildSite({ contentDir: "tests/fixtures/many/content", mode: "production" });
  assert.equal(many.html("index.html").querySelector(".more a")?.getAttribute("href"), "/writing/");
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

test("text meets 4.5:1 on the background it sits on", () => {
  const pairs: [string, string][] = [
    // The page.
    ["--ink", "--page"],
    ["--ink-soft", "--page"],
    ["--link", "--page"],
    // The yellow column, where the header, Intro and footer sit.
    ["--ink", "--band"],
    ["--ink-soft", "--band"],
    ["--link", "--band"],
    // Cards and the white keys.
    ["--ink", "--card"],
    ["--ink-soft", "--card"],
    ["--link", "--card"],
    ["--ink", "--row-hover"],
    // The role line: yellow on ink.
    ["--yellow", "--ink"],
    // A Post's code block.
    ["--astro-code-foreground", "--code-bg"],
    ["--astro-code-token-comment", "--code-bg"],
    ["--astro-code-token-constant", "--code-bg"],
    ["--astro-code-token-function", "--code-bg"],
    ["--astro-code-token-keyword", "--code-bg"],
    ["--astro-code-token-link", "--code-bg"],
    ["--astro-code-token-parameter", "--code-bg"],
    ["--astro-code-token-punctuation", "--code-bg"],
    ["--astro-code-token-string", "--code-bg"],
    ["--astro-code-token-string-expression", "--code-bg"],
    // Writing in the header and the 404's Go home.
    ["--on-key", "--key"],
    ["--on-key", "--key-hover"],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test("type is plain CSS: no web fonts, system sans, serif Post prose", () => {
  assert.doesNotMatch(css, /@font-face|fonts\.googleapis/);
  assert.match(declared("--font-body"), /^system-ui/);
  assert.match(declared("--font-prose"), /serif$/);
  assert.match(declared("--font-mono"), /monospace$/);
});

test("links have a visible focus ring", () => {
  assert.match(css, /a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent\)/);
});

test("any motion respects prefers-reduced-motion", () => {
  const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^@]*)/)?.[1] ?? "";
  assert.match(reduced, /\.rows a\s*[,{][^}]*transition:\s*none/);
  assert.match(reduced, /\.brick\s*[,{][^}]*animation:\s*none/, "the bricks are already built");
});

test("the brick stack is in the Homepage Intro only, aria-hidden and with nothing focusable", () => {
  const stack = site.html("index.html").querySelectorAll(".hero [data-chrome]");
  assert.equal(stack.length, 1);
  assert.equal(stack[0].getAttribute("aria-hidden"), "true");
  assert.equal(stack[0].querySelectorAll("a, button, [tabindex]").length, 0);
  for (const page of pages.filter((p) => p !== "index.html")) {
    assert.equal(site.html(page).querySelector("[data-chrome]"), null, `${page} has no brick stack`);
  }
});

test("no page ships a script, apart from the analytics beacon", () => {
  const beacon = /^https:\/\/static\.cloudflareinsights\.com\//;
  for (const page of pages) {
    for (const s of site.html(page).querySelectorAll("script")) {
      assert.match(s.getAttribute("src") ?? "", beacon, `${page} ships a script`);
    }
  }
});

test("production pages carry exactly one analytics beacon with the site token", () => {
  for (const page of pages) {
    const scripts = site.html(page).querySelectorAll('script[src^="https://static.cloudflareinsights.com/"]');
    assert.equal(scripts.length, 1, `${page} has one beacon`);
    assert.equal(JSON.parse(scripts[0].getAttribute("data-cf-beacon")!).token, "fixture-token");
    assert.ok(scripts[0].hasAttribute("defer"), `${page} defers the beacon`);
  }
});

test("preview builds, and sites without a token, ship no beacon", () => {
  const preview = buildSite({ contentDir: "tests/fixtures/posts/content", mode: "preview" });
  assert.equal(preview.html("index.html").querySelectorAll("script").length, 0);
  const noToken = buildSite({ contentDir: "tests/fixtures/content", mode: "production" });
  assert.equal(noToken.html("index.html").querySelectorAll("script").length, 0);
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
