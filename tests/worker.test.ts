import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { unstable_startWorker } from "wrangler";
import { parse } from "node-html-parser";
import { buildSite, type Site } from "./helpers.ts";
import { dashboardQuery, renderDashboard, sameString, windowDays } from "../worker/dashboard.ts";
import {
  gameEventPath,
  gamePage,
  interestSlug,
  likeLabel,
  likeSlug,
  parseGameEvent,
  postSlug,
  refTag,
  referrerHost,
  shouldCount,
  statsText,
} from "../worker/stats.ts";

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

let site: Site;
let worker: Worker;
let persist: string;

const LIVE = "https://jspratt.dev";
const STATS_KEY = "test-stats-key";
const navigate = { "sec-fetch-mode": "navigate" };

/** Run SQL against the same local D1 the Worker uses. */
function sql(command: string): Record<string, unknown>[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "spratt-dev", "--local", "--persist-to", persist, "--json", "--command", command],
    { stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  return JSON.parse(out.toString())[0].results;
}

const views = (slug: string) => sql(`SELECT views FROM post_stats WHERE slug = '${slug}'`)[0]?.views;
const likes = (slug: string) => sql(`SELECT likes FROM post_stats WHERE slug = '${slug}'`)[0]?.likes;
const viewLog = (slug: string) =>
  sql(`SELECT referrer, ref, is_me FROM view_log WHERE slug = '${slug}' ORDER BY id`);
const gameLog = () => sql("SELECT game, event, ending, survived, referrer, ref, is_me FROM game_log ORDER BY id");
const interest = (slug: string) => sql(`SELECT COUNT(*) AS n FROM interest WHERE slug = '${slug}'`)[0].n;

