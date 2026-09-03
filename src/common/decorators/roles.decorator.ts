import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/enums.js';

export const ROLES_KEY = 'roles';

/**
 * Coarse role check only. It answers "is this user an owner?" — never "does
 * this user own THIS venue?". Ownership is a separate check; conflating the
 * two is a classic marketplace data leak.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
