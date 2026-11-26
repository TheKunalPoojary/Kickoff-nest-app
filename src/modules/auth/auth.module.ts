import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { PasswordAuthService } from './password-auth.service.js';
import { GoogleAuthService } from './google-auth.service.js';
import { GoogleTokenVerifier } from './google-token-verifier.service.js';

@Module({
  // Secrets are passed per-call rather than registered here, so the access and
  // refresh paths cannot accidentally share one key.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, TokenService, PasswordAuthService, GoogleAuthService, GoogleTokenVerifier],
  exports: [TokenService],
})
export class AuthModule {}
