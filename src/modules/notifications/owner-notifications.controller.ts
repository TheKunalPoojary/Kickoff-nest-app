import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { VenueOwnershipGuard } from '../../common/guards/venue-ownership.guard.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';
import {
  CustomersQuerySchema,
  HistoryQuerySchema,
  OwnerPreviewSchema,
  OwnerSendSchema,
  type CustomersQueryDto,
  type HistoryQueryDto,
} from './notifications.schemas.js';
import type { z } from 'zod';

/**
 * Venue-side push. Role AND ownership on every route; the audience is always
 * clamped to this venue's customers inside the service.
 */
@Roles('VENUE_OWNER')
@Controller('owner/venues/:venueId')
@UseGuards(VenueOwnershipGuard)
export class OwnerNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('customers')
  customers(
    @Param('venueId') venueId: string,
    @Query(new ZodValidationPipe(CustomersQuerySchema)) query: CustomersQueryDto,
  ) {
    return this.notifications.customers(venueId, query);
  }

  @Get('notifications')
  history(
    @Param('venueId') venueId: string,
    @Query(new ZodValidationPipe(HistoryQuerySchema)) query: HistoryQueryDto,
  ) {
    return this.notifications.listForVenue(venueId, query);
  }

  @Post('notifications/preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('venueId') venueId: string,
    @Body(zodBody(OwnerPreviewSchema)) dto: z.infer<typeof OwnerPreviewSchema>,
  ) {
    return this.notifications.preview(dto.audience, venueId);
  }

  @Post('notifications')
  send(
    @CurrentUser() user: AuthUser,
    @Param('venueId') venueId: string,
    @Body(zodBody(OwnerSendSchema)) dto: z.infer<typeof OwnerSendSchema>,
  ) {
    return this.notifications.send(user, dto, venueId);
  }
}
