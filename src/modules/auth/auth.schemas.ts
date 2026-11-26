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

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Every phone-or-email flow takes exactly one of `{ phone }` / `{ email }`.
 * Two explicit optional fields (not one free-form `identifier` string) keep
 * the wire format self-describing and the existing `{ phone }` clients valid.
 */
const identifierShape = { phone: PhoneSchema.optional(), email: EmailSchema.optional() };

const exactlyOneIdentifier = [
  (v: { phone?: string; email?: string }) => (v.phone === undefined) !== (v.email === undefined),
  { message: 'Provide either a phone number or an email, not both', path: ['phone'] as string[] },
] as const;

const OtpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const RequestOtpSchema = z.object(identifierShape).refine(...exactlyOneIdentifier);

export const VerifyOtpSchema = z
  .object({
    ...identifierShape,
    code: OtpCodeSchema,
    deviceInfo: z.string().max(200).optional(),
  })
  .refine(...exactlyOneIdentifier);

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceInfo: z.string().max(200).optional(),
});

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

/**
 * Length over composition, per NIST 800-63B — a letter and a digit is a
 * reasonable v1 baseline without adding special-character friction this
 * codebase has no prior UX precedent for.
 */
export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72)
  .regex(/[A-Za-z]/, 'Password must include a letter')
  .regex(/[0-9]/, 'Password must include a number');

export const RegisterWithEmailSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: z.string().trim().min(1).max(120).optional(),
});

export const PasswordLoginSchema = z
  .object({
    ...identifierShape,
    // Not re-validated for strength, same reasoning as LoginWithEmailSchema.
    password: z.string().min(1),
    deviceInfo: z.string().max(200).optional(),
  })
  .refine(...exactlyOneIdentifier);

/** First-time password for a signed-in user who has none yet. */
export const SetPasswordSchema = z.object({ password: PasswordSchema });

/** Forgot password: a fresh OTP proves ownership, then sets the new password. */
export const ResetPasswordSchema = z
  .object({
    ...identifierShape,
    code: OtpCodeSchema,
    password: PasswordSchema,
    deviceInfo: z.string().max(200).optional(),
  })
  .refine(...exactlyOneIdentifier);

export const LoginWithEmailSchema = z.object({
  email: EmailSchema,
  // Not re-validated for strength — a password predating a rule change must
  // still be checkable; only a length-1 sanity bound here.
  password: z.string().min(1),
  deviceInfo: z.string().max(200).optional(),
});

export const GoogleLoginSchema = z.object({
  idToken: z.string().min(1),
  deviceInfo: z.string().max(200).optional(),
});

export type RequestOtpDto = z.infer<typeof RequestOtpSchema>;
export type VerifyOtpDto = z.infer<typeof VerifyOtpSchema>;
export type RefreshDto = z.infer<typeof RefreshSchema>;
export type LogoutDto = z.infer<typeof LogoutSchema>;
export type RegisterWithEmailDto = z.infer<typeof RegisterWithEmailSchema>;
export type PasswordLoginDto = z.infer<typeof PasswordLoginSchema>;
export type SetPasswordDto = z.infer<typeof SetPasswordSchema>;
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;
export type LoginWithEmailDto = z.infer<typeof LoginWithEmailSchema>;
export type GoogleLoginDto = z.infer<typeof GoogleLoginSchema>;
