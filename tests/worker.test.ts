import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { unstable_startWorker } from "wrangler";
import { parse } from "node-html-parser";
import { buildSite, type Site } from "./helpers.ts";
import { dashboardQuery, niceMax, renderDashboard, windowDays, type DashboardData } from "../worker/dashboard.ts";
import { accessConfig, accessIdentity, certsUrl, parseKeys, teamOrigin, verifyAccessJwt, type AccessKey } from "../worker/access.ts";
import {
  cleanInitials,
  fromPage,
  gameEventPath,
  isBot,
  isPageView,
  outPath,
  outTarget,
  visitorId,
  visitorOf,
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
const ACCESS_AUD = "test-access-aud";
const navigate = { "sec-fetch-mode": "navigate" };
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
/** A reader's browser navigating to a page. */
const browser = { ...navigate, "user-agent": BROWSER };
/** One of the owner's browsers: its Visitor is in owner_visitors from the start. */
const ME = "eeeeeeee-0000-4000-8000-00000000000e";
const mine = { ...browser, cookie: `visitor=${ME}` };

let db: DatabaseSync;

/**
 * Run SQL against the same local D1 the Worker uses, by opening its SQLite file directly.
 * (Spawning `wrangler d1 execute` per query cost ~0.8s each and was most of this file's runtime.)
 */
function sql(command: string): Record<string, unknown>[] {
  if (!db) {
    const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
    const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
    db = new DatabaseSync(join(dir, file!));
    db.exec("PRAGMA busy_timeout = 5000");
  }
  const stmt = db.prepare(command);
  if (stmt.columns().length === 0) {
    stmt.run();
    return [];
  }
  return stmt.all().map((row) => ({ ...row }));
}

/** How many Events of a kind a page has, the owner's included. Post Views, Likes and Interest are written before the response. */
const count = (kind: string, path: string) => Number(sql(`SELECT COUNT(*) AS n FROM events WHERE kind = '${kind}' AND path = '${path}'`)[0].n);
const views = (slug: string) => count("view", `/writing/${slug}/`);
const likes = (slug: string) => count("like", `/writing/${slug}/`);
const interest = (slug: string) => count("interest", `/writing/${slug}/`);
const viewLog = (slug: string) =>
  sql(`SELECT referrer, ref, is_me FROM events WHERE kind = 'view' AND path = '/writing/${slug}/' ORDER BY id`);

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

const get = (url: string, headers: Record<string, string> = browser) => send("GET", url, headers);

/** A browser submitting a Post form (Like or email interest) on the page at `url`'s origin. */
const like = (url: string, headers: Record<string, string> = {}) =>
  send("POST", url, { origin: new URL(url).origin, ...headers });

/** The game's own script reporting a Play or a Finish from a page on `url`'s origin. */
const report = (url: string, event: object, headers: Record<string, string> = {}) =>
  send("POST", url, { origin: new URL(url).origin, "content-type": "application/json", ...headers }, JSON.stringify(event));

const stats = (body: string) => /<span data-stats[^>]*>([^<]*)<\/span>/.exec(body)?.[1];
const likeText = (body: string) => /<span data-like-label[^>]*>([^<]*)<\/span>/.exec(body)?.[1];

// Cloudflare Access, played by a local server serving a test key as the team's certs.
let access: Server;
let team: string;
let signingKey: CryptoKey;
let publicKey: AccessKey;
const KID = "test-kid";

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A JWT as Access would sign it for the owner, with any claims overridden. */
async function accessJwt(claims: Record<string, unknown> = {}, { kid = KID, key = signingKey } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ aud: [ACCESS_AUD], iss: team, email: "owner@example.com", sub: "1", iat: now, nbf: now, exp: now + 3600, ...claims }),
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const rsaKeyPair = () =>
  crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;

before(async () => {
  const pair = await rsaKeyPair();
  signingKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicKey = { kid: KID, kty: "RSA", alg: "RS256", n: jwk.n!, e: jwk.e! };
  access = createServer((req, res) => {
    if (req.url !== "/cdn-cgi/access/certs") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [publicKey], public_cert: {}, public_certs: [] }));
  });
  await new Promise<void>((r) => access.listen(0, "127.0.0.1", r));
  team = `http://127.0.0.1:${(access.address() as AddressInfo).port}`;

  site = buildSite({ contentDir: "tests/fixtures/posts/content", mode: "production" });
  persist = mkdtempSync(join(tmpdir(), "spratt-dev-d1-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "spratt-dev", "--local", "--persist-to", persist], {
    stdio: "pipe",
    env: { ...process.env, CI: "1" },
  });
  sql(`INSERT INTO owner_visitors (visitor) VALUES ('${ME}')`);
  worker = await unstable_startWorker({
    config: "wrangler.jsonc",
    assets: site.outDir,
    bindings: {
      ACCESS_TEAM_DOMAIN: { type: "secret_text", value: team },
      ACCESS_AUD: { type: "secret_text", value: ACCESS_AUD },
    },
    dev: { persist, server: { port: 0 }, inspector: false, watch: false, logLevel: "none" },
  });
  await worker.ready;
});

after(async () => {
  db?.close();
  await worker?.dispose();
  access?.close();
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
  assert.equal(views("newer-post"), 2, "each one is a View Event");
});

test("a request without Sec-Fetch-Mode (crawler, curl) is not counted but still sees the count", async () => {
  const before = views("newer-post");
  const { body } = await get(`${LIVE}/writing/newer-post/`, {});
  assert.equal(views("newer-post"), before);
  assert.equal(stats(body), ` · Read ${before} times`);
});

