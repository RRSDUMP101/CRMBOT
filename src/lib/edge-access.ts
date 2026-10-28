import { timingSafeEqual } from 'node:crypto';

export function validEdgeKey(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected || expected.length < 32) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
