import { z } from 'zod';

const MINUTES_IN_DAY = 1440;

const PriceRuleBaseSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Bitmask of applicable weekdays, Sunday = bit 0. 127 = every day. */
  weekdayMask: z.number().int().min(1).max(127),
  /**
   * Minutes from LOCAL midnight, matched against the slot START. endMin may
   * exceed 1440 to cover after-midnight slots, mirroring OperatingHours.
   */
  startMin: z.number().int().min(0).max(2 * MINUTES_IN_DAY),
  endMin: z.number().int().min(1).max(2 * MINUTES_IN_DAY),
  pricePaise: z.number().int().nonnegative(),
  /** Highest priority wins where rules overlap. */
  priority: z.number().int().min(0).max(1000).default(0),
  validFrom: z.coerce.date().nullable().optional(),
  validUntil: z.coerce.date().nullable().optional(),
});

const timeWindowOk = (v: { startMin?: number; endMin?: number }) =>
  v.startMin === undefined || v.endMin === undefined || v.endMin > v.startMin;

const validityOk = (v: { validFrom?: Date | null; validUntil?: Date | null }) =>
  !v.validFrom || !v.validUntil || v.validUntil > v.validFrom;

export const CreatePriceRuleSchema = PriceRuleBaseSchema.refine(timeWindowOk, {
  message: 'endMin must be after startMin',
  path: ['endMin'],
}).refine(validityOk, { message: 'validUntil must be after validFrom', path: ['validUntil'] });

/**
 * Partial updates are re-validated against the stored row in the service — a
 * PATCH of only `endMin` can still invert the window.
 */
export const UpdatePriceRuleSchema = PriceRuleBaseSchema.partial()
  .refine(timeWindowOk, { message: 'endMin must be after startMin', path: ['endMin'] })
  .refine(validityOk, { message: 'validUntil must be after validFrom', path: ['validUntil'] });

export type CreatePriceRuleDto = z.infer<typeof CreatePriceRuleSchema>;
export type UpdatePriceRuleDto = z.infer<typeof UpdatePriceRuleSchema>;
