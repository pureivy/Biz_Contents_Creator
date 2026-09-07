import { describe, it, expect } from 'vitest';
import {
  SHORTS_PLATFORMS, platformLabel, platformPlanGuide, autoDailyCapFor,
  canPublishTo, kstDate, youtubeUploadsToday, youtubeDailyCapBlock, platformQuotaCommitted, autoCapApplies } from './shortsPlatform';

describe('platformPlanGuide — 채널별로 다른 대본이 나오게 하는 지침(순수)', () => {
  it('유튜브·인스타 지침이 서로 다르다', () => {
    const yt = platformPlanGuide('youtube');
    const ig = platformPlanGuide('instagram');
    expect(yt).not.toBe(ig);
    expect(yt.length).toBeGreaterThan(50);
    expect(ig.length).toBeGreaterThan(50);
  });
  it('유튜브는 검색·완결을 지시하고 예고로 결론을 대체하지 말라고 못박는다', () => {
    const yt = platformPlanGuide('youtube');
    expect(yt).toContain('검색');
    expect(yt).toContain('다음 편');
  });
  it('인스타는 훅 길이와 판단 장면을 지시한다', () => {
    const ig = platformPlanGuide('instagram');
    expect(ig).toContain('24자');
    expect(ig).toContain('판단 장면');
  });
  it('레거시(미지정)는 빈 문자열 — 종전 동작 그대로', () => {
    expect(platformPlanGuide(undefined)).toBe('');
  });
});


describe('canPublishTo — 채널 발행 게이트(순수)', () => {
  it('자기 채널에만 올릴 수 있다', () => {
    expect(canPublishTo('youtube', 'youtube')).toBe(true);
    expect(canPublishTo('youtube', 'instagram')).toBe(false);
    expect(canPublishTo('instagram', 'instagram')).toBe(true);
    expect(canPublishTo('instagram', 'youtube')).toBe(false);
  });
  it('레거시(미지정)는 양쪽 허용 — 기존 108편의 재발행 경로를 막지 않는다', () => {
    expect(canPublishTo(undefined, 'youtube')).toBe(true);
    expect(canPublishTo(undefined, 'instagram')).toBe(true);
  });
});

describe('youtubeUploadsToday·youtubeDailyCapBlock — 하루 1편 상한(순수)', () => {
  // 2026-09-03 09:00 KST = 2026-09-03T00:00:00Z
  const now = Date.parse('2026-09-03T00:00:00Z');
  it('KST 날짜로 센다 — UTC 로 세면 저녁 업로드가 다음 날로 밀린다', () => {
    // 2026-09-02 20:03 KST = 2026-09-02T11:03Z
    expect(kstDate(Date.parse('2026-09-02T11:03:00Z'))).toBe('2026-09-02');
    // 2026-09-03 06:44 KST = 2026-09-02T21:44Z — UTC 로는 전날이지만 KST 로는 당일
    expect(kstDate(Date.parse('2026-09-02T21:44:00Z'))).toBe('2026-09-03');
  });
  it('오늘 업로드분만 센다', () => {
    const list = [
      { youtubeTs: '2026-09-02T21:44:00Z' }, // 09-03 06:44 KST — 오늘
      { youtubeTs: '2026-09-02T11:03:00Z' }, // 09-02 20:03 KST — 어제
      { youtubeTs: undefined },              // 미업로드
    ];
    expect(youtubeUploadsToday(list, now)).toBe(1);
  });
  it('상한에 닿으면 사유를 돌려준다', () => {
    const list = [{ youtubeTs: '2026-09-02T21:44:00Z' }];
    const msg = youtubeDailyCapBlock(list, now, 1);
    expect(msg).toContain('1/1편');
    expect(msg).toContain('2026-09-03');
  });
  it('상한 미달이면 null(통과)', () => {
    expect(youtubeDailyCapBlock([], now, 1)).toBeNull();
    expect(youtubeDailyCapBlock([{ youtubeTs: '2026-09-02T11:03:00Z' }], now, 1)).toBeNull();
  });
  it('cap 0 이하는 상한 없음 — 끄는 스위치', () => {
    const list = [{ youtubeTs: '2026-09-02T21:44:00Z' }, { youtubeTs: '2026-09-02T22:00:00Z' }];
    expect(youtubeDailyCapBlock(list, now, 0)).toBeNull();
    expect(youtubeDailyCapBlock(list, now, -1)).toBeNull();
  });
  it('깨진 타임스탬프는 세지 않는다', () => {
    expect(youtubeUploadsToday([{ youtubeTs: 'not-a-date' }], now)).toBe(0);
  });
});

describe('상수·표기', () => {
  it('채널은 유튜브·인스타 둘', () => { expect([...SHORTS_PLATFORMS]).toEqual(['youtube', 'instagram']); });
  it('사람이 읽는 이름', () => {
    expect(platformLabel('youtube')).toBe('유튜브');
    expect(platformLabel('instagram')).toBe('인스타');
    expect(platformLabel(undefined)).toBe('공용');
  });
});

