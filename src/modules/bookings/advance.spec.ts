import { describe, expect, it } from 'vitest';
import { computeAdvance } from './advance.js';

describe('computeAdvance', () => {
  it('is the full price at 100%', () => {
    expect(computeAdvance(90_000, 100)).toBe(90_000);
  });

  it('takes the configured share', () => {
    expect(computeAdvance(90_000, 30)).toBe(27_000);
  });

  it('rounds up so a hold is never free', () => {
    expect(computeAdvance(1, 1)).toBe(1);
    expect(computeAdvance(333, 10)).toBe(34);
  });

  it('is zero for a free booking', () => {
    expect(computeAdvance(0, 30)).toBe(0);
  });
});
