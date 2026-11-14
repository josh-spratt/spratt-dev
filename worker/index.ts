/**
 * Runs only for /writing/* (see run_worker_first in wrangler.jsonc). Every page
 * is still built statically. For a Post page this counts the View in D1 and
 * writes the View and Like counts into the HTML. A Like and the email-interest
 * answer are plain form POSTs, so the page ships no client script.
 */

import {
  INTEREST_ANCHOR,
  hasAnsweredInterest,
  hasLiked,
  interestSlug,
  interestedCookie,
  isLive,
  isSameOrigin,
  likeLabel,
  likeSlug,
  likedCookie,
  postSlug,
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

const INTEREST_THANKS =
  `<p class="interest" id="${INTEREST_ANCHOR}">Thanks. If enough people say so, I’ll set up email.</p>`;

async function readStats(env: Env, slug: string, count: boolean): Promise<Stats> {
  const row = await env.DB.prepare(count ? COUNT_VIEW : READ).bind(slug).first<Stats>();
  return row ?? { views: 0, likes: 0 };
}

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
    stats = await readStats(env, slug, shouldCount(request));
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

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

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
