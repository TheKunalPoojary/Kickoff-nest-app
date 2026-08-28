import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Zod rather than class-validator, so the exact same schema can be imported by
 * the React Native app and validate identically on both sides of the wire —
 * decorator-based DTOs cannot cross that boundary.
 *
 * Usage:
 *   @Post()
 *   create(@Body(new ZodValidationPipe(CreateBookingSchema)) dto: CreateBookingDto) {}
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    return result.data;
  }
}

/** Convenience for the common case of validating a request body. */
export const zodBody = <T>(schema: ZodType<T>) => new ZodValidationPipe(schema);
