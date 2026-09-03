import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { HoldSweeperService } from './hold-sweeper.service.js';

@Module({
  imports: [AvailabilityModule, PaymentsModule],
  controllers: [BookingsController],
  providers: [BookingsService, HoldSweeperService],
  exports: [BookingsService, HoldSweeperService],
})
export class BookingsModule {}
