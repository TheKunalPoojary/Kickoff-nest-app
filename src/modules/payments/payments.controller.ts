import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayClient } from './razorpay.client.js';
import { CreateOrderSchema, type CreateOrderDto } from './payment.schemas.js';

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly razorpay: RazorpayClient,
  ) {}

  @Post('order')
  @HttpCode(HttpStatus.OK)
  createOrder(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(CreateOrderSchema)) dto: CreateOrderDto,
  ) {
    return this.payments.createOrder(user.id, dto.bookingId);
  }

  @Get(':bookingId/status')
  getStatus(@CurrentUser() user: AuthUser, @Param('bookingId') bookingId: string) {
    return this.payments.getStatus(user.id, bookingId);
  }

  /** Dev/staging-only. Refuses to run when NODE_ENV=production — see PaymentsService.devConfirmPayment. */
  @Post('dev/confirm')
  @HttpCode(HttpStatus.OK)
  devConfirm(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(CreateOrderSchema)) dto: CreateOrderDto,
  ) {
    return this.payments.devConfirmPayment(user.id, dto.bookingId);
  }

  /**
   * Server-to-server, so it is @Public() — Razorpay has no bearer token. The
   * HMAC signature IS the authentication, and it is checked over the RAW body
   * before anything in the payload is trusted or parsed. Without that, this
   * endpoint would be an open "mark my booking as paid" API.
   */
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-razorpay-signature') signature?: string,
    @Headers('x-razorpay-event-id') eventId?: string,
  ) {
    const raw = req.rawBody;

    if (!raw || !this.razorpay.verifyWebhookSignature(raw, signature)) {
      throw new ForbiddenException({
        code: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'Signature verification failed.',
      });
    }

    const body = JSON.parse(raw.toString('utf8')) as {
      event?: string;
      payload?: Record<string, unknown>;
    };

    if (!eventId || !body.event) {
      // Ack rather than 4xx: retrying a malformed delivery will not help.
      return { received: true, handled: false, reason: 'missing event id or type' };
    }

    const result = await this.payments.processEvent({
      eventId,
      eventType: body.event,
      payload: body.payload ?? {},
    });

    return { received: true, ...result };
  }
}
