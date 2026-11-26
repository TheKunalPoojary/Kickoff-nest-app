import { describe, expect, it } from 'vitest';
import { computeRefund } from './refund-policy.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const AMOUNT = 100_000; // ₹1000

const at = (hoursFromNow: number) =>
  new Date(NOW.getTime() + hoursFromNow * 60 * 60 * 1000);

describe('computeRefund', () => {
  const cases: [string, number, number, string][] = [
    ['a week ahead', 168, AMOUNT, 'FULL_EARLY'],
    ['exactly 24h ahead', 24, AMOUNT, 'FULL_EARLY'],
    ['just inside 24h', 23.999, 50_000, 'HALF_LATE'],
    ['12h ahead', 12, 50_000, 'HALF_LATE'],
    ['exactly 6h ahead', 6, 50_000, 'HALF_LATE'],
    ['just inside 6h', 5.999, 0, 'NONE_LAST_MINUTE'],
    ['1h ahead', 1, 0, 'NONE_LAST_MINUTE'],
    ['1 minute ahead', 1 / 60, 0, 'NONE_LAST_MINUTE'],
  ];

  // The boundaries are where money actually goes wrong, so each tier is
  // pinned on both sides rather than sampled in the middle.
  it.each(cases)('%s → %s paise (%s)', (_label, hours, expected, tier) => {
    const result = computeRefund({ amountPaise: AMOUNT, startsAt: at(hours), now: NOW });

    expect(result.refundPaise).toBe(expected);
    expect(result.tier).toBe(tier);
  });

  it('refunds nothing once the slot has started', () => {
    expect(computeRefund({ amountPaise: AMOUNT, startsAt: at(0), now: NOW })).toMatchObject({
      refundPaise: 0,
      tier: 'ALREADY_STARTED',
    });
    expect(computeRefund({ amountPaise: AMOUNT, startsAt: at(-3), now: NOW })).toMatchObject({
      refundPaise: 0,
      tier: 'ALREADY_STARTED',
    });
  });

  it('refunds nothing when the venue cancels, whatever the notice', () => {
    // Business rule: the online payment is a non-refundable booking advance.
    for (const hours of [72, 12, 1, 0, -2]) {
      expect(
        computeRefund({
          amountPaise: AMOUNT,
          startsAt: at(hours),
          now: NOW,
          cancelledByVenue: true,
        }),
      ).toMatchObject({ refundPaise: 0, tier: 'NONE_VENUE_CANCELLED' });
    }
  });

  it('never refunds more than was paid, including odd amounts', () => {
    // 50% of an odd number must round DOWN.
    const odd = computeRefund({ amountPaise: 99_999, startsAt: at(12), now: NOW });
    expect(odd.refundPaise).toBe(49_999);
    expect(odd.refundPaise).toBeLessThan(99_999);
  });

  it('handles a zero-amount booking without producing a negative refund', () => {
    for (const hours of [48, 12, 1]) {
      const r = computeRefund({ amountPaise: 0, startsAt: at(hours), now: NOW });
      expect(r.refundPaise).toBe(0);
    }
  });
});
