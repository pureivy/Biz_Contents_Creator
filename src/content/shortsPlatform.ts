/**
 * 숏폼 플랫폼 분리 — 유튜브 쇼츠와 인스타 릴스를 대본부터 따로 만들기 위한 순수 규칙.
 *
 * 왜: 2026-09-02 저녁부터 유튜브 신작 4편 연속 조회 0~5회(구작 꼬리·인스타는 정상). 같은 파일을
 * 양 채널에 그대로 올리고, 108편이 같은 템플릿·같은 훅 공식이었다. 유튜브 대량생산·비진정성 정책이
 * 예시로 드는 형태와 겹친다. 채널별로 다른 물건을 만들어 그 지문을 지운다(사용자 확정 2026-09-03).
 *
 * 두 채널은 소비 방식 자체가 다르다 — 이 파일의 지침은 전부 이 프로젝트 실측에 근거한다:
 *  · 유튜브: 조회의 86~91%가 Shorts 피드, 검색 유입이 하루 200~340회로 실재. 시청 지속률 중앙 75%
 *    (반복 재생 편은 185%)로 '보기 시작하면 끝까지 본다'. 즉 훅보다 완결성·검색어 적합이 남은 레버다.
 *  · 인스타: 도달의 99.5%가 비팔로워 추천. 소재별 릴스 중앙값이 전정·가지치기 5,464 > 꽃·개화 2,185 >
 *    열매·수확 1,006 ≈ 전체 862. 화분·실내 프레임은 525로 최하위. 손·도구가 보이는 '판단 장면'이 강하다.
 */

export type ShortsPlatform = 'youtube' | 'instagram';

export const SHORTS_PLATFORMS: readonly ShortsPlatform[] = ['youtube', 'instagram'] as const;

/** 사람이 읽는 이름(로그·알림). */
export function platformLabel(p: ShortsPlatform | undefined): string {
  return p === 'youtube' ? '유튜브' : p === 'instagram' ? '인스타' : '공용';
}

/**
 * 기획 프롬프트에 주입할 채널 지침(순수) — 같은 원문에서 서로 다른 대본이 나오게 하는 핵심.
 * 레거시(platform 미지정, 2026-09-03 이전 108편)는 빈 문자열 — 종전 동작 그대로.
 */
export function platformPlanGuide(platform: ShortsPlatform | undefined): string {
  if (platform === 'youtube') {
    return [
      '[채널: 유튜브 쇼츠] 이 대본은 유튜브 전용이다. 인스타용과 같은 구성을 쓰지 마라.',
      '· 검색해서 들어온 사람에게 답하는 글처럼 짜라. 제목은 사람들이 실제로 검색창에 치는 말에 가깝게(소재명+행동/시기).',
      '· 한 편에서 질문을 끝내라. "다음 편에 이어갈게요" 같은 예고로 결론을 대체하지 마라 — 마지막 씬은 판정 또는 행동 지시로 닫는다.',
      '· 첫 씬에서 무엇을 알려줄지 먼저 밝혀라(결론 예고). 궁금증만 걸고 미루지 마라.',
      '· 화면 텍스트는 소리 없이 봐도 뜻이 통하게. 자막이 곧 본문이다.',
    ].join('\n');
  }
  if (platform === 'instagram') {
    return [
      '[채널: 인스타 릴스] 이 대본은 인스타 전용이다. 유튜브용과 같은 구성을 쓰지 마라.',
      '· 검색이 아니라 스크롤 중에 걸리는 사람에게 말한다. 첫 문장은 24자 이내, 3초 안에 끝나게.',
      '· 손과 도구가 보이는 "판단 장면"을 중심에 둬라 — 어디를 자를지, 무엇을 남길지 같은 결정 순간.',
      '  (실측: 전정·가지치기 소재 중앙 5,464회 vs 계정 전체 862회. 화분·실내 프레임은 525회로 최하위)',
      '· 저장하고 싶게 만들어라. 순서·기준·숫자처럼 나중에 다시 볼 값을 화면에 남긴다.',
      '· 마지막은 예고가 아니라 한 줄 요약으로 닫는다.',
    ].join('\n');
  }
  return '';
}

// platformSceneCount 폐기(2026-09-03) — 인스타를 한 씬 짧게 끊던 장치. 근거는 "채널별로 다른
// 영상이어야 중복으로 안 찍힌다"였는데 유튜브는 인스타를 볼 수 없어 그 전제가 성립하지 않았다.
// 게다가 대본을 공유하는 구조에서는 씬을 하나 빼는 안전한 방법이 없다 — 뒤에서 자르면 CTA 결론
// 카드가 날아가고, 본문에서 빼면 "질문 씬의 답은 다음 씬 첫 문장"이라는 자체 규칙이 깨진다.

/**
 * 이 숏폼을 해당 채널에 올릴 수 있는가(순수).
 * platform 미지정 = 레거시 레코드 → 양 채널 허용(기존 108편의 재발행·보강 경로를 막지 않는다).
 */
export function canPublishTo(shortPlatform: ShortsPlatform | undefined, target: ShortsPlatform): boolean {
  return !shortPlatform || shortPlatform === target;
}

