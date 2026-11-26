/**
 * The share of a booking's price a player pays online to hold the slot; the
 * rest is collected at the venue.
 *
 * Rounded UP so a 1-paisa advance can never round down to a free hold, and
 * clamped so it never exceeds the price (the DB CHECK would reject that).
 */
export function computeAdvance(amountPaise: number, advancePct: number): number {
  if (amountPaise <= 0) return 0;
  return Math.min(amountPaise, Math.ceil((amountPaise * advancePct) / 100));
}
