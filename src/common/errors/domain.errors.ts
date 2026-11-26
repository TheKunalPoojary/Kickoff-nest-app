import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Domain exceptions carry a stable machine-readable `code` that clients branch
 * on. Keeping HTTP status codes here — rather than scattered `throw new
 * HttpException(...)` calls — means the mapping stays consistent.
 */
export class DomainError extends ConflictException {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details });
  }
}

/** The slot was taken between the availability read and the booking write. */
export class SlotUnavailableException extends DomainError {
  constructor(details?: Record<string, unknown>) {
    super('SLOT_UNAVAILABLE', 'That slot is no longer available.', details);
  }
}

export class BookingNotCancellableException extends DomainError {
  constructor(details?: Record<string, unknown>) {
    super('BOOKING_NOT_CANCELLABLE', 'This booking can no longer be cancelled.', details);
  }
}

export class EmailAlreadyRegisteredException extends DomainError {
  constructor() {
    super('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists.');
  }
}

export class PasswordAlreadySetException extends DomainError {
  constructor() {
    super(
      'PASSWORD_ALREADY_SET',
      'This account already has a password. Use "forgot password" to change it.',
    );
  }
}

export class PasswordLoginRequiredException extends DomainError {
  constructor() {
    super(
      'PASSWORD_LOGIN_REQUIRED',
      'This account already has a password. Sign in with it, or use "forgot password".',
    );
  }
}

// 401s — not a DomainError, which is hard-wired to 409. Follows the
// VenueNotFoundException / NotVenueOwnerException pattern instead: extend the
// right HTTP exception and attach `code` directly.
export class InvalidCredentialsException extends UnauthorizedException {
  readonly code = 'INVALID_CREDENTIALS';
  constructor() {
    super({ code: 'INVALID_CREDENTIALS', message: 'Incorrect email, phone number or password.' });
  }
}

export class GoogleTokenInvalidException extends UnauthorizedException {
  readonly code = 'GOOGLE_TOKEN_INVALID';
  constructor() {
    super({ code: 'GOOGLE_TOKEN_INVALID', message: 'Could not verify your Google sign-in.' });
  }
}

export class AccountUnavailableException extends UnauthorizedException {
  readonly code = 'ACCOUNT_UNAVAILABLE';
  constructor() {
    super({ code: 'ACCOUNT_UNAVAILABLE', message: 'This account is no longer active.' });
  }
}

export class VenueNotFoundException extends NotFoundException {
  readonly code = 'VENUE_NOT_FOUND';
  constructor() {
    super({ code: 'VENUE_NOT_FOUND', message: 'Venue not found.' });
  }
}

/**
 * Role alone is never enough in a marketplace — a VENUE_OWNER may only touch
 * venues they actually own.
 */
export class NotVenueOwnerException extends ForbiddenException {
  readonly code = 'NOT_VENUE_OWNER';
  constructor() {
    super({ code: 'NOT_VENUE_OWNER', message: 'You do not manage this venue.' });
  }
}

/** Admin has switched the app into maintenance from the portal. */
export class MaintenanceModeException extends ServiceUnavailableException {
  readonly code = 'MAINTENANCE';
  constructor(message: string) {
    super({
      code: 'MAINTENANCE',
      message: message || 'Kickoff is down for maintenance. Please try again shortly.',
    });
  }
}

/** The app build is older than the admin-set minimum for its platform. */
export class UpgradeRequiredException extends HttpException {
  readonly code = 'UPGRADE_REQUIRED';
  constructor(message: string, details?: { min: string; storeUrl: string }) {
    super(
      {
        code: 'UPGRADE_REQUIRED',
        message: message || 'This version of Kickoff is no longer supported. Please update.',
        details,
      },
      426, // Upgrade Required — not in Nest's HttpStatus enum
    );
  }
}

export class InvalidUploadException extends BadRequestException {
  readonly code = 'INVALID_UPLOAD';
  constructor(message: string) {
    super({ code: 'INVALID_UPLOAD', message });
  }
}

export class BookingNotFoundException extends NotFoundException {
  readonly code = 'BOOKING_NOT_FOUND';
  constructor() {
    super({ code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' });
  }
}

/** Postgres SQLSTATE for a violated exclusion constraint. */
export const PG_EXCLUSION_VIOLATION = '23P01';
/** Postgres SQLSTATE for a violated unique constraint. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Finds a Postgres SQLSTATE inside a Prisma error.
 *
 * Prisma does not surface the driver code at the top level. With the pg driver
 * adapter (Prisma 7) an exclusion violation arrives as:
 *
 *   PrismaClientKnownRequestError
 *     code: 'P2039'
 *     meta.driverAdapterError.cause.code       === '23P01'
 *     meta.driverAdapterError.cause.originalCode === '23P01'
 *
 * The nesting has changed between Prisma versions, so rather than reading one
 * fixed path this walks the error graph over the handful of keys Prisma uses
 * to wrap causes. Bounded and cycle-safe: this runs on a request path.
 */
export function hasPgCode(err: unknown, sqlState: string): boolean {
  const WRAPPER_KEYS = ['cause', 'meta', 'driverAdapterError', 'error'] as const;
  const seen = new Set<object>();
  const stack: unknown[] = [err];

  for (let steps = 0; stack.length > 0 && steps < 50; steps++) {
    const cur = stack.pop();
    if (typeof cur !== 'object' || cur === null || seen.has(cur)) continue;
    seen.add(cur);

    const node = cur as Record<string, unknown>;
    if (node.code === sqlState || node.originalCode === sqlState) return true;

    for (const key of WRAPPER_KEYS) {
      if (node[key]) stack.push(node[key]);
    }
  }

  return false;
}

export const isExclusionViolation = (err: unknown) => hasPgCode(err, PG_EXCLUSION_VIOLATION);

/** An owner targeted a user who is not a customer of the venue (or does not exist — deliberately indistinguishable). */
export class AudienceOutOfScopeException extends BadRequestException {
  readonly code = 'AUDIENCE_OUT_OF_SCOPE';
  constructor() {
    super({
      code: 'AUDIENCE_OUT_OF_SCOPE',
      message: 'Some selected users are not customers of this venue.',
    });
  }
}

export class PushRateLimitedException extends HttpException {
  readonly code = 'PUSH_RATE_LIMITED';
  constructor(limit: number) {
    super(
      {
        code: 'PUSH_RATE_LIMITED',
        message: `This venue can send ${limit} notifications per 24 hours. Try again later.`,
      },
      429,
    );
  }
}
