import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service.js';
import { BlackoutsService } from './blackouts.service.js';
import { OwnerBlackoutsController } from './owner-blackouts.controller.js';
import { ResourcesController } from './resources.controller.js';

@Module({
  controllers: [ResourcesController, OwnerBlackoutsController],
  providers: [AvailabilityService, BlackoutsService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
