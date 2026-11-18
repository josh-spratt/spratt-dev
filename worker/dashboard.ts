/**
 * The private traffic dashboard at /stats/: what the Worker reads from D1,
 * rendered as one plain HTML page with no client script. Pure helpers only,
 * kept out of the entry module (workerd treats its exports as entrypoints).
 */

/** Holds a hash of STATS_KEY, never the key itself. Scoped to /stats/. */
export const STATS_COOKIE = "stats";

/** The windows the dashboard offers, in days. */
export const WINDOWS = [7, 30, 90] as const;
export const DEFAULT_WINDOW = 30;

/** "/stats" or "/stats/"; anything else under /stats is not a page. */
export function isDashboard(pathname: string): boolean {
  return pathname === "/stats" || pathname === "/stats/";
}

/** The cookie value for a key: a SHA-256, so the cookie can't be turned back into the key. */
export async function statsToken(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`spratt-dev-stats:${key}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares in time that doesn't depend on where the strings first differ. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** 400 days is the longest any browser keeps a cookie. */
export function statsCookie(token: string): string {
  return `${STATS_COOKIE}=${token}; Path=/stats/; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict`;
}

export interface DashboardQuery {
  days: number;
  /** Include the owner's own Views (marked with /writing/?me). */
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
  /** Views per UTC day in the window; days with none are missing. */
  daily: { day: string; views: number }[];
  /** Views per Post in the window. */
  windowViews: { slug: string; views: number }[];
  /** All-time counters, which never include the owner's Views. */
  totals: { slug: string; views: number; likes: number }[];
  interest: { slug: string; answers: number }[];
  sources: { source: string; views: number }[];
  recent: { created_at: string; slug: string; source: string; is_me: number }[];
  /** Per Game in the window: Views of its page, Plays, Finishes, and Finishes the passenger lived through. */
  games: { game: string; views: number; plays: number; finishes: number; lived: number }[];
  /** Game Views, Plays and Finishes in the window, by source. */
  gameSources: { source: string; views: number; plays: number; finishes: number }[];
  /** Finishes in the window, by Ending. */
  endings: { ending: string; survived: number; finishes: number }[];
}

/** Display names for the Games in game_log. */
const GAME_TITLES: Record<string, string> = { "twenty-boats": "Twenty Boats" };

/** Every UTC day in the window, oldest first, ending today. */
export function windowDays(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const num = (n: number) => n.toLocaleString("en-GB");

/** "2026-11-15" → "15 Nov" */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function href(q: DashboardQuery): string {
  const params = new URLSearchParams();
  if (q.days !== DEFAULT_WINDOW) params.set("days", String(q.days));
  const s = params.toString();
  return `/stats/${s ? `?${s}` : ""}${q.withMe ? `${s ? "&" : "?"}me` : ""}`;
}

function tile(label: string, value: number, note: string): string {
  return `<div class="tile"><p class="label">${esc(label)}</p><p class="value">${num(value)}</p><p class="note">${esc(note)}</p></div>`;
}

function chart(days: string[], counts: Map<string, number>): string {
  const max = Math.max(1, ...days.map((d) => counts.get(d) ?? 0));
  const cols = days
    .map((d, i) => {
      const n = counts.get(d) ?? 0;
      const edge = i < 3 ? " start" : i >= days.length - 3 ? " end" : "";
      const tip = `${shortDay(d)}: ${num(n)} ${n === 1 ? "View" : "Views"}`;
      return `<div class="col${edge}" data-tip="${esc(tip)}" aria-hidden="true"><div class="bar" style="height:${((n / max) * 100).toFixed(2)}%"></div></div>`;
    })
    .join("");
  const rows = days
    .slice()
    .reverse()
    .map((d) => `<tr><td>${esc(shortDay(d))}</td><td class="n">${num(counts.get(d) ?? 0)}</td></tr>`)
    .join("");
  return `<figure class="chart-wrap">
  <div class="y"><span>${num(max)}</span><span>0</span></div>
  <div class="chart" role="img" aria-label="Views per day, ${esc(shortDay(days[0]))} to ${esc(shortDay(days.at(-1)!))}, peaking at ${num(max)}">${cols}</div>
  <div class="x"><span>${esc(shortDay(days[0]))}</span><span>${esc(shortDay(days.at(-1)!))}</span></div>
</figure>
<details><summary>Show as a table</summary><table><thead><tr><th>Day</th><th class="n">Views</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

/** A table cell with a proportional bar behind the number, for scanning a column. */
function barCell(n: number, max: number): string {
  const w = max > 0 ? ((n / max) * 100).toFixed(1) : "0";
  return `<td class="n bar-cell"><span class="hbar" style="width:${w}%"></span><span class="v">${num(n)}</span></td>`;
}

export function renderDashboard(q: DashboardQuery, data: DashboardData, now = new Date()): string {
  const meta = new Map(data.posts.map((p) => [p.slug, p]));
  const windowViews = new Map(data.windowViews.map((r) => [r.slug, r.views]));
  const totals = new Map(data.totals.map((r) => [r.slug, r]));
  const interest = new Map(data.interest.map((r) => [r.slug, r.answers]));
  const days = windowDays(q.days, now);
  const daily = new Map(data.daily.map((r) => [r.day, r.views]));

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const inWindow = sum(data.windowViews.map((r) => r.views));
  const allTime = sum(data.totals.map((r) => r.views));
  const likes = sum(data.totals.map((r) => r.likes));
  const answers = sum(data.interest.map((r) => r.answers));

  // Every Post in the build, plus any slug D1 knows that the build doesn't (a removed Post).
  const slugs = [...new Set([...data.posts.map((p) => p.slug), ...totals.keys(), ...windowViews.keys()])];
  const postRows = slugs
    .map((slug) => ({
      slug,
      title: meta.get(slug)?.title ?? slug,
      tags: meta.get(slug)?.tags ?? [],
      live: meta.has(slug),
      window: windowViews.get(slug) ?? 0,
      views: totals.get(slug)?.views ?? 0,
      likes: totals.get(slug)?.likes ?? 0,
      interest: interest.get(slug) ?? 0,
    }))
    .sort((a, b) => b.window - a.window || b.views - a.views || a.title.localeCompare(b.title));
  const maxPost = Math.max(0, ...postRows.map((r) => r.window));

  const byTag = new Map<string, { views: number; posts: number }>();
  for (const r of postRows) {
    for (const t of r.tags) {
      const cur = byTag.get(t) ?? { views: 0, posts: 0 };
      byTag.set(t, { views: cur.views + r.window, posts: cur.posts + 1 });
    }
  }
  const tagRows = [...byTag].sort((a, b) => b[1].views - a[1].views || a[0].localeCompare(b[0]));
  const maxTag = Math.max(0, ...tagRows.map(([, v]) => v.views));
  const maxSource = Math.max(0, ...data.sources.map((s) => s.views));

  const windowLinks = WINDOWS.map((d) =>
    d === q.days
      ? `<span class="pill on" aria-current="page">${d} days</span>`
      : `<a class="pill" href="${esc(href({ ...q, days: d }))}">${d} days</a>`,
  ).join("");
  const meLink = `<a class="pill${q.withMe ? " on" : ""}" href="${esc(href({ ...q, withMe: !q.withMe }))}" aria-pressed="${q.withMe}">Include my Views</a>`;
  const scope = q.withMe ? "including yours" : "not counting yours";

  const tags = (ts: string[]) => ts.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ");

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
      <p class="sub">Views of Posts in the last ${q.days} days (UTC), ${scope}. <a href="/writing/">Writing</a></p>
    </div>
    <nav class="filters" aria-label="Window">${windowLinks}${meLink}</nav>
  </header>

  <section class="tiles" aria-label="Totals">
    ${tile(`Views, ${q.days} days`, inWindow, scope)}
    ${tile("Views, all time", allTime, "the public count")}
    ${tile("Likes", likes, "all time")}
    ${tile("Would subscribe", answers, "email interest, all time")}
  </section>

  <section class="card">
    <h2>Views per day</h2>
    ${chart(days, daily)}
  </section>

  <section class="card">
    <h2>Posts</h2>
    <div class="scroll"><table>
      <thead><tr><th>Post</th><th>Tags</th><th class="n">${q.days} days</th><th class="n">All time</th><th class="n">Likes</th><th class="n">Interest</th></tr></thead>
      <tbody>${
        postRows
          .map(
            (r) =>
              `<tr><td>${r.live ? `<a href="/writing/${esc(r.slug)}/">${esc(r.title)}</a>` : `${esc(r.title)} <span class="muted">(not in this build)</span>`}</td><td>${tags(r.tags)}</td>${barCell(r.window, maxPost)}<td class="n">${num(r.views)}</td><td class="n">${num(r.likes)}</td><td class="n">${num(r.interest)}</td></tr>`,
          )
          .join("") || `<tr><td colspan="6" class="muted">No Posts yet.</td></tr>`
      }</tbody>
    </table></div>
  </section>

  <div class="split">
    <section class="card">
      <h2>Sources</h2>
      <p class="hint">The <code>?ref=</code> tag, else the linking site, else direct.</p>
      <table>
        <thead><tr><th>Source</th><th class="n">Views</th></tr></thead>
        <tbody>${
          data.sources.map((s) => `<tr><td>${esc(s.source)}</td>${barCell(s.views, maxSource)}</tr>`).join("") ||
          `<tr><td colspan="2" class="muted">No Views in this window.</td></tr>`
        }</tbody>
      </table>
    </section>
    <section class="card">
      <h2>Tags</h2>
      <p class="hint">A Post with two tags counts towards both.</p>
      <table>
        <thead><tr><th>Tag</th><th class="n">Posts</th><th class="n">Views</th></tr></thead>
        <tbody>${
          tagRows.map(([t, v]) => `<tr><td>${esc(t)}</td><td class="n">${num(v.posts)}</td>${barCell(v.views, maxTag)}</tr>`).join("") ||
          `<tr><td colspan="3" class="muted">No tagged Posts.</td></tr>`
        }</tbody>
      </table>
    </section>
  </div>

  ${gamesSection(data, q)}

  <section class="card">
    <h2>Latest Views</h2>
    <div class="scroll"><table>
      <thead><tr><th>When (UTC)</th><th>Post</th><th>Source</th></tr></thead>
      <tbody>${
        data.recent
          .map(
            (r) =>
              `<tr><td class="when">${esc(r.created_at.slice(0, 16))}</td><td>${esc(meta.get(r.slug)?.title ?? r.slug)}</td><td>${esc(r.source)}${r.is_me ? ` <span class="muted">(you)</span>` : ""}</td></tr>`,
          )
          .join("") || `<tr><td colspan="3" class="muted">No Views in this window.</td></tr>`
      }</tbody>
    </table></div>
  </section>
</main>
</body>
</html>`;
}

/** Views, Plays and Finishes of the Games, by Game, by source and by Ending. */
function gamesSection(data: DashboardData, q: DashboardQuery): string {
  const games = data.games.length ? data.games : Object.keys(GAME_TITLES).map((game) => ({ game, views: 0, plays: 0, finishes: 0, lived: 0 }));
  const maxSource = Math.max(0, ...data.gameSources.map((s) => s.views));
  const maxEnding = Math.max(0, ...data.endings.map((e) => e.finishes));
  const none = (cols: number) => `<tr><td colspan="${cols}" class="muted">Nothing in this window.</td></tr>`;
  return `<section class="card">
    <h2>Games</h2>
    <p class="hint">A Play is a run started, a Finish a run that reached its Ending. Last ${q.days} days.</p>
    <div class="scroll"><table>
      <thead><tr><th>Game</th><th class="n">Views</th><th class="n">Plays</th><th class="n">Finishes</th><th class="n">Lived</th></tr></thead>
      <tbody>${games
        .map(
          (g) =>
            `<tr><td><a href="/games/${esc(g.game)}/">${esc(GAME_TITLES[g.game] ?? g.game)}</a></td><td class="n">${num(g.views)}</td><td class="n">${num(g.plays)}</td><td class="n">${num(g.finishes)}</td><td class="n">${num(g.lived)}</td></tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </section>

  <div class="split">
    <section class="card">
      <h2>Game sources</h2>
      <p class="hint">The same as for Posts: the <code>?ref=</code> tag, else the linking site, else direct.</p>
      <div class="scroll"><table>
        <thead><tr><th>Source</th><th class="n">Views</th><th class="n">Plays</th><th class="n">Finishes</th></tr></thead>
        <tbody>${
          data.gameSources
            .map((s) => `<tr><td>${esc(s.source)}</td>${barCell(s.views, maxSource)}<td class="n">${num(s.plays)}</td><td class="n">${num(s.finishes)}</td></tr>`)
            .join("") || none(4)
        }</tbody>
      </table></div>
    </section>
    <section class="card">
      <h2>Endings</h2>
      <p class="hint">Which Ending each Finish reached.</p>
      <table>
        <thead><tr><th>Ending</th><th>Lived</th><th class="n">Finishes</th></tr></thead>
        <tbody>${
          data.endings
            .map((e) => `<tr><td>${esc(e.ending)}</td><td>${e.survived ? "yes" : "no"}</td>${barCell(e.finishes, maxEnding)}</tr>`)
            .join("") || none(3)
        }</tbody>
      </table>
    </section>
  </div>`;
}

/** The site's tokens (src/styles/global.css), trimmed to what this page uses. Light only, like the site. */
const CSS = `
:root{--page:#fffdf7;--card:#fff;--ink:#15151a;--ink-soft:#4d4a42;--line:#15151a;--grid:#d9d6cc;--link:#2338a8;--blue:#2b49c0;--red:#e8412f;--yellow:#f2c230;--thumb:#eef1ff;--border:3px solid var(--line)}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link);text-underline-offset:.18em}
a:focus-visible,summary:focus-visible{outline:3px solid var(--link);outline-offset:3px}
main{max-width:68rem;margin:0 auto;padding:2rem 16px 4rem}
h1{margin:0;font-size:2.2rem;font-weight:900;letter-spacing:-.02em}
h2{margin:0 0 .75rem;font-size:1.15rem;font-weight:900}
.top{display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:end;justify-content:space-between;margin-bottom:1.5rem}
.sub,.hint{margin:.25rem 0 0;color:var(--ink-soft)}
.hint{margin:-.5rem 0 .75rem;font-size:.85rem}
.filters{display:flex;flex-wrap:wrap;gap:.5rem}
.pill{padding:.25rem .8rem;font-size:.85rem;font-weight:700;color:var(--ink);text-decoration:none;background:var(--card);border:2px solid var(--line);border-radius:999px}
.pill:hover{background:var(--thumb)}
.pill.on{background:var(--yellow)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:1rem;margin-bottom:1.5rem}
.tile,.card{background:var(--card);border:var(--border);border-radius:14px;box-shadow:5px 5px 0 var(--blue)}
.tile{padding:.9rem 1.1rem}
.tile p{margin:0}
.label{font-size:.85rem;font-weight:700;color:var(--ink-soft)}
.value{font-size:2.2rem;font-weight:900;line-height:1.15;font-variant-numeric:tabular-nums}
.note{font-size:.8rem;color:var(--ink-soft)}
.card{padding:1.1rem 1.25rem;margin-bottom:1.5rem;min-width:0}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:0 1.5rem}
.chart-wrap{display:grid;grid-template-columns:auto 1fr;grid-template-rows:12rem auto;column-gap:.5rem;margin:1.5rem 0 .5rem}
.y{display:flex;flex-direction:column;justify-content:space-between;font-size:.75rem;color:var(--ink-soft);text-align:right;font-variant-numeric:tabular-nums;margin:-.5em 0}
.chart{display:flex;align-items:flex-end;gap:2px;border-top:1px dashed var(--grid);border-bottom:1px solid var(--ink-soft)}
.col{position:relative;flex:1;height:100%;display:flex;align-items:flex-end}
.col:hover{background:var(--thumb)}
.bar{width:100%;background:var(--blue);border-radius:4px 4px 0 0}
.col:hover .bar{background:var(--link)}
.col:hover::after{content:attr(data-tip);position:absolute;top:-2rem;left:50%;transform:translateX(-50%);z-index:1;padding:.15rem .5rem;font-size:.8rem;font-weight:700;white-space:nowrap;color:var(--ink);background:var(--card);border:2px solid var(--line);border-radius:6px;pointer-events:none}
.col.start:hover::after{left:0;transform:none}
.col.end:hover::after{left:auto;right:0;transform:none}
.x{grid-column:2;display:flex;justify-content:space-between;font-size:.75rem;color:var(--ink-soft);padding-top:.25rem}
details{margin-top:.75rem;font-size:.9rem}
summary{cursor:pointer;color:var(--link);font-weight:700}
details table{max-width:16rem;margin-top:.5rem}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th{text-align:left;font-size:.8rem;color:var(--ink-soft);font-weight:700;border-bottom:2px solid var(--line);padding:.35rem .5rem}
td{padding:.4rem .5rem;border-bottom:1px solid var(--grid);vertical-align:top}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar-cell{position:relative;min-width:6rem}
.hbar{position:absolute;right:.5rem;top:.3rem;bottom:.3rem;max-width:calc(100% - 1rem);background:var(--thumb);border-radius:4px 0 0 4px}
.v{position:relative}
.tag{display:inline-block;padding:0 .45rem;font-size:.75rem;font-weight:700;border:2px solid var(--line);border-radius:999px;white-space:nowrap}
.muted{color:var(--ink-soft)}
.when{white-space:nowrap;font-variant-numeric:tabular-nums}
code{font-size:.85em;background:var(--thumb);padding:0 .25rem;border-radius:4px}
`;
