import { Module } from '@nestjs/common';
import { VenuesModule } from '../venues/venues.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [VenuesModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
