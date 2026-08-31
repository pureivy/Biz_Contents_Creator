// 모든 날짜·시각 표기의 단일 기준 = 대한민국 표준시(KST, Asia/Seoul). Intl 에 timeZone 을 명시해
// 호스트 OS 타임존(서버가 UTC 여도)과 무관하게 KST 로 고정한다. toISOString()(항상 UTC)의 '아침
// 하루 밀림'(KST 00:00~08:59 에 전날로 찍힘)을 회피한다.
const KST = 'Asia/Seoul';

/** KST 달력 날짜 YYYY-MM-DD — 로그·페이지·요약 스탬프용. en-CA 로캘이 YYYY-MM-DD 포맷을 보장. */
export function kstDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** KST 한국어 풀 표기 — 예: "2026년 6월 23일 화요일 17시 30분 (KST)". 에이전트 프롬프트 주입용. */
export function kstNowKo(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes): string => parts.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}년 ${+g('month')}월 ${+g('day')}일 ${g('weekday')} ${g('hour')}시 ${g('minute')}분 (KST)`;
}
