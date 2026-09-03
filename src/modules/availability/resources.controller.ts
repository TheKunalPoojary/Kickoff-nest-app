import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AvailabilityService } from './availability.service.js';
import { AvailabilityQuerySchema, type AvailabilityQueryDto } from './availability.schemas.js';

/**
 * Public: users pick a slot before signing in, and are only asked to
 * authenticate at the point of booking.
 */
@Public()
@Controller('resources')
export class ResourcesController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get(':resourceId/availability')
  getAvailability(
    @Param('resourceId') resourceId: string,
    @Query(new ZodValidationPipe(AvailabilityQuerySchema)) query: AvailabilityQueryDto,
  ) {
    return this.availability.getAvailability(resourceId, query.date);
  }
}
