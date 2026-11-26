import { Module } from '@nestjs/common';
import { AdminNotificationsController } from './admin-notifications.controller.js';
import { DevicesController } from './devices.controller.js';
import { NotificationsService } from './notifications.service.js';
import { OwnerNotificationsController } from './owner-notifications.controller.js';
import { ExpoPushProvider, PushProvider } from './push.provider.js';

@Module({
  controllers: [DevicesController, OwnerNotificationsController, AdminNotificationsController],
  providers: [NotificationsService, { provide: PushProvider, useClass: ExpoPushProvider }],
  exports: [NotificationsService],
})
export class NotificationsModule {}
