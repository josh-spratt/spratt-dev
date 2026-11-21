/** Pure helpers for the Worker, kept apart because workerd treats every export of the entry module as an entrypoint. */

/** Only the live site writes counts; branch previews just read them. */
export const LIVE_HOST = "jspratt.dev";

/** Set on /writing/<slug>/ after a Like, so the browser only sends it for that Post. */
export const LIKED_COOKIE = "liked";

/**
 * Set on /writing/ after answering the email-interest question. Scoped to all
 * Posts, so one browser counts once however many Posts it answers on.
 */
export const INTERESTED_COOKIE = "interested";

/**
 * Marks a browser as the site owner's. Set by visiting /writing/?me, for the
 * whole site so it reaches the Games too. Its Views, Plays and Finishes are
 * still logged (flagged) but don't add to the public count.
 */
export const ME_COOKIE = "me";

/** Where the redirect back after answering lands, so the thank-you is in view. */
export const INTEREST_ANCHOR = "interest";

const SLUG = "([a-z0-9][a-z0-9-]*)";

/** "/writing/some-post/" → "some-post"; anything else (the list, the feed) → null. */
export function postSlug(pathname: string): string | null {
  return new RegExp(`^/writing/${SLUG}/$`).exec(pathname)?.[1] ?? null;
}

/** "/writing/some-post/like" → "some-post"; anything else → null. */
export function likeSlug(pathname: string): string | null {
  return new RegExp(`^/writing/${SLUG}/like$`).exec(pathname)?.[1] ?? null;
}

/** "/writing/some-post/interest" → "some-post"; anything else → null. */
export function interestSlug(pathname: string): string | null {
  return new RegExp(`^/writing/${SLUG}/interest$`).exec(pathname)?.[1] ?? null;
}

export function isLive(request: Request): boolean {
  return new URL(request.url).hostname === LIVE_HOST;
}

/**
 * A View is a real browser navigation to the live site. Crawlers and curl
 * don't send Sec-Fetch-Mode. `?liked` and `?interested` are redirects back
 * after a form, which aren't new Views.
 */
export function shouldCount(request: Request): boolean {
  const params = new URL(request.url).searchParams;
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    isLive(request) &&
    !params.has("liked") &&
    !params.has("interested")
  );
}

/** Browsers send Origin on every form POST; anything else is another site or a script. */
export function isSameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}

function hasCookie(request: Request, name: string): boolean {
  const cookies = request.headers.get("cookie") ?? "";
  return cookies.split(";").some((c) => c.trim() === `${name}=1`);
}

/** The cookie is path-scoped to one Post, so its presence means this browser liked this Post. */
export function hasLiked(request: Request): boolean {
  return hasCookie(request, LIKED_COOKIE);
}

export function hasAnsweredInterest(request: Request): boolean {
  return hasCookie(request, INTERESTED_COOKIE);
}

export function interestedCookie(): string {
  return `${INTERESTED_COOKIE}=1; Path=/writing/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}

export function likedCookie(slug: string): string {
  return `${LIKED_COOKIE}=1; Path=/writing/${slug}/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}

export function isMe(request: Request): boolean {
  return hasCookie(request, ME_COOKIE);
}

/** 400 days is the longest any browser keeps a cookie. */
export function meCookie(): string {
  return `${ME_COOKIE}=1; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`;
}

/** "/writing/?me" is the address that sets the owner cookie. */
export function isMeSetup(url: URL): boolean {
  return url.pathname === "/writing/" && url.searchParams.has("me");
}

/** The hostname of a URL, or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Hostname of the linking page, or null. Browsers send only the origin cross-site by default. */
export function referrerHost(request: Request): string | null {
  return hostOf(request.headers.get("referer"));
}

/** A ?ref= tag, cleaned so arbitrary input can't fill the log. */
export function cleanTag(tag: string | null | undefined): string | null {
  if (typeof tag !== "string") return null;
  return (
    tag
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 40) || null
  );
}

/** The ?ref= tag on a shared link. */
export function refTag(url: URL): string | null {
  return cleanTag(url.searchParams.get("ref"));
}

/** The Games whose Views, Plays and Finishes are logged, by their name in /games/<name>/. */
export const GAMES = ["twenty-boats", "cactus-boats"] as const;
export type Game = (typeof GAMES)[number];

function isGame(name: string | undefined): name is Game {
  return (GAMES as readonly string[]).includes(name ?? "");
}

/** "/games/twenty-boats/" → "twenty-boats"; anything else → null. */
export function gamePage(pathname: string): Game | null {
  const name = /^\/games\/([a-z0-9-]+)\/$/.exec(pathname)?.[1];
  return isGame(name) ? name : null;
}

/** "/games/twenty-boats/event" → "twenty-boats", where the game reports a Play or a Finish; anything else → null. */
export function gameEventPath(pathname: string): Game | null {
  const name = /^\/games\/([a-z0-9-]+)\/event$/.exec(pathname)?.[1];
  return isGame(name) ? name : null;
}

