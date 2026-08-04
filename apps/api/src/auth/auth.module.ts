import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../common/audit/audit.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { JwtMiddleware } from './jwt.middleware';
import { TokenService } from './token.service';

@Module({
  // Secrets are passed per call in TokenService and JwtMiddleware — the access
  // and refresh halves use different ones, so a module-level default would only
  // be right half the time.
  imports: [JwtModule.register({}), PermissionsModule, AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    JwtMiddleware,
    /**
     * Authentication is the default for every route in the application.
     * Opting out is explicit, via @Public() — a controller added without any
     * decorator ends up protected rather than quietly open.
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    /**
     * Authorisation runs second. Order here IS execution order, and
     * PermissionsGuard assumes JwtAuthGuard has already established a
     * principal — reversing the two would ask the database about `undefined`
     * on every anonymous request.
     */
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  /**
   * AppModule applies JwtMiddleware, and Nest instantiates middleware in the
   * injector of the module that applies it — so JwtModule has to be re-exported
   * for JwtService to be resolvable there, not just the middleware class.
   */
  exports: [JwtMiddleware, JwtModule],
})
export class AuthModule {}
