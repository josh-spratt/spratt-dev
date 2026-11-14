-- Safe while the Views-only Worker is still live: it never reads this column.
ALTER TABLE post_stats ADD COLUMN likes INTEGER NOT NULL DEFAULT 0;
