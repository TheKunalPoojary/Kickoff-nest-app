import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.util.js';

describe('password.util', () => {
  it('round-trips a password through hash and verify', async () => {
    const hash = await hashPassword('correcthorsebatterystaple');
    expect(await verifyPassword(hash, 'correcthorsebatterystaple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correcthorsebatterystaple');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('salts each hash differently, even for the same password', async () => {
    const a = await hashPassword('correcthorsebatterystaple');
    const b = await hashPassword('correcthorsebatterystaple');
    expect(a).not.toBe(b);
  });
});
