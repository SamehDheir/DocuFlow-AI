import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Opts a route out of JwtAuthGuard.
 *
 * The guard is registered globally, so authentication is the default and this
 * is the exception. That direction matters: a new controller added without a
 * decorator is protected, rather than silently open until someone notices.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
