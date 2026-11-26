/**
 * The private traffic dashboard at /stats/: six numbers read from the events
 * table and rendered as one plain HTML page, with no client script. The
 * owner's Events are left out unless asked for. Kept out of the entry module
 * (workerd treats its exports as entrypoints).
 */

import { GAMES } from "./stats.ts";

/** The windows the dashboard offers, in days. */
export const WINDOWS = [7, 30, 90, 365] as const;
export const DEFAULT_WINDOW = 30;

/** "/stats" or "/stats/"; anything else under /stats is not a page. */
export function isDashboard(pathname: string): boolean {
  return pathname === "/stats" || pathname === "/stats/";
}

export interface DashboardQuery {
  days: number;
  /** Include the owner's own Events. */
  withMe: boolean;
}

export function dashboardQuery(url: URL): DashboardQuery {
  const days = Number(url.searchParams.get("days"));
  return {
    days: (WINDOWS as readonly number[]).includes(days) ? days : DEFAULT_WINDOW,
    withMe: url.searchParams.has("me"),
  };
}

export interface PostMeta {
  slug: string;
  title: string;
  date: string;
  tags: string[];
}

export interface DashboardData {
  posts: PostMeta[];
  /** Per UTC day in the window: distinct Visitors that day, in the 7 days and in the 30 days up to it. */
  active: { day: string; dau: number; wau: number; mau: number }[];
  /** Distinct Visitors in the last 24 hours, 7 days and 30 days, rolling from now. */
  current: { dau: number; wau: number; mau: number };
  pages: { path: string; views: number; visitors: number }[];
  sources: { source: string; views: number; visitors: number }[];
  /** Visitors in the window whose first Event is in it, and those who had one before. */
  visitors: { fresh: number; returning: number };
  games: { game: string; plays: number; finishes: number; players: number }[];
  reactions: { path: string; likes: number; interest: number }[];
  clicks: { target: string; clicks: number; visitors: number }[];
}

// The queries. Every one takes ?1, the window's start as a date modifier
// ("-29 days" for 30 days, including today), and ?2, 1 to include the owner.

/**
 * Leaves the owner out: Events flagged is_me, and any Event from a Visitor
 * that has opened /stats/ through Access, whenever it happened.
 */
const COUNTED = "(?2 = 1 OR (is_me = 0 AND (visitor IS NULL OR visitor NOT IN (SELECT visitor FROM owner_visitors))))";
const IN_WINDOW = `created_at >= date('now', ?1) AND ${COUNTED}`;
const SOURCE = "COALESCE(ref, referrer, 'direct')";

export const DASHBOARD_SQL = {
  active: `WITH RECURSIVE days(day) AS (
      SELECT date('now', ?1) UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < date('now')
    ), seen AS (
      SELECT DISTINCT date(created_at) AS day, visitor FROM events
      WHERE created_at >= date('now', ?1, '-29 days') AND visitor IS NOT NULL AND ${COUNTED}
    )
    SELECT d.day,
      COUNT(DISTINCT CASE WHEN s.day = d.day THEN s.visitor END) AS dau,
      COUNT(DISTINCT CASE WHEN s.day > date(d.day, '-7 days') THEN s.visitor END) AS wau,
      COUNT(DISTINCT s.visitor) AS mau
    FROM days d LEFT JOIN seen s ON s.day > date(d.day, '-30 days') AND s.day <= d.day
    GROUP BY d.day ORDER BY d.day`,
  current: `SELECT
      COUNT(DISTINCT CASE WHEN created_at >= datetime('now', '-1 day') THEN visitor END) AS dau,
      COUNT(DISTINCT CASE WHEN created_at >= datetime('now', '-7 days') THEN visitor END) AS wau,
      COUNT(DISTINCT visitor) AS mau
    FROM events WHERE created_at >= datetime('now', '-30 days') AND visitor IS NOT NULL AND ${COUNTED}`,
  pages: `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM events
    WHERE kind = 'view' AND ${IN_WINDOW} GROUP BY path ORDER BY views DESC, path LIMIT 50`,
  sources: `SELECT ${SOURCE} AS source, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM events
    WHERE kind = 'view' AND ${IN_WINDOW} GROUP BY source ORDER BY views DESC, source LIMIT 25`,
  visitors: `SELECT COALESCE(SUM(first >= date('now', ?1)), 0) AS fresh, COALESCE(SUM(first < date('now', ?1)), 0) AS "returning"
    FROM (SELECT visitor, MIN(created_at) AS first FROM events
      WHERE visitor IN (SELECT visitor FROM events WHERE ${IN_WINDOW} AND visitor IS NOT NULL) GROUP BY visitor)`,
  games: `SELECT game, SUM(kind = 'play') AS plays, SUM(kind = 'finish') AS finishes,
      COUNT(DISTINCT CASE WHEN kind = 'play' THEN visitor END) AS players
    FROM events WHERE kind IN ('play', 'finish') AND game IS NOT NULL AND ${IN_WINDOW} GROUP BY game ORDER BY game`,
  reactions: `SELECT path, SUM(kind = 'like') AS likes, SUM(kind = 'interest') AS interest FROM events
    WHERE kind IN ('like', 'interest') AND ${IN_WINDOW} GROUP BY path`,
  clicks: `SELECT target, COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS visitors FROM events
    WHERE kind = 'click_out' AND ${IN_WINDOW} GROUP BY target ORDER BY clicks DESC, target LIMIT 50`,
} as const;

