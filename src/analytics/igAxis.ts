/**
 * 인스타 소재 축 성적(2026-09-04 사용자 확정) — 주제를 고를 때 '어느 각도로 잡을지'의 근거.
 *
 * 왜 인스타만 보는가. 유튜브 피드는 09-02 이후 노출이 끊겨 신호가 없고, 검색은 축이 아니라
 * 검색어 매칭이 레버다(ytSearchDemand). 지금 '피드에서 무엇이 먹히는가'를 말해 줄 수 있는
 * 채널은 인스타뿐이다 — 도달의 99.5%가 비팔로워 추천이라 순수한 추천 성적이다.
 *
 * 실측(111편, 2026-09-04):
 *   꽃·개화      8편  중앙 1,362      심기·자리   19편  중앙 818
 *   전정·가지치기 17편  중앙   943      열매·수확   12편  중앙 733
 *   관리·병해    10편  중앙   633      화분·실내    6편  중앙 491
 *   기타         39편  중앙   557   ← 가장 큰 덩어리가 최하위권
 *   전체 중앙 679
 *
 * 읽는 법이 중요하다. 최고 축과 최저 축의 차이는 2.8배로, 압도적이지는 않다. 진짜 문제는
 * 35%가 어느 축에도 안 걸린다는 것이다. 그래서 이 신호는 "이 소재를 다뤄라"가 아니라
 * "같은 소재라도 잘 먹히는 각도로 잡아라"로 쓴다 — 회양목 하나도 전정으로 잡을 수 있고
 * 심기로 잡을 수 있고 월동으로 잡을 수 있다.
 *
 * 축 분류는 표현 매칭이라 근사다. 정교한 분류기가 아니라 '기울이는 신호'로만 쓴다.
 */

import { activityAxes } from '../content/brand';

export interface AxisPerf { readonly axis: string; readonly count: number; readonly median: number }

export interface IgAxis { readonly axis: string; readonly test: RegExp }
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 소재 축 — 이름과 판별 표현. 브랜드 행위 축(activityAxes)에서 만든다: terms[0] 이 축 이름, terms 전부가 판별 표현.
 * 앞에서부터 먼저 걸리는 축을 쓴다(구체적인 것을 앞에). 브랜드 설정이 없으면 축이 없고 전부 '기타'다 —
 * 종전엔 원예 축 6개(전정·꽃·열매·화분·심기·관리)가 코드에 박혀 있었다(범용화 2026-09-07).
 */
export function igAxes(axes: ReadonlyArray<{ terms: string[] }> = activityAxes()): IgAxis[] {
  return axes
    .filter((a) => a.terms.length)
    .map((a) => ({ axis: a.terms[0]!, test: new RegExp(a.terms.map(escapeRe).join('|')) }));
}

/**
 * 이 주제가 '화분·실내' 재배 이야기인가(순수).
 *
 * 축 분류와 같은 표현을 쓴다 — 두 곳이 갈라지면 한쪽만 고쳐 놓고 고쳤다고 믿게 된다.
 * 쓰임은 다르다. 축 분류는 성적을 묶는 데 쓰고, 이 함수는 이미지 프롬프트가 화분·받침
 * 같은 컨테이너 소품을 넣어도 되는지 판정하는 데 쓴다.
 *
 * 왜 필요한가(실측 2026-09-06). "대추나무 결실주" 편의 씬2 프롬프트에 생활감 로테이션이
 * "색이 바랜 화분, 물 자국이 남은 받침"을 넣었다. 결실주는 과수원 나무인데 화분을 지시하니
 * 모델이 화분에 심긴 관엽식물을 그렸고, 대추나무가 아니게 됐다.
 */
export function isContainerTopic(text: string, axes: readonly IgAxis[] = igAxes()): boolean {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  // '화분·실내' 이름의 축이 브랜드에 있을 때만 판정 — 없으면 컨테이너 소품 판정 자체가 없다.
  return (axes.find((a) => /화분|실내/.test(a.axis))?.test ?? /$^/).test(t);
}

/** 축에 안 걸리는 소재의 이름 — 실측에서 가장 큰 덩어리이자 최하위권이다. */
export const AXIS_NONE = '기타';

/** 텍스트가 어느 축인가(순수). 어느 것에도 안 걸리면 AXIS_NONE. */
export function classifyAxis(text: string, axes: readonly IgAxis[] = igAxes()): string {
  const t = String(text ?? '');
  if (!t.trim()) return AXIS_NONE;
  return axes.find((a) => a.test.test(t))?.axis ?? AXIS_NONE;
}

/** 중앙값(순수). 빈 배열은 0. */
function median(a: readonly number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * 편별 (텍스트, 조회수) → 축별 성적(순수). 표본이 minCount 미만인 축은 뺀다 —
 * 2~3편으로 만든 중앙값을 근거로 주제를 기울이면 잡음을 따라가게 된다.
 */
export function axisPerformance(
  rows: ReadonlyArray<{ text: string; views: number }>, minCount = 5, axes: readonly IgAxis[] = igAxes(),
): AxisPerf[] {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const v = Number(r?.views);
    if (!Number.isFinite(v) || v < 0) continue;
    const a = classifyAxis(r.text, axes);
    by.set(a, [...(by.get(a) ?? []), v]);
  }
  return [...by.entries()]
    .filter(([, vs]) => vs.length >= minCount)
    .map(([axis, vs]) => ({ axis, count: vs.length, median: median(vs) }))
    .sort((x, y) => y.median - x.median);
}

/**
 * 주제 제안 프롬프트에 넣을 축 블록(순수).
 *
 * "이 소재를 다뤄라"가 아니라 "각도를 이렇게 잡아라"로 쓴다. 축은 소재가 아니라 프레이밍이고,
 * 같은 소재도 어느 축으로든 잡을 수 있다. 계절과 싸우지 않게 하는 것도 이 때문이다.
 */
export function axisBlock(perf: readonly AxisPerf[]): string {
  if (perf.length < 2) return '';
  const top = perf.slice(0, 2).map((p) => p.axis);
  const none = perf.find((p) => p.axis === AXIS_NONE);
  return [
    '[인스타 소재 축 성적 — 같은 소재라도 어느 각도로 잡느냐로 도달이 갈린다(실측 중앙값)]',
    ...perf.map((p) => `- ${p.axis}: 중앙 ${p.median.toLocaleString()}회 (${p.count}편)`),
    '',
    `· 각도를 정할 때 위쪽 축(${top.join(', ')})으로 잡을 수 있으면 그렇게 잡아라.`,
    '· 축은 소재가 아니라 프레이밍이다 — 같은 소재도 어느 축으로든 잡을 수 있다.',
    none
      ? `· 다만 어느 축에도 안 걸리는 주제가 가장 많고(${none.count}편) 성적도 낮다(중앙 ${none.median.toLocaleString()}회). 주제를 정했으면 그 주제가 위 축 중 하나로 읽히는지 확인하라.`
      : '',
    '· 계절과 싸우지 마라. 지금 시기에 맞지 않는 축이면 이 신호보다 시의성이 우선이다.',
  ].filter(Boolean).join('\n');
}
