/**
 * Runs only for /writing/*, /stats* and a Game's page and event address (see
 * run_worker_first in wrangler.jsonc). Every page is still built statically.
 * For a Post page this counts the View in D1 and writes the View and Like
 * counts into the HTML. For a Game it logs the page's Views and the Plays and
 * Finishes the game reports, and keeps its Leaderboard. A Like and the
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
  gameEventPath,
  gamePage,
  hasAnsweredInterest,
  hasLiked,
  interestSlug,
  interestedCookie,
  BOARD_SIZE,
  CLOCK_ALLOWANCE_MS,
  LEADERBOARD_MAX_BYTES,
  RUN_MAX_AGE_HOURS,
  isPlausible,
  leaderboardPath,
  parseScore,
  parseStart,
  scoreOf,
  type LeaderboardGame,
  isLive,
  isMe,
  isMeSetup,
  isSameOrigin,
  likeLabel,
  likeSlug,
  likedCookie,
  meCookie,
  parseGameEvent,
  postSlug,
  refTag,
  referrerHost,
  shouldCount,
  statsText,
  type Game,
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
const LOG_GAME =
  "INSERT INTO game_log (game, event, ending, survived, referrer, ref, is_me) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";

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
  "This browser is now marked as yours. Its Views of Posts and Games, and its Plays, are logged as yours and don't add to the public count.\n";

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
 * A Game's page: served as built, with a View logged under the same rules as
 * a Post's (a browser navigation to the live site; the owner's flagged).
 */
async function gameView(request: Request, env: Env, game: Game): Promise<Response> {
  const page = await env.ASSETS.fetch(request);
  const isHtml = page.headers.get("content-type")?.startsWith("text/html");
  if (page.status !== 200 || !isHtml || !shouldCount(request)) return page;
  try {
    await env.DB.prepare(LOG_GAME)
      .bind(game, "view", null, null, referrerHost(request), refTag(new URL(request.url)), isMe(request) ? 1 : 0)
      .run();
  } catch (err) {
    console.error("game view failed", err);
  }
  return page;
}

/**
 * A Play or a Finish, POSTed by the game's own script (play.js). Same-site
 * only, and only the live site writes. Always 204, so the game never waits
 * on it or shows an error.
 */
async function gameEvent(request: Request, env: Env, game: Game): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const event = parseGameEvent(await request.text());
  if (!event) return new Response("Bad Request", { status: 400 });
  if (isLive(request)) {
    try {
      await env.DB.prepare(LOG_GAME)
        .bind(game, event.event, event.ending, event.survived, event.referrer, event.ref, isMe(request) ? 1 : 0)
        .run();
    } catch (err) {
      console.error("game event failed", err);
    }
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

// The Leaderboard: the board is the top Scores, highest first, the earlier
// run winning a tie. Only submitted rows are on it.
const START_RUN = "INSERT INTO scores (game, referrer, ref, is_me) VALUES (?1, ?2, ?3, ?4) RETURNING id";
// One statement, so a Score lands only on a run that is this Game's, not yet
// scored, under RUN_MAX_AGE_HOURS old, and has been going at least as long as
// it says it survived (less CLOCK_ALLOWANCE_MS). Two Scores sent at once for
// one run can't both land. The clock is D1's, the same one that stamped started_at.
const SUBMIT_SCORE = `UPDATE scores SET submitted_at = datetime('now'), initials = ?3, survived_ms = ?4, sinks = ?5, score = ?6, is_me = MAX(is_me, ?7)
  WHERE id = ?1 AND game = ?2 AND submitted_at IS NULL
    AND started_at > datetime('now', '-${RUN_MAX_AGE_HOURS} hours')
    AND ?4 <= (julianday('now') - julianday(started_at)) * 86400000 + ${CLOCK_ALLOWANCE_MS}
  RETURNING id`;
const BOARD = `SELECT initials, score, survived_ms AS survivedMs, sinks, strftime('%Y-%m-%dT%H:%M:%SZ', submitted_at) AS at FROM scores WHERE game = ?1 AND submitted_at IS NOT NULL ORDER BY score DESC, id LIMIT ${BOARD_SIZE}`;
const RANK =
  "SELECT COUNT(*) + 1 AS rank FROM scores WHERE game = ?1 AND submitted_at IS NOT NULL AND (score > ?2 OR (score = ?2 AND id < ?3))";

interface BoardEntry {
  initials: string;
  score: number;
  survivedMs: number;
  sinks: number;
  at: string;
}

const json = (data: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });

/** The POSTs: same-site only, and a body that says it's over the cap isn't read (parsing caps it too). */
function refuse(request: Request): Response | null {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > LEADERBOARD_MAX_BYTES) {
    return new Response("Content Too Large", { status: 413 });
  }
  return null;
}

