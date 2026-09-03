import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { VenueOwnershipGuard } from '../../common/guards/venue-ownership.guard.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import {
  CreateResourceSchema,
  CreateVenueSchema,
  OperatingHoursSchema,
  UpdateResourceSchema,
  UpdateVenueSchema,
  type CreateResourceDto,
  type CreateVenueDto,
  type OperatingHoursDto,
  type UpdateResourceDto,
  type UpdateVenueDto,
} from './owner.schemas.js';
import { OwnerVenuesService } from './owner-venues.service.js';

/**
 * Every route here needs BOTH checks:
 *   @Roles       — is the caller an owner at all?
 *   Ownership    — do they own THIS venue?
 * Role alone would let any owner edit any other owner's venue.
 */
@Roles('VENUE_OWNER')
@Controller('owner')
export class OwnerVenuesController {
  constructor(private readonly owner: OwnerVenuesService) {}

  @Get('venues')
  listMine(@CurrentUser() user: AuthUser) {
    return this.owner.listMine(user.id);
  }

  // No ownership guard: nothing exists to own yet.
  @Post('venues')
  createVenue(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(CreateVenueSchema)) dto: CreateVenueDto,
  ) {
    return this.owner.createVenue(user.id, dto);
  }

  @Patch('venues/:venueId')
  @UseGuards(VenueOwnershipGuard)
  updateVenue(
    @Param('venueId') venueId: string,
    @Body(zodBody(UpdateVenueSchema)) dto: UpdateVenueDto,
  ) {
    return this.owner.updateVenue(venueId, dto);
  }

  @Put('venues/:venueId/hours')
  @UseGuards(VenueOwnershipGuard)
  replaceHours(
    @Param('venueId') venueId: string,
    @Body(zodBody(OperatingHoursSchema)) dto: OperatingHoursDto,
  ) {
    return this.owner.replaceHours(venueId, dto);
  }

  @Post('venues/:venueId/resources')
  @UseGuards(VenueOwnershipGuard)
  createResource(
    @Param('venueId') venueId: string,
    @Body(zodBody(CreateResourceSchema)) dto: CreateResourceDto,
  ) {
    return this.owner.createResource(venueId, dto);
  }

  @Patch('resources/:resourceId')
  @UseGuards(VenueOwnershipGuard)
  updateResource(
    @Param('resourceId') resourceId: string,
    @Body(zodBody(UpdateResourceSchema)) dto: UpdateResourceDto,
  ) {
    return this.owner.updateResource(resourceId, dto);
  }

  @Delete('resources/:resourceId')
  @UseGuards(VenueOwnershipGuard)
  @HttpCode(HttpStatus.OK)
  archiveResource(@Param('resourceId') resourceId: string) {
    return this.owner.archiveResource(resourceId);
  }
}
