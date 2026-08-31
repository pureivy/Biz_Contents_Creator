import { describe, it, expect } from 'vitest';
import { qaPublishBlockReason } from './cardnews';

// 실사고(2026-08-10): QA가 "슬라이드 5 미해결(오타 가능성)"을 로그로만 남기고 레코드에 기록하지 않아
// 발행 게이트가 알 길이 없었고, 오타 슬라이드("떨여집니다"·"쐬웁니다")가 인스타에 그대로 발행됐다.
// 미해결 플래그는 레코드(qaUnresolved)에 영속하고, 발행은 사용자 확인(force)이 있어야만 통과한다.
describe('qaPublishBlockReason — QA 미해결 발행 차단(순수)', () => {
  it('미해결 슬라이드가 있으면 발행 차단 사유를 돌려준다', () => {
    const r = qaPublishBlockReason({ qaUnresolved: [5] });
    expect(r).toBeTruthy();
    expect(r).toContain('5');
  });
  it('force(사용자 확인)면 미해결이어도 통과한다', () => {
    expect(qaPublishBlockReason({ qaUnresolved: [5] }, true)).toBeNull();
  });
  it('미해결이 없으면(빈 배열·미기록) 통과한다', () => {
    expect(qaPublishBlockReason({ qaUnresolved: [] })).toBeNull();
    expect(qaPublishBlockReason({})).toBeNull();
  });
  it('여러 장 미해결이면 전부 사유에 나열한다', () => {
    const r = qaPublishBlockReason({ qaUnresolved: [2, 5] });
    expect(r).toContain('2');
    expect(r).toContain('5');
  });
});