/**
 * POST /games/<name>/start → { run }. The run id the Play's Score goes
 * against later, stamped with when it started. Off the live site, or when D1
 * fails, there's no run, and the game shows the board as read-only.
 */
async function startRun(request: Request, env: Env, game: LeaderboardGame): Promise<Response> {
  const refused = refuse(request);
  if (refused) return refused;
  const from = parseStart(await request.text());
  if (!from) return new Response("Bad Request", { status: 400 });
  if (!isLive(request)) return json({ run: null });
  try {
    const row = await env.DB.prepare(START_RUN)
      .bind(game, from.referrer, from.ref, isMe(request) ? 1 : 0)
      .first<{ id: number }>();
    return json({ run: row?.id ?? null });
  } catch (err) {
    console.error("leaderboard start failed", err);
    return json({ run: null });
  }
}

/**
 * POST /games/<name>/score { run, initials, survivedMs, sinks, score } →
 * { rank, top }. The Worker stores its own scoreOf. It refuses (400, writing
 * nothing) rude Initials, a Score that doesn't match scoreOf or sinks more
 * boats than could have come, and a run it never handed out, already scored,
 * too old, or younger than the time survived. Live site only.
 */
async function submitScore(request: Request, env: Env, game: LeaderboardGame): Promise<Response> {
  const refused = refuse(request);
  if (refused) return refused;
  const sub = parseScore(await request.text());
  if (!sub) return new Response("Bad Request", { status: 400 });
  if (!isPlausible(sub)) return new Response("Bad Request", { status: 400 });
  const score = scoreOf(sub.survivedMs, sub.sinks);
  if (!isLive(request)) return new Response("Forbidden", { status: 403 });
  try {
    const row = await env.DB.prepare(SUBMIT_SCORE)
      .bind(sub.run, game, sub.initials, sub.survivedMs, sub.sinks, score, isMe(request) ? 1 : 0)
      .first<{ id: number }>();
    if (!row) return new Response("Bad Request", { status: 400 });
    const [rank, top] = await env.DB.batch([
      env.DB.prepare(RANK).bind(game, score, row.id),
      env.DB.prepare(BOARD).bind(game),
    ]);
    return json({ rank: (rank.results[0] as { rank: number }).rank, top: top.results as unknown as BoardEntry[] });
  } catch (err) {
    console.error("leaderboard score failed", err);
    return new Response("Service Unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
}

/**
 * GET /games/<name>/scores → { top }. Every host reads the live board, so
 * previews show it too. Cached briefly; when D1 fails, an empty board flagged
 * unavailable.
 */
async function topScores(request: Request, env: Env, game: LeaderboardGame): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  try {
    const { results } = await env.DB.prepare(BOARD).bind(game).all<BoardEntry>();
    return json({ top: results }, 200, "public, max-age=10");
  } catch (err) {
    console.error("leaderboard read failed", err);
    return json({ top: [], unavailable: true });
  }
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
  `SELECT game, SUM(event = 'view') AS views, SUM(event = 'play') AS plays, SUM(event = 'finish') AS finishes, SUM(event = 'finish' AND survived = 1) AS lived FROM game_log WHERE ${IN_WINDOW} GROUP BY game ORDER BY game`,
  `SELECT ${SOURCE} AS source, SUM(event = 'view') AS views, SUM(event = 'play') AS plays, SUM(event = 'finish') AS finishes FROM game_log WHERE ${IN_WINDOW} GROUP BY source ORDER BY views DESC, plays DESC, source LIMIT 25`,
  `SELECT ending, survived, COUNT(*) AS finishes FROM game_log WHERE event = 'finish' AND ${IN_WINDOW} GROUP BY ending, survived ORDER BY finishes DESC, ending LIMIT 25`,
];
/** The queries above that take the window (?1) and the owner switch (?2). */
const WINDOWED = new Set([0, 1, 2, 3, 6, 7, 8]);

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
      DASHBOARD_SQL.map((sql, i) => (WINDOWED.has(i) ? env.DB.prepare(sql).bind(since, withMe) : env.DB.prepare(sql))),
    ),
  ]);
  const [daily, windowViews, sources, recent, totals, interest, games, gameSources, endings] = results.map((r) => r.results);
  const data = { posts, daily, windowViews, sources, recent, totals, interest, games, gameSources, endings } as DashboardData;

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

    const playing = gamePage(pathname);
    if (playing) return gameView(request, env, playing);
    const reporting = gameEventPath(pathname);
    if (reporting) return gameEvent(request, env, reporting);
    const board = leaderboardPath(pathname);
    if (board?.action === "start") return startRun(request, env, board.game);
    if (board?.action === "score") return submitScore(request, env, board.game);
    if (board?.action === "scores") return topScores(request, env, board.game);

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
