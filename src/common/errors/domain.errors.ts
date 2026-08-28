import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

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
