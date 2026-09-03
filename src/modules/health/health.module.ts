import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [BookingsModule],
  controllers: [HealthController],
})
export class HealthModule {}
