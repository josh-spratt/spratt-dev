// Starts Cactus Boats on its page (src/pages/games/cactus-boats.astro).
// The game fills #game; its jspratt.dev link goes back to the Homepage.
// Plays and Finishes aren't reported yet: the Worker starts logging Cactus
// Boats when it launches as a Project, and the Leaderboard comes after that.
// ?seed=<number> fixes the sea, for trying a particular Play again.

const game = document.getElementById('game');
const status = document.getElementById('game-status');
const seed = Number.parseInt(new URLSearchParams(location.search).get('seed') ?? '', 10);

try {
  // Imported here rather than at the top, so a module that fails to download
  // shows the message below instead of leaving the page on "Loading".
  const { mountCactusBoats } = await import('./cactus-boats.js?v=2026-11-21-v2');
  await mountCactusBoats(game, { homeHref: '/', seed: Number.isFinite(seed) ? seed : undefined });
  status.remove();
} catch (error) {
  console.error(error);
  status.textContent = 'Cactus Boats didn’t load. Reload the page to try again.';
}
