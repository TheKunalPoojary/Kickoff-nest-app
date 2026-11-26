import { z } from 'zod';
import { EmailSchema, PasswordSchema } from '../auth/auth.schemas.js';
import { CreateVenueSchema } from '../venues/owner.schemas.js';

export const CreateOwnerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: EmailSchema,
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number')
    .optional(),
  /** Shared with the owner out of band; they log in with it via /auth/email/login. */
  tempPassword: PasswordSchema,
});

export const ListUsersSchema = z.object({
  q: z.string().trim().max(80).optional(),
  role: z.enum(['USER', 'VENUE_OWNER', 'VENUE_STAFF', 'ADMIN', 'SUPPORT']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * ADMIN is deliberately not assignable from the API: a compromised admin
 * session must not be able to mint further admins. Promote via the database.
 */
export const UpdateUserSchema = z
  .object({
    isBlocked: z.boolean().optional(),
    role: z.enum(['USER', 'VENUE_OWNER', 'VENUE_STAFF', 'SUPPORT']).optional(),
  })
  .refine((v) => v.isBlocked !== undefined || v.role !== undefined, {
    message: 'Nothing to update',
  });

export const ListVenuesSchema = z.object({
  status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED']).optional(),
  q: z.string().trim().max(80).optional(),
  ownerId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const AdminUpdateVenueSchema = z
  .object({
    status: z.enum(['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED']).optional(),
    commissionPct: z.number().min(0).max(100).optional(),
    /** Share of the price paid online at booking; the rest at the venue. */
    advancePct: z.number().int().min(1).max(100).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const AdminCreateVenueSchema = CreateVenueSchema.extend({ ownerId: z.string().min(1) });

export const AdminBookingsSchema = z.object({
  venueId: z.string().min(1).optional(),
  status: z
    .enum(['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED', 'NO_SHOW'])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type CreateOwnerDto = z.infer<typeof CreateOwnerSchema>;
export type ListUsersDto = z.infer<typeof ListUsersSchema>;
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;
export type ListVenuesDto = z.infer<typeof ListVenuesSchema>;
export type AdminUpdateVenueDto = z.infer<typeof AdminUpdateVenueSchema>;
export type AdminCreateVenueDto = z.infer<typeof AdminCreateVenueSchema>;
export type AdminBookingsDto = z.infer<typeof AdminBookingsSchema>;
