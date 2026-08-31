/**
 * 성과 대시보드 '수집 불가' 칩 판정 — performanceHandler 가 그대로 쓰는 함수를 직접 검증.
 * 이 상태는 드물게(비공개·삭제·기한 경과) 나타나 실데이터로는 거의 안 밟히므로, 회귀는 여기서 잡는다.
 */
import { describe, it, expect } from 'vitest';
import { shortsPerfStale, shortsMetaPerfStale } from './shortsPerf';
import { cardnewsPerfStale } from './cardnewsPerf';

const NOW = 1_785_000_000_000;
const DAYS = 7; // CONFIG.shortsPerfDays 기본값 — 포기 지평은 그 4배(28일)
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('shortsPerfStale — 유튜브 쇼츠', () => {
  it('포기 지평(28일) 경과 + 미반영 → 수집 불가 (삭제·영구 비공개 영상)', () => {
    expect(shortsPerfStale({ youtubeId: 'x', youtubeTs: ago(30), perfReflected: false }, NOW, DAYS)).toBe(true);
  });

  it('측정창 안 미반영 → 수집 불가 아님 (정상 대기 = 측정 중)', () => {
    expect(shortsPerfStale({ youtubeId: 'x', youtubeTs: ago(3), perfReflected: false }, NOW, DAYS)).toBe(false);
  });

  it('창은 지났지만 지평 전 미반영 → 수집 불가 아님 (아직 수집 재시도 중)', () => {
    expect(shortsPerfStale({ youtubeId: 'x', youtubeTs: ago(17), perfReflected: false }, NOW, DAYS)).toBe(false);
  });

  it('이미 반영됨 → 지평을 한참 넘겨도 수집 불가 아님 (✓ 반영 유지)', () => {
    expect(shortsPerfStale({ youtubeId: 'x', youtubeTs: ago(400), perfReflected: true }, NOW, DAYS)).toBe(false);
  });

  it('업로드 시각은 있는데 영상 id 가 없음 → 즉시 수집 불가 (영원히 조회 불가)', () => {
    expect(shortsPerfStale({ youtubeId: '', youtubeTs: ago(1), perfReflected: false }, NOW, DAYS)).toBe(true);
  });

  it('업로드된 적 없음 → 수집 불가 (행 자체가 안 그려지지만 판정은 안전측)', () => {
    expect(shortsPerfStale({ youtubeId: '', youtubeTs: undefined, perfReflected: false }, NOW, DAYS)).toBe(true);
  });

  it('업로드 시각이 깨진 문자열 → 수집 불가 (무한 재시도 방지)', () => {
    expect(shortsPerfStale({ youtubeId: 'x', youtubeTs: 'not-a-date', perfReflected: false }, NOW, DAYS)).toBe(true);
  });
});

describe('shortsMetaPerfStale — 인스타 릴스 (유튜브와 독립 판정)', () => {
  it('지평 경과 미반영 → 수집 불가', () => {
    expect(shortsMetaPerfStale({ igReelId: 'r', metaPublishedTs: ago(30), metaPerfReflected: false }, NOW, DAYS)).toBe(true);
  });

  it('창 안 미반영 → 수집 불가 아님', () => {
    expect(shortsMetaPerfStale({ igReelId: 'r', metaPublishedTs: ago(3), metaPerfReflected: false }, NOW, DAYS)).toBe(false);
  });

  it('유튜브가 죽어도 릴스 판정은 오염되지 않는다 (채널별 독립 플래그)', () => {
    const s = {
      youtubeId: 'x', youtubeTs: ago(30), perfReflected: false,   // 유튜브는 수집 불가
      igReelId: 'r', metaPublishedTs: ago(2), metaPerfReflected: false, // 릴스는 정상 대기
    };
    expect(shortsPerfStale(s, NOW, DAYS)).toBe(true);
    expect(shortsMetaPerfStale(s, NOW, DAYS)).toBe(false);
  });
});

describe('cardnewsPerfStale — 카드뉴스', () => {
  it('지평 경과 미반영 → 수집 불가 (삭제된 IG 게시물)', () => {
    expect(cardnewsPerfStale({ igMediaId: 'm', publishedTs: ago(30), perfReflected: false }, NOW, DAYS)).toBe(true);
  });

  it('창 안 미반영 → 수집 불가 아님', () => {
    expect(cardnewsPerfStale({ igMediaId: 'm', publishedTs: ago(3), perfReflected: false }, NOW, DAYS)).toBe(false);
  });

  it('반영 완료 → 수집 불가 아님', () => {
    expect(cardnewsPerfStale({ igMediaId: 'm', publishedTs: ago(90), perfReflected: true }, NOW, DAYS)).toBe(false);
  });
});

describe('경계 — 지평 정확히 4배', () => {
  it('지평 직전(27.9일)은 아직 수집 대상, 직후(28.1일)부터 수집 불가', () => {
    expect(shortsPerfStale({ youtubeId: 'x', youtubeTs: ago(27.9), perfReflected: false }, NOW, DAYS)).toBe(false);
    expect(shortsPerfStale({ youtubeId: 'x', youtubeTs: ago(28.1), perfReflected: false }, NOW, DAYS)).toBe(true);
  });
});
