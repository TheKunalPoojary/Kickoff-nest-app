import { z } from 'zod';

/**
 * A calendar date in the VENUE's timezone, not the caller's. A user in New York
 * asking for a Pune turf's "2026-09-05" means Pune's 5th.
 */
export const AvailabilityQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a real date'),
});

export const CreateBlackoutSchema = z
  .object({
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type AvailabilityQueryDto = z.infer<typeof AvailabilityQuerySchema>;
export type CreateBlackoutDto = z.infer<typeof CreateBlackoutSchema>;