/** A Play or a Finish, as the game reports it, with where the player came from. */
export interface GameEvent {
  event: "play" | "finish";
  /** A Finish's Ending id; null for a Play. */
  ending: string | null;
  /** A Finish's 1 (lived) or 0 (didn't); null for a Play. */
  survived: 0 | 1 | null;
  referrer: string | null;
  ref: string | null;
}

/** The longest body a game's report can be; a real one is under 200 bytes. */
export const GAME_EVENT_MAX_BYTES = 1024;

/**
 * Reads the game's JSON report: { event, ending?, survived?, ref?, referrer? }.
 * `ref` is the page's ?ref= tag and `referrer` its document.referrer, so a
 * Play has the same source as the page's View. Anything else is null.
 */
export function parseGameEvent(body: string): GameEvent | null {
  if (body.length > GAME_EVENT_MAX_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const from = { referrer: typeof d.referrer === "string" ? hostOf(d.referrer) : null, ref: cleanTag(d.ref as string) };
  if (d.event === "play") return { event: "play", ending: null, survived: null, ...from };
  if (d.event === "finish") {
    const ending = typeof d.ending === "string" && /^[a-z0-9-]{1,40}$/.test(d.ending) ? d.ending : null;
    if (!ending || typeof d.survived !== "boolean") return null;
    return { event: "finish", ending, survived: d.survived ? 1 : 0, ...from };
  }
  return null;
}

// The Leaderboard. Kept apart from GAMES: a Game can be logged without having
// a Leaderboard. The Score is the game's own scoreOf, so the two can't disagree.

export { scoreOf } from "../public/games/cactus-boats/score.js";

/** The Games with a Leaderboard, by their name in /games/<name>/. */
export const LEADERBOARD_GAMES = ["cactus-boats"] as const;
export type LeaderboardGame = (typeof LEADERBOARD_GAMES)[number];

/** How many Scores the board shows. */
export const BOARD_SIZE = 10;

export type LeaderboardAction = "start" | "score" | "scores";

/** "/games/cactus-boats/score" → { game: "cactus-boats", action: "score" }; anything else → null. */
export function leaderboardPath(pathname: string): { game: LeaderboardGame; action: LeaderboardAction } | null {
  const m = /^\/games\/([a-z0-9-]+)\/(start|score|scores)$/.exec(pathname);
  if (!m || !(LEADERBOARD_GAMES as readonly string[]).includes(m[1])) return null;
  return { game: m[1] as LeaderboardGame, action: m[2] as LeaderboardAction };
}

/** Three letters A–Z, uppercased; anything else (spaces, digits, accents, two or four letters) → null. */
export function cleanInitials(initials: unknown): string | null {
  if (typeof initials !== "string") return null;
  const up = initials.toUpperCase();
  return /^[A-Z]{3}$/.test(up) ? up : null;
}

/** The longest body `start` or `score` reads; a real one is under 200 bytes. */
export const LEADERBOARD_MAX_BYTES = 512;

function parseObject(body: string): Record<string, unknown> | null {
  if (body.length > LEADERBOARD_MAX_BYTES) return null;
  try {
    const data: unknown = JSON.parse(body);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Where the player came from, sent when a Play starts: { ref?, referrer? }, cleaned like a Play's. */
export function parseStart(body: string): { referrer: string | null; ref: string | null } | null {
  const d = parseObject(body);
  if (!d) return null;
  return { referrer: typeof d.referrer === "string" ? hostOf(d.referrer) : null, ref: cleanTag(d.ref as string) };
}

/** A Score as the game sends it when the player is sunk. */
export interface ScoreSubmission {
  run: number;
  initials: string;
  survivedMs: number;
  sinks: number;
  /** What the game says the Score is; the Worker checks it against scoreOf and stores its own. */
  score: number;
}

const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Reads { run, initials, survivedMs, sinks, score }: whole, non-negative
 * numbers, a positive run id and clean Initials, or null. Whether the Score
 * is plausible (and matches scoreOf) is checked against the run separately.
 */
export function parseScore(body: string): ScoreSubmission | null {
  const d = parseObject(body);
  if (!d) return null;
  const initials = cleanInitials(d.initials);
  const { run, survivedMs, sinks, score } = d;
  if (!initials || !count(run) || run === 0 || !count(survivedMs) || !count(sinks) || !count(score)) return null;
  return { run, initials, survivedMs, sinks, score };
}

export function statsText(views: number): string {
  return ` · Read ${views.toLocaleString("en-GB")} ${views === 1 ? "time" : "times"}`;
}

export function likeLabel(likes: number, liked: boolean): string {
  const word = liked ? "Liked" : "Like";
  return likes > 0 ? `${word} · ${likes.toLocaleString("en-GB")}` : word;
}
