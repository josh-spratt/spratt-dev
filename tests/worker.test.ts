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
  cleanInitials,
  gameEventPath,
  gamePage,
  interestSlug,
  leaderboardPath,
  likeLabel,
  maxSinks,
  likeSlug,
  parseGameEvent,
  parseScore,
  parseStart,
  postSlug,
  refTag,
  referrerHost,
  shouldCount,
  statsText,
} from "../worker/stats.ts";
import { maxSpawnedBy } from "../public/games/cactus-boats/sim.js";

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
  assert.equal(gamePage("/games/cactus-boats/"), "cactus-boats");
  assert.equal(gamePage("/games/"), null, "the Games page isn't a Game");
  assert.equal(gamePage("/games/not-a-game/"), null);
  assert.equal(gameEventPath("/games/twenty-boats/event"), "twenty-boats");
  assert.equal(gameEventPath("/games/cactus-boats/event"), "cactus-boats");
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

test("Cactus Boats' page View is logged with its source, and the page is served as built", async () => {
  const before = gameLog().length;
  const res = await get(`${LIVE}/games/cactus-boats/?ref=cb`, { ...navigate, referer: "https://www.reddit.com/r/webgames/" });
  assert.equal(res.status, 200);
  assert.equal(res.body, site.read("games/cactus-boats/index.html"));
  await get(`${LIVE}/games/cactus-boats/`, {}); // a crawler: not logged
  await get("https://views.spratt-dev.example.workers.dev/games/cactus-boats/"); // a preview: not logged
  await get(`${LIVE}/games/cactus-boats/`, { ...navigate, cookie: "me=1" });
  assert.deepEqual(gameLog().slice(before), [
    { game: "cactus-boats", event: "view", ending: null, survived: null, referrer: "www.reddit.com", ref: "cb", is_me: 0 },
    { game: "cactus-boats", event: "view", ending: null, survived: null, referrer: null, ref: null, is_me: 1 },
  ]);
});

test("Cactus Boats reports Plays and sunk Finishes on the live site, the owner's flagged", async () => {
  const before = gameLog().length;
  const url = `${LIVE}/games/cactus-boats/event`;
  const from = { ref: "cb", referrer: "https://www.reddit.com/r/webgames/" };
  assert.equal((await report(url, { event: "play", ...from })).status, 204);
  assert.equal((await report(url, { event: "finish", ending: "sunk", survived: false, ...from })).status, 204);
  assert.equal((await report(url, { event: "play" }, { cookie: "me=1" })).status, 204);
  assert.equal((await report(url, { event: "finish", ending: "sunk", survived: false }, { cookie: "me=1" })).status, 204);
  assert.deepEqual(gameLog().slice(before), [
    { game: "cactus-boats", event: "play", ending: null, survived: null, referrer: "www.reddit.com", ref: "cb", is_me: 0 },
    { game: "cactus-boats", event: "finish", ending: "sunk", survived: 0, referrer: "www.reddit.com", ref: "cb", is_me: 0 },
    { game: "cactus-boats", event: "play", ending: null, survived: null, referrer: null, ref: null, is_me: 1 },
    { game: "cactus-boats", event: "finish", ending: "sunk", survived: 0, referrer: null, ref: null, is_me: 1 },
  ]);
});

test("a Cactus Boats report from another site or on a preview writes nothing", async () => {
  const before = gameLog().length;
  const url = `${LIVE}/games/cactus-boats/event`;
  assert.equal((await report(url, { event: "play" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await report("https://views.spratt-dev.example.workers.dev/games/cactus-boats/event", { event: "play" })).status, 204);
  assert.equal(gameLog().length, before);
});

// The Leaderboard (Cactus Boats). scoreOf is 10 a whole second plus 250 a sink.

test("leaderboardPath matches a Leaderboard Game's three addresses only", () => {
  assert.deepEqual(leaderboardPath("/games/cactus-boats/start"), { game: "cactus-boats", action: "start" });
  assert.deepEqual(leaderboardPath("/games/cactus-boats/score"), { game: "cactus-boats", action: "score" });
  assert.deepEqual(leaderboardPath("/games/cactus-boats/scores"), { game: "cactus-boats", action: "scores" });
  for (const path of ["/games/twenty-boats/score", "/games/cactus-boats/scores/", "/games/cactus-boats/", "/games/cactus-boats/event", "/games/nope/start"]) {
    assert.equal(leaderboardPath(path), null, path);
  }
});

test("cleanInitials keeps exactly three letters, uppercased", () => {
  assert.equal(cleanInitials("abc"), "ABC");
  assert.equal(cleanInitials("JoS"), "JOS");
  for (const bad of ["AB", "ABCD", "A C", "A1C", " ABC", "ÅBC", "", null, 123, ["ABC"]]) {
    assert.equal(cleanInitials(bad), null, String(bad));
  }
});

test("parseScore keeps whole, non-negative numbers, a run id and clean Initials", () => {
  const good = { run: 7, initials: "jos", survivedMs: 61_500, sinks: 3, score: 1360 };
  assert.deepEqual(parseScore(JSON.stringify(good)), { ...good, initials: "JOS" });
  assert.deepEqual(parseScore(JSON.stringify({ ...good, extra: "ignored" })), { ...good, initials: "JOS" });
  for (const bad of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...good, run: 0 }),
    JSON.stringify({ ...good, run: "7" }),
    JSON.stringify({ ...good, initials: "JO" }),
    JSON.stringify({ ...good, survivedMs: -1 }),
    JSON.stringify({ ...good, survivedMs: 1.5 }),
    JSON.stringify({ ...good, sinks: null }),
    JSON.stringify({ ...good, score: 1e300 }),
    JSON.stringify({ ...good, pad: "x".repeat(600) }),
    JSON.stringify({ ...good, initials: "ass" }),
    JSON.stringify({ ...good, initials: "KKK" }),
  ]) {
    assert.equal(parseScore(bad), null, bad.slice(0, 80));
  }
});

