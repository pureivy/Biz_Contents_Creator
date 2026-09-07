import { describe, it, expect } from 'vitest';
import { classifyAxis, axisPerformance, axisBlock, isContainerTopic, AXIS_NONE, IG_AXES } from './igAxis';

describe('classifyAxis — 소재 축 판별(순수)', () => {
  it('표현으로 축을 잡는다', () => {
    expect(classifyAxis('배롱나무 전정, 꽃 진 자리')).toBe('전정·가지치기');
    expect(classifyAxis('무화과 열매 익는 시기')).toBe('열매·수확');
    expect(classifyAxis('고무나무 화분 분갈이')).toBe('화분·실내');
    expect(classifyAxis('생울타리 묘목 심기')).toBe('심기·자리');
  });
  it('앞에 놓인 축이 이긴다 — 여러 표현이 걸릴 때 구체적인 쪽', () => {
    // '꽃 진 자리를 자른다'는 전정 이야기지 개화 이야기가 아니다.
    expect(classifyAxis('꽃 진 자리를 자르는 법')).toBe('전정·가지치기');
  });
  it('어느 것에도 안 걸리면 기타', () => {
    expect(classifyAxis('9월 정원 준비')).toBe(AXIS_NONE);
    expect(classifyAxis('')).toBe(AXIS_NONE);
  });
  it('축 목록에 중복 이름이 없다', () => {
    const names = IG_AXES.map((a) => a.axis);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('axisPerformance — 축별 중앙값(순수)', () => {
  const rows = (axis: string, ...views: number[]) => views.map((v) => ({ text: axis, views: v }));

  it('중앙값 큰 순으로 준다', () => {
    const p = axisPerformance([
      ...rows('전정', 100, 200, 300, 400, 500),
      ...rows('화분', 10, 20, 30, 40, 50),
    ]);
    expect(p.map((x) => x.axis)).toEqual(['전정·가지치기', '화분·실내']);
    expect(p[0]).toMatchObject({ median: 300, count: 5 });
  });
  it('표본이 적은 축은 뺀다 — 2~3편 중앙값으로 주제를 기울이면 잡음을 따라간다', () => {
    const p = axisPerformance([...rows('전정', 1000, 2000), ...rows('화분', 1, 2, 3, 4, 5)]);
    expect(p.map((x) => x.axis)).toEqual(['화분·실내']);
  });
  it('짝수 표본은 가운데 둘의 평균', () => {
    expect(axisPerformance(rows('전정', 10, 20, 30, 40), 4)[0]!.median).toBe(25);
  });
  it('불량 조회수는 버린다', () => {
    const p = axisPerformance([...rows('전정', 10, 20, 30, 40, 50), { text: '전정', views: NaN }], 5);
    expect(p[0]!.count).toBe(5);
  });
  it('빈 입력은 빈 결과', () => {
    expect(axisPerformance([])).toEqual([]);
  });
});

describe('axisBlock — 프롬프트 블록(순수)', () => {
  const perf = [
    { axis: '꽃·개화', count: 8, median: 1362 },
    { axis: '전정·가지치기', count: 17, median: 943 },
    { axis: AXIS_NONE, count: 39, median: 557 },
  ];
  it('축이 둘 미만이면 빈 문자열 — 비교가 안 되면 신호가 아니다', () => {
    expect(axisBlock([])).toBe('');
    expect(axisBlock([{ axis: '전정·가지치기', count: 9, median: 900 }])).toBe('');
  });
  it('상위 축을 이름으로 지목한다', () => {
    const b = axisBlock(perf);
    expect(b).toContain('꽃·개화, 전정·가지치기');
    expect(b).toContain('중앙 1,362회 (8편)');
  });
  it('축은 소재가 아니라 프레이밍이라고 못박는다', () => {
    expect(axisBlock(perf)).toContain('축은 소재가 아니라 프레이밍이다');
  });
  it('기타가 많고 낮다는 사실을 숫자로 알려 준다', () => {
    expect(axisBlock(perf)).toContain('39편');
  });
  it('계절이 우선이라고 못박는다 — 축 신호가 시의성을 이기면 안 된다', () => {
    expect(axisBlock(perf)).toContain('계절과 싸우지 마라');
  });
});

describe('isContainerTopic — 컨테이너 소품 게이트(순수)', () => {
  it('화분·실내 주제만 참', () => {
    expect(isContainerTopic('고무나무 화분 분갈이')).toBe(true);
    expect(isContainerTopic('베란다 채소 키우기')).toBe(true);
    expect(isContainerTopic('실내 공기정화 식물')).toBe(true);
  });
  it('노지 수종 주제는 거짓 — 이 편에 화분 소품이 들어가면 종이 틀어진다', () => {
    // 실사고(2026-09-06): 이 제목의 씬2 에 "색이 바랜 화분"이 배정돼 대추나무가 아닌 그림이 나왔다.
    expect(isContainerTopic('대추나무 결실주 대추나무 결실주, 열매보다 가지를 먼저 봅니다')).toBe(false);
    expect(isContainerTopic('배롱나무 묘목 심는 시기')).toBe(false);
    expect(isContainerTopic('과수원 사과나무 전정')).toBe(false);
  });
  it('빈 값은 거짓', () => {
    expect(isContainerTopic('')).toBe(false);
    expect(isContainerTopic('   ')).toBe(false);
  });
  it('축 분류와 같은 표현을 쓴다 — 두 곳이 갈라지면 한쪽만 고치게 된다', () => {
    const axisTest = IG_AXES.find((a) => a.axis === '화분·실내')!.test;
    for (const t of ['화분 물주기', '분갈이 시기', '노지 월동']) {
      expect(isContainerTopic(t)).toBe(axisTest.test(t));
    }
  });
});
