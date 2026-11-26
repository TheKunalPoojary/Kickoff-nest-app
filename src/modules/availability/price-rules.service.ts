import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { CreatePriceRuleDto, UpdatePriceRuleDto } from './price-rules.schemas.js';

const RULE_SELECT = {
  id: true,
  resourceId: true,
  name: true,
  weekdayMask: true,
  startMin: true,
  endMin: true,
  pricePaise: true,
  priority: true,
  validFrom: true,
  validUntil: true,
} as const;

/**
 * Peak / off-peak overrides. Availability resolves prices on every request, so
 * a change here applies to the very next slot lookup — no regeneration step.
 * Bookings already made keep the price they were created with.
 */
@Injectable()
export class PriceRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(resourceId: string) {
    await this.assertResourceExists(resourceId);
    return this.prisma.priceRule.findMany({
      where: { resourceId },
      select: RULE_SELECT,
      orderBy: [{ priority: 'desc' }, { startMin: 'asc' }],
    });
  }

  async create(resourceId: string, dto: CreatePriceRuleDto) {
    await this.assertResourceExists(resourceId);
    return this.prisma.priceRule.create({
      data: { ...dto, resourceId },
      select: RULE_SELECT,
    });
  }

  async update(priceRuleId: string, dto: UpdatePriceRuleDto) {
    const existing = await this.prisma.priceRule.findUnique({
      where: { id: priceRuleId },
      select: RULE_SELECT,
    });
    if (!existing) throw this.notFound();

    const merged = { ...existing, ...dto };
    if (merged.endMin <= merged.startMin) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'endMin must be after startMin.',
      });
    }
    if (merged.validFrom && merged.validUntil && merged.validUntil <= merged.validFrom) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'validUntil must be after validFrom.',
      });
    }

    return this.prisma.priceRule.update({
      where: { id: priceRuleId },
      data: dto,
      select: RULE_SELECT,
    });
  }

  async remove(priceRuleId: string) {
    const existing = await this.prisma.priceRule.findUnique({
      where: { id: priceRuleId },
      select: { id: true },
    });
    if (!existing) throw this.notFound();

    await this.prisma.priceRule.delete({ where: { id: priceRuleId } });
    return { id: priceRuleId, deleted: true };
  }

  private notFound() {
    return new NotFoundException({ code: 'PRICE_RULE_NOT_FOUND', message: 'Price rule not found.' });
  }

  private async assertResourceExists(resourceId: string): Promise<void> {
    const resource = await this.prisma.resource.findFirst({
      where: { id: resourceId, deletedAt: null },
      select: { id: true },
    });
    if (!resource) {
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'Resource not found.' });
    }
  }
}