describe('platformQuotaCommitted — 자율런 채널별 생성 상한(순수)', () => {
  const now = Date.parse('2026-09-03T00:00:00Z'); // 09-03 09:00 KST
  const yTs = '2026-09-02T21:44:00Z'; // 09-03 06:44 KST

  it('오늘 이미 유튜브에 올렸으면 유튜브 몫이 찼다', () => {
    expect(platformQuotaCommitted([{ youtubeTs: yTs }], now, 1, 'youtube')).toBe(true);
  });
  it('오늘 만든 미발행 편도 그 채널 몫을 잡는다 — 만들어 놓고 못 올리는 낭비 방지', () => {
    expect(platformQuotaCommitted([{ platform: 'youtube', stage: 'planning', createdTs: yTs }], now, 1, 'youtube')).toBe(true);
  });
  it('인스타도 같은 상한을 받는다(2026-09-03 — 종전엔 유튜브만 막혔다)', () => {
    expect(platformQuotaCommitted([{ platform: 'instagram', stage: 'ready', createdTs: yTs }], now, 1, 'instagram')).toBe(true);
  });
  it('채널이 다르면 서로 몫을 안 잡는다', () => {
    const list = [{ platform: 'instagram' as const, stage: 'ready', createdTs: yTs }];
    expect(platformQuotaCommitted(list, now, 1, 'youtube')).toBe(false);
    expect(platformQuotaCommitted(list, now, 1, 'instagram')).toBe(true);
  });
  it('유튜브 업로드는 인스타 몫을 잡지 않는다', () => {
    expect(platformQuotaCommitted([{ youtubeTs: yTs }], now, 1, 'instagram')).toBe(false);
  });
  it('실패분은 몫을 잡지 않는다', () => {
    expect(platformQuotaCommitted([{ platform: 'youtube', stage: 'error', createdTs: yTs }], now, 1, 'youtube')).toBe(false);
  });
  it('어제 것은 세지 않는다', () => {
    expect(platformQuotaCommitted([{ platform: 'youtube', stage: 'ready', createdTs: '2026-09-02T01:00:00Z' }], now, 1, 'youtube')).toBe(false);
  });
  it('cap 0 이하는 상한 없음', () => {
    expect(platformQuotaCommitted([{ youtubeTs: yTs }], now, 0, 'youtube')).toBe(false);
  });
  it('상한 2 면 두 편까지', () => {
    const one = [{ platform: 'instagram' as const, stage: 'ready', createdTs: yTs }];
    expect(platformQuotaCommitted(one, now, 2, 'instagram')).toBe(false);
    expect(platformQuotaCommitted([...one, ...one], now, 2, 'instagram')).toBe(true);
  });
});



describe('autoDailyCapFor — 채널별 자율런 상한', () => {
  const caps = { youtube: 1, instagram: 2 };
  it('채널마다 다른 값을 준다', () => {
    expect(autoDailyCapFor('youtube', caps)).toBe(1);
    expect(autoDailyCapFor('instagram', caps)).toBe(2);
  });
  it('레거시(채널 미지정)는 유튜브 값 — 보수적으로 조인다', () => {
    expect(autoDailyCapFor(undefined, caps)).toBe(1);
  });
  it('상한이 실제로 갈린다 — 인스타 1편 만든 뒤에도 인스타 몫이 남는다', () => {
    const now = Date.parse('2026-09-03T00:00:00Z');
    const made = [{ platform: 'instagram' as const, stage: 'ready', createdTs: '2026-09-02T21:44:00Z' }];
    expect(platformQuotaCommitted(made, now, autoDailyCapFor('instagram', caps), 'instagram')).toBe(false);
    // 같은 상황에서 유튜브 상한(1)이었다면 찼을 것
    expect(platformQuotaCommitted(made, now, autoDailyCapFor('youtube', caps), 'instagram')).toBe(true);
  });
});

describe('autoCapApplies — 상한을 걸 대상 판정(순수)', () => {
  it('스케줄러가 알아서 돈 글에는 건다', () => {
    expect(autoCapApplies({ auto: true })).toBe(true);
  });
  it('사용자가 주제를 넣어 돌린 글에는 안 건다', () => {
    expect(autoCapApplies({})).toBe(false);
    expect(autoCapApplies({ auto: false })).toBe(false);
  });
  it('사용자가 "오토런 지시"로 시작한 글에는 안 건다 — 손으로 시킨 일이다', () => {
    expect(autoCapApplies({ auto: true, userTriggered: true })).toBe(false);
  });
  it('출처를 모르면 건다 — 모르는 것을 무제한으로 열지 않는다', () => {
    expect(autoCapApplies(undefined)).toBe(true);
  });
  it('케이던스 기준선과 같은 기준을 쓴다 — auto && !userTriggered', () => {
    const cases = [
      { auto: true, userTriggered: false },
      { auto: true, userTriggered: true },
      { auto: false, userTriggered: false },
      { auto: false, userTriggered: true },
    ];
    // cadenceBaselineTs 는 `p.auto && !p.userTriggered` 인 것만 자율 생산분으로 센다.
    for (const c of cases) expect(autoCapApplies(c)).toBe(!!c.auto && !c.userTriggered);
  });
});
