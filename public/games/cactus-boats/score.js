// A Play's Score, in one pure function with no DOM, shared by the game and
// (for the Leaderboard) the Worker, so the two can never disagree.
//
//   scoreOf(survivedMs, sinks) -> points

/** What a Score is made of: points for each whole second survived, and for each boat sunk. */
export const SCORE = { perSecond: 10, perSink: 250 };

/** The Score for surviving `survivedMs` and sinking `sinks` boats. */
export function scoreOf(survivedMs, sinks) {
  const seconds = Math.floor(Math.max(0, survivedMs) / 1000);
  return seconds * SCORE.perSecond + Math.max(0, Math.floor(sinks)) * SCORE.perSink;
}
