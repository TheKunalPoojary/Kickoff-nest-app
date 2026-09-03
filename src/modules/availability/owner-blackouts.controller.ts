import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { VenueOwnershipGuard } from '../../common/guards/venue-ownership.guard.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { BlackoutsService } from './blackouts.service.js';
import { CreateBlackoutSchema, type CreateBlackoutDto } from './availability.schemas.js';

@Roles('VENUE_OWNER')
@Controller('owner/resources')
export class OwnerBlackoutsController {
  constructor(private readonly blackouts: BlackoutsService) {}

  @Get(':resourceId/blackouts')
  @UseGuards(VenueOwnershipGuard)
  list(@Param('resourceId') resourceId: string) {
    return this.blackouts.list(resourceId);
  }

  @Post(':resourceId/blackouts')
  @UseGuards(VenueOwnershipGuard)
  create(
    @Param('resourceId') resourceId: string,
    @CurrentUser() user: AuthUser,
    @Body(zodBody(CreateBlackoutSchema)) dto: CreateBlackoutDto,
  ) {
    return this.blackouts.create(resourceId, user.id, dto);
  }

  @Delete(':resourceId/blackouts/:blackoutId')
  @UseGuards(VenueOwnershipGuard)
  @HttpCode(HttpStatus.OK)
  remove(@Param('blackoutId') blackoutId: string) {
    return this.blackouts.remove(blackoutId);
  }
}
