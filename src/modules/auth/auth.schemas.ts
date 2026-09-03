import { z } from 'zod';

/**
 * Shared with the React Native client so both sides validate identically.
 *
 * E.164: a leading + and 8-15 digits. Storing anything else makes "find my
 * friend by phone" and SMS delivery unreliable later.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number including country code');

export const RequestOtpSchema = z.object({
  phone: PhoneSchema,
});

export const VerifyOtpSchema = z.object({
  phone: PhoneSchema,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  deviceInfo: z.string().max(200).optional(),
});

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceInfo: z.string().max(200).optional(),
});

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RequestOtpDto = z.infer<typeof RequestOtpSchema>;
export type VerifyOtpDto = z.infer<typeof VerifyOtpSchema>;
export type RefreshDto = z.infer<typeof RefreshSchema>;
export type LogoutDto = z.infer<typeof LogoutSchema>;
