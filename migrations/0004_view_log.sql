-- One row per View, alongside the post_stats totals, so Views can be broken
-- down by day and by where the reader came from. Safe while the old Worker is
-- still live: it never touches this table.
CREATE TABLE view_log (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Hostname of the page that linked here, e.g. "news.ycombinator.com"; NULL when none was sent.
  referrer TEXT,
  -- The ?ref= tag on a shared link, e.g. "bluesky"; NULL when the link had none.
  ref TEXT,
  -- 1 when the browser carries the owner's `me` cookie. These Views aren't added to post_stats.
  is_me INTEGER NOT NULL DEFAULT 0
);
