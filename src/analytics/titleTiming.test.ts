/**
 * 제목 유형·발행 시각 A/B(후속 카드 2026-08-12) — 순수 함수만 검증(수집기는 실스토어 의존이라 제외,
 * perfStale.test.ts 관례). 분류가 흔들리면 매일 같은 제목이 다른 유형으로 집계돼 A/B 자체가 무너진다.
 * 리뷰 확정 교정(ㄹ까 축약·가지치기 오탐·채널 분리·미측정 분모)의 회귀도 여기서 잡는다.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTitleType, kstHourOf, slotOf, aggregate, dailyFollowerDeltas, crossFollowerByType,
  type PublishedItem,
} from './titleTiming';
import type { FollowerSnapshot } from './followers';

describe('classifyTitleType — 정보/후킹/질문 결정적 분류', () => {
  it('물음표·의문 어미 → 질문형 (실제 발행 제목)', () => {
    expect(classifyTitleType('하스카프베리 재배 두 품종은 왜 필수일까')).toBe('question');
    expect(classifyTitleType('겨울 전정 언제 해야 할까요?')).toBe('question');
    expect(classifyTitleType('심을까 말까 고민되는 8월 묘목')).toBe('question');
  });

  it('ㄹ까 축약 의문 어미(될까·뭘까·다를까…)도 질문형 — 열거 누락 교정(리뷰 2026-08-12)', () => {
    expect(classifyTitleType('지금 심어도 될까')).toBe('question');
    expect(classifyTitleType('감나무와 대봉감, 뭐가 다를까')).toBe('question');
    expect(classifyTitleType('배롱나무 꽃은 언제 필까')).toBe('question');
    expect(classifyTitleType('이 나무 마당에서도 잘 자랄까')).toBe('question');
    expect(classifyTitleType('가을 거름, 어떨까요')).toBe('question');
  });

  it('이유 종결 "니까"는 질문이 아니다', () => {
    expect(classifyTitleType('물을 줬으니까 안심하면 생기는 실수')).toBe('hook');
    expect(classifyTitleType('여름이니까 하는 통풍 관리')).toBe('info');
  });

  it('숫자 리스트·호기심 표식 → 후킹형', () => {
    expect(classifyTitleType('7월에 심는 꽃 5가지, 한여름 파종 성공법')).toBe('hook');
    expect(classifyTitleType('하스카프베리 열매 안 달리는 이유, 두 품종이 답이다')).toBe('hook');
    expect(classifyTitleType('모르면 후회하는 묘목 고르기')).toBe('hook');
  });

  it('"N가지"는 소재어 "가지치기"와 충돌하지 않는다 — 오탐 교정(리뷰 2026-08-12)', () => {
    expect(classifyTitleType('2026 가지치기 완벽 정리')).toBe('info');
    expect(classifyTitleType('과일나무 가지치기 3가지 원칙')).toBe('hook'); // 진짜 리스티클은 유지
  });

  it('질문 표식이 후킹 표식과 겹치면 질문형 우선 (클릭 심리 지배)', () => {
    expect(classifyTitleType('열매 안 달리는 이유는 무엇일까')).toBe('question');
  });

  it('표식 없으면 정보형(기본값) — 애매한 건 정보형이 받아야 통계가 덜 오염된다', () => {
    expect(classifyTitleType('폭염 나무 물주기, 이른 아침 깊이 급수 완벽 가이드')).toBe('info');
    expect(classifyTitleType('장마철나무관리 물을 빼야 나무가 산다')).toBe('info');
  });

  it('한글이 이어지는 어중 유사 어미는 오탐하지 않는다 — "까지" 류', () => {
    expect(classifyTitleType('블루베리나무 품종부터 수확까지 완전 가이드')).toBe('info');
  });
});

describe('kstHourOf / slotOf — KST 시각·슬롯', () => {
  it('UTC → KST(+9) 변환 — 서버 타임존과 무관', () => {
    expect(kstHourOf('2026-08-11T23:00:04.353Z')).toBe(8);  // KST 08시
    expect(kstHourOf('2026-08-11T16:30:00.000Z')).toBe(1);  // KST 01시(자정 넘어감)
  });

  it('파싱 불가 → null', () => {
    expect(kstHourOf('없는 날짜')).toBeNull();
  });

  it('슬롯 경계 — 각 칸의 시작 시가 그 칸에 속한다', () => {
    expect(slotOf(0)).toBe('새벽(0~6시)');
    expect(slotOf(6)).toBe('아침(6~10시)');
    expect(slotOf(10)).toBe('낮(10~14시)');
    expect(slotOf(14)).toBe('오후(14~18시)');
    expect(slotOf(18)).toBe('저녁(18~22시)');
    expect(slotOf(22)).toBe('밤(22~24시)');
    expect(slotOf(23)).toBe('밤(22~24시)');
  });
});

const item = (over: Partial<PublishedItem>): PublishedItem => ({
  kind: 'blog', id: 'x', title: 't', publishedTs: '2026-08-05T00:00:00.000Z',
  titleType: 'info', signal: 0.5, views: 100, measured: true, mature: true, ...over,
});

describe('aggregate — 그룹 평균·정렬', () => {
  it('평균신호 내림차순, 동률은 표본 많은 쪽 우선, null 키는 제외', () => {
    const rows = aggregate([
      item({ titleType: 'info', signal: 0.1, views: 10 }),
      item({ titleType: 'info', signal: 0.3, views: 30 }),
      item({ titleType: 'hook', signal: 0.3, views: 50 }),
      item({ titleType: 'question', signal: 0.3, views: 70 }),
      item({ titleType: 'question', signal: 0.3, views: 90 }),
    ], (i) => i.titleType);
    expect(rows.map((r) => r.key)).toEqual(['question', 'hook', 'info']); // 0.3(2편) > 0.3(1편) > 0.2
    expect(rows[0]).toMatchObject({ count: 2, avgSignal: 0.3, avgViews: 80 });
    expect(rows[2]!.avgSignal).toBeCloseTo(0.2, 10);
    expect(aggregate([item({})], () => null)).toEqual([]);
  });
});

const snap = (date: string, ch: Partial<FollowerSnapshot>): FollowerSnapshot =>
  ({ date, youtube: null, instagram: null, facebook: null, ...ch });

describe('dailyFollowerDeltas — 연속 스냅샷만 앞 날짜(D)에 귀속', () => {
  it('하루 간격 쌍 → D 에 증감 기록, 결측일로 벌어진 쌍은 버린다', () => {
    const d = dailyFollowerDeltas([
      snap('2026-08-01', { instagram: 100, youtube: 50 }),
      snap('2026-08-02', { instagram: 110, youtube: 52 }),
      snap('2026-08-04', { instagram: 130, youtube: 55 }), // 08-03 결측 — 08-02 몫인지 알 수 없음
      snap('2026-08-05', { instagram: 131, youtube: null }), // 채널 실패는 그 채널만 제외
    ]);
    expect(d.get('2026-08-01')).toEqual({ instagram: 10, youtube: 2 });
    expect(d.has('2026-08-02')).toBe(false);
    expect(d.get('2026-08-04')).toEqual({ instagram: 1 }); // youtube null → 키 자체가 없음
  });
});

describe('crossFollowerByType — 채널 안에서만, 발행 전체를 분모로 귀속', () => {
  const snaps = [
    snap('2026-08-05', { instagram: 100, naver: 3 }),
    snap('2026-08-06', { instagram: 106, naver: 4 }),
  ];
  it('채널을 섞지 않는다 — 같은 유형이라도 채널별 행으로 분리(성장률 교란 차단)', () => {
    const rows = crossFollowerByType([
      item({ kind: 'cardnews', titleType: 'hook', publishedTs: '2026-08-05T03:00:00.000Z' }),
      item({ kind: 'reels', titleType: 'info', publishedTs: '2026-08-05T09:00:00.000Z' }), // 둘 다 instagram
      item({ kind: 'blog', titleType: 'hook', publishedTs: '2026-08-05T05:00:00.000Z' }),  // naver +1 은 단독
    ], snaps);
    const igHook = rows.find((r) => r.channel === 'instagram' && r.type === 'hook')!;
    const igInfo = rows.find((r) => r.channel === 'instagram' && r.type === 'info')!;
    const nvHook = rows.find((r) => r.channel === 'naver' && r.type === 'hook')!;
    expect(igHook).toMatchObject({ items: 1, totalDelta: 3 }); // IG +6 을 2편이 반씩
    expect(igInfo).toMatchObject({ items: 1, totalDelta: 3 });
    expect(nvHook).toMatchObject({ items: 1, totalDelta: 1 }); // 네이버 +1 은 채널 분리 유지
  });

  it('분모는 발행 전체 — 미측정(measured=false) 동일일·동일채널 발행분도 몫을 가져간다', () => {
    const rows = crossFollowerByType([
      item({ kind: 'cardnews', titleType: 'hook', publishedTs: '2026-08-05T03:00:00.000Z' }),
      item({ kind: 'cardnews', titleType: 'info', publishedTs: '2026-08-05T09:00:00.000Z', measured: false }),
    ], snaps);
    const hook = rows.find((r) => r.type === 'hook')!;
    expect(hook.totalDelta).toBe(3); // +6 을 2편이 나눔 — 측정분만 세면 6으로 과대 귀속됐을 것
  });

  it('스냅샷 범위 밖 발행분은 표본에서 제외', () => {
    const rows = crossFollowerByType([
      item({ kind: 'cardnews', titleType: 'hook', publishedTs: '2026-07-01T03:00:00.000Z' }),
    ], snaps);
    expect(rows).toEqual([]);
  });

  it('KST 날짜 경계 — UTC 15시(=KST 자정) 이후 발행은 다음 날 몫', () => {
    const rows = crossFollowerByType([
      // 2026-08-04T16:00Z = KST 08-05 01:00 → 08-05 발행으로 귀속돼야 한다
      item({ kind: 'cardnews', titleType: 'question', publishedTs: '2026-08-04T16:00:00.000Z' }),
    ], snaps);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'instagram', type: 'question', items: 1, totalDelta: 6 });
  });
});
