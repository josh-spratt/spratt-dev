-- One row per "I would" click on a Post's email-interest question. A row per
-- click, not a counter, so it shows which Posts made people want more.
CREATE TABLE interest (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
