/** Pure helpers for the Worker, kept apart because workerd treats every export of the entry module as an entrypoint. */

/** Only the live site writes counts; branch previews just read them. */
export const LIVE_HOST = "jspratt.dev";

/** Set on /writing/<slug>/ after a Like, so the browser only sends it for that Post. */
export const LIKED_COOKIE = "liked";

const SLUG = "([a-z0-9][a-z0-9-]*)";

/** "/writing/some-post/" → "some-post"; anything else (the list, the feed) → null. */
export function postSlug(pathname: string): string | null {
  return new RegExp(`^/writing/${SLUG}/$`).exec(pathname)?.[1] ?? null;
}

/** "/writing/some-post/like" → "some-post"; anything else → null. */
export function likeSlug(pathname: string): string | null {
  return new RegExp(`^/writing/${SLUG}/like$`).exec(pathname)?.[1] ?? null;
}

export function isLive(request: Request): boolean {
  return new URL(request.url).hostname === LIVE_HOST;
}

/**
 * A View is a real browser navigation to the live site. Crawlers and curl
 * don't send Sec-Fetch-Mode. `?liked` is the redirect back after a Like,
 * which isn't a new View.
 */
export function shouldCount(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    isLive(request) &&
    !new URL(request.url).searchParams.has("liked")
  );
}

/** Browsers send Origin on every form POST; anything else is another site or a script. */
export function isSameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}

/** The cookie is path-scoped to one Post, so its presence means this browser liked this Post. */
export function hasLiked(request: Request): boolean {
  const cookies = request.headers.get("cookie") ?? "";
  return cookies.split(";").some((c) => c.trim() === `${LIKED_COOKIE}=1`);
}

export function likedCookie(slug: string): string {
  return `${LIKED_COOKIE}=1; Path=/writing/${slug}/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}

export function statsText(views: number): string {
  return ` · Read ${views.toLocaleString("en-GB")} ${views === 1 ? "time" : "times"}`;
}

export function likeLabel(likes: number, liked: boolean): string {
  const word = liked ? "Liked" : "Like";
  return likes > 0 ? `${word} · ${likes.toLocaleString("en-GB")}` : word;
}
