import { describe, expect, it } from 'vitest';
import { buildTitleArtPrompt } from './shortsTitleArt';

describe('buildTitleArtPrompt', () => {
  it('2줄 카피 — 위계(1줄 라벨 작게·2줄 훅 크게)와 밑줄은 2줄 아래에만', () => {
    const p = buildTitleArtPrompt({ line1: '블루베리나무화분', line2: '라벨 확인', points: [] });
    expect(p).toContain("'블루베리나무화분'");
    expect(p).toContain("'라벨 확인'");
    expect(p).toContain('정확히 2줄');
    expect(p).toContain('크림 화이트');
    expect(p).toContain('노랑');
    expect(p).toContain('2줄(노랑 강조 줄) 아래에만');
    expect(p).toContain('1줄(크림 화이트 라벨 줄) 아래에는 절대 긋지 않는다');
    expect(p).toContain('납작한 가로형'); // 세로 팽창 억제 — 26% 박스 contain 축소 최소화
    expect(p).toContain('검은색');
    expect(p).toContain('글로우·후광·번짐·그림자·빛무리는 절대');
  });

  it('1줄 카피 — 단독 한 줄(노랑 구간 없음) + 기본 밑줄, 2줄 전용 지시 없음', () => {
    const p = buildTitleArtPrompt({ line1: '한여름 물주기', line2: '', points: [] });
    expect(p).toContain("'한여름 물주기'");
    expect(p).toContain('한 줄로 크게');
    expect(p).not.toContain('노랑');
    expect(p).toContain('제목 아래에 밑줄');
    expect(p).not.toContain('납작한 가로형');
  });
});
