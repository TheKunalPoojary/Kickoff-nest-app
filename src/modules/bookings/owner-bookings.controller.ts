import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { VenueOwnershipGuard } from '../../common/guards/venue-ownership.guard.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { BookingsService } from './bookings.service.js';
import {
  CancelBookingSchema,
  CollectBalanceSchema,
  CreateManualBookingSchema,
  OwnerBookingsQuerySchema,
  OwnerSummaryQuerySchema,
  type CancelBookingDto,
  type CollectBalanceDto,
  type CreateManualBookingDto,
  type OwnerBookingsQueryDto,
  type OwnerSummaryQueryDto,
} from './booking.schemas.js';

/** Venue-side booking management for the owner portal. Role AND ownership on every route. */
@Roles('VENUE_OWNER')
@Controller('owner')
@UseGuards(VenueOwnershipGuard)
export class OwnerBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get('venues/:venueId/bookings')
  list(
    @Param('venueId') venueId: string,
    @Query(new ZodValidationPipe(OwnerBookingsQuerySchema)) query: OwnerBookingsQueryDto,
  ) {
    return this.bookings.listForVenue(venueId, query);
  }

  @Get('venues/:venueId/summary')
  summary(
    @Param('venueId') venueId: string,
    @Query(new ZodValidationPipe(OwnerSummaryQuerySchema)) query: OwnerSummaryQueryDto,
  ) {
    return this.bookings.summaryForVenue(venueId, query);
  }

  /** Walk-in / phone booking, paid at the venue. */
  @Post('resources/:resourceId/bookings')
  createManual(
    @CurrentUser() user: AuthUser,
    @Param('resourceId') resourceId: string,
    @Body(zodBody(CreateManualBookingSchema)) dto: CreateManualBookingDto,
  ) {
    return this.bookings.createManual(user.id, resourceId, dto);
  }

  @Post('bookings/:bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('bookingId') bookingId: string,
    @Body(zodBody(CancelBookingSchema)) dto: CancelBookingDto,
  ) {
    return this.bookings.cancelByVenue(user.id, bookingId, dto);
  }

  @Post('bookings/:bookingId/collect-balance')
  @HttpCode(HttpStatus.OK)
  collectBalance(
    @Param('bookingId') bookingId: string,
    @Body(zodBody(CollectBalanceSchema)) dto: CollectBalanceDto,
  ) {
    return this.bookings.collectBalance(bookingId, dto);
  }
}