test("the Worker's sink cap is the game's own spawner: no more sinks than boats spawned by then", () => {
  for (let ms = 0; ms <= 4 * 60 * 60 * 1000; ms += 997) {
    assert.equal(maxSinks(ms), maxSpawnedBy(ms), `${ms} ms`);
  }
  assert.equal(maxSinks(0), 0);
  assert.equal(maxSinks(1990), 0, "the first boat is warned of at 2 s");
  assert.equal(maxSinks(2000), 1);
});

test("parseStart cleans where the player came from", () => {
  assert.deepEqual(parseStart(JSON.stringify({ ref: "HN!", referrer: "https://news.ycombinator.com/item?id=1" })), {
    ref: "hn",
    referrer: "news.ycombinator.com",
  });
  assert.deepEqual(parseStart("{}"), { ref: null, referrer: null });
  assert.equal(parseStart("nope"), null);
  assert.equal(parseStart(JSON.stringify({ ref: "x".repeat(600) })), null);
});

const BOARD_URL = `${LIVE}/games/cactus-boats`;
const PREVIEW = "https://views.spratt-dev.example.workers.dev";
const scoreRows = () =>
  sql("SELECT id, game, initials, survived_ms, sinks, score, submitted_at IS NOT NULL AS submitted, started_at IS NOT NULL AS started, referrer, ref, is_me FROM scores ORDER BY id");

/** The game's starter asking for a run id; returns it (or null). */
async function startRun(headers: Record<string, string> = {}, url = BOARD_URL, from: object = {}): Promise<number | null> {
  const res = await report(`${url}/start`, from, headers);
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  return JSON.parse(res.body).run;
}

/** Moves a run's start `seconds` into the past, as if the Play had been sailing that long. */
function backdate(run: number | null, seconds: number) {
  sql(`UPDATE scores SET started_at = datetime('now', '-${seconds} seconds') WHERE id = ${Number(run)}`);
}

/** The board as everyone reads it. */
const board = async () => JSON.parse((await get(`${BOARD_URL}/scores`, {})).body).top;

/** A Score for `run` with the right scoreOf, unless `score` says otherwise. */
const submitScore = (run: number | null, initials: string, survivedMs: number, sinks: number, more: object = {}, headers: Record<string, string> = {}, url = BOARD_URL) =>
  report(`${url}/score`, { run, initials, survivedMs, sinks, score: Math.floor(survivedMs / 1000) * 10 + sinks * 250, ...more }, headers);

