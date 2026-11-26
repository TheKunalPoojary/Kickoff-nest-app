import { z } from 'zod';

export const CreateBookingSchema = z.object({
  resourceId: z.string().min(1),
  /** Must exactly match a slot start from the availability endpoint. */
  startsAt: z.coerce.date(),
  /**
   * Consecutive slots to book as ONE booking — a 2-hour game is one row
   * spanning the range, not two rows. One range, one constraint check, one
   * refund.
   */
  slots: z.number().int().min(1).max(8).default(1),
});

export const ListBookingsSchema = z.object({
  status: z
    .enum(['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED', 'NO_SHOW'])
    .optional(),
  /** upcoming = starts in the future and still live. */
  scope: z.enum(['upcoming', 'past', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const CancelBookingSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

// ------------------------------------------------------------ owner portal

const BookingStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'EXPIRED',
  'NO_SHOW',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

const WindowSchema = z.object({ from: z.coerce.date(), to: z.coerce.date() });

/** A window of at most 62 days, so a dashboard query can never scan the whole table. */
const windowOk = (v: { from: Date; to: Date }) =>
  v.to > v.from && v.to.getTime() - v.from.getTime() <= 62 * DAY_MS;
const WINDOW_ERROR = { message: 'to must be after from, at most 62 days apart', path: ['to'] };

export const OwnerBookingsQuerySchema = WindowSchema.extend({
  resourceId: z.string().min(1).optional(),
  status: BookingStatusSchema.optional(),
  source: z.enum(['APP', 'WALK_IN']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).refine(windowOk, WINDOW_ERROR);

export const OwnerSummaryQuerySchema = WindowSchema.refine(windowOk, WINDOW_ERROR);

export const CreateManualBookingSchema = z.object({
  /** Must exactly match a slot start from the availability endpoint. */
  startsAt: z.coerce.date(),
  slots: z.number().int().min(1).max(8).default(1),
  customerName: z.string().trim().min(1).max(80),
  customerPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{7,15}$/, 'Enter a valid phone number')
    .optional(),
  /** Taken at the time of booking (cash/UPI). The rest can be recorded later. */
  collectedPaise: z.number().int().nonnegative().default(0),
});

export const CollectBalanceSchema = z.object({
  amountPaise: z.number().int().positive(),
});

export type OwnerBookingsQueryDto = z.infer<typeof OwnerBookingsQuerySchema>;
export type OwnerSummaryQueryDto = z.infer<typeof OwnerSummaryQuerySchema>;
export type CreateManualBookingDto = z.infer<typeof CreateManualBookingSchema>;
export type CollectBalanceDto = z.infer<typeof CollectBalanceSchema>;
export type CreateBookingDto = z.infer<typeof CreateBookingSchema>;
export type ListBookingsDto = z.infer<typeof ListBookingsSchema>;
export type CancelBookingDto = z.infer<typeof CancelBookingSchema>;
