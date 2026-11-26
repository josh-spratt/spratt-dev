-- The cutover: copy the old tables' history into events, once, then drop
-- them. Apply it right after the Worker that reads only Events is live
-- (docs/database.md, "The cutover"); the Worker before it still writes the old
-- tables.
--
-- From PR 1's deploy (2026-11-26 00:39 UTC, before the first Event at 01:26)
-- every View, Play, Finish, Like and Interest was written to both the old
-- tables and events. So only old rows from before then are copied: anything
-- later is already an Event, and copying it would count it twice. Copied
-- Events have no Visitor id: Visitors start at PR 1.

-- Views of Posts, 2026-11-15 to the cutoff.
INSERT INTO events (kind, path, created_at, ref, referrer, is_me)
SELECT 'view', '/writing/' || slug || '/', created_at, ref, referrer, is_me
FROM view_log WHERE created_at < '2026-11-26 00:39:00' ORDER BY id;

-- A Game's page Views, Plays and Finishes, 2026-11-18 to the cutoff.
INSERT INTO events (kind, path, created_at, ref, referrer, is_me, game, ending, survived)
SELECT event, '/games/' || game || '/', created_at, ref, referrer, is_me, game, ending, survived
FROM game_log WHERE created_at < '2026-11-26 00:39:00' ORDER BY id;

-- Interest, if any came before the cutoff.
INSERT INTO events (kind, path, created_at)
SELECT 'interest', '/writing/' || slug || '/', created_at
FROM interest WHERE created_at < '2026-11-26 00:39:00' ORDER BY id;

-- Not copied, by the owner's choice: Views from before view_log (2026-11-15),
-- which were only a total in post_stats, and Likes, which were only a counter
-- there. So "Read N times" and the Like counts start again from the copied rows.

DROP TABLE post_stats;
DROP TABLE view_log;
DROP TABLE game_log;
DROP TABLE interest;

-- A Post's public counts: its Views and Likes, read on every View of it.
CREATE INDEX events_page ON events (path, kind);
