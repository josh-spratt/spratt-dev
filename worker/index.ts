/**
 * Runs for every page of the site, a Game's event and Leaderboard addresses,
 * /out/* and /stats* (see run_worker_first in wrangler.jsonc). Every page is
 * still built statically. Each page View is recorded as an Event, and so is
 * every Play, Finish, Like, Interest and Click out (docs/database.md). Beside
 * that, the old tables keep their own counts until the cutover: for a Post
 * page this counts the View and writes the View and Like counts into the HTML,
 * and for a Game it logs the page's Views and the Plays and Finishes the game
 * reports, and keeps its Leaderboard. A Like and the email-interest answer are
 * plain form POSTs, so the page ships no client script. /stats/ is the owner's
 * private traffic dashboard, read from the Events, behind Cloudflare Access. A
 * daily cron strips Visitor ids from Events older than 13 months.
 */

import { dashboardQuery, isDashboard, loadDashboard, renderDashboard, type PostMeta } from "./dashboard.ts";
import { accessConfig, accessIdentity } from "./access.ts";

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
  fromPage,
  isPageView,
  outPath,
  outTarget,
  visitorOf,
  type EventKind,
  isBot,
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

// Events. Written apart from the old tables' statements, and never awaited by
// the response, so an Event that fails can't change what the old tables or the
// reader get.
// An Event is the owner's when the browser has the `me` cookie or its Visitor
// has opened /stats/ through Access (owner_visitors).
const OWNER_VISITOR = (visitor: string) => `EXISTS (SELECT 1 FROM owner_visitors WHERE visitor = ${visitor})`;
const RECORD_EVENT = `INSERT INTO events (kind, path, ref, referrer, visitor, is_me, game, ending, survived, target)
  VALUES (?1, ?2, ?3, ?4, ?5, MAX(?6, ${OWNER_VISITOR("?5")}), ?7, ?8, ?9, ?10)`;
// A Like, Interest or Click out has no source of its own: it takes the source
// of this Visitor's latest View of the page (?2), or none (direct).
const RECORD_FROM_VIEW = `INSERT INTO events (kind, path, ref, referrer, visitor, is_me, target)
  SELECT ?1, ?2, v.ref, v.referrer, ?3, MAX(?4, ${OWNER_VISITOR("?3")}), ?5 FROM (SELECT 1) LEFT JOIN (
    SELECT ref, referrer FROM events WHERE visitor = ?3 AND kind = 'view' AND path = ?2 ORDER BY id DESC LIMIT 1
  ) v ON 1`;

interface Event {
  kind: EventKind;
  path: string;
  ref: string | null;
  referrer: string | null;
  visitor: string | null;
  game?: string | null;
  ending?: string | null;
  survived?: 0 | 1 | null;
}

function recordEvent(env: Env, ctx: ExecutionContext, request: Request, e: Event): void {
  const stmt = env.DB.prepare(RECORD_EVENT).bind(
    e.kind, e.path, e.ref, e.referrer, e.visitor, isMe(request) ? 1 : 0, e.game ?? null, e.ending ?? null, e.survived ?? null, null,
  );
  ctx.waitUntil(stmt.run().catch((err) => console.error(`${e.kind} event failed`, err)));
}

function recordFromView(
  env: Env, ctx: ExecutionContext, request: Request, kind: EventKind, path: string, visitor: string | null, target: string | null = null,
): void {
  const stmt = env.DB.prepare(RECORD_FROM_VIEW).bind(kind, path, visitor, isMe(request) ? 1 : 0, target);
  ctx.waitUntil(stmt.run().catch((err) => console.error(`${kind} event failed`, err)));
}

/** The response with a header added; asset responses' headers can't be changed in place. */
function withCookie(res: Response, cookie: string | null): Response {
  if (!cookie) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", cookie);
  return out;
}

/**
 * Records a View Event for a page response when it is one (isPageView), giving
 * a new browser its Visitor cookie. The page itself is served unchanged.
 */
