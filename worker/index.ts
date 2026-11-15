/**
 * Runs only for /writing/* and /stats* (see run_worker_first in wrangler.jsonc).
 * Every page is still built statically. For a Post page this counts the View in
 * D1 and writes the View and Like counts into the HTML. A Like and the
 * email-interest answer are plain form POSTs, so the page ships no client
 * script. /stats/ is the owner's private traffic dashboard.
 */

import {
  STATS_COOKIE,
  cookieValue,
  dashboardQuery,
  isDashboard,
  renderDashboard,
  sameString,
  statsCookie,
  statsToken,
  type DashboardData,
  type PostMeta,
} from "./dashboard.ts";

import {
  INTEREST_ANCHOR,
  hasAnsweredInterest,
  hasLiked,
  interestSlug,
  interestedCookie,
  isLive,
  isMe,
  isMeSetup,
  isSameOrigin,
  likeLabel,
  likeSlug,
  likedCookie,
  meCookie,
  postSlug,
  refTag,
  referrerHost,
  shouldCount,
  statsText,
} from "./stats.ts";

interface Stats {
  views: number;
  likes: number;
}

// Each change is one atomic statement, so concurrent Views or Likes can't lose a count.
const COUNT_VIEW =
  "INSERT INTO post_stats (slug, views) VALUES (?1, 1) ON CONFLICT (slug) DO UPDATE SET views = views + 1 RETURNING views, likes";
const COUNT_LIKE =
  "INSERT INTO post_stats (slug, likes) VALUES (?1, 1) ON CONFLICT (slug) DO UPDATE SET likes = likes + 1";
const READ = "SELECT views, likes FROM post_stats WHERE slug = ?1";
const RECORD_INTEREST = "INSERT INTO interest (slug) VALUES (?1)";
const LOG_VIEW = "INSERT INTO view_log (slug, referrer, ref, is_me) VALUES (?1, ?2, ?3, ?4)";

const INTEREST_THANKS =
  `<p class="interest" id="${INTEREST_ANCHOR}">Thanks. If enough people say so, I’ll set up email.</p>`;

/**
 * Reads a Post's counts, and for a View also logs it. The owner's Views are
 * logged (flagged) but not added to the total. The batch is one transaction,
 * so the total and the log can't disagree.
 */
async function readStats(env: Env, request: Request, slug: string): Promise<Stats> {
  if (!shouldCount(request)) {
    return (await env.DB.prepare(READ).bind(slug).first<Stats>()) ?? { views: 0, likes: 0 };
  }
  const me = isMe(request);
  const url = new URL(request.url);
  const [stats] = await env.DB.batch<Stats>([
    env.DB.prepare(me ? READ : COUNT_VIEW).bind(slug),
    env.DB.prepare(LOG_VIEW).bind(slug, referrerHost(request), refTag(url), me ? 1 : 0),
  ]);
  return stats.results[0] ?? { views: 0, likes: 0 };
}

const ME_SET =
  "This browser is now marked as yours. Its Views of Posts are logged as yours and don't add to the public count.\n";

/** Only Posts that really exist get rows, so made-up URLs can't create them. */
async function postExists(env: Env, request: Request, slug: string): Promise<boolean> {
  const page = await env.ASSETS.fetch(new URL(`/writing/${slug}/`, request.url));
  return page.status === 200;
}

interface FormAction {
  /** Whether this browser has already done it (its cookie is present). */
  done: boolean;
  /** One SQL statement taking the slug as ?1. */
  sql: string;
  /** Set only once the write succeeds, so a failed write can be retried. */
  cookie: string;
  /** Where to send the browser back to. */
  location: string;
  /** For the error log. */
  name: string;
}

/** A Post's form POST: same-site, real Posts only, once per browser, and only the live site writes. */
async function submit(request: Request, env: Env, slug: string, action: FormAction): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  if (!(await postExists(env, request, slug))) return new Response("Not Found", { status: 404 });

  const headers = new Headers({ location: action.location });
  if (isLive(request) && !action.done) {
    try {
      await env.DB.prepare(action.sql).bind(slug).run();
      headers.set("set-cookie", action.cookie);
    } catch (err) {
      console.error(`${action.name} failed`, err);
    }
  }
  return new Response(null, { status: 303, headers });
}

async function post(request: Request, env: Env, slug: string, page: Response): Promise<Response> {
  let stats: Stats | undefined;
  try {
    stats = await readStats(env, request, slug);
  } catch (err) {
    // D1 down or overloaded: no counts; the empty placeholder is hidden.
    console.error("post_stats failed", err);
  }
  const liked = hasLiked(request);

  let rewriter = new HTMLRewriter();
  if (stats) {
    const { views, likes } = stats;
    rewriter = rewriter
      .on("[data-stats]", {
        element(el) {
          if (views > 0) el.setInnerContent(statsText(views));
        },
      })
      .on("[data-like-label]", {
        element(el) {
          el.setInnerContent(likeLabel(likes, liked));
        },
      });
  }
  // Doesn't need D1: the cookie alone says this browser has answered.
  if (hasAnsweredInterest(request)) {
    rewriter = rewriter.on("form.interest", {
      element(el) {
        el.replace(INTEREST_THANKS, { html: true });
      },
    });
  }
  const res = rewriter.transform(page);
  // The counts change on every View, so this HTML must not be cached.
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store");
  headers.delete("etag");
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Anyone without the key gets the ordinary 404 page, so /stats/ looks like it
 * isn't there. The path is one no asset has, so the assets serve the 404 page.
 */
async function notFound(env: Env, request: Request): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL("/stats/not-found/", request.url));
  const headers = new Headers(page.headers);
  headers.set("cache-control", "no-store");
  return new Response(page.body, { status: 404, headers });
}

