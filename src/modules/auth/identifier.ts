export type Identifier =
  | { kind: 'phone'; value: string }
  | { kind: 'email'; value: string };

/**
 * Collapses the validated `{ phone } | { email }` body into one tagged value.
 * The schemas guarantee exactly one is set; the throw is a programmer-error
 * guard, not a client-facing path.
 */
export function toIdentifier(dto: { phone?: string; email?: string }): Identifier {
  if (dto.phone !== undefined) return { kind: 'phone', value: dto.phone };
  if (dto.email !== undefined) return { kind: 'email', value: dto.email };
  throw new Error('toIdentifier called without a phone or email');
}

/** Safe-for-logs form: enough to correlate, not enough to identify. */
export function maskIdentifier(id: Identifier): string {
  if (id.kind === 'phone') return `${id.value.slice(0, 3)}****${id.value.slice(-2)}`;
  const [local = '', domain = ''] = id.value.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
