import { describe, it, expect } from 'vitest';
import { partitionVerified, restoreVerified } from './verifiedCleanup';

describe('partitionVerified — 소급 정리(거절 규칙만 적용, 원장 없음)', () => {
  it('거절 줄은 archive, 나머지는 keep, 형식 안 맞는 줄은 keep', () => {
    const text = [
      '- (2026-08-25) 4월 하순부터 약충이 깨어난다 _(근거: 농사로 curationNo=1964)_',
      '- (2026-08-25) | 보조3 | 올리브나무 키우기 | ⚠️ 미실측 _(근거: 검색어트렌드(데이터랩))_',
      '- (2026-08-25) 처서 이후 시비 _(근거: 동일)_',
      '- (2026-08-25) 출처 없음 전례 _(근거: 위키 「폭염 회복 가이드 · 비평(bd370ecc)」 S-2)_',
      '## 머리말',
    ].join('\n');
    const r = partitionVerified(text);
    expect(r.keep).toEqual(['- (2026-08-25) 4월 하순부터 약충이 깨어난다 _(근거: 농사로 curationNo=1964)_', '## 머리말']);
    expect(r.archive).toHaveLength(3);
  });
});

describe('restoreVerified — 규칙 좁힘 후 재통과 줄만 복원, 헤더·여전히 거절되는 줄은 잔류', () => {
  it('가정·미확인 토큰 좁힘으로 지금은 통과하는 줄만 restore, 나머지·헤더는 stay', () => {
    const text = [
      '## 2026-08-25 소급 정리(근거 규칙 미달)',
      '- (2026-08-25) 실내·가정 맥락을 제목에 명시 _(근거: 네이버 블로그 SERP "올리브나무 물주기")_',
      '- (2026-08-25) 처서 이후 시비 _(근거: 동일)_',
      '',
    ].join('\n');
    const r = restoreVerified(text);
    expect(r.restore).toEqual(['- (2026-08-25) 실내·가정 맥락을 제목에 명시 _(근거: 네이버 블로그 SERP "올리브나무 물주기")_']);
    expect(r.stay).toEqual(['## 2026-08-25 소급 정리(근거 규칙 미달)', '- (2026-08-25) 처서 이후 시비 _(근거: 동일)_', '']);
  });
});
