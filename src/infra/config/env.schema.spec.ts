import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

/** Payments are optional locally but mandatory in production. */
const productionExtras = {
  RAZORPAY_KEY_ID: 'rzp_live_x',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
};

describe('validateEnv', () => {
  it('applies defaults for optional values', () => {
    const env = validateEnv({ ...base });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.BOOKING_HOLD_MINUTES).toBe(10);
  });

  it('coerces numeric values from strings, as they arrive from the shell', () => {
    const env = validateEnv({ ...base, PORT: '4300', BOOKING_HOLD_MINUTES: '15' });

    expect(env.PORT).toBe(4300);
    expect(env.BOOKING_HOLD_MINUTES).toBe(15);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    // The booking exclusion constraint is Postgres-only; pointing this at
    // MySQL or Mongo would silently lose double-booking protection.
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects short JWT secrets', () => {
    expect(() => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('reports every problem at once rather than one per restart', () => {
    try {
      validateEnv({ DATABASE_URL: 'nope', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('JWT_ACCESS_SECRET');
      expect(msg).toContain('JWT_REFRESH_SECRET');
    }
  });

  it('refuses placeholder secrets in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        ...productionExtras,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'change-me-but-long-enough-to-pass-length',
      }),
    ).toThrow(/placeholder/);
  });

  it('requires payment credentials in production', () => {
    // An empty webhook secret makes signature verification fail closed, which
    // presents as a mysterious 403 on every callback. Better to refuse to boot.
    for (const missing of [
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ]) {
      const env: Record<string, unknown> = {
        ...base,
        ...productionExtras,
        NODE_ENV: 'production',
      };
      delete env[missing];

      expect(() => validateEnv(env)).toThrow(new RegExp(`${missing} is required`));
    }
  });

  it('does not require payment credentials outside production', () => {
    // Local development must run without a Razorpay account.
    expect(() => validateEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
  });

  it('allows a fully configured production environment', () => {
    expect(() =>
      validateEnv({ ...base, ...productionExtras, NODE_ENV: 'production' }),
    ).not.toThrow();
  });
});
