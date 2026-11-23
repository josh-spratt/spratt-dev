// Starts Cactus Boats on its page (src/pages/games/cactus-boats.astro).
// The game fills #game; its jspratt.dev link goes back to the Homepage.
// Each Play and Finish is reported to the Worker (worker/index.ts), with the
// page's ?ref= tag and referrer so it has the same source as the page's View,
// as Twenty Boats' play.js does. It also backs the game's Leaderboard.
// ?seed=<number> fixes the sea, for trying a particular Play again.

const game = document.getElementById('game');
const status = document.getElementById('game-status');
const params = new URLSearchParams(location.search);
const seed = Number.parseInt(params.get('seed') ?? '', 10);
const from = { ref: params.get('ref'), referrer: document.referrer || null };

// Fire and forget: a lost report must never get in the way of the game.
function report(event) {
  try {
    fetch('/games/cactus-boats/event', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, ...from }),
    }).catch(() => {});
  } catch {
    // No fetch, or it threw: nothing to do.
  }
}

// The Leaderboard, backed by the Worker (worker/index.ts), so the game never
// knows its addresses. Every call answers null rather than throwing when the
// board can't be reached, and gives up after a few seconds. Off jspratt.dev
// `start` hands out no run, so the board is read-only.
const BOARD = '/games/cactus-boats/';
// The board is cached for a few seconds; just after sending a Score, a reload asks again.
const SENT_KEY = 'cactus-boats:sent';
// `refusable`: a 4xx answers { refused: true } (the Worker turned the Score
// down) rather than null (the board couldn't be reached).
async function ask(path, body, refusable = false) {
  try {
    let cache = 'default';
    try {
      if (!body && Date.now() - Number(sessionStorage.getItem(SENT_KEY)) < 15_000) cache = 'reload';
    } catch {
      // Without storage a reload may show the board from a few seconds ago.
    }
    const res = await fetch(BOARD + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache,
      signal: AbortSignal.timeout(6000),
    });
    if (refusable && res.status >= 400 && res.status < 500) return { refused: true };
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const leaderboard = {
  /** → { run } (run is null off the live site), or null. */
  start: () => ask('start', { ref: params.get('ref') ?? undefined, referrer: document.referrer || undefined }),
  /** { run, initials, survivedMs, sinks, score } → { rank, top }, { refused: true } if not accepted, or null. */
  async submit(entry) {
    const sent = await ask('score', entry, true);
    try {
      if (sent && !sent.refused) sessionStorage.setItem(SENT_KEY, String(Date.now()));
    } catch {
      // As above.
    }
    return sent;
  },
  /** → the top 10 [{ initials, score, survivedMs, sinks, at }], or null. */
  top: async () => {
    const board = await ask('scores');
    return board && !board.unavailable ? board.top : null;
  },
};

try {
  // Imported here rather than at the top, so a module that fails to download
  // shows the message below instead of leaving the page on "Loading".
  const { mountCactusBoats } = await import('./cactus-boats.js?v=2026-11-22-v2');
  await mountCactusBoats(game, { homeHref: '/', onEvent: report, leaderboard, seed: Number.isFinite(seed) ? seed : undefined });
  status.remove();
} catch (error) {
  console.error(error);
  status.textContent = 'Cactus Boats didn’t load. Reload the page to try again.';
}
