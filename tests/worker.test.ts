import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { unstable_startWorker } from "wrangler";
import { buildSite, type Site } from "./helpers.ts";
import { likeLabel, likeSlug, postSlug, statsText } from "../worker/stats.ts";

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

let site: Site;
let worker: Worker;
let persist: string;

const LIVE = "https://jspratt.dev";
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
async function send(method: string, url: string, headers: Record<string, string>): Promise<Got> {
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
    req.end();
  });
}

const get = (url: string, headers: Record<string, string> = navigate) => send("GET", url, headers);

/** A browser submitting the Like form on the page at `url`'s origin. */
const like = (url: string, headers: Record<string, string> = {}) =>
  send("POST", url, { origin: new URL(url).origin, ...headers });

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
