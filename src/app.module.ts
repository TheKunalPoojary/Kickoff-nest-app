import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { validateEnv } from './infra/config/env.schema.js';
import { PrismaModule } from './infra/prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AvailabilityModule } from './modules/availability/availability.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { VenuesModule } from './modules/venues/venues.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    JwtModule.register({}),
    PrismaModule,
    HealthModule,
    AuthModule,
    AvailabilityModule,
    BookingsModule,
    PaymentsModule,
    UsersModule,
    VenuesModule,
  ],
  providers: [
    // Deny by default: every route requires a valid token unless marked
    // @Public(). Forgetting the decorator locks a route down rather than
    // exposing it, which is the safe direction to fail.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Runs after JwtAuthGuard, so req.user is populated.
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
