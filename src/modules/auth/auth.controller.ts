import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import {
  LogoutSchema,
  RefreshSchema,
  RequestOtpSchema,
  VerifyOtpSchema,
  type LogoutDto,
  type RefreshDto,
  type RequestOtpDto,
  type VerifyOtpDto,
} from './auth.schemas.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body(zodBody(RequestOtpSchema)) dto: RequestOtpDto, @Req() req: Request) {
    return this.auth.requestOtp(dto.phone, req.ip);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body(zodBody(VerifyOtpSchema)) dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code, dto.deviceInfo);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body(zodBody(RefreshSchema)) dto: RefreshDto) {
    return this.tokens.rotate(dto.refreshToken, dto.deviceInfo);
  }

  /**
   * Public because the access token may already have expired — that is the
   * normal case when a user returns after a break. The refresh token in the
   * body is the credential being presented.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body(zodBody(LogoutSchema)) dto: LogoutDto): Promise<void> {
    await this.tokens.revokeOne(dto.refreshToken);
  }
}