test("a Play's run gets a Score on the live site: one row, the Worker's own Score, a rank and the top 10", async () => {
  const run = await startRun({}, BOARD_URL, { ref: "hn", referrer: "https://news.ycombinator.com/" });
  assert.ok(Number.isInteger(run));
  assert.deepEqual(scoreRows(), [
    { id: run, game: "cactus-boats", initials: null, survived_ms: null, sinks: null, score: null, submitted: 0, started: 1, referrer: "news.ycombinator.com", ref: "hn", is_me: 0 },
  ]);

  backdate(run, 65);
  const res = await submitScore(run, "jos", 61_500, 3);
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const { rank, top } = JSON.parse(res.body);
  assert.equal(rank, 1);
  assert.equal(top.length, 1);
  assert.deepEqual({ ...top[0], at: undefined }, { initials: "JOS", score: 1360, survivedMs: 61_500, sinks: 3, at: undefined });
  assert.match(top[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(scoreRows(), [
    { id: run, game: "cactus-boats", initials: "JOS", survived_ms: 61_500, sinks: 3, score: 1360, submitted: 1, started: 1, referrer: "news.ycombinator.com", ref: "hn", is_me: 0 },
  ]);
});

test("the board is the top 10, highest first with the earlier run winning a tie, and a Score off it still gets its rank", async () => {
  // Already on the board: JOS 1360. Eleven more, from 100 to 2100 points.
  const ranks: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const run = await startRun();
    backdate(run, 300);
    const res = await submitScore(run, "ABCDEFGHIJL"[i].repeat(3), i * 20_000 + 10_000, 0);
    assert.equal(res.status, 200);
    ranks.push(JSON.parse(res.body).rank);
  }
  // 100, 300 … 2100: each new best goes to the top, except below JOS's 1360 at first.
  assert.deepEqual(ranks, [2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1]);
  const tie = await startRun();
  backdate(tie, 300);
  const tied = JSON.parse((await submitScore(tie, "TIE", 136_000, 0)).body);
  assert.equal(tied.rank, 6, "behind the earlier 1360");

  const res = await get(`${BOARD_URL}/scores`, {});
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  assert.equal(res.headers["cache-control"], "public, max-age=10");
  const { top } = JSON.parse(res.body);
  assert.deepEqual(top, tied.top, "the board after a Score is the board everyone reads");
  assert.deepEqual(
    top.map((e: { initials: string; score: number }) => `${e.initials} ${e.score}`),
    ["LLL 2100", "JJJ 1900", "III 1700", "HHH 1500", "JOS 1360", "TIE 1360", "GGG 1300", "FFF 1100", "EEE 900", "DDD 700"],
  );
  const low = await startRun();
  assert.equal(JSON.parse((await submitScore(low, "LOW", 0, 0)).body).rank, 14, "off the board, after everyone");
});

test("a run nobody scores isn't on the board", async () => {
  await startRun();
  const { top } = JSON.parse((await get(`${BOARD_URL}/scores`, {})).body);
  assert.ok(top.every((e: { initials: string | null }) => e.initials));
});

test("the Leaderboard refuses, and writes nothing for, another site, no Origin, GET, bad bodies, bad Initials, an unknown run or a wrong Score", async () => {
  const run = await startRun();
  const before = scoreRows();
  const evil = { origin: "https://evil.example" };
  // Node sends a Content-Length, so these are refused unread; parseStart and parseScore cap the rest.
  const big = JSON.stringify({ ref: "x".repeat(2000) });
  const refusals: [string, Promise<Got>, number][] = [
    ["start from another site", report(`${BOARD_URL}/start`, {}, evil), 403],
    ["start with no Origin", send("POST", `${BOARD_URL}/start`, {}, "{}"), 403],
    ["start by GET", get(`${BOARD_URL}/start`, {}), 405],
    ["start malformed", send("POST", `${BOARD_URL}/start`, { origin: LIVE }, "{nope"), 400],
    ["start oversized", send("POST", `${BOARD_URL}/start`, { origin: LIVE }, big), 413],
    ["score from another site", submitScore(run, "ABC", 5000, 0, {}, evil), 403],
    ["score with no Origin", send("POST", `${BOARD_URL}/score`, {}, JSON.stringify({ run, initials: "ABC", survivedMs: 5000, sinks: 0, score: 50 })), 403],
    ["score by GET", get(`${BOARD_URL}/score`, {}), 405],
    ["score malformed", send("POST", `${BOARD_URL}/score`, { origin: LIVE }, "[1,2"), 400],
    ["score oversized", submitScore(run, "ABC", 5000, 0, { pad: "x".repeat(2000) }), 413],
    ["two Initials", submitScore(run, "AB", 5000, 0), 400],
    ["four Initials", submitScore(run, "ABCD", 5000, 0), 400],
    ["a digit in the Initials", submitScore(run, "A1C", 5000, 0), 400],
    ["no Initials", submitScore(run, "", 5000, 0), 400],
    ["an unknown run", submitScore(run! + 1000, "ABC", 5000, 0), 400],
    ["no run", submitScore(null, "ABC", 5000, 0), 400],
    ["a Score that isn't scoreOf", submitScore(run, "ABC", 5000, 0, { score: 51 }), 400],
    ["a Score for time not survived", submitScore(run, "ABC", 5000, 0, { score: 1000 }), 400],
    ["scores by POST", report(`${BOARD_URL}/scores`, {}), 405],
  ];
  for (const [what, res, status] of refusals) assert.equal((await res).status, status, what);
  assert.deepEqual(scoreRows(), before);
});

test("a preview reads the live board, but start hands out no run and score writes nothing", async () => {
  const live = JSON.parse((await get(`${BOARD_URL}/scores`, {})).body);
  const before = scoreRows();
  const preview = await get(`${PREVIEW}/games/cactus-boats/scores`, {});
  assert.equal(preview.status, 200);
  assert.deepEqual(JSON.parse(preview.body), live);
  assert.equal(await startRun({}, `${PREVIEW}/games/cactus-boats`), null);
  const unscored = before.find((r) => !r.submitted)!;
  const res = await submitScore(unscored.id as number, "PRE", 999_000, 9, {}, {}, `${PREVIEW}/games/cactus-boats`);
  assert.equal(res.status, 403);
  assert.deepEqual(scoreRows(), before);
});

test("the owner's runs are stored as theirs and their Score still shows on the board", async () => {
  const run = await startRun({ cookie: "me=1" });
  backdate(run, 610);
  const res = await submitScore(run, "JSP", 600_000, 20, {}, { cookie: "me=1" });
  assert.equal(res.status, 200);
  const { rank, top } = JSON.parse(res.body);
  assert.equal(rank, 1);
  assert.equal(top[0].initials, "JSP");
  assert.equal("is_me" in top[0], false, "the board doesn't say whose is whose");
  assert.equal(scoreRows().find((r) => r.id === run)?.is_me, 1);
});

/**
 * Plausibility: each refusal is a 400 that writes nothing, so the run's row
 * and the board are just as they were.
 */
async function assertRefused(run: number | null, initials: string, survivedMs: number, sinks: number) {
  const rows = scoreRows();
  const top = await board();
  const res = await submitScore(run, initials, survivedMs, sinks);
  assert.equal(res.status, 400, res.body);
  assert.deepEqual(scoreRows(), rows, "nothing written");
  assert.deepEqual(await board(), top, "the board is unchanged");
}

test("a Score with rude Initials is refused, and the run can still be scored with others", async () => {
  const run = await startRun();
  backdate(run, 60);
  await assertRefused(run, "ass", 30_000, 1);
  await assertRefused(run, "FUK", 30_000, 1);
  assert.equal((await submitScore(run, "NIC", 30_000, 1)).status, 200);
});

test("a Play is scored once: a second Score for the same run is refused", async () => {
  const run = await startRun();
  backdate(run, 60);
  assert.equal((await submitScore(run, "ONE", 40_000, 2)).status, 200);
  await assertRefused(run, "TWO", 50_000, 3);
  await assertRefused(run, "ONE", 40_000, 2);
});

test("a run older than a few hours can't be scored", async () => {
  const run = await startRun();
  backdate(run, 4 * 60 * 60);
  await assertRefused(run, "OLD", 60_000, 1);
});

test("a Score can't have survived longer than the Play has been going", async () => {
  const run = await startRun();
  backdate(run, 60);
  await assertRefused(run, "FIB", 120_000, 0);
  const fresh = await startRun();
  await assertRefused(fresh, "FIB", 30_000, 0);
});

test("a Score can't sink more boats than the spawner could have sent in the time survived", async () => {
  const run = await startRun();
  backdate(run, 600);
  // 300 s of the curve is 56 arrivals at most.
  await assertRefused(run, "GUN", 300_000, 57);
  await assertRefused(run, "GUN", 1_990, 1);
});

test("a long Play sent the moment it's sunk is accepted, within the small allowance", async () => {
  const run = await startRun();
  backdate(run, 600);
  // The run's start is stamped a little after the Play began (the request's
  // round trip), so a Score a few seconds over the wall clock still counts.
  const res = await submitScore(run, "FST", 603_000, 10);
  assert.equal(res.status, 200, res.body);
  assert.equal(scoreRows().find((r) => r.id === run)?.score, 603 * 10 + 10 * 250);
});

test("a high sink count that fits the spawn curve is accepted", async () => {
  const run = await startRun();
  backdate(run, 610);
  // 600 s of the curve is 154 arrivals at most: sinking every one is allowed.
  const res = await submitScore(run, "ACE", 600_000, 154);
  assert.equal(res.status, 200, res.body);
  const { rank, top } = JSON.parse(res.body);
  assert.equal(rank, 1);
  assert.deepEqual([top[0].initials, top[0].sinks], ["ACE", 154]);
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
  // Cactus Boats sits beside it: one counted View, Play and Finish (sunk), from cb; the owner's left out.
  const cactus = row("Cactus Boats").querySelectorAll("td").map((td) => td.text.trim());
  assert.deepEqual(cactus, ["Cactus Boats", "1", "1", "1", "0"]);
  assert.deepEqual(row("cb").querySelectorAll("td").map((td) => td.text.trim()), ["cb", "1", "1", "1"]);
  assert.deepEqual(row("sunk").querySelectorAll("td").map((td) => td.text.trim()), ["sunk", "no", "1"]);
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
