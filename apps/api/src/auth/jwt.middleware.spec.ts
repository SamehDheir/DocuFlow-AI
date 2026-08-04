import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Response } from 'express';
import type { Env } from '../config/env.validation';
import type { AuthenticatedRequest, JwtPayload } from './auth.types';
import { JwtMiddleware } from './jwt.middleware';

const SECRET = 'test-access-secret-at-least-32-characters';

const config = {
  get: () => SECRET,
} as unknown as ConfigService<Env, true>;

function requestWith(authorization?: string): AuthenticatedRequest {
  return { headers: authorization ? { authorization } : {} } as AuthenticatedRequest;
}

describe('JwtMiddleware', () => {
  const jwt = new JwtService({});
  const middleware = new JwtMiddleware(jwt, config);
  const response = {} as Response;

  function run(authorization?: string): AuthenticatedRequest {
    const request = requestWith(authorization);
    const next = jest.fn();

    middleware.use(request, response, next);

    // Every path must continue the chain: rejecting here would also block
    // /auth/login and /auth/refresh, which are reached without a valid token.
    expect(next).toHaveBeenCalledTimes(1);

    return request;
  }

  it('maps the token claims onto the request principal', () => {
    const payload: JwtPayload = {
      sub: 'user-1',
      company_id: 'company-a',
      roles: ['Owner', 'Member'],
    };
    const token = jwt.sign(payload, { secret: SECRET, expiresIn: 60 });

    expect(run(`Bearer ${token}`).user).toEqual({
      sub: 'user-1',
      companyId: 'company-a',
      roles: ['Owner', 'Member'],
    });
  });

  it('leaves the request anonymous when there is no header', () => {
    expect(run().user).toBeUndefined();
  });

  it('ignores a header that is not a bearer token', () => {
    expect(run('Basic dXNlcjpwYXNz').user).toBeUndefined();
  });

  it('ignores a token signed with the wrong secret', () => {
    // The forgery check that matters: a token minted elsewhere must not be
    // able to name its own company_id and have the tenant guard trust it.
    const forged = jwt.sign({ sub: 'user-1', company_id: 'company-b', roles: [] } as JwtPayload, {
      secret: 'a-different-secret-that-is-also-32-chars',
      expiresIn: 60,
    });

    expect(run(`Bearer ${forged}`).user).toBeUndefined();
  });

  it('ignores an expired token', () => {
    const expired = jwt.sign({ sub: 'user-1', company_id: 'company-a', roles: [] } as JwtPayload, {
      secret: SECRET,
      expiresIn: -10,
    });

    expect(run(`Bearer ${expired}`).user).toBeUndefined();
  });

  it('defaults roles to an empty list when the claim is absent', () => {
    const token = jwt.sign({ sub: 'user-1', company_id: 'company-a' }, { secret: SECRET });

    expect(run(`Bearer ${token}`).user?.roles).toEqual([]);
  });
});
