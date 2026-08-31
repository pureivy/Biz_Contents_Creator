/**
 * 24절기 시의성 신호(순수) — 자율 아이디어·리서치 프롬프트에 "오늘이 달력상 어디인가"를 한 줄로 준다.
 *
 * 배경(2026-08-07 사용자 제안): 두뇌 프롬프트는 "시의성·계절성을 고려하라"고 지시하면서 정작 오늘
 * 날짜를 알려주지 않았다 — 시간을 안 주고 시의성을 요구하는 공백. 나무 작업은 절기 단위로 움직이므로
 * 절기가 가장 자연스러운 달력 신호다.
 *
 * 고정 날짜 표: 실제 절기는 해마다 ±1일 변동하나(천문), 시의성 '신호' 용도로 하루 오차는 무의미 —
 * 연도별 정밀 표는 YAGNI. 나무 작업 함의는 여기 넣지 않는다(업종 의미는 코드가 아니라 브랜드 컨텍스트
 * — LLM 이 절기 상식과 브랜드를 결합해 스스로 끌어낸다).
 */

interface SolarTerm { name: string; month: number; day: number; meaning: string }

// 통상 KST 기준 날짜(±1일 근사). 순서 = 연중 순환.
const TERMS: readonly SolarTerm[] = [
  { name: '소한', month: 1, day: 5, meaning: '겨울 추위의 본격' },
  { name: '대한', month: 1, day: 20, meaning: '가장 큰 추위' },
  { name: '입춘', month: 2, day: 4, meaning: '봄의 시작' },
  { name: '우수', month: 2, day: 19, meaning: '눈이 비로 바뀜' },
  { name: '경칩', month: 3, day: 5, meaning: '해빙·생물이 깨어남' },
  { name: '춘분', month: 3, day: 20, meaning: '낮밤 길이 같음' },
  { name: '청명', month: 4, day: 5, meaning: '맑은 봄·식목 적기' },
  { name: '곡우', month: 4, day: 20, meaning: '봄비·파종 적기' },
  { name: '입하', month: 5, day: 5, meaning: '여름의 시작' },
  { name: '소만', month: 5, day: 21, meaning: '만물이 자라 차오름' },
  { name: '망종', month: 6, day: 6, meaning: '씨뿌리기 마지막 적기' },
  { name: '하지', month: 6, day: 21, meaning: '낮이 가장 긺' },
  { name: '소서', month: 7, day: 7, meaning: '더위의 시작' },
  { name: '대서', month: 7, day: 22, meaning: '가장 심한 더위' },
  { name: '입추', month: 8, day: 7, meaning: '가을의 시작' },
  { name: '처서', month: 8, day: 23, meaning: '더위가 꺾임' },
  { name: '백로', month: 9, day: 7, meaning: '이슬이 맺히기 시작' },
  { name: '추분', month: 9, day: 23, meaning: '낮밤 길이 같음' },
  { name: '한로', month: 10, day: 8, meaning: '찬 이슬' },
  { name: '상강', month: 10, day: 23, meaning: '서리가 내림' },
  { name: '입동', month: 11, day: 7, meaning: '겨울의 시작' },
  { name: '소설', month: 11, day: 22, meaning: '첫눈이 올 무렵' },
  { name: '대설', month: 12, day: 7, meaning: '큰 눈이 올 무렵' },
  { name: '동지', month: 12, day: 22, meaning: '밤이 가장 긺' },
] as const;

const DAY_MS = 24 * 3600 * 1000;

/** now 가 속한 절기(가장 최근에 지난 절기)와 다음 절기 — 연초·연말은 전년 동지/이듬해 소한으로 랩. */
function around(now: Date): { cur: SolarTerm; curDate: Date; next: SolarTerm; nextDate: Date } {
  const y = now.getFullYear();
  // 전년 말~이듬해 초까지 이어 붙여 경계 걱정 없이 스캔.
  const seq = [
    ...TERMS.map((t) => ({ t, d: new Date(y - 1, t.month - 1, t.day) })),
    ...TERMS.map((t) => ({ t, d: new Date(y, t.month - 1, t.day) })),
    ...TERMS.map((t) => ({ t, d: new Date(y + 1, t.month - 1, t.day) })),
  ];
  let curIdx = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i]!.d.getTime() <= now.getTime()) curIdx = i;
    else break;
  }
  const cur = seq[curIdx]!;
  const next = seq[curIdx + 1]!;
  return { cur: cur.t, curDate: cur.d, next: next.t, nextDate: next.d };
}

/** 프롬프트 주입용 한 줄 — 예: "[오늘] 8월 7일 — 절기: 입추(가을의 시작), 다음 절기: 처서(8/23, 더위가 꺾임)". */
export function seasonalContext(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) return '';
  const { cur, curDate, next, nextDate } = around(now);
  const passed = Math.floor((now.getTime() - curDate.getTime()) / DAY_MS);
  const passedTxt = passed > 0 ? ` +${passed}일` : '';
  return `[오늘] ${now.getMonth() + 1}월 ${now.getDate()}일 — 절기: ${cur.name}(${cur.meaning})${passedTxt}, ` +
    `다음 절기: ${next.name}(${nextDate.getMonth() + 1}/${nextDate.getDate()}, ${next.meaning})`;
}
