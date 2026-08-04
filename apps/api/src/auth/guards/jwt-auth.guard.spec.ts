import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextWith(user?: AuthenticatedUser): ExecutionContext {
  const request = { user } as AuthenticatedRequest;

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const principal: AuthenticatedUser = { sub: 'user-1', companyId: 'company-a', roles: ['Owner'] };

  it('rejects a request with no principal', () => {
    const guard = new JwtAuthGuard(new Reflector());

    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
  });

  it('admits a request that JwtMiddleware resolved', () => {
    const guard = new JwtAuthGuard(new Reflector());

    expect(guard.canActivate(contextWith(principal))).toBe(true);
  });

  it('lets @Public() routes through anonymously', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    expect(new JwtAuthGuard(reflector).canActivate(contextWith())).toBe(true);
  });

  it('defaults to protected when no decorator is present', () => {
    // The guard is global, so an undecorated controller must fail closed —
    // otherwise a new endpoint is public until somebody notices.
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    expect(() => new JwtAuthGuard(reflector).canActivate(contextWith())).toThrow(
      UnauthorizedException,
    );
  });
});
