import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service.js';
import { BlackoutsService } from './blackouts.service.js';
import { OwnerBlackoutsController, OwnerClosuresController } from './owner-blackouts.controller.js';
import { OwnerPriceRulesController } from './owner-price-rules.controller.js';
import { PriceRulesService } from './price-rules.service.js';
import { ResourcesController } from './resources.controller.js';

@Module({
  controllers: [
    ResourcesController,
    OwnerBlackoutsController,
    OwnerClosuresController,
    OwnerPriceRulesController,
  ],
  providers: [AvailabilityService, BlackoutsService, PriceRulesService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
