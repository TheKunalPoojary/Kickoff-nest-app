import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { BookingsService } from './bookings.service.js';
import {
  CancelBookingSchema,
  CreateBookingSchema,
  ListBookingsSchema,
  type CancelBookingDto,
  type CreateBookingDto,
  type ListBookingsDto,
} from './booking.schemas.js';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /**
   * `Idempotency-Key` is optional but strongly recommended — without it a
   * retried request creates a second booking and charges twice.
   */
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(CreateBookingSchema)) dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bookings.create(user.id, dto, idempotencyKey?.trim() || undefined);
  }

  @Get('me')
  listMine(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(ListBookingsSchema)) query: ListBookingsDto,
  ) {
    return this.bookings.listMine(user.id, query);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.findOne(user.id, id);
  }

  /** Lets the app show the exact refund before the user commits. */
  @Get(':id/cancellation-preview')
  preview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.previewCancellation(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodBody(CancelBookingSchema)) dto: CancelBookingDto,
  ) {
    return this.bookings.cancel(user.id, id, dto);
  }
}
