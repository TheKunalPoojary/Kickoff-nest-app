import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { VenueOwnershipGuard } from '../../common/guards/venue-ownership.guard.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { PriceRulesService } from './price-rules.service.js';
import {
  CreatePriceRuleSchema,
  UpdatePriceRuleSchema,
  type CreatePriceRuleDto,
  type UpdatePriceRuleDto,
} from './price-rules.schemas.js';

@Roles('VENUE_OWNER')
@Controller('owner')
@UseGuards(VenueOwnershipGuard)
export class OwnerPriceRulesController {
  constructor(private readonly rules: PriceRulesService) {}

  @Get('resources/:resourceId/price-rules')
  list(@Param('resourceId') resourceId: string) {
    return this.rules.list(resourceId);
  }

  @Post('resources/:resourceId/price-rules')
  create(
    @Param('resourceId') resourceId: string,
    @Body(zodBody(CreatePriceRuleSchema)) dto: CreatePriceRuleDto,
  ) {
    return this.rules.create(resourceId, dto);
  }

  @Patch('price-rules/:priceRuleId')
  update(
    @Param('priceRuleId') priceRuleId: string,
    @Body(zodBody(UpdatePriceRuleSchema)) dto: UpdatePriceRuleDto,
  ) {
    return this.rules.update(priceRuleId, dto);
  }

  @Delete('price-rules/:priceRuleId')
  @HttpCode(HttpStatus.OK)
  remove(@Param('priceRuleId') priceRuleId: string) {
    return this.rules.remove(priceRuleId);
  }
}
