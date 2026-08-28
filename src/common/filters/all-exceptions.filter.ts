import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { isExclusionViolation } from '../errors/domain.errors.js';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}

/**
 * Single error envelope for the whole API:
 *   { error: { code, message, details?, requestId } }
 *
 * `code` is what the app branches on, `message` is safe to show a user, and
 * `requestId` is what support quotes to find the log line.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req.headers['x-request-id'] as string) ?? crypto.randomUUID();

    const { status, body } = this.translate(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Full detail to logs, never to the client.
      this.logger.error(
        `${req.method} ${req.url} → ${status} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${req.method} ${req.url} → ${status} ${body.code} [${requestId}]`);
    }

    res.status(status).json({ error: body });
  }

  private translate(exception: unknown, requestId: string): { status: number; body: ErrorBody } {
    // A racing booking that lost. Surfaces as 409 so the client can refresh
    // availability and show the user which slots are genuinely free.
    if (isExclusionViolation(exception)) {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          code: 'SLOT_UNAVAILABLE',
          message: 'That slot is no longer available.',
          requestId,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        return {
          status,
          body: {
            code: typeof r.code === 'string' ? r.code : this.defaultCode(status),
            message: this.messageOf(r, exception.message),
            details: r.details,
            requestId,
          },
        };
      }

      return {
        status,
        body: { code: this.defaultCode(status), message: String(response), requestId },
      };
    }

    // Anything unrecognised is a bug. Never echo it back — Prisma errors in
    // particular expose schema and constraint names.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
        requestId,
      },
    };
  }

  /** Nest's ValidationPipe puts an array of messages under `message`. */
  private messageOf(r: Record<string, unknown>, fallback: string): string {
    if (typeof r.message === 'string') return r.message;
    if (Array.isArray(r.message)) return r.message.join('; ');
    return fallback;
  }

  private defaultCode(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE',
      429: 'RATE_LIMITED',
    };
    return map[status] ?? 'ERROR';
  }
}