interface Got {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * A request through the local Worker. Uses node:http, not fetch: undici always
 * overwrites Sec-Fetch-Mode with "cors", so fetch can't act like a browser
 * navigation. The Host header stands in for the site's hostname.
 */
async function send(method: string, url: string, headers: Record<string, string>, body?: string): Promise<Got> {
  const target = new URL(url);
  const local = await worker.url;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method,
        host: local.hostname,
        port: local.port,
        path: target.pathname + target.search,
        headers: { ...headers, host: target.host },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const get = (url: string, headers: Record<string, string> = navigate) => send("GET", url, headers);

/** A browser submitting a Post form (Like or email interest) on the page at `url`'s origin. */
const like = (url: string, headers: Record<string, string> = {}) =>
  send("POST", url, { origin: new URL(url).origin, ...headers });

/** The game's own script reporting a Play or a Finish from a page on `url`'s origin. */
const report = (url: string, event: object, headers: Record<string, string> = {}) =>
  send("POST", url, { origin: new URL(url).origin, "content-type": "application/json", ...headers }, JSON.stringify(event));

const stats = (body: string) => /<span data-stats[^>]*>([^<]*)<\/span>/.exec(body)?.[1];
const likeText = (body: string) => /<span data-like-label[^>]*>([^<]*)<\/span>/.exec(body)?.[1];

before(async () => {
  site = buildSite({ contentDir: "tests/fixtures/posts/content", mode: "production" });
  persist = mkdtempSync(join(tmpdir(), "spratt-dev-d1-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "spratt-dev", "--local", "--persist-to", persist], {
    stdio: "pipe",
    env: { ...process.env, CI: "1" },
  });
  worker = await unstable_startWorker({
    config: "wrangler.jsonc",
    assets: site.outDir,
    bindings: { STATS_KEY: { type: "secret_text", value: STATS_KEY } },
    dev: { persist, server: { port: 0 }, inspector: false, watch: false, logLevel: "none" },
  });
});

after(async () => {
  await worker?.dispose();
});

test("postSlug matches Post pages only", () => {
  assert.equal(postSlug("/writing/newer-post/"), "newer-post");
  assert.equal(postSlug("/writing/"), null);
  assert.equal(postSlug("/writing/rss.xml"), null);
  assert.equal(postSlug("/writing/newer-post"), null);
  assert.equal(postSlug("/writing/a/b/"), null);
});

test("likeSlug matches the Like action only", () => {
  assert.equal(likeSlug("/writing/newer-post/like"), "newer-post");
  assert.equal(likeSlug("/writing/newer-post/"), null);
  assert.equal(likeSlug("/writing/newer-post/like/"), null);
});

test("likeLabel shows the state and, once there is one, the count", () => {
  assert.equal(likeLabel(0, false), "Like");
  assert.equal(likeLabel(12, false), "Like · 12");
  assert.equal(likeLabel(1234, true), "Liked · 1,234");
});

test("statsText reads naturally", () => {
  assert.equal(statsText(1), " · Read 1 time");
  assert.equal(statsText(1234), " · Read 1,234 times");
});

test("the static Post ships an empty stats placeholder and a plain Like form", () => {
  const html = site.read("writing/newer-post/index.html");
  assert.equal(stats(html), "");
  const form = site.html("writing/newer-post/index.html").querySelector("form.like");
  assert.equal(form?.getAttribute("method"), "post");
  assert.equal(form?.getAttribute("action"), "/writing/newer-post/like");
  assert.equal(form?.querySelector("button")?.getAttribute("type"), "submit");
  assert.equal(likeText(html), "Like");
});

test("a browser View on the live site is counted and shown, uncached", async () => {
  const first = await get(`${LIVE}/writing/newer-post/`);
  assert.equal(first.status, 200);
  assert.equal(stats(first.body), " · Read 1 time");
  assert.equal(first.headers["cache-control"], "no-store");
  const second = await get(`${LIVE}/writing/newer-post/`);
  assert.equal(stats(second.body), " · Read 2 times");
  assert.equal(views("newer-post"), 2);
});

test("a request without Sec-Fetch-Mode (crawler, curl) is not counted but still sees the count", async () => {
  const before = views("newer-post");
  const { body } = await get(`${LIVE}/writing/newer-post/`, {});
  assert.equal(views("newer-post"), before);
  assert.equal(stats(body), ` · Read ${before} times`);
});

test("a preview hostname reads counts but never writes", async () => {
  await get("https://views.spratt-dev.example.workers.dev/writing/older-post/");
  assert.equal(views("older-post"), undefined);
});

test("an unknown slug creates no row and still gets the 404 page", async () => {
  const { status, body } = await get(`${LIVE}/writing/not-a-post/`);
  assert.equal(status, 404);
  assert.equal(body, site.read("404.html"));
  assert.equal(views("not-a-post"), undefined);
});

test("/writing/ and the feed pass through unchanged", async () => {
  assert.equal((await get(`${LIVE}/writing/`)).body, site.read("writing/index.html"));
  assert.equal((await get(`${LIVE}/writing/rss.xml`)).body, site.read("writing/rss.xml"));
});

test("a Like on the live site adds one, sets the cookie and redirects back", async () => {
  const res = await like(`${LIVE}/writing/newer-post/like`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/writing/newer-post/?liked");
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /^liked=1; /);
  assert.match(cookie, /Path=\/writing\/newer-post\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(likes("newer-post"), 1);
});

test("the redirect back after a Like isn't a new View, and shows Liked", async () => {
  const before = views("newer-post");
  const { body } = await get(`${LIVE}/writing/newer-post/?liked`, { ...navigate, cookie: "liked=1" });
  assert.equal(views("newer-post"), before);
  assert.equal(likeText(body), "Liked · 1");
});

test("other browsers see the count without the Liked state", async () => {
  assert.equal(likeText((await get(`${LIVE}/writing/newer-post/`, {})).body), "Like · 1");
});

test("a browser that already liked a Post can't like it again", async () => {
  const res = await like(`${LIVE}/writing/newer-post/like`, { cookie: "liked=1" });
  assert.equal(res.status, 303);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(likes("newer-post"), 1);
});

test("a Like from another site, or with no Origin, is refused", async () => {
  assert.equal((await like(`${LIVE}/writing/newer-post/like`, { origin: "https://evil.example" })).status, 403);
  assert.equal((await send("POST", `${LIVE}/writing/newer-post/like`, {})).status, 403);
  assert.equal(likes("newer-post"), 1);
});

test("a Like only accepts POST", async () => {
  const res = await get(`${LIVE}/writing/newer-post/like`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "POST");
});

test("a Like for an unknown slug creates no row", async () => {
  assert.equal((await like(`${LIVE}/writing/not-a-post/like`)).status, 404);
  assert.equal(likes("not-a-post"), undefined);
});

test("a Like on a preview redirects back but never writes", async () => {
  const res = await like("https://views.spratt-dev.example.workers.dev/writing/older-post/like");
  assert.equal(res.status, 303);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(likes("older-post"), undefined);
});

test("interestSlug matches the email-interest action only", () => {
  assert.equal(interestSlug("/writing/newer-post/interest"), "newer-post");
  assert.equal(interestSlug("/writing/newer-post/"), null);
  assert.equal(interestSlug("/writing/newer-post/interest/"), null);
});

test("the redirect back after answering isn't a View", () => {
  const nav = (url: string) => new Request(url, { headers: navigate });
  assert.equal(shouldCount(nav(`${LIVE}/writing/newer-post/`)), true);
  assert.equal(shouldCount(nav(`${LIVE}/writing/newer-post/?interested`)), false);
});

test("the static Post ships the email-interest question as a plain form", () => {
  const forms = site.html("writing/newer-post/index.html").querySelectorAll("form.interest");
  assert.equal(forms.length, 1, "the question appears once");
  const form = forms[0];
  assert.equal(form?.getAttribute("method"), "post");
  assert.equal(form?.getAttribute("action"), "/writing/newer-post/interest");
  assert.equal(form?.getAttribute("id"), "interest");
  assert.equal(form?.querySelector("button")?.getAttribute("type"), "submit");
  assert.equal(form?.querySelectorAll("input").length, 0, "nothing is collected");
});

test("answering on the live site records a row, sets a site-wide cookie and redirects to the thank-you", async () => {
  const res = await like(`${LIVE}/writing/newer-post/interest`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/writing/newer-post/?interested#interest");
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /^interested=1; /);
  assert.match(cookie, /Path=\/writing\/;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.equal(interest("newer-post"), 1);
});

test("a browser that has answered sees the thank-you on every Post, not the form", async () => {
  for (const slug of ["newer-post", "older-post"]) {
    const { body } = await get(`${LIVE}/writing/${slug}/`, { cookie: "interested=1" });
    assert.doesNotMatch(body, /<form class="interest"/);
    assert.match(body, /<p class="interest" id="interest">Thanks\./);
  }
  assert.match((await get(`${LIVE}/writing/older-post/`, {})).body, /<form class="interest"/);
});

test("a browser that has answered can't answer again, even on another Post", async () => {
  const res = await like(`${LIVE}/writing/older-post/interest`, { cookie: "interested=1" });
  assert.equal(res.status, 303);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(interest("older-post"), 0);
});

test("an answer from another site, by GET, or for an unknown slug is refused", async () => {
  assert.equal((await like(`${LIVE}/writing/newer-post/interest`, { origin: "https://evil.example" })).status, 403);
  assert.equal((await get(`${LIVE}/writing/newer-post/interest`)).status, 405);
  assert.equal((await like(`${LIVE}/writing/not-a-post/interest`)).status, 404);
  assert.equal(interest("newer-post"), 1);
  assert.equal(interest("not-a-post"), 0);
});

test("an answer on a preview redirects back but never writes", async () => {
  const res = await like("https://views.spratt-dev.example.workers.dev/writing/older-post/interest");
  assert.equal(res.status, 303);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(interest("older-post"), 0);
});

test("referrerHost keeps only the hostname", () => {
  const req = (referer?: string) => new Request(LIVE, { headers: referer ? { referer } : {} });
  assert.equal(referrerHost(req("https://news.ycombinator.com/item?id=1")), "news.ycombinator.com");
  assert.equal(referrerHost(req("not a url")), null);
  assert.equal(referrerHost(req()), null);
});

test("refTag is cleaned and capped", () => {
  assert.equal(refTag(new URL(`${LIVE}/writing/newer-post/?ref=BlueSky`)), "bluesky");
  assert.equal(refTag(new URL(`${LIVE}/writing/newer-post/?ref=<script>`)), "script");
  assert.equal(refTag(new URL(`${LIVE}/writing/newer-post/?ref=${"a".repeat(100)}`))?.length, 40);
  assert.equal(refTag(new URL(`${LIVE}/writing/newer-post/?ref=`)), null);
  assert.equal(refTag(new URL(`${LIVE}/writing/newer-post/`)), null);
});

test("every counted View is logged with where it came from", async () => {
  const slug = "older-post";
  await get(`${LIVE}/writing/${slug}/?ref=bluesky`, { ...navigate, referer: "https://bsky.app/" });
  await get(`${LIVE}/writing/${slug}/`);
  await get(`${LIVE}/writing/${slug}/`, {}); // a crawler: neither counted nor logged
  assert.deepEqual(viewLog(slug), [
    { referrer: "bsky.app", ref: "bluesky", is_me: 0 },
    { referrer: null, ref: null, is_me: 0 },
  ]);
  assert.equal(views(slug), 2);
});

test("a preview never logs a View", async () => {
  await get("https://views.spratt-dev.example.workers.dev/writing/older-post/");
  assert.equal(viewLog("older-post").length, 2);
});

test("/writing/?me marks the browser as the owner's", async () => {
  const res = await get(`${LIVE}/writing/?me`);
  assert.equal(res.status, 200);
  assert.match(res.body, /marked as yours/);
  assert.equal(res.headers["cache-control"], "no-store");
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /^me=1; /);
  assert.match(cookie, /Path=\/;/, "the whole site, so it reaches the Games too");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.equal((await get(`${LIVE}/writing/`)).body, site.read("writing/index.html"), "plain /writing/ is unchanged");
});

test("the owner's Views are logged as theirs but leave the public count alone", async () => {
  const slug = "older-post";
  const { body } = await get(`${LIVE}/writing/${slug}/`, { ...navigate, cookie: "me=1" });
  assert.equal(stats(body), " · Read 2 times");
  assert.equal(views(slug), 2);
  assert.deepEqual(viewLog(slug).at(-1), { referrer: null, ref: null, is_me: 1 });
});

test("gamePage and gameEventPath match a known Game only", () => {
  assert.equal(gamePage("/games/twenty-boats/"), "twenty-boats");
  assert.equal(gamePage("/games/twenty-boats/play.js"), null);
  assert.equal(gamePage("/games/not-a-game/"), null);
  assert.equal(gameEventPath("/games/twenty-boats/event"), "twenty-boats");
  assert.equal(gameEventPath("/games/not-a-game/event"), null);
  assert.equal(gameEventPath("/games/twenty-boats/event/"), null);
});

test("parseGameEvent keeps a Play or a Finish and cleans where it came from", () => {
  assert.deepEqual(parseGameEvent(JSON.stringify({ event: "play", ref: "HN", referrer: "https://news.ycombinator.com/item?id=1" })), {
    event: "play",
    ending: null,
    survived: null,
    referrer: "news.ycombinator.com",
    ref: "hn",
  });
  assert.deepEqual(parseGameEvent(JSON.stringify({ event: "finish", ending: "boat-7", survived: true })), {
    event: "finish",
    ending: "boat-7",
    survived: 1,
    referrer: null,
    ref: null,
  });
  for (const bad of [
    "not json",
    "null",
    JSON.stringify({ event: "view" }),
    JSON.stringify({ event: "finish", ending: "<b>", survived: true }),
    JSON.stringify({ event: "finish", ending: "boat-7" }),
    JSON.stringify({ event: "play", ref: "x".repeat(2000) }),
  ]) {
    assert.equal(parseGameEvent(bad), null, bad);
  }
});

test("a browser View of a Game's page is logged with its source, and the page is served as built", async () => {
  const res = await get(`${LIVE}/games/twenty-boats/?ref=hn`, { ...navigate, referer: "https://news.ycombinator.com/" });
  assert.equal(res.status, 200);
  assert.equal(res.body, site.read("games/twenty-boats/index.html"));
  await get(`${LIVE}/games/twenty-boats/`, {}); // a crawler: not logged
  await get("https://views.spratt-dev.example.workers.dev/games/twenty-boats/"); // a preview: not logged
  await get(`${LIVE}/games/twenty-boats/`, { ...navigate, cookie: "me=1" });
  assert.deepEqual(gameLog(), [
    { game: "twenty-boats", event: "view", ending: null, survived: null, referrer: "news.ycombinator.com", ref: "hn", is_me: 0 },
    { game: "twenty-boats", event: "view", ending: null, survived: null, referrer: null, ref: null, is_me: 1 },
  ]);
});

test("the game's other files don't run the Worker's logging", async () => {
  const before = gameLog().length;
  const res = await get(`${LIVE}/games/twenty-boats/play.js`);
  assert.equal(res.status, 200);
  assert.equal(gameLog().length, before);
});

test("the game reports Plays and Finishes on the live site, the owner's flagged", async () => {
  const url = `${LIVE}/games/twenty-boats/event`;
  const from = { ref: "hn", referrer: "https://news.ycombinator.com/" };
  const play = await report(url, { event: "play", ...from });
  assert.equal(play.status, 204);
  assert.equal(play.headers["cache-control"], "no-store");
  assert.equal((await report(url, { event: "finish", ending: "water-lost", survived: false, ...from })).status, 204);
  assert.equal((await report(url, { event: "play" }, { cookie: "me=1" })).status, 204);
  assert.deepEqual(gameLog().slice(-3), [
    { game: "twenty-boats", event: "play", ending: null, survived: null, referrer: "news.ycombinator.com", ref: "hn", is_me: 0 },
    { game: "twenty-boats", event: "finish", ending: "water-lost", survived: 0, referrer: "news.ycombinator.com", ref: "hn", is_me: 0 },
    { game: "twenty-boats", event: "play", ending: null, survived: null, referrer: null, ref: null, is_me: 1 },
  ]);
});

test("a game report from another site, by GET, malformed, or on a preview writes nothing", async () => {
  const before = gameLog().length;
  const url = `${LIVE}/games/twenty-boats/event`;
  assert.equal((await report(url, { event: "play" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await send("POST", url, {}, JSON.stringify({ event: "play" }))).status, 403);
  assert.equal((await get(url)).status, 405);
  assert.equal((await report(url, { event: "finish" })).status, 400);
  assert.equal((await report("https://views.spratt-dev.example.workers.dev/games/twenty-boats/event", { event: "play" })).status, 204);
  // Not a Game, so the Worker doesn't run and the assets refuse the POST.
  assert.equal((await report(`${LIVE}/games/not-a-game/event`, { event: "play" })).status, 405);
  assert.equal(gameLog().length, before);
});

/** Opens the dashboard with the key and returns the cookie it sets. */
async function statsLogin(): Promise<string> {
  const res = await get(`${LIVE}/stats/?key=${STATS_KEY}`, {});
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/stats/");
  return String(res.headers["set-cookie"]).split(";")[0];
}

test("/stats/ is the ordinary 404 page without the key, with a wrong key or wrong cookie", async () => {
  for (const [url, headers] of [
    [`${LIVE}/stats/`, {}],
    [`${LIVE}/stats/?key=wrong`, {}],
    [`${LIVE}/stats/`, { cookie: "stats=nope" }],
    [`${LIVE}/stats/posts.json`, {}],
  ] as const) {
    const res = await get(url, headers);
    assert.equal(res.status, 404, url);
    assert.equal(res.body, site.read("404.html"));
    assert.equal(res.headers["set-cookie"], undefined);
  }
});

test("the key sets a hashed, /stats/-scoped cookie and redirects the key out of the address bar", async () => {
  const res = await get(`${LIVE}/stats/?key=${STATS_KEY}`, {});
  assert.equal(res.headers["cache-control"], "no-store");
  const cookie = String(res.headers["set-cookie"]);
  assert.match(cookie, /^stats=[0-9a-f]{64}; /);
  assert.doesNotMatch(cookie, new RegExp(STATS_KEY));
  assert.match(cookie, /Path=\/stats\/;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});

test("the dashboard shows Views, Likes, sources and tags from D1, uncached and unindexed", async () => {
  const cookie = await statsLogin();
  const res = await get(`${LIVE}/stats/`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(String(res.headers["x-robots-tag"]), /noindex/);
  assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
  const page = parse(res.body);
  assert.equal(page.querySelectorAll("script").length, 0, "no client script");
  const row = (title: string) =>
    page.querySelectorAll("tbody tr").find((tr) => tr.querySelector("td")?.text.startsWith(title))!;
  // Earlier tests: newer-post had 2 counted Views and 1 Like; older-post 2 Views plus one of the owner's.
  const newer = row("Newer Post").querySelectorAll("td").map((td) => td.text.trim());
  assert.deepEqual(newer, ["Newer Post", "AI Career", "2", "2", "1", "1"]);
  const older = row("Older Post").querySelectorAll("td").map((td) => td.text.trim());
  assert.deepEqual(older.slice(2), ["2", "2", "0", "0"], "the owner's View is left out");
  assert.ok(row("bluesky"), "a ?ref= tag is a source");
  assert.ok(row("AI"), "tags are listed");
  // Earlier tests: one counted View, one Play and one Finish of Twenty Boats, all from hn; the owner's left out.
  const game = row("Twenty Boats").querySelectorAll("td").map((td) => td.text.trim());
  assert.deepEqual(game, ["Twenty Boats", "1", "1", "1", "0"]);
  const hn = row("hn").querySelectorAll("td").map((td) => td.text.trim());
  assert.deepEqual(hn, ["hn", "1", "1", "1"]);
  assert.deepEqual(row("water-lost").querySelectorAll("td").map((td) => td.text.trim()), ["water-lost", "no", "1"]);
});

test("the dashboard can include the owner's Views", async () => {
  const cookie = await statsLogin();
  const page = parse((await get(`${LIVE}/stats/?me`, { cookie })).body);
  const older = page.querySelectorAll("tbody tr").find((tr) => tr.querySelector("td")?.text.startsWith("Older Post"))!;
  assert.equal(older.querySelectorAll("td")[2].text.trim(), "3");
  assert.match(page.text, /\(you\)/);
});

test("dashboardQuery only accepts the offered windows", () => {
  assert.deepEqual(dashboardQuery(new URL(`${LIVE}/stats/`)), { days: 30, withMe: false });
  assert.deepEqual(dashboardQuery(new URL(`${LIVE}/stats/?days=7&me`)), { days: 7, withMe: true });
  assert.equal(dashboardQuery(new URL(`${LIVE}/stats/?days=1000`)).days, 30);
});

test("windowDays ends today and has one entry per day", () => {
  const days = windowDays(7, new Date("2026-03-10T12:00:00Z"));
  assert.deepEqual([days.length, days[0], days.at(-1)], [7, "2026-03-04", "2026-03-10"]);
});

test("sameString compares whole strings", () => {
  assert.equal(sameString("abc", "abc"), true);
  assert.equal(sameString("abc", "abd"), false);
  assert.equal(sameString("abc", "ab"), false);
});

test("the dashboard escapes everything that came from a reader", () => {
  const html = renderDashboard(
    { days: 7, withMe: false },
    {
      posts: [],
      daily: [],
      windowViews: [{ slug: "<b>x</b>", views: 1 }],
      totals: [],
      interest: [],
      sources: [{ source: "<script>alert(1)</script>", views: 1 }],
      recent: [{ created_at: "2026-03-10 12:00:00", slug: "<i>", source: "\"><img>", is_me: 0 }],
      games: [{ game: "<u>", views: 1, plays: 1, finishes: 0, lived: 0 }],
      gameSources: [{ source: "<s>", views: 1, plays: 1, finishes: 0 }],
      endings: [{ ending: "<em>", survived: 0, finishes: 1 }],
    },
  );
  assert.doesNotMatch(html, /<script>|<img>|<b>x|<i>|<u>|<s>|<em>/);
  assert.match(html, /&lt;script&gt;/);
});