function pageView(env: Env, ctx: ExecutionContext, request: Request, res: Response, game: Game | null = null): Response {
  if (!isPageView(request, res)) return res;
  const url = new URL(request.url);
  const visitor = visitorOf(request);
  recordEvent(env, ctx, request, {
    kind: "view", path: url.pathname, ref: refTag(url), referrer: referrerHost(request), visitor: visitor.id, game,
  });
  return withCookie(res, visitor.cookie);
}

/**
 * GET /out/<name>/: a Click out. Redirects (302) to the address the build's
 * list has for that name, and on the live site records the Click out first,
 * with the source of the page's View. A name not on the list is the ordinary
 * 404 page, so this can't send anyone anywhere else.
 */
async function clickOut(request: Request, env: Env, ctx: ExecutionContext, name: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  let links: unknown = null;
  try {
    const res = await env.ASSETS.fetch(new URL("/out/links.json", request.url));
    if (res.ok) links = await res.json();
  } catch (err) {
    console.error("out links failed", err);
  }
  const target = outTarget(links, name);
  if (!target) return notFound(env, request);

  const headers = new Headers({ location: target, "cache-control": "no-store" });
  if (request.method === "GET" && shouldCount(request) && !isBot(request)) {
    const visitor = visitorOf(request);
    recordFromView(env, ctx, request, "click_out", fromPage(request) ?? `/out/${name}/`, visitor.id, name);
    if (visitor.cookie) headers.set("set-cookie", visitor.cookie);
  }
  return new Response(null, { status: 302, headers });
}

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
  /** For the error log, and the Event it records. */
  name: "like" | "interest";
}

/** A Post's form POST: same-site, real Posts only, once per browser, and only the live site writes. */
async function submit(request: Request, env: Env, ctx: ExecutionContext, slug: string, action: FormAction): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  if (!(await postExists(env, request, slug))) return new Response("Not Found", { status: 404 });

  const headers = new Headers({ location: action.location });
  if (isLive(request) && !action.done) {
    try {
      await env.DB.prepare(action.sql).bind(slug).run();
      headers.set("set-cookie", action.cookie);
      const visitor = visitorOf(request);
      recordFromView(env, ctx, request, action.name, `/writing/${slug}/`, visitor.id);
      if (visitor.cookie) headers.append("set-cookie", visitor.cookie);
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
async function gameView(request: Request, env: Env, ctx: ExecutionContext, game: Game): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const page = pageView(env, ctx, request, asset, game);
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
async function gameEvent(request: Request, env: Env, ctx: ExecutionContext, game: Game): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const event = parseGameEvent(await request.text());
  if (!event) return new Response("Bad Request", { status: 400 });
  const headers = new Headers({ "cache-control": "no-store" });
  if (isLive(request)) {
    const visitor = visitorOf(request);
    recordEvent(env, ctx, request, {
      kind: event.event, path: `/games/${game}/`, ref: event.ref, referrer: event.referrer, visitor: visitor.id,
      game, ending: event.ending, survived: event.survived,
    });
    if (visitor.cookie) headers.set("set-cookie", visitor.cookie);
    try {
      await env.DB.prepare(LOG_GAME)
        .bind(game, event.event, event.ending, event.survived, event.referrer, event.ref, isMe(request) ? 1 : 0)
        .run();
    } catch (err) {
      console.error("game event failed", err);
    }
  }
  return new Response(null, { status: 204, headers });
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
 * Anyone who isn't the owner gets the ordinary 404 page, so /stats/ looks like
 * it isn't there. The path is one no asset has, so the assets serve the 404 page.
 */
async function notFound(env: Env, request: Request): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL("/stats/not-found/", request.url));
  const headers = new Headers(page.headers);
  headers.set("cache-control", "no-store");
  return new Response(page.body, { status: 404, headers });
}

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

