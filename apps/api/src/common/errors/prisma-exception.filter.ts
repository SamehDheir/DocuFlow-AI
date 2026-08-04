import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { ERROR_CODES, apiError, type ApiErrorBody } from './error-codes';

/**
 * Turns Prisma's constraint errors into HTTP answers.
 *
 * Without this, a duplicate folder name reaches the client as a 500 with a
 * stack trace — the database already knows the request was invalid, and losing
 * that into "internal server error" makes a recoverable mistake look like an
 * outage. Registered via APP_FILTER so it covers every module.
 *
 * Services that can produce a *specific* message should still throw their own
 * ConflictException — this is the safety net for the ones that slip through,
 * and it deliberately reports a generic code, because it cannot know which of
 * a model's unique constraints the caller meant to satisfy.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = translate(exception);

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      // Unmapped Prisma codes are a gap in this filter, not a client mistake.
      this.logger.error(`Unhandled Prisma error ${exception.code}: ${exception.message}`);
    }

    response.status(status).json({ statusCode: status, ...body });
  }
}

function translate(exception: Prisma.PrismaClientKnownRequestError): {
  status: HttpStatus;
  body: ApiErrorBody;
} {
  switch (exception.code) {
    // Unique constraint violated.
    case 'P2002':
      return {
        status: HttpStatus.CONFLICT,
        body: apiError(ERROR_CODES.CONFLICT, `That ${describeTarget(exception)} is already taken`),
      };

    // Foreign key constraint violated — the caller referenced something absent.
    case 'P2003':
      return {
        status: HttpStatus.CONFLICT,
        body: apiError(ERROR_CODES.CONFLICT, 'A referenced record does not exist'),
      };

    // Record required by the operation was not found.
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        body: apiError(ERROR_CODES.NOT_FOUND, 'The requested record does not exist'),
      };

    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: apiError(ERROR_CODES.CONFLICT, 'The request could not be completed'),
      };
  }
}

/**
 * Names the offending field(s) when Prisma reports them.
 *
 * `meta.target` is a string[] on Postgres, but the shape is driver-dependent
 * and untyped, so it is narrowed rather than trusted.
 */
function describeTarget(exception: Prisma.PrismaClientKnownRequestError): string {
  const target = exception.meta?.target;

  if (Array.isArray(target)) {
    return (
      target.filter((field): field is string => typeof field === 'string').join(', ') || 'value'
    );
  }

  return typeof target === 'string' ? target : 'value';
}
