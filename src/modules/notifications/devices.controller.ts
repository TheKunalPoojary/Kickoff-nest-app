import { Body, Controller, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';
import {
  RegisterDeviceSchema,
  UnregisterDeviceSchema,
  type RegisterDeviceDto,
  type UnregisterDeviceDto,
} from './notifications.schemas.js';

/** The mobile app registers its Expo push token here after sign-in. */
@Controller('devices')
export class DevicesController {
  constructor(private readonly notifications: NotificationsService) {}

  @Put()
  register(@CurrentUser() user: AuthUser, @Body(zodBody(RegisterDeviceSchema)) dto: RegisterDeviceDto) {
    return this.notifications.registerDevice(user.id, dto);
  }

  /** POST rather than DELETE: the token contains brackets, awkward in a URL path. */
  @Post('unregister')
  @HttpCode(HttpStatus.OK)
  unregister(@CurrentUser() user: AuthUser, @Body(zodBody(UnregisterDeviceSchema)) dto: UnregisterDeviceDto) {
    return this.notifications.unregisterDevice(user.id, dto.expoPushToken);
  }
}
