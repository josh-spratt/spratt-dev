import assert from "node:assert/strict";
import { test } from "node:test";
import { isHolidaySeason } from "../src/lib/holiday.ts";
import { buildSite } from "./helpers.ts";

const on = (y: number, m: number, d: number, h = 12) => isHolidaySeason(new Date(y, m - 1, d, h));

test("the Holiday season runs from 20 November through Christmas Day, every year", () => {
  assert.equal(on(2026, 11, 19, 23), false);
  assert.equal(on(2026, 11, 20, 0), true);
  assert.equal(on(2026, 12, 1), true);
  assert.equal(on(2026, 12, 25, 23), true);
  assert.equal(on(2026, 12, 26, 0), false, "gone on Boxing Day");
  assert.equal(on(2027, 1, 1), false);
  assert.equal(on(2027, 7, 4), false);
  assert.equal(on(2027, 11, 25), true, "back next year");
});

test("every site page boots the Holiday from its head, and loads the decorations only in season", () => {
  const site = buildSite({ contentDir: "tests/fixtures/posts/content", mode: "production" });
  for (const page of ["index.html", "writing/index.html", "writing/newer-post/index.html", "games/index.html", "404.html"]) {
    const boot = site.html(page).querySelector("head script[data-holiday-script]");
    assert.ok(boot, `${page} boots the Holiday in its head`);
    assert.ok(!boot.hasAttribute("src"), `${page}'s boot is inline, so it runs before the first paint`);
    const asset = (name: string, ext: string) => {
      const href = boot.text.match(new RegExp(`"(/_astro/${name}\\.[\\w-]+\\.${ext})"`))?.[1];
      assert.ok(href, `${page} loads the hashed ${name}.${ext}`);
      return site.read(href.slice(1));
    };
    assert.match(asset("holiday", "js"), /data-holiday-toggle/, "the decorations build the switch");
    assert.match(asset("holiday-decorations", "css"), /\.lights/, "and style the lights");
    // The season check runs first: out of season nothing is marked and nothing loads.
    assert.ok(boot.text.indexOf("isHolidaySeason") < boot.text.indexOf("createElement"));
  }
});
