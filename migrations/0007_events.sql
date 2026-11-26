-- One row per Event: everything a reader does that the live site records (a
-- View of any page, a Play, a Finish, a Like, an Interest, a Click out), in
-- one shape so they're all counted the same way. Written alongside post_stats,
-- view_log, game_log and interest, which keep working until the cutover. Safe
-- while the old Worker is still live: it never touches this table.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('view', 'play', 'finish', 'like', 'interest', 'click_out')),
  -- The page it happened on, e.g. "/writing/the-graveyard/" or "/games/cactus-boats/".
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- The ?ref= tag on the link that brought the reader, e.g. "bluesky"; NULL when none.
  ref TEXT,
  -- Hostname of the page that linked here, e.g. "news.ycombinator.com"; NULL when none was sent.
  referrer TEXT,
  -- The browser's anonymous Visitor id from the `visitor` cookie; NULL when it sent none.
  -- Never an IP. Stripped from rows older than 13 months.
  visitor TEXT,
  -- 1 when the browser is the owner's.
  is_me INTEGER NOT NULL DEFAULT 0,
  -- On a Game's page: its name in /games/<name>/, e.g. "twenty-boats".
  game TEXT,
  -- For a 'finish': the Ending's id, e.g. "boat-7" or "sunk".
  ending TEXT,
  -- For a 'finish': 1 when the passenger lived, else 0.
  survived INTEGER,
  -- For a 'click_out': the name in /out/<name>/, e.g. "github" or "marinaradb".
  target TEXT
);

-- Daily, weekly and monthly active Visitors: distinct visitor over a time window.
CREATE INDEX events_time_visitor ON events (created_at, visitor);
-- Per kind, per page and per source over a window, e.g. Views by page last 30 days.
CREATE INDEX events_kind_time ON events (kind, created_at, path);
-- A Visitor's own Events: the source of the View a Like or Click out came from,
-- marking the owner's Visitor, and stripping old ids.
CREATE INDEX events_visitor ON events (visitor, kind, path);
