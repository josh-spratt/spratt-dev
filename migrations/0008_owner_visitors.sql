-- The owner's Visitors: every browser that has opened /stats/ through
-- Cloudflare Access. Their Events, past and future, are flagged is_me and left
-- out of every count on the dashboard. Safe while the old Worker is still
-- live: it never touches this table.
CREATE TABLE owner_visitors (
  -- The browser's anonymous Visitor id, from the `visitor` cookie.
  visitor TEXT PRIMARY KEY,
  -- When it was first marked as the owner's.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
