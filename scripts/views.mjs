// Prints where Views have come from, from the live D1 view_log.
//
//   npm run views                 last 14 days, your own Views left out
//   npm run views -- --days 60    a longer window
//   npm run views -- --with-me    include your own Views (marked with /writing/?me)
//
// A View's source is its ?ref= tag if the link had one, else the site that
// linked to it, else "direct" (typed in, bookmarked, or an app that sends no referrer).

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const daysAt = args.indexOf("--days");
const days = daysAt === -1 ? 14 : Number(args[daysAt + 1]);
if (!Number.isInteger(days) || days < 1) {
  console.error("--days needs a whole number of days, e.g. --days 30");
  process.exit(1);
}
const withMe = args.includes("--with-me");

const where = `created_at >= datetime('now', '-${days} days')${withMe ? "" : " AND is_me = 0"}`;
const source = "COALESCE(ref, referrer, 'direct')";

function query(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "spratt-dev", "--remote", "--json", "--command", sql],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(out.toString())[0].results;
}

function print(title, rows, columns) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells) => "  " + cells.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  console.log(line(columns));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(columns.map((c) => r[c])));
}

const bySource = query(
  `SELECT ${source} AS source, COUNT(*) AS views FROM view_log WHERE ${where} GROUP BY source ORDER BY views DESC`,
);
const byPost = query(
  `SELECT slug AS post, ${source} AS source, COUNT(*) AS views FROM view_log WHERE ${where} GROUP BY post, source ORDER BY post, views DESC`,
);
const byDay = query(
  `SELECT date(created_at) AS day, slug AS post, ${source} AS source, COUNT(*) AS views FROM view_log WHERE ${where} GROUP BY day, post, source ORDER BY day DESC, views DESC`,
);

console.log(`Views in the last ${days} days (UTC)${withMe ? ", including yours" : ", not counting yours"}`);
print("By source", bySource, ["source", "views"]);
print("By Post and source", byPost, ["post", "source", "views"]);
print("By day", byDay, ["day", "post", "source", "views"]);
