// Starts Twenty Boats on its page (src/pages/games/twenty-boats.astro).
// The game fills #game; its jspratt.dev link goes back to the Homepage.
// Each Play and Finish is reported to the Worker (worker/index.ts), with the
// page's ?ref= tag and referrer so it has the same source as the page's View.

const game = document.getElementById('game');
const status = document.getElementById('game-status');
const from = { ref: new URLSearchParams(location.search).get('ref'), referrer: document.referrer || null };

// Fire and forget: a lost report must never get in the way of the game.
function report(event) {
  try {
    fetch('/games/twenty-boats/event', {
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
  const { mountTwentyBoats } = await import('./twenty-boats.js?v=2026-11-17-v2');
  await mountTwentyBoats(game, { homeHref: '/', onEvent: report });
  status.remove();
} catch (error) {
  console.error(error);
  status.textContent = 'Twenty Boats didn’t load. Reload the page to try again.';
}
