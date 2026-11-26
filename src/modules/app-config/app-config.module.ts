import { Module } from '@nestjs/common';
import { AdminAppConfigController, AppConfigController } from './app-config.controller.js';
import { AppConfigService } from './app-config.service.js';
import { AppVersionGuard } from './app-version.guard.js';
import { MaintenanceGuard } from './maintenance.guard.js';

@Module({
  controllers: [AppConfigController, AdminAppConfigController],
  providers: [AppConfigService, MaintenanceGuard, AppVersionGuard],
  exports: [AppConfigService, MaintenanceGuard, AppVersionGuard],
})
export class AppConfigModule {}
