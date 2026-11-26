import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { VenueOwnershipGuard } from '../../common/guards/venue-ownership.guard.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { BlackoutsService } from './blackouts.service.js';
import { CreateBlackoutSchema, type CreateBlackoutDto } from './availability.schemas.js';

@Roles('VENUE_OWNER')
@Controller('owner/resources')
export class OwnerBlackoutsController {
  constructor(private readonly blackouts: BlackoutsService) {}

  @Get(':resourceId/blackouts')
  @UseGuards(VenueOwnershipGuard)
  list(@Param('resourceId') resourceId: string) {
    return this.blackouts.list(resourceId);
  }

  @Post(':resourceId/blackouts')
  @UseGuards(VenueOwnershipGuard)
  create(
    @Param('resourceId') resourceId: string,
    @CurrentUser() user: AuthUser,
    @Body(zodBody(CreateBlackoutSchema)) dto: CreateBlackoutDto,
  ) {
    return this.blackouts.create(resourceId, user.id, dto);
  }

  @Delete(':resourceId/blackouts/:blackoutId')
  @UseGuards(VenueOwnershipGuard)
  @HttpCode(HttpStatus.OK)
  remove(@Param('resourceId') resourceId: string, @Param('blackoutId') blackoutId: string) {
    return this.blackouts.remove(resourceId, blackoutId);
  }
}

@Roles('VENUE_OWNER')
@Controller('owner/venues')
export class OwnerClosuresController {
  constructor(private readonly blackouts: BlackoutsService) {}

  @Get(':venueId/blackouts')
  @UseGuards(VenueOwnershipGuard)
  list(@Param('venueId') venueId: string, @Query('from') from?: string) {
    const fromDate = from ? new Date(from) : undefined;
    return this.blackouts.listForVenue(
      venueId,
      fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : undefined,
    );
  }

  @Post(':venueId/closures')
  @UseGuards(VenueOwnershipGuard)
  closeVenue(
    @Param('venueId') venueId: string,
    @CurrentUser() user: AuthUser,
    @Body(zodBody(CreateBlackoutSchema)) dto: CreateBlackoutDto,
  ) {
    return this.blackouts.closeVenue(venueId, user.id, dto);
  }
}
