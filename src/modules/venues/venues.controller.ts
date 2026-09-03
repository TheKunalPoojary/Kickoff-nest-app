import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { SearchVenuesSchema, type SearchVenuesDto } from './venues.schemas.js';
import { VenuesService } from './venues.service.js';

/**
 * Browsing is public. Requiring sign-in before a user can see what is on offer
 * is the fastest way to lose them.
 */
@Public()
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Get()
  search(@Query(new ZodValidationPipe(SearchVenuesSchema)) query: SearchVenuesDto) {
    return this.venues.search(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.venues.findById(id);
  }

  @Get(':id/resources')
  listResources(@Param('id') id: string) {
    return this.venues.listResources(id);
  }
}