test("a preview hostname reads counts but never writes", async () => {
  const { body } = await get("https://views.spratt-dev.example.workers.dev/writing/newer-post/");
  assert.equal(stats(body), " · Read 2 times");
  assert.equal(views("newer-post"), 2);
});

test("an unknown slug records nothing and still gets the 404 page", async () => {
  const { status, body } = await get(`${LIVE}/writing/not-a-post/`);
  assert.equal(status, 404);
  assert.equal(body, site.read("404.html"));
  assert.equal(views("not-a-post"), 0);
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
  const { body } = await get(`${LIVE}/writing/newer-post/?liked`, { ...browser, cookie: "liked=1" });
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

test("a Like for an unknown slug records nothing", async () => {
  assert.equal((await like(`${LIVE}/writing/not-a-post/like`)).status, 404);
  assert.equal(likes("not-a-post"), 0);
});

test("a Like on a preview redirects back but never writes", async () => {
  const res = await like("https://views.spratt-dev.example.workers.dev/writing/older-post/like");
  assert.equal(res.status, 303);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(likes("older-post"), 0);
});

test("interestSlug matches the email-interest action only", () => {
  assert.equal(interestSlug("/writing/newer-post/interest"), "newer-post");
  assert.equal(interestSlug("/writing/newer-post/"), null);
  assert.equal(interestSlug("/writing/newer-post/interest/"), null);
});

test("the redirect back after answering isn't a View", () => {
  const nav = (url: string) => new Request(url, { headers: browser });
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

test("answering on the live site records an Interest, sets a site-wide cookie and redirects to the thank-you", async () => {
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

test("every counted View is recorded with where it came from", async () => {
  const slug = "older-post";
  await get(`${LIVE}/writing/${slug}/?ref=bluesky`, { ...browser, referer: "https://bsky.app/" });
  await get(`${LIVE}/writing/${slug}/`);
  await get(`${LIVE}/writing/${slug}/`, {}); // a crawler: not a View
  assert.deepEqual(viewLog(slug), [
    { referrer: "bsky.app", ref: "bluesky", is_me: 0 },
    { referrer: null, ref: null, is_me: 0 },
  ]);
});

test("a preview never records a View", async () => {
  await get("https://views.spratt-dev.example.workers.dev/writing/older-post/");
  assert.equal(viewLog("older-post").length, 2);
});

test("/writing/?me is just the Writing list, and sets no cookie", async () => {
  const res = await get(`${LIVE}/writing/?me`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body, site.read("writing/index.html"));
  assert.equal(res.headers["set-cookie"], undefined);
});

test("the owner's Views are recorded as theirs but leave the public count alone", async () => {
  const slug = "older-post";
  const { body } = await get(`${LIVE}/writing/${slug}/`, mine);
  assert.equal(stats(body), " · Read 2 times");
  assert.deepEqual(viewLog(slug).at(-1), { referrer: null, ref: null, is_me: 1 });
  const { body: theirs } = await get(`${LIVE}/writing/${slug}/`, { ...browser, cookie: "me=1" });
  assert.equal(stats(theirs), " · Read 3 times", "the old `me` cookie means nothing now");
});

test("a Post's count includes Views copied from before Events, and leaves the owner's out", async () => {
  const path = "/writing/older-post/";
  const before = Number(/Read (\d+)/.exec(stats((await get(`${LIVE}${path}`, {})).body) ?? "")?.[1]);
  sql(`INSERT INTO events (kind, path, created_at, referrer, is_me) VALUES
    ('view', '${path}', '2026-11-20 10:00:00', 'news.ycombinator.com', 0),
    ('view', '${path}', '2026-11-20 11:00:00', NULL, 1)`);
  const { body } = await get(`${LIVE}${path}`, {});
  assert.equal(stats(body), ` · Read ${before + 1} times`, "the copied View counts; the owner's copied View doesn't");
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

/** Every Play and Finish Event of a Game, oldest first. */
const plays = (game: string) =>
  sql(`SELECT kind, ending, survived, referrer, ref, is_me FROM events WHERE game = '${game}' AND kind IN ('play', 'finish') ORDER BY id`);

/** A Game's Play and Finish Events after the first `from`, waiting for `expect` of them: they're written after the 204. */
async function playsAfter(game: string, from: number, expect: number) {
  let rows = plays(game).slice(from);
  for (let i = 0; i < 10 && rows.length < expect; i++) {
    await new Promise((r) => setTimeout(r, 200));
    rows = plays(game).slice(from);
  }
  return rows;
}

test("a Game's page is served as built", async () => {
  for (const game of ["twenty-boats", "cactus-boats"]) {
    const res = await get(`${LIVE}/games/${game}/?ref=hn`, { ...browser, referer: "https://news.ycombinator.com/" });
    assert.equal(res.status, 200);
    assert.equal(res.body, site.read(`games/${game}/index.html`));
  }
});

test("the game reports Plays and Finishes on the live site, the owner's flagged", async () => {
  const url = `${LIVE}/games/twenty-boats/event`;
  const from = { ref: "hn", referrer: "https://news.ycombinator.com/" };
  const before = plays("twenty-boats").length;
  const play = await report(url, { event: "play", ...from });
  assert.equal(play.status, 204);
  assert.equal(play.headers["cache-control"], "no-store");
  assert.equal((await report(url, { event: "finish", ending: "water-lost", survived: false, ...from })).status, 204);
  assert.equal((await report(url, { event: "play" }, { cookie: `visitor=${ME}` })).status, 204);
  assert.deepEqual(await playsAfter("twenty-boats", before, 3), [
    { kind: "play", ending: null, survived: null, referrer: "news.ycombinator.com", ref: "hn", is_me: 0 },
    { kind: "finish", ending: "water-lost", survived: 0, referrer: "news.ycombinator.com", ref: "hn", is_me: 0 },
    { kind: "play", ending: null, survived: null, referrer: null, ref: null, is_me: 1 },
  ]);
});

test("a game report from another site, by GET, malformed, or on a preview writes nothing", async () => {
  const url = `${LIVE}/games/twenty-boats/event`;
  const before = plays("twenty-boats").length;
  assert.equal((await report(url, { event: "play" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await send("POST", url, {}, JSON.stringify({ event: "play" }))).status, 403);
  assert.equal((await get(url)).status, 405);
  assert.equal((await report(url, { event: "finish" })).status, 400);
  assert.equal((await report("https://views.spratt-dev.example.workers.dev/games/twenty-boats/event", { event: "play" })).status, 204);
  // Not a Game, so the Worker doesn't run and the assets refuse the POST.
  assert.equal((await report(`${LIVE}/games/not-a-game/event`, { event: "play" })).status, 405);
  // One recorded report after them, so the wait has something to find.
  await report(url, { event: "play", ref: "last" });
  const rows = await playsAfter("twenty-boats", before, 1);
  assert.deepEqual(rows.map((r) => r.ref), ["last"]);
});

test("Cactus Boats reports Plays and sunk Finishes on the live site, the owner's flagged", async () => {
  const url = `${LIVE}/games/cactus-boats/event`;
  const from = { ref: "cb", referrer: "https://www.reddit.com/r/webgames/" };
  const before = plays("cactus-boats").length;
  const owner = { cookie: `visitor=${ME}` };
  assert.equal((await report(url, { event: "play", ...from })).status, 204);
  assert.equal((await report(url, { event: "finish", ending: "sunk", survived: false, ...from })).status, 204);
  assert.equal((await report(url, { event: "play" }, owner)).status, 204);
  assert.equal((await report(url, { event: "finish", ending: "sunk", survived: false }, owner)).status, 204);
  assert.deepEqual(await playsAfter("cactus-boats", before, 4), [
    { kind: "play", ending: null, survived: null, referrer: "www.reddit.com", ref: "cb", is_me: 0 },
    { kind: "finish", ending: "sunk", survived: 0, referrer: "www.reddit.com", ref: "cb", is_me: 0 },
    { kind: "play", ending: null, survived: null, referrer: null, ref: null, is_me: 1 },
    { kind: "finish", ending: "sunk", survived: 0, referrer: null, ref: null, is_me: 1 },
  ]);
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
  const run = await startRun({ cookie: `visitor=${ME}` });
  backdate(run, 610);
  const res = await submitScore(run, "JSP", 600_000, 20, {}, { cookie: `visitor=${ME}` });
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

// Events (docs/database.md).

const VISITOR = "0b3c9d5e-1f2a-4b6c-8d7e-9f0a1b2c3d4e";

interface EventRow {
  kind: string;
  path: string;
  ref: string | null;
  referrer: string | null;
  visitor: string | null;
  is_me: number;
  game: string | null;
  ending: string | null;
  survived: number | null;
  target: string | null;
}

const lastEventId = () => Number(sql("SELECT COALESCE(MAX(id), 0) AS id FROM events")[0].id);

/**
 * The Events after `since`, waiting a little: the Worker writes them after it
 * has answered, so they can land just after the response.
 */
async function eventsAfter(since: number, expect = 1): Promise<EventRow[]> {
  const read = () =>
    sql(`SELECT kind, path, ref, referrer, visitor, is_me, game, ending, survived, target FROM events WHERE id > ${since} ORDER BY id`) as unknown as EventRow[];
  let rows = read();
  for (let i = 0; i < 10 && rows.length < expect; i++) {
    await new Promise((r) => setTimeout(r, 200));
    rows = read();
  }
  return rows;
}

const event = (e: Partial<EventRow>): EventRow => ({
  kind: "view", path: "/", ref: null, referrer: null, visitor: VISITOR, is_me: 0,
  game: null, ending: null, survived: null, target: null, ...e,
});

const req = (url: string, headers: Record<string, string> = {}, method = "GET") => new Request(url, { method, headers });

test("isBot catches link previews, uptime checkers, headless browsers and no user agent, not browsers", () => {
  assert.equal(isBot(req(LIVE, { "user-agent": BROWSER })), false);
  assert.equal(isBot(req(LIVE, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" })), false);
  for (const agent of [
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "facebookexternalhit/1.1",
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 HeadlessChrome/140.0 Safari/537.36",
    "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
    "WhatsApp/2.23.20.0",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  ]) {
    assert.equal(isBot(req(LIVE, { "user-agent": agent })), true, agent);
  }
  assert.equal(isBot(req(LIVE)), true);
});

test("a Visitor id is only ever a random UUID from its own cookie", () => {
  assert.equal(visitorId(req(LIVE, { cookie: `liked=1; visitor=${VISITOR}` })), VISITOR);
  assert.equal(visitorId(req(LIVE, { cookie: "visitor=not-an-id" })), null);
  assert.equal(visitorId(req(LIVE, { cookie: `xvisitor=${VISITOR}` })), null);
  assert.deepEqual(visitorOf(req(LIVE, { cookie: `visitor=${VISITOR}` })), { id: VISITOR, cookie: null });
  const fresh = visitorOf(req(LIVE));
  assert.match(fresh.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fresh.cookie, `visitor=${fresh.id}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`);
});

test("isPageView is a browser navigation to a live page, answered with the page or a 304", () => {
  const html = new Response("", { headers: { "content-type": "text/html; charset=utf-8" } });
  const ok = req(`${LIVE}/`, browser);
  assert.equal(isPageView(ok, html), true);
  assert.equal(isPageView(ok, new Response(null, { status: 304 })), true);
  assert.equal(isPageView(ok, new Response("", { status: 404, headers: { "content-type": "text/html" } })), false);
  assert.equal(isPageView(ok, new Response("", { headers: { "content-type": "application/xml" } })), false);
  assert.equal(isPageView(req(`${LIVE}/`, navigate), html), false, "no user agent");
  assert.equal(isPageView(req(`${LIVE}/`, { "user-agent": BROWSER }), html), false, "not a navigation");
  assert.equal(isPageView(req("https://x.spratt-dev.example.workers.dev/", browser), html), false, "a preview");
  assert.equal(isPageView(req(`${LIVE}/writing/a/?liked`, browser), html), false, "back from a Like");
});

test("outPath, outTarget and fromPage only accept what they should", () => {
  assert.equal(outPath("/out/github/"), "github");
  assert.equal(outPath("/out/github"), "github");
  assert.equal(outPath("/out/"), null);
  assert.equal(outPath("/out/a/b/"), null);
  assert.equal(outPath("/out/links.json"), null);
  const links = { github: "https://github.com/x", email: "mailto:x@example.com", bad: "javascript:alert(1)" };
  assert.equal(outTarget(links, "github"), "https://github.com/x");
  assert.equal(outTarget(links, "email"), "mailto:x@example.com");
  assert.equal(outTarget(links, "bad"), null);
  assert.equal(outTarget(links, "constructor"), null);
  assert.equal(outTarget(links, "nope"), null);
  assert.equal(outTarget(null, "github"), null);
  assert.equal(fromPage(req(`${LIVE}/out/github/`, { referer: `${LIVE}/writing/a/?ref=x` })), "/writing/a/");
  assert.equal(fromPage(req(`${LIVE}/out/github/`, { referer: "https://evil.example/" })), null);
  assert.equal(fromPage(req(`${LIVE}/out/github/`)), null);
});

/** A run_worker_first pattern as a regex: `*` is anything, the rest is literal. */
const routeMatcher = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

test("run_worker_first covers every built page, so each one's Views are recorded", () => {
  const config = JSON.parse(
    readFileSync("wrangler.jsonc", "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
  const routes: RegExp[] = config.assets.run_worker_first.map(routeMatcher);
  const pages = execFileSync("find", [site.outDir, "-name", "index.html"])
    .toString()
    .trim()
    .split("\n")
    .map((f) => f.slice(site.outDir.length).replace(/index\.html$/, ""));
  assert.ok(pages.includes("/") && pages.includes("/games/"));
  for (const page of pages) assert.ok(routes.some((r) => r.test(page)), `${page} runs the Worker`);
  assert.ok(!routes.some((r) => r.test("/_astro/x.css")), "assets don't run it");
});

test("a browser View of any page is an Event, giving a new browser its Visitor cookie", async () => {
  const since = lastEventId();
  const res = await get(`${LIVE}/?ref=Mastodon`, { ...browser, referer: "https://mastodon.social/@x" });
  assert.equal(res.status, 200);
  assert.equal(res.body, site.read("index.html"), "the page is served as built");
  const cookie = String(res.headers["set-cookie"]);
  const id = /^visitor=([0-9a-f-]{36}); Path=\/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax$/.exec(cookie)?.[1];
  assert.ok(id, cookie);
  assert.deepEqual(await eventsAfter(since), [event({ path: "/", ref: "mastodon", referrer: "mastodon.social", visitor: id })]);
});

test("a returning Visitor keeps its id and gets no new cookie, on the Games page and the Writing list too", async () => {
  const since = lastEventId();
  const headers = { ...browser, cookie: `visitor=${VISITOR}` };
  const games = await get(`${LIVE}/games/`, headers);
  assert.equal(games.headers["set-cookie"], undefined);
  assert.equal(games.body, site.read("games/index.html"));
  await get(`${LIVE}/writing/`, headers);
  assert.deepEqual(await eventsAfter(since, 2), [event({ path: "/games/" }), event({ path: "/writing/" })]);
});

test("a revalidated page (304) is still a View", async () => {
  const first = await get(`${LIVE}/games/`, { ...browser, cookie: `visitor=${VISITOR}` });
  const etag = String(first.headers.etag ?? "");
  assert.ok(etag, "the assets send an ETag");
  const since = lastEventId();
  const again = await get(`${LIVE}/games/`, { ...browser, cookie: `visitor=${VISITOR}`, "if-none-match": etag });
  assert.equal(again.status, 304);
  assert.deepEqual(await eventsAfter(since), [event({ path: "/games/" })]);
});

test("crawlers, bots, previews, missing pages, a Game's files and the redirect after a Like aren't Views", async () => {
  const since = lastEventId();
  await get(`${LIVE}/`, { "user-agent": BROWSER }); // not a navigation
  await get(`${LIVE}/`, { ...navigate, "user-agent": "Slackbot-LinkExpanding 1.0" });
  await get(`${LIVE}/`, navigate); // no user agent
  const preview = await get("https://views.spratt-dev.example.workers.dev/", browser);
  assert.equal(preview.headers["set-cookie"], undefined, "previews set no Visitor cookie");
  await get(`${LIVE}/writing/not-a-post/`, browser);
  await get(`${LIVE}/games/twenty-boats/play.js`, browser);
  await get(`${LIVE}/writing/newer-post/?liked`, browser);
  await get(`${LIVE}/stats/`, browser);
  // One real View after them, so the wait has something to find.
  await get(`${LIVE}/writing/`, { ...browser, cookie: `visitor=${VISITOR}` });
  assert.deepEqual(await eventsAfter(since), [event({ path: "/writing/" })]);
});

test("a Post View is an Event counted in the page, and the owner's is flagged and not counted", async () => {
  const slug = "older-post";
  const shown = async (headers: Record<string, string>) => stats((await get(`${LIVE}/writing/${slug}/?ref=hn`, headers)).body);
  const before = Number(/Read (\d+)/.exec((await shown({})) ?? "")?.[1]);
  const since = lastEventId();
  const res = await get(`${LIVE}/writing/${slug}/?ref=hn`, browser);
  assert.equal(stats(res.body), ` · Read ${before + 1} times`, "the reader's own View is in the count");
  const id = /^visitor=([0-9a-f-]{36});/.exec(String(res.headers["set-cookie"]))?.[1];
  assert.ok(id, "a new browser gets its Visitor cookie on a Post too");
  assert.equal(await shown({ ...browser, cookie: `visitor=${VISITOR}` }), ` · Read ${before + 2} times`);
  assert.equal(await shown(mine), ` · Read ${before + 2} times`, "the owner's View leaves the public count alone");
  assert.deepEqual(await eventsAfter(since, 3), [
    event({ path: `/writing/${slug}/`, ref: "hn", visitor: id }),
    event({ path: `/writing/${slug}/`, ref: "hn" }),
    event({ path: `/writing/${slug}/`, ref: "hn", visitor: ME, is_me: 1 }),
  ]);
});

test("a Game's page View, Plays and Finishes are Events with the Game", async () => {
  const since = lastEventId();
  const cookie = `visitor=${VISITOR}`;
  await get(`${LIVE}/games/cactus-boats/?ref=hn`, { ...browser, cookie });
  const url = `${LIVE}/games/cactus-boats/event`;
  const from = { ref: "hn", referrer: "https://news.ycombinator.com/" };
  await report(url, { event: "play", ...from }, { cookie });
  await report(url, { event: "finish", ending: "sunk", survived: false, ...from }, { cookie });
  const fresh = await report(url, { event: "play" });
  assert.match(String(fresh.headers["set-cookie"]), /^visitor=/, "a browser without one gets a Visitor id");
  await report("https://views.spratt-dev.example.workers.dev/games/cactus-boats/event", { event: "play" }, { cookie });
  const rows = await eventsAfter(since, 4);
  const game = { path: "/games/cactus-boats/", game: "cactus-boats" };
  assert.deepEqual(rows.slice(0, 3), [
    event({ ...game, ref: "hn" }),
    event({ ...game, kind: "play", ref: "hn", referrer: "news.ycombinator.com" }),
    event({ ...game, kind: "finish", ref: "hn", referrer: "news.ycombinator.com", ending: "sunk", survived: 0 }),
  ]);
  assert.equal(rows.length, 4, "the preview's report is no Event");
  assert.equal(rows[3].kind, "play");
  assert.notEqual(rows[3].visitor, VISITOR);
});

test("a Like and an Interest are Events with the source of the Visitor's View of the Post", async () => {
  const visitor = "11111111-2222-4333-8444-555555555555";
  const cookie = `visitor=${visitor}`;
  await get(`${LIVE}/writing/newer-post/?ref=bluesky`, { ...browser, cookie, referer: "https://bsky.app/" });
  const since = lastEventId();
  const before = likes("newer-post");
  assert.equal((await like(`${LIVE}/writing/newer-post/like`, { cookie })).status, 303);
  assert.equal(likes("newer-post"), before + 1, "written before the redirect, so the page shows it");
  assert.equal((await like(`${LIVE}/writing/newer-post/interest`, { cookie })).status, 303);
  // Already liked: no second Like, and no Event for it.
  await like(`${LIVE}/writing/newer-post/like`, { cookie: `liked=1; ${cookie}` });
  const source = { path: "/writing/newer-post/", ref: "bluesky", referrer: "bsky.app", visitor };
  assert.deepEqual(await eventsAfter(since, 2), [event({ ...source, kind: "like" }), event({ ...source, kind: "interest" })]);
});

test("a Click out records the Event with the page's source and redirects to the real address", async () => {
  const cookie = `visitor=${VISITOR}`;
  await get(`${LIVE}/?ref=cv`, { ...browser, cookie });
  const since = lastEventId();
  const res = await get(`${LIVE}/out/github/`, { ...browser, cookie, referer: `${LIVE}/?ref=cv` });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "https://github.com/fixture");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["set-cookie"], undefined);
  const project = await get(`${LIVE}/out/fixture-alpha/`, { ...browser, cookie, referer: `${LIVE}/` });
  assert.equal(project.headers.location, "https://example.com/alpha");
  const email = await get(`${LIVE}/out/email/`, { ...browser, cookie, referer: `${LIVE}/writing/` });
  assert.equal(email.headers.location, "mailto:fixture@example.com");
  assert.deepEqual(await eventsAfter(since, 3), [
    event({ kind: "click_out", path: "/", ref: "cv", target: "github" }),
    event({ kind: "click_out", path: "/", ref: "cv", target: "fixture-alpha" }),
    event({ kind: "click_out", path: "/writing/", target: "email" }),
  ]);
});

test("a Click out to a name not on the list is the 404 page; previews and bots are redirected but not recorded", async () => {
  for (const path of ["/out/evil/", "/out/constructor/", "/out/a/b/"]) {
    const res = await get(`${LIVE}${path}`, browser);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.location, undefined, path);
  }
  const since = lastEventId();
  const preview = await get("https://views.spratt-dev.example.workers.dev/out/github/", browser);
  assert.equal(preview.status, 302);
  assert.equal(preview.headers.location, "https://github.com/fixture");
  assert.equal(preview.headers["set-cookie"], undefined);
  const bot = await get(`${LIVE}/out/github/`, { ...navigate, "user-agent": "Slackbot 1.0" });
  assert.equal(bot.status, 302);
  // A recorded one after them, so the wait has something to find.
  await get(`${LIVE}/out/linkedin/`, { ...browser, cookie: `visitor=${VISITOR}` });
  assert.deepEqual(await eventsAfter(since), [event({ kind: "click_out", path: "/out/linkedin/", target: "linkedin" })]);
});

// The dashboard: /stats/, behind Cloudflare Access, read from the Events.

const OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** /stats/ as Access passes it on: with a signed JWT for the owner. */
async function openStats(path = "/stats/", headers: Record<string, string> = {}): Promise<Got> {
  return get(`${LIVE}${path}`, { ...browser, "cf-access-jwt-assertion": await accessJwt(), ...headers });
}

const cookiesOf = (res: Got) => [res.headers["set-cookie"] ?? []].flat();

/** The cells of the table row whose first cell is `first`, or undefined. */
function rowOf(page: ReturnType<typeof parse>, first: string): string[] | undefined {
  const tr = page.querySelectorAll("tbody tr").find((r) => r.querySelector("td")?.text.trim() === first);
  return tr?.querySelectorAll("td").map((td) => td.text.trim());
}

const numbers = (page: ReturnType<typeof parse>, selector: string) =>
  page.querySelectorAll(selector).map((el) => Number(el.text.replace(/,/g, "")));

test("verifyAccessJwt accepts only the team's RS256 JWT for this application, in date", async () => {
  const config = { team, aud: ACCESS_AUD };
  assert.deepEqual(await verifyAccessJwt(await accessJwt(), config, [publicKey]), { email: "owner@example.com", sub: "1" });
  assert.ok(await verifyAccessJwt(await accessJwt({ aud: ACCESS_AUD }), config, [publicKey]), "aud may be a string");
  const now = Math.floor(Date.now() / 1000);
  const other = await rsaKeyPair();
  for (const [why, token] of [
    ["another application", await accessJwt({ aud: ["other-aud"] })],
    ["another team", await accessJwt({ iss: "https://evil.cloudflareaccess.com" })],
    ["expired", await accessJwt({ exp: now - 3600, nbf: now - 7200 })],
    ["not yet valid", await accessJwt({ nbf: now + 3600 })],
    ["no expiry", await accessJwt({ exp: undefined })],
    ["signed by another key", await accessJwt({}, { key: other.privateKey })],
    ["an unknown key id", await accessJwt({}, { kid: "nope" })],
    ["not a JWT", "x.y.z"],
    ["empty", ""],
  ] as const) {
    assert.equal(await verifyAccessJwt(token, config, [publicKey]), null, why);
  }
  const [h, p, sig] = (await accessJwt()).split(".");
  const forged = b64url(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), email: "x@evil.example" }));
  assert.equal(await verifyAccessJwt(`${h}.${forged}.${sig}`, config, [publicKey]), null, "a changed payload");
  const none = b64url(JSON.stringify({ alg: "none", kid: KID }));
  assert.equal(await verifyAccessJwt(`${none}.${p}.`, config, [publicKey]), null, "alg none");
});

test("without both Access secrets nothing opens, whatever the request carries", async () => {
  assert.equal(accessConfig({}), null);
  assert.equal(accessConfig({ ACCESS_TEAM_DOMAIN: "jspratt.cloudflareaccess.com" }), null);
  assert.equal(accessConfig({ ACCESS_TEAM_DOMAIN: "jspratt.cloudflareaccess.com", ACCESS_AUD: " " }), null);
  assert.deepEqual(accessConfig({ ACCESS_TEAM_DOMAIN: " a.cloudflareaccess.com ", ACCESS_AUD: "x" }), { team: "a.cloudflareaccess.com", aud: "x" });
  const signed = req(`${LIVE}/stats/`, { "cf-access-jwt-assertion": await accessJwt() });
  assert.equal(await accessIdentity(signed, null), null);
  assert.equal(teamOrigin("jspratt.cloudflareaccess.com"), "https://jspratt.cloudflareaccess.com");
  assert.equal(certsUrl("https://jspratt.cloudflareaccess.com/"), "https://jspratt.cloudflareaccess.com/cdn-cgi/access/certs");
  assert.deepEqual(parseKeys({ keys: [publicKey, { kid: "ec", kty: "EC" }, null] }), [publicKey]);
  assert.deepEqual(parseKeys("nope"), []);
});

test("/stats/ is the ordinary 404 page without a valid Access JWT, and sets no cookie", async () => {
  const cases: [string, Record<string, string>][] = [
    ["/stats/", {}],
    ["/stats/", { "cf-access-jwt-assertion": "x.y.z" }],
    ["/stats/", { "cf-access-jwt-assertion": await accessJwt({ aud: ["other-aud"] }) }],
    ["/stats/", { "cf-access-jwt-assertion": await accessJwt({ exp: 1, nbf: 0 }) }],
    ["/stats/", { "cf-access-jwt-assertion": await accessJwt({}, { key: (await rsaKeyPair()).privateKey }) }],
    ["/stats/", { "cf-access-jwt-assertion": "" }],
    ["/stats/posts.json", { "cf-access-jwt-assertion": await accessJwt() }],
    ["/stats/other/", { "cf-access-jwt-assertion": await accessJwt() }],
  ];
  for (const [path, headers] of cases) {
    const res = await get(`${LIVE}${path}`, { ...browser, ...headers });
    assert.equal(res.status, 404, `${path} ${JSON.stringify(headers).slice(0, 60)}`);
    assert.equal(res.body, site.read("404.html"));
    assert.equal(res.headers["set-cookie"], undefined);
  }
  const post = await send("POST", `${LIVE}/stats/`, { "cf-access-jwt-assertion": await accessJwt() });
  assert.equal(post.status, 404);
});

test("the dashboard is uncached, unindexed, scriptless, and says who is signed in", async () => {
  const res = await openStats();
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(String(res.headers["x-robots-tag"]), /noindex/);
  assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
  const page = parse(res.body);
  assert.equal(page.querySelectorAll("script").length, 0, "no client script");
  assert.match(page.text, /Signed in as owner@example\.com/);
  assert.ok(page.querySelector('a[href="/privacy/"]'));
  assert.deepEqual(
    page.querySelectorAll("h2").map((h) => h.childNodes[0].text.trim()),
    ["Active Visitors", "Views", "New and returning Visitors", "Games", "Posts", "Click outs"],
  );
  const gameRows = page.querySelectorAll("tbody tr").filter((r) => r.querySelectorAll("td").length === 5);
  assert.ok(gameRows.some((r) => r.querySelector("td")?.text.trim() === "Twenty Boats"), "every Game has a row");
  assert.ok(rowOf(page, "Newer Post"), "every Post has a row");
});

test("opening /stats/ through Access marks the browser as the owner's, its past and future Events too", async () => {
  const cookie = `visitor=${OWNER}`;
  let since = lastEventId();
  await get(`${LIVE}/writing/`, { ...browser, cookie });
  assert.deepEqual(await eventsAfter(since), [event({ path: "/writing/", visitor: OWNER })], "not yet the owner's");

  const res = await openStats("/stats/", { cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(cookiesOf(res), [], "an existing Visitor keeps its id, and no other cookie is set");
  assert.deepEqual(sql(`SELECT COUNT(*) AS n FROM owner_visitors WHERE visitor = '${OWNER}'`), [{ n: 1 }]);
  assert.deepEqual(sql(`SELECT DISTINCT is_me FROM events WHERE visitor = '${OWNER}'`), [{ is_me: 1 }], "past Events flagged");

  // Later, this Visitor's Events are the owner's.
  since = lastEventId();
  await get(`${LIVE}/games/`, { ...browser, cookie });
  await get(`${LIVE}/out/github/`, { ...browser, cookie, referer: `${LIVE}/games/` });
  assert.deepEqual(await eventsAfter(since, 2), [
    event({ path: "/games/", visitor: OWNER, is_me: 1 }),
    event({ kind: "click_out", path: "/games/", visitor: OWNER, is_me: 1, target: "github" }),
  ]);

  // A browser with no Visitor id yet gets one, and it's the owner's.
  const fresh = await openStats();
  const id = /^visitor=([0-9a-f-]{36});/.exec(cookiesOf(fresh).find((c) => c.startsWith("visitor=")) ?? "")?.[1];
  assert.ok(id);
  assert.deepEqual(sql(`SELECT COUNT(*) AS n FROM owner_visitors WHERE visitor = '${id}'`), [{ n: 1 }]);
  assert.equal((await openStats("/stats/", { cookie })).status, 200, "opening it again is fine");
});

test("the dashboard counts active, new and returning Visitors, Views, Plays, Likes and Click outs from the Events, without the owner", async () => {
  const before = parse((await openStats()).body);
  const [a, b, c] = ["d1d1d1d1-0000-4000-8000-000000000001", "d1d1d1d1-0000-4000-8000-000000000002", "d1d1d1d1-0000-4000-8000-000000000003"];
  const at = (ago: string) => `datetime('now', '${ago}')`;
  const row = (kind: string, path: string, visitor: string | null, when: string, more: { ref?: string; game?: string; target?: string; is_me?: number } = {}) =>
    `('${kind}', '${path}', ${more.ref ? `'${more.ref}'` : "NULL"}, ${visitor ? `'${visitor}'` : "NULL"}, ${more.is_me ?? 0}, ${more.game ? `'${more.game}'` : "NULL"}, ${more.target ? `'${more.target}'` : "NULL"}, ${when})`;
  sql(`INSERT INTO events (kind, path, ref, visitor, is_me, game, target, created_at) VALUES ${[
    // Three Visitors: today, 3 days ago and 20 days ago; the last was here 60 days ago too.
    row("view", "/dash/page/", a, at("-1 minute"), { ref: "dash-src" }),
    row("view", "/dash/page/", b, at("-3 days"), { ref: "dash-src" }),
    row("view", "/dash/page/", c, at("-20 days"), { ref: "dash-src" }),
    row("view", "/dash/old/", c, at("-60 days"), { ref: "dash-old" }),
    // Plays and a Finish of one Game, by two Visitors.
    row("play", "/games/dash-game/", a, at("-2 minutes"), { game: "dash-game" }),
    row("play", "/games/dash-game/", a, at("-2 minutes"), { game: "dash-game" }),
    row("play", "/games/dash-game/", b, at("-3 days"), { game: "dash-game" }),
    row("finish", "/games/dash-game/", a, at("-2 minutes"), { game: "dash-game" }),
    // Likes and an Interest on a Post.
    row("like", "/writing/dash-post/", a, at("-1 minute")),
    row("like", "/writing/dash-post/", b, at("-3 days")),
    row("interest", "/writing/dash-post/", a, at("-1 minute")),
    // Click outs.
    row("click_out", "/", a, at("-1 minute"), { target: "dash-target" }),
    row("click_out", "/", a, at("-1 minute"), { target: "dash-target" }),
    row("click_out", "/", b, at("-3 days"), { target: "dash-target" }),
    // The owner: a marked Visitor's Event that somehow isn't flagged, and a flagged one with no Visitor.
    row("view", "/dash/page/", OWNER, at("-1 minute"), { ref: "dash-owner" }),
    row("view", "/dash/page/", null, at("-1 minute"), { ref: "dash-me", is_me: 1 }),
    row("click_out", "/", OWNER, at("-1 minute"), { target: "dash-owner-target" }),
  ].join(", ")}`);

  const page = parse((await openStats()).body);
  const delta = (sel: string) => numbers(page, sel).map((n, i) => n - numbers(before, sel)[i]);
  assert.deepEqual(delta(".tile .value"), [1, 2, 3], "daily, weekly and monthly active Visitors");
  assert.deepEqual(delta(".pair b"), [2, 1], "two new Visitors, one returning");
  const today = (p: typeof page) => rowOf(p, page.querySelector("details tbody td")!.text.trim())!.slice(1).map(Number);
  assert.deepEqual(today(page).map((n, i) => n - today(before)[i]), [1, 2, 3], "the trend's last day");

  assert.deepEqual(rowOf(page, "/dash/page/"), ["/dash/page/", "3", "3"]);
  assert.deepEqual(rowOf(page, "dash-src"), ["dash-src", "3", "3"]);
  assert.equal(rowOf(page, "/dash/old/"), undefined, "before the window");
  assert.deepEqual(rowOf(page, "/games/dash-game/"), ["/games/dash-game/", "3", "1", "2", "1.5"]);
  assert.deepEqual(rowOf(page, "/writing/dash-post/"), ["/writing/dash-post/", "2", "1"]);
  assert.deepEqual(rowOf(page, "dash-target"), ["dash-target", "3", "2"]);
  for (const owners of ["dash-owner", "dash-me", "dash-owner-target"]) assert.equal(rowOf(page, owners), undefined, owners);

  const withMe = parse((await openStats("/stats/?me")).body);
  assert.deepEqual(rowOf(withMe, "/dash/page/"), ["/dash/page/", "5", "4"], "with the owner: two more Views, one more Visitor");
  assert.ok(rowOf(withMe, "dash-owner") && rowOf(withMe, "dash-me") && rowOf(withMe, "dash-owner-target"));

  const week = parse((await openStats("/stats/?days=7")).body);
  assert.deepEqual(rowOf(week, "/dash/page/"), ["/dash/page/", "2", "2"], "7 days leaves the 20-day-old View out");
  assert.equal(week.querySelectorAll("details tbody tr").length, 7);
});

test("the daily cron strips Visitor ids from Events older than 13 months, keeping the Events", async () => {
  const old = "0c0c0c0c-0000-4000-8000-000000000001";
  const recent = "0c0c0c0c-0000-4000-8000-000000000002";
  sql(`INSERT INTO events (kind, path, visitor, created_at) VALUES
    ('view', '/cron/', '${old}', datetime('now', '-14 months')),
    ('view', '/cron/', '${recent}', datetime('now', '-12 months'))`);
  // worker.scheduled() looks in the proxy, not the runtime that holds the Worker, so reach the runtime's Miniflare.
  const runtime = (worker.raw.runtimes as unknown as { mf?: { getWorker(name: string): Promise<{ scheduled(o: { cron: string }): Promise<{ outcome: string }> }> } }[]).find((r) => r.mf)!;
  const res = await (await runtime.mf!.getWorker("spratt-dev")).scheduled({ cron: "17 3 * * *" });
  assert.equal(res.outcome, "ok");
  assert.deepEqual(sql("SELECT visitor FROM events WHERE path = '/cron/' ORDER BY created_at"), [{ visitor: null }, { visitor: recent }]);
});

test("dashboardQuery only accepts the offered windows", () => {
  assert.deepEqual(dashboardQuery(new URL(`${LIVE}/stats/`)), { days: 30, withMe: false });
  assert.deepEqual(dashboardQuery(new URL(`${LIVE}/stats/?days=7&me`)), { days: 7, withMe: true });
  assert.equal(dashboardQuery(new URL(`${LIVE}/stats/?days=365`)).days, 365);
  assert.equal(dashboardQuery(new URL(`${LIVE}/stats/?days=1000`)).days, 30);
});

test("windowDays ends today and has one entry per day", () => {
  const days = windowDays(7, new Date("2026-03-10T12:00:00Z"));
  assert.deepEqual([days.length, days[0], days.at(-1)], [7, "2026-03-04", "2026-03-10"]);
});

test("niceMax rounds the chart's top up to 1, 2 or 5 × 10ⁿ", () => {
  assert.deepEqual([0, 1, 3, 7, 12, 50, 51, 999].map(niceMax), [1, 1, 5, 10, 20, 50, 100, 1000]);
});

test("the dashboard escapes everything that came from a reader", () => {
  const data: DashboardData = {
    posts: [],
    active: [{ day: "2026-03-10", dau: 1, wau: 1, mau: 1 }],
    current: { dau: 1, wau: 1, mau: 1 },
    pages: [{ path: "/<b>x</b>/", views: 1, visitors: 1 }],
    sources: [{ source: "<script>alert(1)</script>", views: 1, visitors: 1 }],
    visitors: { fresh: 1, returning: 0 },
    games: [{ game: "<u>", plays: 1, finishes: 0, players: 1 }],
    reactions: [{ path: "/writing/<i>/", likes: 1, interest: 0 }],
    clicks: [{ target: "\"><img>", clicks: 1, visitors: 1 }],
  };
  const html = renderDashboard({ days: 7, withMe: false }, data, { email: "<em>@x" }, new Date("2026-03-10T12:00:00Z"));
  assert.doesNotMatch(html, /<script>|<img>|<b>x|<i>|<u>|<em>/);
  assert.match(html, /&lt;script&gt;/);
});
