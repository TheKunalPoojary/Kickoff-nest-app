import { randomInt } from 'node:crypto';

/**
 * Crockford-style alphabet: no I, L, O, U. Support staff read these codes over
 * the phone, and 0/O and 1/I are the classic mishearings.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateBookingCode(): string {
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `KO-${out}`;
}
