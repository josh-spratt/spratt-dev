/** Pure helpers for the Worker, kept apart because workerd treats every export of the entry module as an entrypoint. */

/** Only the live site writes counts; branch previews just read them. */
export const LIVE_HOST = "jspratt.dev";

/** "/writing/some-post/" → "some-post"; anything else (the list, the feed) → null. */
export function postSlug(pathname: string): string | null {
  const m = /^\/writing\/([a-z0-9][a-z0-9-]*)\/$/.exec(pathname);
  return m ? m[1] : null;
}

/** A View is a real browser navigation to the live site. Crawlers and curl don't send Sec-Fetch-Mode. */
export function shouldCount(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    new URL(request.url).hostname === LIVE_HOST
  );
}

export function statsText(views: number): string {
  return ` · Read ${views.toLocaleString("en-GB")} ${views === 1 ? "time" : "times"}`;
}
