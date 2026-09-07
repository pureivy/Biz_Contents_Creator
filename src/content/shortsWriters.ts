/**
 * 숏폼 작가 3인 — 편마다 다른 작가가 쓰고, 작가마다 다른 목소리로 읽는다(2026-09-03).
 *
 * id 는 company.yaml 의 역할 id 와 같다. 오피스·직원 화면·티커가 전부 역할 로스터를 읽기 때문에,
 * 층위를 나누면(코드 페르소나 vs 역할) 새 작가가 어디에도 안 보인다(사용자 제보 2026-09-03).
 * 집필 규칙은 각 역할의 system_prompt 에 있고(같은 base + 각자 문체 블록), 이 파일은 그 역할이
 * 어떤 목소리로 읽히는지와 배정 규칙만 담는다.
 *
 * 왜: 148편이 전부 같은 작가(유하린)·같은 목소리(Jisoo)·같은 문체였다. 채널 지문의 큰 축이다.
 * 유튜브 대량생산 판정을 피하는 실질은 '결과물이 매번 다른 것'이고, 작가를 나누면 문체·훅·마무리와
 * 목소리가 한꺼번에 갈린다(목소리만 바꾸면 대본은 그대로라 절반만 갈린다).
 *
 * 목소리는 일레븐랩스 계정에 실재하는 한국어 보이스 id 여야 한다(2026-09-03 /v1/voices 조회로 확정한 값).
 * 다른 계정·다른 브랜드로 옮기면 그 계정의 /v1/voices 로 voiceId 를 바꿔라 — 없는 id 는 TTS 가 폴백한다.
 * 개인 복제 보이스는 쓰지 않는다.
 */

export interface ShortsWriter {
  id: string;
  /** 화면·기록에 노출되는 이름(people.yaml 의 shorts_writer 와 같은 층위). */
  name: string;
  /** 일레븐랩스 voice_id — 이 작가의 편은 이 목소리로 낭독된다. */
  voiceId: string;
  /** 참고용 보이스 설명(사람이 읽는 메모 — 코드 동작에는 영향 없음). */
  voiceNote: string;
  /**
   * 일레븐랩스 voice_settings — 작가별로 안정성·표현을 달리해 같은 문장도 다르게 읽히게 한다.
   * stability 낮을수록 표현 폭이 크고, 높을수록 또박또박해진다.
   */
  voiceSettings: { stability: number; similarity_boost: number; style?: number };
  /** 기획 프롬프트에 주입할 문체 지침 — 이게 대본을 실제로 가른다. */
  styleGuide: string;
}

export const SHORTS_WRITERS: readonly ShortsWriter[] = [
  {
    id: 'shorts_writer',
    name: '유하린',
    voiceId: 'iWLjl1zCuqXRkW6494ve',
    voiceNote: 'Jisoo — 여성·젊은 톤·또렷함(종전 전 편이 쓰던 목소리)',
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
    styleGuide: [
      '[작가: 유하린 — 실무 안내형]',
      '· 절차와 확인 순서로 말한다. "먼저 ~를 보고, 그다음 ~를 정해요" 같은 골격.',
      '· 문장은 짧고 단정하게. 군더더기 부사를 쓰지 않는다.',
      '· 숫자와 기준을 화면에 남긴다(며칠·몇 미터·몇 번).',
    ].join('\n'),
  },
  {
    id: 'shorts_writer_b',
    name: '임태윤',
    voiceId: 'm3gJBS8OofDJfycyA2Ip',
    voiceNote: 'Taehyung — 남성·젊은 톤·친근한 소셜 화법',
    voiceSettings: { stability: 0.35, similarity_boost: 0.7, style: 0.35 },
    styleGuide: [
      '[작가: 임태윤 — 대화형]',
      '· 듣는 사람에게 말을 건다. 묻고 바로 답하는 리듬으로 쓴다.',
      '· 종결을 "~죠", "~더라고요", "~거든요"로 섞는다. "~입니다"만 반복하지 않는다.',
      '· 흔한 오해를 먼저 집고("이거 다들 그렇게 알고 있잖아요") 뒤집는다.',
    ].join('\n'),
  },
  {
    id: 'shorts_writer_c',
    name: '곽재현',
    voiceId: 'H9ihk5yaEtJLXjhBgRaF',
    voiceNote: 'Jay Lee — 남성·중년 톤·설명형(중장년 시청층이 주인 채널에 맞음)',
    voiceSettings: { stability: 0.65, similarity_boost: 0.8 },
    styleGuide: [
      '[작가: 곽재현 — 현장 서술형]',
      '· 현장에서 본 장면으로 시작한다. 상황을 먼저 그리고 원인을 뒤에 붙인다.',
      '· 차분하게 단정한다. 과장·감탄사를 쓰지 않는다.',
      '· 계절과 시기를 축으로 삼는다("이맘때", "제철 들어가기 전").',
    ].join('\n'),
  },
];

/** 초기 배정분(2026-09-03 오전)에 쓰던 임시 id — 역할 id 로 합치기 전 레코드 호환. */
const LEGACY_ID: Record<string, string> = {
  w_haerin: 'shorts_writer', w_taeyun: 'shorts_writer_b', w_jaehyun: 'shorts_writer_c',
};

export function writerById(id: string | undefined): ShortsWriter | undefined {
  if (!id) return undefined;
  const key = LEGACY_ID[id] ?? id;
  return SHORTS_WRITERS.find((w) => w.id === key);
}

/** 이름으로 조회(레거시 레코드는 writerId 없이 이름만 있다). */
export function writerByName(name: string | undefined): ShortsWriter | undefined {
  return SHORTS_WRITERS.find((w) => w.name === name);
}

/**
 * 다음 편 작가 고르기(순수) — 최근 쓴 작가를 피한다. 최근 목록은 최신순.
 * 같은 작가가 연달아 나오지 않게 하는 게 목적이라 '가장 오래 안 쓴 작가'를 고른다.
 * 동률이면 목록 순서(안정) — 무작위를 쓰지 않는 이유는 재현성과 테스트 때문이다.
 */
export function pickWriter(recentWriterIds: ReadonlyArray<string | undefined>): ShortsWriter {
  let best = SHORTS_WRITERS[0]!;
  let bestAge = -1;
  for (const w of SHORTS_WRITERS) {
    const idx = recentWriterIds.findIndex((id) => id === w.id);
    const age = idx === -1 ? Number.MAX_SAFE_INTEGER : idx; // 안 나왔으면 가장 오래된 것으로
    if (age > bestAge) { bestAge = age; best = w; }
  }
  return best;
}
