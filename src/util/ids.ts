import { randomUUID } from 'node:crypto';

/** 짧은 식별자 — prefix_xxxxxxxx. */
export function genId(prefix = 'id'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export function runId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}
