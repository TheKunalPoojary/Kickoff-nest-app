import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import type { Env } from './infra/config/env.schema.js';

async function bootstrap() {
  // rawBody is required to verify the Razorpay webhook HMAC: re-serialising a
  // parsed body changes the bytes and invalidates the signature.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get(ConfigService<Env, true>);

  // Only the portal's origin(s). The mobile app is not a browser and is
  // unaffected; a wildcard here would let any website drive a signed-in
  // owner's session from their browser.
  app.enableCors({ origin: config.get('CORS_ORIGINS', { infer: true }) });

  // Uploaded venue photos. Outside the API prefix and the guards — they are
  // public images. nosniff so a browser never reinterprets one as HTML/script.
  app.useStaticAssets(config.get('UPLOAD_DIR', { infer: true }), {
    prefix: '/uploads/',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  });

  // `health` sits outside the version prefix so uptime monitors and the load
  // balancer have a stable URL that survives an API version bump.
  //
  // Only ever list concrete paths here: a wildcard in `exclude` matches every
  // controller and silently strips the prefix from the whole API.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  // Validation is per-route via ZodValidationPipe rather than a global
  // class-validator pipe — Zod schemas are shared with the React Native client.

  app.useGlobalFilters(new AllExceptionsFilter());

  // Graceful shutdown so in-flight bookings finish and Prisma disconnects.
  app.enableShutdownHooks();

  // Routes are mounted during init; this must come after so it only sees
  // genuine misses. Without it, unmatched paths fall through to Express's
  // default handler and return an HTML error page a JSON client cannot parse.
  await app.init();
  app.getHttpAdapter()
    .getInstance()
    .use((req: Request, res: Response, _next: NextFunction) => {
      res.status(404).json({
        error: {
          code: 'ROUTE_NOT_FOUND',
          message: 'This endpoint does not exist.',
          requestId: (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
        },
      });
    });

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  new Logger('Bootstrap').log(`Kickoff API listening on :${port}`);
}

await bootstrap();
