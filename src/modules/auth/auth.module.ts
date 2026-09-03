import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';

@Module({
  // Secrets are passed per-call rather than registered here, so the access and
  // refresh paths cannot accidentally share one key.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
  exports: [TokenService],
})
export class AuthModule {}
