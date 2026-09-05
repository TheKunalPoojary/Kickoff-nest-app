import { z } from 'zod';

/**
 * Environment contract. Validated once at boot so a misconfigured deploy fails
 * immediately and loudly, rather than at 2am on the first request that happens
 * to need the missing value.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().startsWith('postgresql://'),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * How long a PENDING_PAYMENT booking blocks its slot. Long enough for UPI
   * (which involves an app switch and can take 2-3 minutes), short enough that
   * an abandoned checkout does not squat the slot.
   */
  BOOKING_HOLD_MINUTES: z.coerce.number().int().positive().default(10),

  /** Phone verification. Codes are short-lived and attempt-capped. */
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Per phone, per hour. SMS costs money — this is the abuse ceiling. */
  OTP_MAX_REQUESTS_PER_HOUR: z.coerce.number().int().positive().default(3),
  /**
   * Per IP, per hour. Looser than the per-phone limit — a NAT/office network
   * shares one IP across many legitimate phones — but it is what stops one
   * attacker from spraying OTP requests across many numbers, which the
   * per-phone limit alone cannot catch.
   */
  OTP_MAX_REQUESTS_PER_HOUR_PER_IP: z.coerce.number().int().positive().default(20),

  REDIS_URL: z.string().optional(),

  /**
   * Optional so local development can run without payments configured, but
   * required in production — see the check below. An empty webhook secret
   * makes signature verification fail closed, which is safe but presents as a
   * mysterious 403 on every callback.
   */
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  // Production must never run on the placeholder secrets from .env.example.
  if (parsed.data.NODE_ENV === 'production') {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (parsed.data[key].startsWith('change-me')) {
        throw new Error(`${key} still holds its placeholder value in production`);
      }
    }

    // Fail at boot rather than at the first checkout, and rather than
    // returning 403 on every webhook because the HMAC key is empty.
    for (const key of [
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ] as const) {
      if (!parsed.data[key]) {
        throw new Error(`${key} is required in production`);
      }
    }
  }

  return parsed.data;
}
