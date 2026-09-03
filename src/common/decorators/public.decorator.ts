import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of the global JwtAuthGuard. Auth is deny-by-default:
 * forgetting this decorator makes a route private, which is the safe way to
 * be wrong.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
