import { z } from 'zod';
import { ResourceKindSchema } from './venues.schemas.js';

const MINUTES_IN_DAY = 1440;

export const CreateVenueSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  addressLine: z.string().trim().min(4).max(240),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  timezone: z.string().trim().min(3).max(64).default('Asia/Kolkata'),
  contactPhone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number'),
  amenities: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  photos: z.array(z.string().url()).max(20).default([]),
});

export const UpdateVenueSchema = CreateVenueSchema.partial();

export const ResourceAttributesSchema = z.record(z.string(), z.unknown());

export const CreateResourceSchema = z.object({
  kind: ResourceKindSchema,
  name: z.string().trim().min(1).max(80),
  attributes: ResourceAttributesSchema.default({}),
  slotDurationMins: z.number().int().min(15).max(480).default(60),
  bufferMins: z.number().int().min(0).max(120).default(0),
  basePricePaise: z.number().int().nonnegative(),
  maxPlayers: z.number().int().positive().max(100).optional(),
});

export const UpdateResourceSchema = CreateResourceSchema.partial().extend({
  isActive: z.boolean().optional(),
});

/**
 * Minutes from LOCAL midnight. `closesAt` may exceed 1440 for venues that
 * close after midnight (opens 06:00 → 360, closes 02:00 → 1560), which is why
 * the ceiling is 2880 rather than 1440.
 */
export const OperatingHoursSchema = z.object({
  hours: z
    .array(
      z
        .object({
          weekday: z.number().int().min(0).max(6),
          opensAt: z.number().int().min(0).max(MINUTES_IN_DAY),
          closesAt: z.number().int().min(1).max(2 * MINUTES_IN_DAY),
        })
        .refine((h) => h.closesAt > h.opensAt, {
          message: 'closesAt must be after opensAt',
          path: ['closesAt'],
        }),
    )
    .min(1)
    .max(7)
    .refine((hs) => new Set(hs.map((h) => h.weekday)).size === hs.length, {
      message: 'Each weekday may appear only once',
    }),
});

export type CreateVenueDto = z.infer<typeof CreateVenueSchema>;
export type UpdateVenueDto = z.infer<typeof UpdateVenueSchema>;
export type CreateResourceDto = z.infer<typeof CreateResourceSchema>;
export type UpdateResourceDto = z.infer<typeof UpdateResourceSchema>;
export type OperatingHoursDto = z.infer<typeof OperatingHoursSchema>;
