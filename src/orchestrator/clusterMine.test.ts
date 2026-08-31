import { describe, it, expect } from 'vitest';
import { filterCandidates } from './clusterMine';

const existing = [
  { title: '추희자두 특징과 키우는 법', keyword: '추희자두', kind: '블로그' as const },      // 시드 편
  { title: '추희자두 묘목, 늦게 익는 나무를 심는다는 것', keyword: '추희자두 묘목', kind: '블로그' as const }, // 기발행
];

describe('filterCandidates — 채굴 코드 게이트', () => {
  it('시드 편 자신과의 유사는 무시하고, 다른 기발행 글과의 충돌은 기각한다(실측 시나리오)', () => {
    const { pass, rejected } = filterCandidates(
      ['추희자두 수확시기', '추희자두 묘목', '추희자두 후숙'],
      '추희자두', '추희자두 특징과 키우는 법', existing,
    );
    expect(pass).toContain('추희자두 수확시기');   // 시드와만 유사 — 계획된 갈래
    expect(pass).toContain('추희자두 후숙');
    expect(pass).not.toContain('추희자두 묘목');   // 기발행 글과 충돌 — 진짜 중복
    expect(rejected.find((r) => r.kw === '추희자두 묘목')?.why).toContain('중복');
  });

  it('시드 표기 동치(공백 차이)는 기각', () => {
    const { pass } = filterCandidates(['추희 자두'], '추희자두', '추희자두 특징과 키우는 법', existing);
    expect(pass).toHaveLength(0);
  });

  it('브랜드 밖 소재는 기각(offBrandTerm 게이트 — 활성 브랜드 없으면 통과)', () => {
    // offBrandTerm 은 활성 브랜드 프로필 기준 — 테스트 환경(브랜드 미설정)에선 null 반환이 정상.
    const { pass } = filterCandidates(['추희자두 병충해'], '추희자두', '추희자두 특징과 키우는 법', []);
    expect(pass).toContain('추희자두 병충해');
  });

  // 실측 2026-08-06(배롱나무 스모크): 파생 카드뉴스의 keyword 가 시드와 동일("배롱나무")이라, 시드를
  // 포함하는 모든 형제가 포함 규칙(배롱나무 ⊂ 배롱나무꽃)에 걸려 전 후보가 기각됐다. 시드 '편'만이
  // 아니라 시드 키워드를 쓰는 콘텐츠 가족 전체가 문제 — 가족은 차별화 부분(diff)으로만 대조한다.
  describe('시드 키워드 가족(파생·동일 키워드 콘텐츠) 대조', () => {
    const family = [
      { title: '배롱나무 심기, 자리 폭과 햇빛부터 정해야 하는 이유', keyword: '배롱나무', kind: '블로그' as const },   // 시드 편
      { title: '배롱나무 여름철 관리, 놓치면 안 되는 실수 3가지', keyword: '배롱나무', kind: '카드뉴스' as const },      // 파생(시드 키워드)
      { title: '배롱나무 심기 전 확인해야 할 자리 선택 3가지', keyword: '배롱나무', kind: '블로그' as const },          // 동일 키워드 다른 글
      { title: '배롱나무 꽃 안 피는 이유, 네 가지 원인과 해결법', keyword: '배롱나무 꽃 안 피는 이유', kind: '블로그' as const },
    ];

    it('시드 가족과의 단순 포함은 무시 — "배롱나무 개화시기"는 통과한다', () => {
      const { pass } = filterCandidates(['배롱나무 개화시기'], '배롱나무', '배롱나무 심기, 자리 폭과 햇빛부터 정해야 하는 이유', family);
      expect(pass).toContain('배롱나무 개화시기');
    });

    it('가족 글 제목에 차별화 부분이 들어 있으면 진짜 중복 — "배롱나무 심기"는 기각', () => {
      const { pass, rejected } = filterCandidates(['배롱나무 심기'], '배롱나무', '배롱나무 심기, 자리 폭과 햇빛부터 정해야 하는 이유', family);
      expect(pass).toHaveLength(0);
      expect(rejected[0]?.why).toContain('중복');
    });

    it('가족 밖 콘텐츠와의 충돌은 종전대로 기각 — "배롱나무 꽃"은 꽃 안 피는 이유 글과 중복', () => {
      const { pass } = filterCandidates(['배롱나무 꽃'], '배롱나무', '배롱나무 심기, 자리 폭과 햇빛부터 정해야 하는 이유', family);
      expect(pass).toHaveLength(0);
    });
  });
});
