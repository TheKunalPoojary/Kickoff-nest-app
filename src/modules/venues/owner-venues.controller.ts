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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { VenueOwnershipGuard } from '../../common/guards/venue-ownership.guard.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import {
  CreateResourceSchema,
  CreateVenueSchema,
  OperatingHoursSchema,
  RemovePhotoSchema,
  UpdateResourceSchema,
  UpdateVenueSchema,
  type CreateResourceDto,
  type CreateVenueDto,
  type OperatingHoursDto,
  type RemovePhotoDto,
  type UpdateResourceDto,
  type UpdateVenueDto,
} from './owner.schemas.js';
import { MAX_PHOTO_BYTES, OwnerVenuesService } from './owner-venues.service.js';

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

  @Get('venues/:venueId')
  @UseGuards(VenueOwnershipGuard)
  getVenue(@Param('venueId') venueId: string) {
    return this.owner.getMine(venueId);
  }

  @Post('venues/:venueId/photos')
  @UseGuards(VenueOwnershipGuard)
  // Multer's own limit stops an oversized body before it is buffered whole;
  // +1 byte so the service, not multer, reports the friendly size error.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES + 1, files: 1 } }))
  addPhoto(
    @Param('venueId') venueId: string,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    return this.owner.addPhoto(venueId, file);
  }

  @Delete('venues/:venueId/photos')
  @UseGuards(VenueOwnershipGuard)
  @HttpCode(HttpStatus.OK)
  removePhoto(
    @Param('venueId') venueId: string,
    @Body(zodBody(RemovePhotoSchema)) dto: RemovePhotoDto,
  ) {
    return this.owner.removePhoto(venueId, dto.url);
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
