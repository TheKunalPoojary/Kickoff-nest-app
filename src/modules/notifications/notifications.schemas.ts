import { z } from 'zod';

const UserIds = z.array(z.string().min(1)).min(1).max(500);

const UsersAudience = z.object({ type: z.literal('USERS'), userIds: UserIds });

/** What a venue owner may target — always scoped to the venue in the URL. */
export const OwnerAudienceSchema = z.discriminatedUnion('type', [
  UsersAudience,
  z.object({ type: z.literal('ALL_CUSTOMERS') }),
]);

/** What a super admin may target. */
export const AdminAudienceSchema = z.discriminatedUnion('type', [
  UsersAudience,
  z.object({ type: z.literal('ALL') }),
  z.object({ type: z.literal('VENUE_CUSTOMERS'), venueId: z.string().min(1) }),
  z
    .object({
      type: z.literal('SEGMENT'),
      city: z.string().trim().min(1).max(80).optional(),
      sports: z.array(z.string().trim().min(1).max(40)).min(1).max(10).optional(),
    })
    .refine((v) => v.city !== undefined || v.sports !== undefined, {
      message: 'Pick a city, sports, or both',
    }),
]);

export type OwnerAudience = z.infer<typeof OwnerAudienceSchema>;
export type AdminAudience = z.infer<typeof AdminAudienceSchema>;
export type Audience = OwnerAudience | AdminAudience;

// Push titles/bodies are truncated by the OS well before these limits.
const Title = z.string().trim().min(1).max(65);
const Body = z.string().trim().min(1).max(240);

export const OwnerSendSchema = z.object({ title: Title, body: Body, audience: OwnerAudienceSchema });
export const AdminSendSchema = z.object({ title: Title, body: Body, audience: AdminAudienceSchema });
export const OwnerPreviewSchema = z.object({ audience: OwnerAudienceSchema });
export const AdminPreviewSchema = z.object({ audience: AdminAudienceSchema });

export type SendDto = { title: string; body: string; audience: Audience };

export const CustomersQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type CustomersQueryDto = z.infer<typeof CustomersQuerySchema>;

export const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type HistoryQueryDto = z.infer<typeof HistoryQuerySchema>;

/** `ExponentPushToken[...]` (current) or the legacy `ExpoPushToken[...]`. */
export const RegisterDeviceSchema = z.object({
  expoPushToken: z.string().regex(/^(Exponent|Expo)PushToken\[[^\]]{1,200}\]$/, 'Not an Expo push token'),
  platform: z.enum(['ios', 'android']),
});
export const UnregisterDeviceSchema = RegisterDeviceSchema.pick({ expoPushToken: true });
export type RegisterDeviceDto = z.infer<typeof RegisterDeviceSchema>;
export type UnregisterDeviceDto = z.infer<typeof UnregisterDeviceSchema>;
