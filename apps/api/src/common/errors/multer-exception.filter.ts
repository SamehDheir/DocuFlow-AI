import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { MulterError } from 'multer';
import { ERROR_CODES, apiError, type ApiErrorBody } from './error-codes';

/**
 * Turns multer's upload rejections into HTTP answers.
 *
 * Without this an over-limit file surfaces as a 500, which reads as "the server
 * is broken" when the truth is "that file is too big" — and the user has no way
 * to know they should try a smaller one. The size limit itself is enforced by
 * multer, before the body is fully read, so this is the only place that
 * particular rejection can be described.
 */
@Catch(MulterError)
export class MulterExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(MulterExceptionFilter.name);

  catch(exception: MulterError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = translate(exception);

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Unhandled upload error ${exception.code}: ${exception.message}`);
    }

    response.status(status).json({ statusCode: status, ...body });
  }
}

function translate(exception: MulterError): { status: HttpStatus; body: ApiErrorBody } {
  switch (exception.code) {
    case 'LIMIT_FILE_SIZE':
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        body: apiError(ERROR_CODES.FILE_TOO_LARGE, 'That file is larger than the upload limit'),
      };

    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return {
        status: HttpStatus.BAD_REQUEST,
        body: apiError(ERROR_CODES.FILE_REQUIRED, 'Send exactly one file, in the "file" field', {
          file: 'Send exactly one file',
        }),
      };

    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        body: apiError(ERROR_CODES.STORAGE_UNAVAILABLE, 'The upload could not be processed'),
      };
  }
}