/** Reads everything the page shows in one D1 batch (one round trip). */
export async function loadDashboard(db: D1Database, q: DashboardQuery, posts: PostMeta[]): Promise<DashboardData> {
  const since = `-${q.days - 1} days`;
  const names = Object.keys(DASHBOARD_SQL) as (keyof typeof DASHBOARD_SQL)[];
  const results = await db.batch(names.map((n) => db.prepare(DASHBOARD_SQL[n]).bind(since, q.withMe ? 1 : 0)));
  const rows = Object.fromEntries(names.map((n, i) => [n, results[i].results])) as Record<keyof typeof DASHBOARD_SQL, never[]>;
  return {
    posts,
    active: rows.active,
    current: rows.current[0] ?? { dau: 0, wau: 0, mau: 0 },
    pages: rows.pages,
    sources: rows.sources,
    visitors: rows.visitors[0] ?? { fresh: 0, returning: 0 },
    games: rows.games,
    reactions: rows.reactions,
    clicks: rows.clicks,
  };
}

/** Display names for the Games. */
const GAME_TITLES: Record<string, string> = { "twenty-boats": "Twenty Boats", "cactus-boats": "Cactus Boats" };

/** Names for the pages that aren't a Post or a Game. */
const PAGE_TITLES: Record<string, string> = {
  "/": "Homepage",
  "/games/": "Games page",
  "/writing/": "Writing",
  "/privacy/": "How this site counts visits",
};

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const num = (n: number) => Number(n ?? 0).toLocaleString("en-GB");
const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

