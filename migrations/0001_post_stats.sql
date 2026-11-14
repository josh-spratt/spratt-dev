-- One row per Post, created on its first View.
CREATE TABLE post_stats (
  slug TEXT PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0
);