// The window is the last N UTC days including today: ?1 is "-(N-1) days".
// ?2 = 1 includes the owner's Views.
const IN_WINDOW = "created_at >= date('now', ?1) AND (?2 = 1 OR is_me = 0)";
const SOURCE = "COALESCE(ref, referrer, 'direct')";
const DASHBOARD_SQL = [
  `SELECT date(created_at) AS day, COUNT(*) AS views FROM view_log WHERE ${IN_WINDOW} GROUP BY day`,
  `SELECT slug, COUNT(*) AS views FROM view_log WHERE ${IN_WINDOW} GROUP BY slug`,
  `SELECT ${SOURCE} AS source, COUNT(*) AS views FROM view_log WHERE ${IN_WINDOW} GROUP BY source ORDER BY views DESC, source LIMIT 25`,
  `SELECT created_at, slug, ${SOURCE} AS source, is_me FROM view_log WHERE ${IN_WINDOW} ORDER BY created_at DESC, id DESC LIMIT 25`,
  "SELECT slug, views, likes FROM post_stats",
  "SELECT slug, COUNT(*) AS answers FROM interest GROUP BY slug",
];

/** The Posts in this build (src/pages/stats/posts.json.ts), read straight from the assets. */
async function buildPosts(env: Env, request: Request): Promise<PostMeta[]> {
  try {
    const res = await env.ASSETS.fetch(new URL("/stats/posts.json", request.url));
    return res.ok ? await res.json<PostMeta[]>() : [];
  } catch {
    return [];
  }
}

const PRIVATE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

/**
 * /stats/?key=<STATS_KEY> once per browser sets a cookie holding a hash of the
 * key, then redirects to /stats/ so the key leaves the address bar. With no
 * STATS_KEY set (branch previews, local runs without .dev.vars) nothing opens.
 */
async function dashboard(request: Request, env: Env, url: URL): Promise<Response> {
  // A secret, so not in wrangler.jsonc; `wrangler types` only knows it when .dev.vars has it.
  const key = (env as Env & { STATS_KEY?: string }).STATS_KEY;
  if (!key || request.method !== "GET" || !isDashboard(url.pathname)) return notFound(env, request);
  const token = await statsToken(key);

  const given = url.searchParams.get("key");
  if (given !== null) {
    if (!sameString(await statsToken(given), token)) return notFound(env, request);
    return new Response(null, {
      status: 303,
      headers: { ...PRIVATE_HEADERS, location: "/stats/", "set-cookie": statsCookie(token) },
    });
  }
  if (!sameString(cookieValue(request, STATS_COOKIE) ?? "", token)) return notFound(env, request);

  const q = dashboardQuery(url);
  const since = `-${q.days - 1} days`;
  const withMe = q.withMe ? 1 : 0;
  const [posts, results] = await Promise.all([
    buildPosts(env, request),
    env.DB.batch(
      DASHBOARD_SQL.map((sql, i) => (i < 4 ? env.DB.prepare(sql).bind(since, withMe) : env.DB.prepare(sql))),
    ),
  ]);
  const [daily, windowViews, sources, recent, totals, interest] = results.map((r) => r.results);
  const data = { posts, daily, windowViews, sources, recent, totals, interest } as DashboardData;

  return new Response(renderDashboard(q, data), {
    headers: {
      ...PRIVATE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/stats" || pathname.startsWith("/stats/")) return dashboard(request, env, url);

    if (isMeSetup(url)) {
      return new Response(ME_SET, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "set-cookie": meCookie() },
      });
    }

    const liking = likeSlug(pathname);
    if (liking) {
      return submit(request, env, liking, {
        name: "like",
        done: hasLiked(request),
        sql: COUNT_LIKE,
        cookie: likedCookie(liking),
        location: `/writing/${liking}/?liked`,
      });
    }

    const answering = interestSlug(pathname);
    if (answering) {
      return submit(request, env, answering, {
        name: "interest",
        done: hasAnsweredInterest(request),
        sql: RECORD_INTEREST,
        cookie: interestedCookie(),
        location: `/writing/${answering}/?interested#${INTEREST_ANCHOR}`,
      });
    }

    const page = await env.ASSETS.fetch(request);
    const slug = postSlug(pathname);
    const isHtml = page.headers.get("content-type")?.startsWith("text/html");
    if (!slug || page.status !== 200 || !isHtml) return page;
    return post(request, env, slug, page);
  },
} satisfies ExportedHandler<Env>;
