import { describe, expect, it } from 'vitest';
import { ACCOUNT, captureLines, isBalanced, refundLines } from './ledger.entries.js';

const sumOf = (lines: ReturnType<typeof captureLines>, account: string) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + l.amountPaise, 0);

describe('captureLines', () => {
  it('splits a capture into commission and owner payable', () => {
    const lines = captureLines({ venueId: 'v1', amountPaise: 100_000, commissionPct: 10 });

    expect(sumOf(lines, ACCOUNT.PLATFORM_CASH)).toBe(100_000);
    expect(sumOf(lines, ACCOUNT.COMMISSION)).toBe(10_000);
    expect(sumOf(lines, ACCOUNT.ownerPayable('v1'))).toBe(90_000);
    expect(isBalanced(lines)).toBe(true);
  });

  it('never loses a paisa to rounding', () => {
    // 7.5% of 33333 is 2499.975 — the split must still add back exactly.
    const lines = captureLines({ venueId: 'v1', amountPaise: 33_333, commissionPct: 7.5 });

    const commission = sumOf(lines, ACCOUNT.COMMISSION);
    const owner = sumOf(lines, ACCOUNT.ownerPayable('v1'));

    expect(commission + owner).toBe(33_333);
    expect(isBalanced(lines)).toBe(true);
  });

  it('stays balanced across a wide range of amounts and rates', () => {
    for (let amount = 1; amount <= 5000; amount += 7) {
      for (const pct of [0, 2.5, 10, 12.75, 33.33, 100]) {
        const lines = captureLines({ venueId: 'v1', amountPaise: amount, commissionPct: pct });

        expect(isBalanced(lines)).toBe(true);
        expect(sumOf(lines, ACCOUNT.COMMISSION) + sumOf(lines, ACCOUNT.ownerPayable('v1'))).toBe(
          amount,
        );
      }
    }
  });

  it('omits zero-value lines rather than writing noise', () => {
    const lines = captureLines({ venueId: 'v1', amountPaise: 100_000, commissionPct: 0 });
    expect(lines.some((l) => l.account === ACCOUNT.COMMISSION)).toBe(false);
    expect(isBalanced(lines)).toBe(true);
  });
});

describe('refundLines', () => {
  it('reverses the original split proportionally', () => {
    // Full refund of a 100000 capture that took 10000 commission.
    const lines = refundLines({
      venueId: 'v1',
      refundPaise: 100_000,
      originalAmountPaise: 100_000,
      originalCommissionPaise: 10_000,
    });

    expect(sumOf(lines, ACCOUNT.PLATFORM_CASH)).toBe(100_000);
    expect(sumOf(lines, ACCOUNT.COMMISSION)).toBe(10_000);
    expect(sumOf(lines, ACCOUNT.ownerPayable('v1'))).toBe(90_000);
    expect(isBalanced(lines)).toBe(true);
  });

  it('splits a partial refund proportionally, not entirely against the owner', () => {
    // Half refund → the platform gives back half its commission too. Charging
    // the whole refund to the owner would mean cancellations are profitable.
    const lines = refundLines({
      venueId: 'v1',
      refundPaise: 50_000,
      originalAmountPaise: 100_000,
      originalCommissionPaise: 10_000,
    });

    expect(sumOf(lines, ACCOUNT.COMMISSION)).toBe(5_000);
    expect(sumOf(lines, ACCOUNT.ownerPayable('v1'))).toBe(45_000);
    expect(isBalanced(lines)).toBe(true);
  });

  it('stays balanced for any partial refund amount', () => {
    const original = 12_345;
    const commission = 1_234;

    for (let refund = 0; refund <= original; refund += 37) {
      const lines = refundLines({
        venueId: 'v1',
        refundPaise: refund,
        originalAmountPaise: original,
        originalCommissionPaise: commission,
      });

      expect(isBalanced(lines)).toBe(true);
      expect(sumOf(lines, ACCOUNT.COMMISSION) + sumOf(lines, ACCOUNT.ownerPayable('v1'))).toBe(
        refund,
      );
    }
  });

  it('a capture followed by a full refund nets every account to zero', () => {
    const capture = captureLines({ venueId: 'v1', amountPaise: 87_654, commissionPct: 12.5 });
    const commissionTaken = sumOf(capture, ACCOUNT.COMMISSION);

    const refund = refundLines({
      venueId: 'v1',
      refundPaise: 87_654,
      originalAmountPaise: 87_654,
      originalCommissionPaise: commissionTaken,
    });

    // Net position per account across both transactions must be zero — the
    // platform should be exactly where it started.
    const net = new Map<string, number>();
    for (const l of [...capture, ...refund]) {
      const delta = l.direction === 'DEBIT' ? l.amountPaise : -l.amountPaise;
      net.set(l.account, (net.get(l.account) ?? 0) + delta);
    }

    for (const [, value] of net) {
      expect(value).toBe(0);
    }
  });

  it('handles a zero original amount without dividing by zero', () => {
    const lines = refundLines({
      venueId: 'v1',
      refundPaise: 0,
      originalAmountPaise: 0,
      originalCommissionPaise: 0,
    });
    expect(lines).toEqual([]);
    expect(isBalanced(lines)).toBe(true);
  });
});
