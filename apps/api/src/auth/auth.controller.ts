import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import type { AuthResult, AuthenticatedUser, SessionUser } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { REFRESH_COOKIE, SESSION_COOKIE, TokenService, type RequestContext } from './token.service';

interface SessionResponse {
  accessToken: string;
  user: SessionUser;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const result = await this.auth.register(dto, contextOf(request));
    return this.startSession(response, result);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const result = await this.auth.login(dto, contextOf(request));
    return this.startSession(response, result);
  }

  /**
   * Public because it is called precisely when the access token has expired.
   * The refresh cookie is the credential here, so requiring a valid bearer
   * token would make the endpoint unreachable exactly when it is needed.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponse> {
    const presented = readRefreshCookie(request);

    if (!presented) {
      // Same shape as a rejected token: whether a cookie was sent is not
      // information worth confirming.
      this.clearSession(response);
      throw new UnauthorizedException('Invalid refresh token');
    }

    const result = await this.auth.refresh(presented, contextOf(request));
    return this.startSession(response, result);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    await this.auth.logout(readRefreshCookie(request), contextOf(request));
    this.clearSession(response);

    return { ok: true };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.auth.forgotPassword(dto, contextOf(request));

    // Always the same answer, registered address or not.
    return { ok: true };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    await this.auth.resetPassword(dto, contextOf(request));

    // Sessions were revoked server-side; drop the browser's copy too.
    this.clearSession(response);

    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user);
  }

  /**
   * The refresh token goes into an httpOnly cookie and the access token into
   * the body. Script cannot read the cookie, so XSS cannot steal the long-lived
   * half; the access token it can reach expires in minutes.
   */
  private startSession(response: Response, result: AuthResult): SessionResponse {
    response.cookie(REFRESH_COOKIE, result.refreshToken, this.tokens.cookieOptions());
    response.cookie(SESSION_COOKIE, '1', this.tokens.sessionCookieOptions());

    return { accessToken: result.accessToken, user: result.user };
  }

  private clearSession(response: Response): void {
    // clearCookie sets its own expiry; leaving Max-Age in would fight it.
    const refresh = this.tokens.cookieOptions();
    delete refresh.maxAge;

    const session = this.tokens.sessionCookieOptions();
    delete session.maxAge;

    response.clearCookie(REFRESH_COOKIE, refresh);
    response.clearCookie(SESSION_COOKIE, session);
  }
}

function contextOf(request: Request): RequestContext {
  return { ipAddress: request.ip, userAgent: request.get('user-agent') };
}

function readRefreshCookie(request: Request): string | undefined {
  const value: unknown = request.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' ? value : undefined;
}