// Marking the owner: this Visitor joins owner_visitors, and its Events so far
// are flagged, so the dashboard and every later count leave them out.
const MARK_OWNER = "INSERT INTO owner_visitors (visitor) VALUES (?1) ON CONFLICT (visitor) DO NOTHING";
const FLAG_OWNER_EVENTS = "UPDATE events SET is_me = 1 WHERE visitor = ?1 AND is_me = 0";

/** The old STATS_KEY dashboard's cookie, cleared from any browser that still sends it. */
const OLD_STATS_COOKIE = "stats=; Path=/stats/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";

// Secrets, so not in wrangler.jsonc; `wrangler types` only knows them when .dev.vars has them.
type AccessEnv = Env & { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };

/**
 * /stats/: the owner's dashboard, behind Cloudflare Access. Access signs the
 * owner in before the request gets here; the Worker checks Access's signed
 * JWT too, and without a valid one (or without ACCESS_TEAM_DOMAIN and
 * ACCESS_AUD set, as on branch previews) it's the 404 page. Opening it marks
 * this browser as the owner's: its Visitor id and the site-wide `me` cookie.
 */
async function dashboard(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" || !isDashboard(url.pathname)) return notFound(env, request);
  const identity = await accessIdentity(request, accessConfig(env as AccessEnv));
  if (!identity) return notFound(env, request);

  const visitor = visitorOf(request);
  try {
    await env.DB.batch([env.DB.prepare(MARK_OWNER).bind(visitor.id), env.DB.prepare(FLAG_OWNER_EVENTS).bind(visitor.id)]);
  } catch (err) {
    console.error("marking the owner failed", err);
  }

  const q = dashboardQuery(url);
  const data = await loadDashboard(env.DB, q, await buildPosts(env, request));
  const headers = new Headers({
    ...PRIVATE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  headers.append("set-cookie", meCookie());
  if (visitor.cookie) headers.append("set-cookie", visitor.cookie);
  if (/(?:^|;\s*)stats=/.test(request.headers.get("cookie") ?? "")) headers.append("set-cookie", OLD_STATS_COOKIE);
  return new Response(renderDashboard(q, data, { email: identity.email }), { headers });
}

// Visitor ids are kept for 13 months, then stripped from the Events, which
// stay (docs/adr/0001-first-party-visitor-cookie.md). Run daily by the cron
// trigger in wrangler.jsonc.
const STRIP_VISITORS = "UPDATE events SET visitor = NULL WHERE visitor IS NOT NULL AND created_at < datetime('now', '-13 months')";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/stats" || pathname.startsWith("/stats/")) return dashboard(request, env, url);

    const playing = gamePage(pathname);
    if (playing) return gameView(request, env, ctx, playing);
    const reporting = gameEventPath(pathname);
    if (reporting) return gameEvent(request, env, ctx, reporting);
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
      return submit(request, env, ctx, liking, {
        name: "like",
        done: hasLiked(request),
        sql: COUNT_LIKE,
        cookie: likedCookie(liking),
        location: `/writing/${liking}/?liked`,
      });
    }

    const answering = interestSlug(pathname);
    if (answering) {
      return submit(request, env, ctx, answering, {
        name: "interest",
        done: hasAnsweredInterest(request),
        sql: RECORD_INTEREST,
        cookie: interestedCookie(),
        location: `/writing/${answering}/?interested#${INTEREST_ANCHOR}`,
      });
    }

    const leaving = outPath(pathname);
    if (leaving) return clickOut(request, env, ctx, leaving);

    // Every other page: a View Event, then for a Post the old counts.
    const page = pageView(env, ctx, request, await env.ASSETS.fetch(request));
    const slug = postSlug(pathname);
    const isHtml = page.headers.get("content-type")?.startsWith("text/html");
    if (!slug || page.status !== 200 || !isHtml) return page;
    return post(request, env, slug, page);
  },

  async scheduled(_controller, env): Promise<void> {
    const { meta } = await env.DB.prepare(STRIP_VISITORS).run();
    console.log(`stripped Visitor ids from ${meta.changes} Events older than 13 months`);
  },
} satisfies ExportedHandler<Env>;
