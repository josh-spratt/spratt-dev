import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { unstable_startWorker } from "wrangler";
import { buildSite, type Site } from "./helpers.ts";
import { postSlug, statsText } from "../worker/stats.ts";

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

interface Got {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * GET through the local Worker. Uses node:http, not fetch: undici always
 * overwrites Sec-Fetch-Mode with "cors", so fetch can't act like a browser
 * navigation. The Host header stands in for the site's hostname.
 */
async function get(url: string, headers: Record<string, string> = navigate): Promise<Got> {
  const target = new URL(url);
  const local = await worker.url;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: local.hostname, port: local.port, path: target.pathname, headers: { ...headers, host: target.host } },
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

const stats = (body: string) => /<span data-stats[^>]*>([^<]*)<\/span>/.exec(body)?.[1];

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

test("statsText reads naturally", () => {
  assert.equal(statsText(1), " · Read 1 time");
  assert.equal(statsText(1234), " · Read 1,234 times");
});

test("the static Post ships an empty stats placeholder", () => {
  assert.equal(stats(site.read("writing/newer-post/index.html")), "");
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
