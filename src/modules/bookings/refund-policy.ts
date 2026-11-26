export type RefundTier =
  | 'FULL_EARLY'
  | 'HALF_LATE'
  | 'NONE_LAST_MINUTE'
  | 'NONE_VENUE_CANCELLED'
  | 'ALREADY_STARTED';

export interface RefundDecision {
  refundPaise: number;
  tier: RefundTier;
  /** Safe to show the user verbatim on the cancel screen. */
  reason: string;
}

export interface RefundInput {
  amountPaise: number;
  startsAt: Date;
  now: Date;
  /**
   * Owner or admin cancellation from the portal. Business rule: the online
   * payment is a slot-booking advance and is non-refundable when the venue
   * cancels, so the notice tiers do not apply.
   */
  cancelledByVenue?: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
export const FULL_REFUND_CUTOFF_HOURS = 24;
export const HALF_REFUND_CUTOFF_HOURS = 6;

/**
 * The single source of truth for what a cancellation is worth.
 *
 * Deliberately a pure function of (amount, startsAt, now): it is called from
 * the cancel endpoint, shown on the confirmation screen before the user
 * commits, and used to write the ledger entries. Three implementations that
 * drift apart is how customers get told one number and refunded another.
 */
export function computeRefund(input: RefundInput): RefundDecision {
  const { amountPaise, startsAt, now, cancelledByVenue = false } = input;

  if (cancelledByVenue) {
    return {
      refundPaise: 0,
      tier: 'NONE_VENUE_CANCELLED',
      reason: 'The venue cancelled this booking. The booking advance is non-refundable.',
    };
  }

  const hoursUntilStart = (startsAt.getTime() - now.getTime()) / HOUR_MS;

  if (hoursUntilStart <= 0) {
    return {
      refundPaise: 0,
      tier: 'ALREADY_STARTED',
      reason: 'This booking has already started and cannot be refunded.',
    };
  }

  if (hoursUntilStart >= FULL_REFUND_CUTOFF_HOURS) {
    return {
      refundPaise: amountPaise,
      tier: 'FULL_EARLY',
      reason: 'Cancelled more than 24 hours ahead — full refund.',
    };
  }

  if (hoursUntilStart >= HALF_REFUND_CUTOFF_HOURS) {
    // Rounds down, so the platform never refunds more than it took.
    return {
      refundPaise: Math.floor(amountPaise / 2),
      tier: 'HALF_LATE',
      reason: 'Cancelled between 6 and 24 hours ahead — 50% refund.',
    };
  }

  return {
    refundPaise: 0,
    tier: 'NONE_LAST_MINUTE',
    reason: 'Cancelled less than 6 hours ahead — no refund.',
  };
}
