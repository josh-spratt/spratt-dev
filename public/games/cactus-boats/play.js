// Starts Cactus Boats on its page (src/pages/games/cactus-boats.astro).
// The game fills #game; its jspratt.dev link goes back to the Homepage.
// Each Play and Finish is reported to the Worker (worker/index.ts), with the
// page's ?ref= tag and referrer so it has the same source as the page's View,
// as Twenty Boats' play.js does. The Leaderboard comes later.
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

try {
  // Imported here rather than at the top, so a module that fails to download
  // shows the message below instead of leaving the page on "Loading".
  const { mountCactusBoats } = await import('./cactus-boats.js?v=2026-11-21-v4');
  await mountCactusBoats(game, { homeHref: '/', onEvent: report, seed: Number.isFinite(seed) ? seed : undefined });
  status.remove();
} catch (error) {
  console.error(error);
  status.textContent = 'Cactus Boats didn’t load. Reload the page to try again.';
}
