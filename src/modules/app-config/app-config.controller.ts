import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { AppConfigService } from './app-config.service.js';
import { UpdateAppConfigSchema, type UpdateAppConfigDto } from './app-config.schemas.js';

/**
 * Read by the mobile app at launch, before sign-in — it decides whether the
 * app may run at all (version gate, maintenance), so it cannot require auth.
 */
@Controller('config')
export class AppConfigController {
  constructor(private readonly config: AppConfigService) {}

  @Public()
  @Get('app')
  get() {
    return this.config.get();
  }
}

@Roles('ADMIN')
@Controller('admin/config')
export class AdminAppConfigController {
  constructor(private readonly config: AppConfigService) {}

  @Get()
  get() {
    return this.config.get();
  }

  @Put()
  update(
    @CurrentUser() user: AuthUser,
    @Body(zodBody(UpdateAppConfigSchema)) dto: UpdateAppConfigDto,
  ) {
    return this.config.update(dto, user);
  }
}
