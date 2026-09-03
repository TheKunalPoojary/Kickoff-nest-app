import { z } from 'zod';

/** Shared with the React Native client so both sides validate identically. */

export const ResourceKindSchema = z.enum(['TURF', 'ARCADE']);

export const SearchVenuesSchema = z
  .object({
    city: z.string().trim().min(1).max(80).optional(),
    /** Free-text over venue name. */
    q: z.string().trim().min(1).max(80).optional(),
    kind: ResourceKindSchema.optional(),
    /** Matches Resource.attributes->>'sport', e.g. football, cricket. */
    sport: z.string().trim().min(1).max(40).optional(),
    minPricePaise: z.coerce.number().int().nonnegative().optional(),
    maxPricePaise: z.coerce.number().int().positive().optional(),

    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().positive().max(100).default(25),

    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng must be provided together',
    path: ['lat'],
  })
  .refine(
    (v) =>
      v.minPricePaise === undefined ||
      v.maxPricePaise === undefined ||
      v.minPricePaise <= v.maxPricePaise,
    { message: 'minPricePaise must not exceed maxPricePaise', path: ['minPricePaise'] },
  );

export type SearchVenuesDto = z.infer<typeof SearchVenuesSchema>;
