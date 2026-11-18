-- One row per View of a Game's page, per Play and per Finish, so a Game's
-- numbers can be broken down by day and by where the player came from. Kept
-- apart from view_log, which is Views of Posts only. Safe while the old
-- Worker is still live: it never touches this table.
CREATE TABLE game_log (
  id INTEGER PRIMARY KEY,
  -- The Game's name in /games/<name>/, e.g. "twenty-boats".
  game TEXT NOT NULL,
  -- 'view' (the page was opened), 'play' (a run started) or 'finish' (a run reached an Ending).
  event TEXT NOT NULL,
  -- For a 'finish': the Ending's id, e.g. "boat-7" or "water-lost". NULL otherwise.
  ending TEXT,
  -- For a 'finish': 1 when the Ending is one the passenger lived through, else 0. NULL otherwise.
  survived INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Hostname of the page that linked to the Game, e.g. "news.ycombinator.com"; NULL when none was sent.
  referrer TEXT,
  -- The ?ref= tag on the Game's link, e.g. "hn"; NULL when the link had none.
  ref TEXT,
  -- 1 when the browser carries the owner's `me` cookie.
  is_me INTEGER NOT NULL DEFAULT 0
);
