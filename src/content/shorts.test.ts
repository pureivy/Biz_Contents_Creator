import { describe, it, expect } from 'vitest';
import { shortsQaPublishBlockReason } from './shorts';

describe('shortsQaPublishBlockReason — 썸네일 QA 발행 게이트', () => {
  it('QA 통과면 막지 않는다', () => {
    expect(shortsQaPublishBlockReason(false)).toBeNull();
  });
  it('QA 미해결이면 막는다', () => {
    const r = shortsQaPublishBlockReason(true);
    expect(r).toBeTruthy();
    expect(r).toContain('썸네일');
  });
  it('force 면 통과 — 사람이 보고 확정한 경우', () => {
    expect(shortsQaPublishBlockReason(true, true)).toBeNull();
  });
  it('force 는 QA 통과 상태를 바꾸지 않는다', () => {
    expect(shortsQaPublishBlockReason(false, true)).toBeNull();
  });
});
