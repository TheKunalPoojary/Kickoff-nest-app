export type LedgerDirection = 'DEBIT' | 'CREDIT';
export type LedgerRefType = 'BOOKING' | 'REFUND' | 'PAYOUT' | 'ADJUSTMENT';

export interface LedgerLine {
  account: string;
  direction: LedgerDirection;
  amountPaise: number;
}

export const ACCOUNT = {
  PLATFORM_CASH: 'PLATFORM_CASH',
  COMMISSION: 'COMMISSION',
  ownerPayable: (venueId: string) => `OWNER_PAYABLE:${venueId}`,
} as const;

/**
 * Platform commission on a captured payment.
 *
 * Charged on the FULL booking price, not just the online advance — the rest is
 * collected at the venue in cash the platform never sees, so this is the only
 * point it can be taken. Capped at what was actually captured, so the owner's
 * share can never go negative.
 */
export function commissionFor(params: {
  capturedPaise: number;
  bookingAmountPaise: number;
  commissionPct: number;
}): number {
  const { capturedPaise, bookingAmountPaise, commissionPct } = params;
  return Math.min(capturedPaise, Math.floor((bookingAmountPaise * commissionPct) / 100));
}

/**
 * Double-entry: every transaction's lines must sum to zero (debits === credits).
 * Splitting a captured payment is where rounding quietly loses paise, so the
 * remainder is always derived by subtraction rather than computed twice.
 */
export function captureLines(params: {
  venueId: string;
  /** What was captured online — the advance. */
  amountPaise: number;
  /** Full booking price; defaults to the captured amount (full prepayment). */
  bookingAmountPaise?: number;
  commissionPct: number;
}): LedgerLine[] {
  const { venueId, amountPaise, commissionPct } = params;
  const bookingAmountPaise = params.bookingAmountPaise ?? amountPaise;

  // Floor, then take the owner's share as the remainder — that way the two
  // parts always add back to exactly the amount captured.
  const commissionPaise = commissionFor({
    capturedPaise: amountPaise,
    bookingAmountPaise,
    commissionPct,
  });
  const ownerPaise = amountPaise - commissionPaise;

  return [
    { account: ACCOUNT.PLATFORM_CASH, direction: 'DEBIT', amountPaise },
    { account: ACCOUNT.COMMISSION, direction: 'CREDIT', amountPaise: commissionPaise },
    { account: ACCOUNT.ownerPayable(venueId), direction: 'CREDIT', amountPaise: ownerPaise },
  ].filter((l) => l.amountPaise > 0) as LedgerLine[];
}

/**
 * A refund reverses the original split proportionally: the platform gives back
 * its commission share and the owner gives back theirs. Charging the whole
 * refund to the owner would mean the platform profits from cancellations.
 */
export function refundLines(params: {
  venueId: string;
  refundPaise: number;
  originalAmountPaise: number;
  originalCommissionPaise: number;
}): LedgerLine[] {
  const { venueId, refundPaise, originalAmountPaise, originalCommissionPaise } = params;

  const commissionBack =
    originalAmountPaise === 0
      ? 0
      : Math.floor((refundPaise * originalCommissionPaise) / originalAmountPaise);
  const ownerBack = refundPaise - commissionBack;

  return [
    { account: ACCOUNT.PLATFORM_CASH, direction: 'CREDIT', amountPaise: refundPaise },
    { account: ACCOUNT.COMMISSION, direction: 'DEBIT', amountPaise: commissionBack },
    { account: ACCOUNT.ownerPayable(venueId), direction: 'DEBIT', amountPaise: ownerBack },
  ].filter((l) => l.amountPaise > 0) as LedgerLine[];
}

/** True when debits equal credits. Asserted before any ledger write. */
export function isBalanced(lines: LedgerLine[]): boolean {
  const debits = lines
    .filter((l) => l.direction === 'DEBIT')
    .reduce((s, l) => s + l.amountPaise, 0);
  const credits = lines
    .filter((l) => l.direction === 'CREDIT')
    .reduce((s, l) => s + l.amountPaise, 0);
  return debits === credits;
}
