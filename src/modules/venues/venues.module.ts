import { Module } from '@nestjs/common';
import { OwnerVenuesController } from './owner-venues.controller.js';
import { OwnerVenuesService } from './owner-venues.service.js';
import { VenuesController } from './venues.controller.js';
import { VenuesService } from './venues.service.js';

@Module({
  controllers: [VenuesController, OwnerVenuesController],
  providers: [VenuesService, OwnerVenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
