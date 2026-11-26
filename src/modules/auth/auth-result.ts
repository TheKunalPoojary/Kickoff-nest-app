import type { TokenPair } from './token.service.js';

export type AuthResult = TokenPair & {
  user: {
    id: string;
    email: string | null;
    phone: string | null;
    name: string | null;
    role: string;
    /**
     * Lets the client decide after an OTP sign-in whether to send the user to
     * "create a password" — and to offer password login next time.
     */
    hasPassword: boolean;
  };
};

export function authUser(user: {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  role: string;
  passwordHash: string | null;
}): AuthResult['user'] {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    role: user.role,
    hasPassword: user.passwordHash !== null,
  };
}