/** "2026-11-15" → "15 Nov" */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Every UTC day in the window, oldest first, ending today. */
export function windowDays(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** The page's name and, for a page of the site, a link to it. */
export function pageLabel(path: string, posts: Map<string, PostMeta>): string {
  const post = /^\/writing\/([a-z0-9][a-z0-9-]*)\/$/.exec(path)?.[1];
  const game = /^\/games\/([a-z0-9-]+)\/$/.exec(path)?.[1];
  const title = PAGE_TITLES[path] ?? (post && posts.get(post)?.title) ?? (game && GAME_TITLES[game]) ?? null;
  if (!title) return `<span class="path">${esc(path)}</span>`;
  return `<a href="${esc(path)}">${esc(title)}</a>`;
}

function href(q: DashboardQuery): string {
  const params: string[] = [];
  if (q.days !== DEFAULT_WINDOW) params.push(`days=${q.days}`);
  if (q.withMe) params.push("me");
  return `/stats/${params.length ? `?${params.join("&")}` : ""}`;
}

/** A table cell with a proportional bar behind the number, for scanning a column. */
function barCell(n: number, max: number): string {
  const w = max > 0 ? ((n / max) * 100).toFixed(1) : "0";
  return `<td class="n bar-cell"><span class="hbar" style="width:${w}%"></span><span class="v">${num(n)}</span></td>`;
}

const empty = (cols: number, text = "Nothing in this window yet.") =>
  `<tr><td colspan="${cols}" class="muted">${esc(text)}</td></tr>`;

/** The smallest 1, 2 or 5 × 10ⁿ at or above n, so the axis reads in round numbers. */
export function niceMax(n: number): number {
  if (n <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= n)!;
}

const SERIES = [
  { key: "mau", name: "Monthly", note: "30 days", cls: "mau" },
  { key: "wau", name: "Weekly", note: "7 days", cls: "wau" },
  { key: "dau", name: "Daily", note: "that day", cls: "dau" },
] as const;

/** DAU, WAU and MAU as three lines over the window, one point per UTC day. */
function activeChart(active: DashboardData["active"], days: string[]): string {
  const byDay = new Map(active.map((r) => [r.day, r]));
  const points = days.map((day) => ({ day, dau: 0, wau: 0, mau: 0, ...byDay.get(day) }));
  const top = niceMax(Math.max(0, ...points.map((p) => p.mau)));
  const W = 1000;
  const H = 300;
  const x = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v: number) => H - (v / top) * H;
  const lines = SERIES.map(
    (s) =>
      `<polyline class="line ${s.cls}" points="${points.map((p, i) => `${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(" ")}" />`,
  ).join("");
  const grid = [0.5, 1].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${y(top * f)}" y2="${y(top * f)}" />`).join("");
  const cols = points
    .map((p, i) => {
      const edge = i < points.length * 0.15 ? " start" : i > points.length * 0.85 ? " end" : "";
      const tip = `${shortDay(p.day)}: ${num(p.dau)} daily · ${num(p.wau)} weekly · ${num(p.mau)} monthly`;
      return `<span class="col${edge}" data-tip="${esc(tip)}"></span>`;
    })
    .join("");
  const mid = points[Math.floor((points.length - 1) / 2)].day;
  const last = points.at(-1)!;
  const legend = SERIES.map(
    (s) => `<li><span class="swatch ${s.cls}"></span>${s.name} <span class="muted">(${s.note})</span> <b>${num(last[s.key])}</b></li>`,
  ).join("");
  const rows = points
    .slice()
    .reverse()
    .map((p) => `<tr><td>${esc(shortDay(p.day))}</td><td class="n">${num(p.dau)}</td><td class="n">${num(p.wau)}</td><td class="n">${num(p.mau)}</td></tr>`)
    .join("");
  return `<ul class="legend">${legend}</ul>
  <figure class="chart-wrap">
    <div class="y" aria-hidden="true"><span>${num(top)}</span><span>${num(top / 2)}</span><span>0</span></div>
    <div class="plot">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Active Visitors per day, ${esc(shortDay(days[0]))} to ${esc(shortDay(last.day))}: today ${num(last.dau)} daily, ${num(last.wau)} weekly, ${num(last.mau)} monthly">${grid}${lines}</svg>
      <div class="cols" aria-hidden="true">${cols}</div>
    </div>
    <div class="x" aria-hidden="true"><span>${esc(shortDay(days[0]))}</span><span>${esc(shortDay(mid))}</span><span>${esc(shortDay(last.day))}</span></div>
  </figure>
  <details><summary>Show as a table</summary><div class="scroll"><table><thead><tr><th>Day</th><th class="n">Daily</th><th class="n">Weekly</th><th class="n">Monthly</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function tile(label: string, value: number, note: string): string {
  return `<div class="tile"><p class="label">${esc(label)}</p><p class="value">${num(value)}</p><p class="note">${esc(note)}</p></div>`;
}

export interface Viewer {
  /** The Access sign-in, e.g. the owner's email. */
  email?: string;
}

export function renderDashboard(q: DashboardQuery, data: DashboardData, viewer: Viewer = {}, now = new Date()): string {
  const posts = new Map(data.posts.map((p) => [p.slug, p]));
  const days = windowDays(q.days, now);
  const scope = q.withMe ? "including yours" : "not counting yours";
  const sum = (xs: number[]) => xs.reduce((a, b) => a + Number(b ?? 0), 0);

  const windowLinks = WINDOWS.map((d) => {
    const label = d === 365 ? "1 year" : `${d} days`;
    return d === q.days
      ? `<span class="pill on" aria-current="page">${label}</span>`
      : `<a class="pill" href="${esc(href({ ...q, days: d }))}">${label}</a>`;
  }).join("");
  const meLink = `<a class="pill${q.withMe ? " on" : ""}" href="${esc(href({ ...q, withMe: !q.withMe }))}" aria-pressed="${q.withMe}">Include me</a>`;

  // Views
  const totalViews = sum(data.pages.map((p) => p.views));
  const maxPage = Math.max(0, ...data.pages.map((p) => p.views));
  const maxSource = Math.max(0, ...data.sources.map((s) => s.views));

  // New and returning
  const { fresh, returning } = data.visitors;
  const seen = Number(fresh) + Number(returning);
  const freshShare = seen ? (Number(fresh) / seen) * 100 : 0;

  // Games: every Game the site logs, even with nothing yet.
  const gameRows = new Map(GAMES.map((g) => [g as string, { game: g as string, plays: 0, finishes: 0, players: 0 }]));
  for (const g of data.games) gameRows.set(g.game, g);

  // Posts: every Post in the build, plus any path D1 knows that the build doesn't (a removed Post).
  const reactions = new Map(data.reactions.map((r) => [r.path, r]));
  const postPaths = [...new Set([...data.posts.map((p) => `/writing/${p.slug}/`), ...reactions.keys()])];
  const postRows = postPaths
    .map((path) => ({ path, likes: Number(reactions.get(path)?.likes ?? 0), interest: Number(reactions.get(path)?.interest ?? 0) }))
    .sort((a, b) => b.likes + b.interest - (a.likes + a.interest) || b.likes - a.likes || a.path.localeCompare(b.path));
  const maxLikes = Math.max(0, ...postRows.map((r) => r.likes));
  const totalLikes = sum(postRows.map((r) => r.likes));
  const totalInterest = sum(postRows.map((r) => r.interest));

  const totalClicks = sum(data.clicks.map((c) => c.clicks));
  const maxClicks = Math.max(0, ...data.clicks.map((c) => c.clicks));

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Traffic</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header class="top">
    <div>
      <h1>Traffic</h1>
      <p class="sub">The last ${q.days === 365 ? "year" : `${q.days} days`} (UTC), ${scope}.</p>
    </div>
    <nav class="filters" aria-label="Window">${windowLinks}${meLink}</nav>
  </header>

  <section aria-labelledby="active">
    <h2 id="active">Active Visitors</h2>
    <p class="hint">Distinct browsers with at least one Event. Rolling from now.</p>
    <div class="tiles">
      ${tile("Daily", data.current.dau, "last 24 hours")}
      ${tile("Weekly", data.current.wau, "last 7 days")}
      ${tile("Monthly", data.current.mau, "last 30 days")}
    </div>
    <div class="card">${activeChart(data.active, days)}</div>
  </section>

  <section aria-labelledby="views">
    <h2 id="views">Views <span class="count">${num(totalViews)}</span></h2>
    <div class="split">
      <div class="card">
        <h3>By page</h3>
        <div class="scroll"><table>
          <thead><tr><th>Page</th><th class="n">Views</th><th class="n">Visitors</th></tr></thead>
          <tbody>${
            data.pages.map((p) => `<tr><td>${pageLabel(p.path, posts)}</td>${barCell(p.views, maxPage)}<td class="n">${num(p.visitors)}</td></tr>`).join("") ||
            empty(3)
          }</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3>By source</h3>
        <p class="hint">The link's <code>?ref=</code> tag, else the site that linked, else direct.</p>
        <div class="scroll"><table>
          <thead><tr><th>Source</th><th class="n">Views</th><th class="n">Visitors</th></tr></thead>
          <tbody>${
            data.sources.map((s) => `<tr><td>${esc(s.source)}</td>${barCell(s.views, maxSource)}<td class="n">${num(s.visitors)}</td></tr>`).join("") ||
            empty(3)
          }</tbody>
        </table></div>
      </div>
    </div>
  </section>

  <section aria-labelledby="new">
    <h2 id="new">New and returning Visitors</h2>
    <div class="card">
      <p class="split-bar" role="img" aria-label="${esc(`${plural(Number(fresh), "new Visitor", "new Visitors")}, ${plural(Number(returning), "returning", "returning")}`)}"><span class="fresh" style="width:${freshShare.toFixed(1)}%"></span></p>
      <div class="pair">
        <p><span class="swatch fresh"></span><b>${num(fresh)}</b> new <span class="muted">· first Event in this window</span></p>
        <p><span class="swatch returning"></span><b>${num(returning)}</b> returning <span class="muted">· had one before it</span></p>
      </div>
    </div>
  </section>

  <section aria-labelledby="games">
    <h2 id="games">Games</h2>
    <div class="card">
      <p class="hint">A Play is a run started; a Finish, one that reached its Ending. Plays per Visitor is Plays over the Visitors who played.</p>
      <div class="scroll"><table>
        <thead><tr><th>Game</th><th class="n">Plays</th><th class="n">Finishes</th><th class="n">Visitors</th><th class="n">Plays per Visitor</th></tr></thead>
        <tbody>${[...gameRows.values()]
          .map(
            (g) =>
              `<tr><td>${pageLabel(`/games/${g.game}/`, posts)}</td><td class="n">${num(g.plays)}</td><td class="n">${num(g.finishes)}</td><td class="n">${num(g.players)}</td><td class="n">${g.players ? (Number(g.plays) / Number(g.players)).toFixed(1) : "–"}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>
    </div>
  </section>

  <section aria-labelledby="posts">
    <h2 id="posts">Posts <span class="count">${plural(totalLikes, "Like", "Likes")} · ${num(totalInterest)} Interest</span></h2>
    <div class="card">
      <p class="hint">Interest is a yes to “Would you subscribe by email?”. Each browser answers once, on whichever Post it’s reading.</p>
      <div class="scroll"><table>
        <thead><tr><th>Post</th><th class="n">Likes</th><th class="n">Interest</th></tr></thead>
        <tbody>${
          postRows.map((r) => `<tr><td>${pageLabel(r.path, posts)}</td>${barCell(r.likes, maxLikes)}<td class="n">${num(r.interest)}</td></tr>`).join("") ||
          empty(3, "No Posts yet.")
        }</tbody>
      </table></div>
    </div>
  </section>

  <section aria-labelledby="clicks">
    <h2 id="clicks">Click outs <span class="count">${num(totalClicks)}</span></h2>
    <div class="card">
      <p class="hint">Links followed off the site: the header’s Links and each Project’s.</p>
      <div class="scroll"><table>
        <thead><tr><th>Target</th><th class="n">Click outs</th><th class="n">Visitors</th></tr></thead>
        <tbody>${
          data.clicks.map((c) => `<tr><td>${esc(c.target)}</td>${barCell(c.clicks, maxClicks)}<td class="n">${num(c.visitors)}</td></tr>`).join("") ||
          empty(3)
        }</tbody>
      </table></div>
    </div>
  </section>

  <footer class="foot">
    <p>${viewer.email ? `Signed in as ${esc(viewer.email)}. ` : ""}This browser is marked as yours, so its Events are left out unless you include them.</p>
    <p><a href="/privacy/">How this site counts visits</a> · <a href="/">jspratt.dev</a></p>
  </footer>
</main>
</body>
</html>`;
}

/** The site's tokens (src/styles/global.css), trimmed to what this page uses. Light only, like the site. */
const CSS = `
:root{--page:#fffdf7;--card:#fff;--ink:#15151a;--ink-soft:#4d4a42;--line:#15151a;--grid:#d9d6cc;--link:#2338a8;--blue:#2b49c0;--red:#e8412f;--yellow:#f2c230;--thumb:#eef1ff;--border:3px solid var(--line)}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link);text-underline-offset:.18em}
a:focus-visible,summary:focus-visible{outline:3px solid var(--link);outline-offset:3px}
main{max-width:64rem;margin:0 auto;padding:2rem 16px 4rem}
h1{margin:0;font-size:2.2rem;font-weight:900;letter-spacing:-.02em}
h2{margin:2.25rem 0 .75rem;font-size:1.35rem;font-weight:900;display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .75rem}
h3{margin:0 0 .5rem;font-size:1rem;font-weight:900}
.count{font-size:.95rem;font-weight:700;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.top{display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:end;justify-content:space-between}
.sub{margin:.25rem 0 0;color:var(--ink-soft)}
.hint{margin:-.4rem 0 .75rem;font-size:.85rem;color:var(--ink-soft)}
.card .hint{margin:0 0 .75rem}
.filters{display:flex;flex-wrap:wrap;gap:.5rem}
.pill{padding:.3rem .85rem;font-size:.85rem;font-weight:700;color:var(--ink);text-decoration:none;background:var(--card);border:2px solid var(--line);border-radius:999px}
.pill:hover{background:var(--thumb)}
.pill.on{background:var(--yellow)}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem;margin-bottom:1rem}
.tile,.card{background:var(--card);border:var(--border);border-radius:14px;box-shadow:4px 4px 0 var(--blue)}
.tile{padding:.75rem 1rem}
.tile p{margin:0}
.label{font-size:.85rem;font-weight:700;color:var(--ink-soft)}
.value{font-size:clamp(1.6rem,6vw,2.4rem);font-weight:900;line-height:1.15;font-variant-numeric:tabular-nums}
.note{font-size:.78rem;color:var(--ink-soft)}
.card{padding:1rem 1.15rem;margin-bottom:1rem;min-width:0}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:0 1rem}
.legend{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;margin:0 0 .75rem;padding:0;list-style:none;font-size:.88rem}
.swatch{display:inline-block;width:.9rem;height:.9rem;margin-right:.4rem;vertical-align:-.1rem;border:2px solid var(--line);border-radius:3px}
.swatch.mau{background:var(--blue)}.swatch.wau{background:var(--red)}.swatch.dau{background:var(--yellow)}
.swatch.fresh{background:var(--yellow)}.swatch.returning{background:var(--blue)}
.chart-wrap{display:grid;grid-template-columns:auto 1fr;grid-template-rows:13rem auto;column-gap:.5rem;margin:0}
.y{display:flex;flex-direction:column;justify-content:space-between;font-size:.75rem;color:var(--ink-soft);text-align:right;font-variant-numeric:tabular-nums;margin:-.5em 0}
.plot{position:relative;border-bottom:2px solid var(--ink)}
.plot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.grid{stroke:var(--grid);stroke-dasharray:4 4;vector-effect:non-scaling-stroke}
.line{fill:none;stroke-width:3;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.line.mau{stroke:var(--blue)}.line.wau{stroke:var(--red)}.line.dau{stroke:var(--ink);stroke-width:2;stroke-dasharray:1 5}
.cols{position:absolute;inset:0;display:flex}
.col{position:relative;flex:1}
.col:hover{background:linear-gradient(var(--grid),var(--grid)) center/2px 100% no-repeat}
.col:hover::after{content:attr(data-tip);position:absolute;top:-2.2rem;left:50%;transform:translateX(-50%);z-index:1;padding:.15rem .5rem;font-size:.8rem;font-weight:700;white-space:nowrap;color:var(--ink);background:var(--card);border:2px solid var(--line);border-radius:6px;pointer-events:none}
.col.start:hover::after{left:0;transform:none}
.col.end:hover::after{left:auto;right:0;transform:none}
.x{grid-column:2;display:flex;justify-content:space-between;font-size:.75rem;color:var(--ink-soft);padding-top:.3rem}
.split-bar{display:flex;height:1.4rem;margin:0 0 .75rem;background:var(--blue);border:2px solid var(--line);border-radius:999px;overflow:hidden}
.split-bar .fresh{background:var(--yellow);border-right:2px solid var(--line)}
.pair{display:flex;flex-wrap:wrap;gap:.25rem 2rem}
.pair p{margin:0}
.pair b{font-size:1.4rem;font-variant-numeric:tabular-nums}
details{margin-top:.75rem;font-size:.9rem}
summary{cursor:pointer;color:var(--link);font-weight:700}
details table{max-width:26rem;margin-top:.5rem}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th{text-align:left;font-size:.8rem;color:var(--ink-soft);font-weight:700;border-bottom:2px solid var(--line);padding:.35rem .5rem}
td{padding:.45rem .5rem;border-bottom:1px solid var(--grid);vertical-align:top}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar-cell{position:relative;min-width:5.5rem}
.hbar{position:absolute;right:.5rem;top:.3rem;bottom:.3rem;max-width:calc(100% - 1rem);background:var(--thumb);border-radius:4px 0 0 4px}
.v{position:relative}
.path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;word-break:break-all}
.muted{color:var(--ink-soft)}
code{font-size:.85em;background:var(--thumb);padding:0 .25rem;border-radius:4px}
.foot{margin-top:2.5rem;padding-top:1rem;border-top:2px solid var(--grid);font-size:.85rem;color:var(--ink-soft)}
.foot p{margin:.25rem 0}
@media (max-width:30rem){.tiles{gap:.5rem}.tile{padding:.6rem .7rem}.chart-wrap{grid-template-rows:10rem auto}}
`;
