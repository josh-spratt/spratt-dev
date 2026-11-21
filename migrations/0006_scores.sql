-- The Leaderboard: one row per Play that asked to be scored. The Worker adds
-- the row when the Play starts (POST /games/<name>/start) and fills in the
-- Score when the player is sunk and puts Initials against it (POST …/score).
-- Stores no IP, address or browser id, like game_log. Safe while the old
-- Worker is still live: it never touches this table.
CREATE TABLE scores (
  id INTEGER PRIMARY KEY,
  -- The Game's name in /games/<name>/, e.g. "cactus-boats".
  game TEXT NOT NULL,
  -- When the Worker handed out this run's id, so a Score can be checked against the time that has passed.
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- When the Score arrived; NULL until then. Only submitted rows are on the board.
  submitted_at TEXT,
  -- Three letters A–Z, uppercase; NULL until submitted.
  initials TEXT,
  survived_ms INTEGER,
  sinks INTEGER,
  -- The Worker's own scoreOf(survived_ms, sinks), never the one the game sent.
  score INTEGER,
  -- Hostname of the page that linked to the Game; NULL when none was sent.
  referrer TEXT,
  -- The ?ref= tag on the Game's link; NULL when the link had none.
  ref TEXT,
  -- 1 when the browser carries the owner's `me` cookie. Still shown on the board.
  is_me INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX scores_board ON scores (game, score DESC);
