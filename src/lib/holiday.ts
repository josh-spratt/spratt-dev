/**
 * The Holiday season: 20 November through Christmas Day, in the visitor's own
 * time zone, every year. On 26 December the decorations are gone without a
 * deploy, because the page asks this in the browser, not at build time.
 *
 * Self-contained on purpose: the page inlines it with Function#toString, so it
 * must not reference anything outside its own body.
 */
export function isHolidaySeason(now: Date): boolean {
  const month = now.getMonth(); // 0-based: 10 is November, 11 is December
  const day = now.getDate();
  return (month === 10 && day >= 20) || (month === 11 && day <= 25);
}

/** localStorage key holding "off" when a visitor has turned the decorations off. */
export const HOLIDAY_KEY = "holiday";
