import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalStore } from './store';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-'));
});

describe('ApprovalStore', () => {
  it('요청 → 승인 결정 → pending 비움', async () => {
    const s = new ApprovalStore(dir);
    const { approval, decided } = s.request({ action_type: 'publish', summary: 'x' }, 10_000);
    expect(s.list()).toHaveLength(1);
    expect(s.decide(approval.id, true, 'go')).toBe(true);
    const d = await decided;
    expect(d.approved).toBe(true);
    expect(d.by).toBe('user');
    expect(s.list()).toHaveLength(0);
  });

  it('거부 결정', async () => {
    const s = new ApprovalStore(dir);
    const { approval, decided } = s.request({ action_type: 'publish', summary: 'x' }, 10_000);
    s.decide(approval.id, false, '아니오');
    expect((await decided).approved).toBe(false);
  });

  it('타임아웃 → fail-open 자동승인', async () => {
    const s = new ApprovalStore(dir);
    const { decided } = s.request({ action_type: 'publish', summary: 'x' }, 30);
    const d = await decided;
    expect(d.approved).toBe(true);
    expect(d.by).toBe('timeout');
  });

  it('알 수 없는 id 결정 → false', () => {
    const s = new ApprovalStore(dir);
    expect(s.decide('apr_none', true)).toBe(false);
  });

  it('영속화 — pending 재로딩', () => {
    const s1 = new ApprovalStore(dir);
    const { approval } = s1.request({ action_type: 'publish', summary: 'x' }, 100_000);
    const s2 = new ApprovalStore(dir);
    expect(s2.list().map((a) => a.id)).toContain(approval.id);
  });
});
