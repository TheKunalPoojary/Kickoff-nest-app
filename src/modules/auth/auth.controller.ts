import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { PasswordAuthService } from './password-auth.service.js';
import { GoogleAuthService } from './google-auth.service.js';
import { toIdentifier } from './identifier.js';
import {
  GoogleLoginSchema,
  PasswordLoginSchema,
  ResetPasswordSchema,
  SetPasswordSchema,
  LoginWithEmailSchema,
  LogoutSchema,
  RefreshSchema,
  RegisterWithEmailSchema,
  RequestOtpSchema,
  VerifyOtpSchema,
  type GoogleLoginDto,
  type PasswordLoginDto,
  type ResetPasswordDto,
  type SetPasswordDto,
  type LoginWithEmailDto,
  type LogoutDto,
  type RefreshDto,
  type RegisterWithEmailDto,
  type RequestOtpDto,
  type VerifyOtpDto,
} from './auth.schemas.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly passwordAuth: PasswordAuthService,
    private readonly googleAuth: GoogleAuthService,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body(zodBody(RequestOtpSchema)) dto: RequestOtpDto, @Req() req: Request) {
    return this.auth.requestOtp(toIdentifier(dto), req.ip);
  }

  /** Sign-up only: 409 PASSWORD_LOGIN_REQUIRED if the account already has a password. */
  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body(zodBody(VerifyOtpSchema)) dto: VerifyOtpDto) {
    return this.auth.verifyOtp(toIdentifier(dto), dto.code, dto.deviceInfo);
  }

  @Public()
  @Post('email/register')
  @HttpCode(HttpStatus.CREATED)
  registerWithEmail(@Body(zodBody(RegisterWithEmailSchema)) dto: RegisterWithEmailDto) {
    return this.passwordAuth.register(dto.email, dto.password, dto.name);
  }

  @Public()
  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  loginWithEmail(@Body(zodBody(LoginWithEmailSchema)) dto: LoginWithEmailDto, @Req() req: Request) {
    return this.passwordAuth.login(
      { kind: 'email', value: dto.email },
      dto.password,
      req.ip,
      dto.deviceInfo,
    );
  }

  /** The only way to sign in to an account that has a password (phone OR email). */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body(zodBody(PasswordLoginSchema)) dto: PasswordLoginDto, @Req() req: Request) {
    return this.passwordAuth.login(toIdentifier(dto), dto.password, req.ip, dto.deviceInfo);
  }

  /** Authenticated (not @Public): called right after the first OTP sign-in. */
  @Post('password/set')
  @HttpCode(HttpStatus.OK)
  setPassword(@Body(zodBody(SetPasswordSchema)) dto: SetPasswordDto, @CurrentUser() user: AuthUser) {
    return this.passwordAuth.setPassword(user.id, dto.password);
  }

  /** Forgot/change password: request a code via `otp/request`, then call this. */
  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body(zodBody(ResetPasswordSchema)) dto: ResetPasswordDto) {
    return this.passwordAuth.resetPassword(toIdentifier(dto), dto.code, dto.password, dto.deviceInfo);
  }

  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  googleLogin(@Body(zodBody(GoogleLoginSchema)) dto: GoogleLoginDto) {
    return this.googleAuth.login(dto.idToken, dto.deviceInfo);
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
