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

export type CreateBookingDto = z.infer<typeof CreateBookingSchema>;
export type ListBookingsDto = z.infer<typeof ListBookingsSchema>;
export type CancelBookingDto = z.infer<typeof CancelBookingSchema>;
