import { describe, expect, it } from 'vitest';
import {
  PG_EXCLUSION_VIOLATION,
  hasPgCode,
  isExclusionViolation,
} from './domain.errors.js';

describe('hasPgCode', () => {
  it('matches a driver error at the top level', () => {
    expect(isExclusionViolation({ code: PG_EXCLUSION_VIOLATION })).toBe(true);
  });

  it('matches the real Prisma 7 + pg adapter error shape', () => {
    // Captured verbatim from an actual exclusion-constraint violation. Prisma
    // reports its own P2039 at the top level and buries the SQLSTATE two
    // levels down, so a naive `err.code === '23P01'` check silently fails and
    // the 409 degrades into a 500.
    const real = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2039',
      meta: {
        modelName: 'Booking',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: PG_EXCLUSION_VIOLATION,
            code: PG_EXCLUSION_VIOLATION,
            kind: 'postgres',
            message: 'conflicting key value violates exclusion constraint "booking_no_overlap"',
          },
        },
      },
    };

    expect(isExclusionViolation(real)).toBe(true);
  });

  it('matches a plain cause chain, in case the nesting changes again', () => {
    expect(
      isExclusionViolation({ code: 'P2010', cause: { cause: { code: PG_EXCLUSION_VIOLATION } } }),
    ).toBe(true);
  });

  it('does not match a unique-constraint violation', () => {
    // 23505 is a duplicate idempotency key, which is a different situation
    // from losing a race for a slot and must not be reported as one.
    expect(isExclusionViolation({ code: '23505' })).toBe(false);
    expect(
      isExclusionViolation({
        code: 'P2002',
        meta: { driverAdapterError: { cause: { code: '23505' } } },
      }),
    ).toBe(false);
  });

  it('is safe on null, undefined and plain errors', () => {
    expect(isExclusionViolation(null)).toBe(false);
    expect(isExclusionViolation(undefined)).toBe(false);
    expect(isExclusionViolation(new Error('boom'))).toBe(false);
  });

  it('terminates on a self-referencing cause chain', () => {
    const cyclic: Record<string, unknown> = { code: 'X' };
    cyclic.cause = cyclic;

    expect(() => hasPgCode(cyclic, PG_EXCLUSION_VIOLATION)).not.toThrow();
    expect(hasPgCode(cyclic, PG_EXCLUSION_VIOLATION)).toBe(false);
  });
});
