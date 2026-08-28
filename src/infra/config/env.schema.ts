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

  REDIS_URL: z.string().optional(),

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
  }

  return parsed.data;
}
