// Starts Twenty Boats on its page (src/pages/games/twenty-boats.astro).
// The game fills #game; its jspratt.dev button goes back to the Homepage.

import { mountTwentyBoats } from './twenty-boats.js?v=2026-10-07-v1';

const game = document.getElementById('game');
const status = document.getElementById('game-status');

try {
  await mountTwentyBoats(game, { onRequestClose: () => location.assign('/') });
  status.remove();
} catch (error) {
  console.error(error);
  status.textContent = 'Twenty Boats didn’t load. Reload the page to try again.';
}
