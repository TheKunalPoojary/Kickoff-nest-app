import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodValidationPipe, zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';
import {
  AdminPreviewSchema,
  AdminSendSchema,
  HistoryQuerySchema,
  type HistoryQueryDto,
} from './notifications.schemas.js';
import type { z } from 'zod';

/** Platform-wide push: specific users, everyone, one venue's customers, or a city/sport segment. */
@Roles('ADMIN')
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  history(@Query(new ZodValidationPipe(HistoryQuerySchema)) query: HistoryQueryDto) {
    return this.notifications.listAll(query);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body(zodBody(AdminPreviewSchema)) dto: z.infer<typeof AdminPreviewSchema>) {
    return this.notifications.preview(dto.audience);
  }

  @Post()
  send(@CurrentUser() user: AuthUser, @Body(zodBody(AdminSendSchema)) dto: z.infer<typeof AdminSendSchema>) {
    return this.notifications.send(user, dto);
  }
}