/** KST 날짜(YYYY-MM-DD, 순수) — 하루 상한은 사용자 체감 기준인 한국 날짜로 센다. */
export function kstDate(ms: number): string {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 오늘(KST) 이미 유튜브에 올라간 편수(순수). */
export function youtubeUploadsToday(
  uploads: ReadonlyArray<{ youtubeTs?: string }>, now: number,
): number {
  const today = kstDate(now);
  return uploads.filter((s) => {
    if (!s.youtubeTs) return false;
    const t = Date.parse(s.youtubeTs);
    return Number.isFinite(t) && kstDate(t) === today;
  }).length;
}

/**
 * 유튜브 하루 상한에 걸렸는가(순수) — 걸리면 사람이 읽을 사유, 아니면 null.
 * cap<=0 은 상한 없음(끄기)으로 본다.
 */
export function youtubeDailyCapBlock(
  uploads: ReadonlyArray<{ youtubeTs?: string }>, now: number, cap: number,
): string | null {
  if (cap <= 0) return null;
  const used = youtubeUploadsToday(uploads, now);
  if (used < cap) return null;
  return `오늘(${kstDate(now)}) 유튜브 업로드 ${used}/${cap}편 — 하루 상한에 걸렸습니다. 내일 올리거나 상한(YOUTUBE_DAILY_CAP)을 조정하세요.`;
}

/** 채널별 자율런 하루 상한 조회(순수) — 미지의 채널은 유튜브 값으로 본다(보수적). */
export function autoDailyCapFor(
  platform: ShortsPlatform | undefined, caps: { youtube: number; instagram: number },
): number {
  return platform === 'instagram' ? caps.instagram : caps.youtube;
}

/**
 * 이 글에서 나온 파생에 자율런 상한을 걸어야 하는가(순수).
 *
 * 상한은 "스케줄러가 알아서 돈 것"에만 건다(사용자 확정 2026-09-04). 사용자가 주제를 넣어
 * 직접 돌린 글도, 사용자가 "오토런 지시" 버튼을 눌러 시작한 글도 상한 밖이다 — 손으로 시킨
 * 일까지 막으면 도구가 아니라 방해가 된다.
 *
 * 종전엔 파생 시점(autoDeriveSet)이 이 구분을 안 봤다. 그래서 사용자가 직접 돌린 사계장미
 * 글의 숏폼이 그날 자율런이 채운 몫 때문에 통째로 누락됐다(실측 2026-09-04). 상한을 안 보는
 * 건 "숏폼 버튼을 직접 누른 경우"뿐이었다.
 *
 * 판정 기준은 케이던스 기준선(cadenceBaselineTs)과 같다 — `auto && !userTriggered`.
 * 두 곳이 다른 기준을 쓰면 "무엇이 자율 생산분인가"가 코드마다 달라진다.
 * 출처를 모르면 상한을 건다(보수적) — 모르는 것을 무제한으로 열어 두지 않는다.
 */
export function autoCapApplies(source: { auto?: boolean; userTriggered?: boolean } | undefined): boolean {
  if (!source) return true;
  return source.auto === true && source.userTriggered !== true;
}

/**
 * 오늘(KST) 이 채널의 자율런 몫이 이미 찼는가(순수) — '자동' 생성 게이트.
 *
 * 적용 범위가 중요하다. 이건 스케줄러가 알아서 도는 자율런에만 건다. 사용자가 직접 지시한 생성은
 * 상한을 보지 않는다(사용자 확정 2026-09-03) — 손으로 시킨 일까지 막으면 도구가 아니라 방해가 된다.
 * 코드로는 autoDeriveSet(자율)과 shortsFromPieceHandler(수동)가 갈라져 있고, 이 함수는 전자에서만 불린다.
 *
 * 발행만 막으면 하루 2~3편이 만들어지고 1편만 올라가 나머지는 버려진다(LLM·이미지 비용). 그래서
 * 파생 시점에도 같은 상한을 본다. '찼다'의 기준은 두 가지 합:
 *  · 오늘 이미 업로드된 편(유튜브는 youtubeTs, 인스타는 igReelId 보유분)
 *  · 오늘 만들어졌고 아직 안 올라간 그 채널 편(실패분 제외 — 실패는 몫을 잡지 않는다)
 */
export function platformQuotaCommitted(
  list: ReadonlyArray<{ platform?: ShortsPlatform; stage?: string; createdTs?: string; youtubeTs?: string; igReelId?: string }>,
  now: number, cap: number, platform: ShortsPlatform,
): boolean {
  if (cap <= 0) return false;
  const today = kstDate(now);
  const onToday = (ts: string | undefined): boolean => {
    if (!ts) return false;
    const t = Date.parse(ts);
    return Number.isFinite(t) && kstDate(t) === today;
  };
  const used = list.filter((s) => {
    if (platform === 'youtube' && onToday(s.youtubeTs)) return true; // 이미 올라감 — 업로드 자체가 몫
    if (s.platform !== platform || s.stage === 'error') return false;
    return onToday(s.createdTs);
  }).length;
  return used >= cap;
}

// shouldStartSecondRun / SIBLING_PLAN_WAIT_MS 폐기(2026-09-03) — 두 번째 채널이 첫 채널의
// '대본'을 보고 각도를 피해 출발하게 하던 장치. 이제 대본을 공유하므로 피할 대상이 없다.
// 형제편 출발은 원편의 '완성'을 기다린다(server/main.ts startAfterPrimary).
