import { Controller, Get, NotFoundException } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  async me(@CurrentUser() current: AuthUser) {
    const user = await this.prisma.user.findFirst({
      where: { id: current.id, deletedAt: null },
      select: {
        id: true,
        phone: true,
        name: true,
        avatarUrl: true,
        role: true,
        city: true,
        preferredSports: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    }

    return user;
  }
}
