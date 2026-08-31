import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  contentTokens, familyVolume, seasonIndex, demandScore, demandVerdict, formatDemandLine,
  buildDemandBlock, assessCandidatesDemand, type DemandRow, type DemandSnap,
} from './topicDemand';

// 커넥터는 전량 가짜 — 실제 네이버 호출 없이 묶음 호출 횟수·매핑만 검증한다.
const H = vi.hoisted(() => ({
  adOn: true, dlOn: true,
  calls: [] as string[][], dlCalls: [] as Array<{ kws: string[]; months: number }>,
  vols: [] as Array<{ keyword: string; pc: number; mobile: number; total: number; comp: string; pcApprox: boolean; mobileApprox: boolean }>,
  /** 설정 시 콜 순서대로 응답을 돌려준다(청크별 실패 재현용). */
  volsSeq: null as Array<Array<{ keyword: string; pc: number; mobile: number; total: number; comp: string; pcApprox: boolean; mobileApprox: boolean }>> | null,
  trends: [] as Array<{ keyword: string; points: Array<{ period: string; ratio: number }>; direction: '상승' | '하락' | '보합' }>,
  volsErr: null as Error | null, trendErr: null as Error | null,
}));
vi.mock('../grounding/naver_searchad', () => ({
  searchAdEnabled: () => H.adOn,
  searchAdVolumes: async (hints: string[]) => {
    const nth = H.calls.length;
    H.calls.push(hints);
    if (H.volsErr) throw H.volsErr;
    return H.volsSeq ? (H.volsSeq[nth] ?? []) : H.vols;
  },
}));
vi.mock('../grounding/naver_datalab', () => ({
  datalabEnabled: () => H.dlOn,
  datalabTrend: async (kws: string[], months: number) => {
    H.dlCalls.push({ kws, months });
    if (H.trendErr) throw H.trendErr;
    return H.trends;
  },
}));

const vol = (keyword: string, total: number, approx = false) => ({
  keyword, pc: 0, mobile: total, total, comp: '중간', pcApprox: approx, mobileApprox: approx,
});
const row = (p: Partial<DemandRow> & { keyword: string }): DemandRow =>
  ({ volume: 0, approx: false, familyMax: 0, ...p });

describe('contentTokens — 후보 키워드의 내용 토큰(순수)', () => {
  it('불용어(주는·시기)를 빼고 내용어만 남긴다', () => {
    expect(contentTokens('가을 거름 주는 시기')).toEqual(['가을', '거름']);
  });
  it('"~나무" 복합어는 유지한다', () => {
    expect(contentTokens('사과나무 비료')).toEqual(['사과나무', '비료']);
  });
  it('단독 "나무"는 불용어라 뺀다(계열 대조를 무의미하게 넓히므로)', () => {
    expect(contentTokens('나무 거름 주는 시기')).toEqual(['거름']);
  });
});

describe('familyVolume — 내용 토큰을 전부 포함하는 연관어 최대치(순수)', () => {
  const rows = [
    { keyword: '밑거름', total: 1220 },
    { keyword: '가을거름주기', total: 90 },
    { keyword: '블루베리전용비료', total: 360 },
    { keyword: '블루베리', total: 5400 },
  ];
  it("'가을·거름' 은 '밑거름'(가을 없음)을 계열로 치지 않는다", () => {
    expect(familyVolume([{ keyword: '밑거름', total: 1220 }], '가을 거름 주는 시기')).toEqual({ max: 0 });
  });
  it('토큰을 전부 포함하는 연관어 중 최대치를 top 과 함께 준다', () => {
    expect(familyVolume(rows, '가을 거름 주는 시기')).toEqual({ max: 90, top: '가을거름주기' });
    expect(familyVolume(rows, '블루베리 비료')).toEqual({ max: 360, top: '블루베리전용비료' });
  });
  it('내용 토큰이 하나도 없으면 0 — 공허참으로 전역 최대가 새어들면 안 된다', () => {
    expect(familyVolume(rows, '나무 주는 시기')).toEqual({ max: 0 });
  });
});

describe('seasonIndex — 13개월 데이터랩의 시즌 지수(순수)', () => {
  // 2025-08 ~ 2026-08(13점). 정점 2026-03=100, 현재(마지막)=2026-08 13.3, 다음달 근사=2025-09 20.
  const pts13 = [
    { period: '2025-08-01', ratio: 12 }, { period: '2025-09-01', ratio: 20 }, { period: '2025-10-01', ratio: 30 },
    { period: '2025-11-01', ratio: 18 }, { period: '2025-12-01', ratio: 9 }, { period: '2026-01-01', ratio: 11 },
    { period: '2026-02-01', ratio: 44 }, { period: '2026-03-01', ratio: 100 }, { period: '2026-04-01', ratio: 71 },
    { period: '2026-05-01', ratio: 40 }, { period: '2026-06-01', ratio: 22 }, { period: '2026-07-01', ratio: 15 },
    { period: '2026-08-01', ratio: 13.3 },
  ];
  it('max(현재, 작년 다음달)/정점 — 지금~다음 달만 본다(2026-08-27 사용자 확정)', () => {
    // 창 = 작년 +1개월(2025-09=20) + 현재(13.3) → 20/100. 작년 +2개월(30)은 보지 않는다.
    expect(seasonIndex(pts13, new Date('2026-08-26T12:00:00'))).toBeCloseTo(0.2, 5);
  });
  it('2개월 뒤 피크(단풍)는 8월 말에 후순위 — 전방 창은 다음 달까지만', () => {
    // 실사고(2026-08-27): 2개월 창이 8월 말에 단풍(10~11월 피크)을 통과시켜 시기 밖 글이 나갔다.
    const autumn = [
      { period: '2025-08-01', ratio: 2 }, { period: '2025-09-01', ratio: 12 }, { period: '2025-10-01', ratio: 40 },
      { period: '2025-11-01', ratio: 100 }, { period: '2025-12-01', ratio: 25 }, { period: '2026-01-01', ratio: 8 },
      { period: '2026-02-01', ratio: 6 }, { period: '2026-03-01', ratio: 5 }, { period: '2026-04-01', ratio: 5 },
      { period: '2026-05-01', ratio: 4 }, { period: '2026-06-01', ratio: 3 }, { period: '2026-07-01', ratio: 3 },
      { period: '2026-08-01', ratio: 3 },
    ];
    const idx = seasonIndex(autumn, new Date('2026-08-26T12:00:00'));
    expect(idx).toBeCloseTo(0.12, 5);           // max(3, 12)/100
    expect(demandVerdict(row({ keyword: '단풍 드는 시기', volume: 40, familyMax: 40, seasonIdx: idx! }), { minVolume: 30, minSeason: 0.25 })).toBe('demote');
  });
  it('13점 미만이면 다음달을 모르니 현재/정점만 본다', () => {
    const pts6 = pts13.slice(-6); // 2026-03(정점 100) ~ 2026-08(13.3)
    expect(seasonIndex(pts6, new Date('2026-08-26T12:00:00'))).toBeCloseTo(13.3 / 100, 5);
  });
  it('데이터랩이 당월을 아직 안 주면(마지막 점이 지난달) 인덱스 대신 period 로 창을 잡는다', () => {
    // 2025-07 ~ 2026-07(13점) — 인덱스(len-12=1)는 2025-08 을 기준점으로 잡지만 실제 다음달은 2025-09.
    // 기준점이 한 칸 밀리면 다음달 값이 밀린다(2025-09=20 → 밀리면 2025-08=12).
    const lagged = [{ period: '2025-07-01', ratio: 8 }, ...pts13.slice(0, 12)];
    expect(seasonIndex(lagged, new Date('2026-08-26T12:00:00'))).toBeCloseTo(20 / 100, 5);
  });
  it('12월에도 롤오버한다 — 작년 +1개월은 이듬해 1월(지연 발행 폴백 경로)', () => {
    // 2025-11 ~ 2026-11(13점), now=2026-12(데이터랩 미제공 → 지연 경로). 기준점은 2026-01(15)이어야 하고
    // 현재(4)와 비교해 0.15. 롤오버가 깨져 2025-12(20)나 2025-11(90)을 잡으면 0.2/0.9 가 된다.
    const dec = [
      { period: '2025-11-01', ratio: 90 }, { period: '2025-12-01', ratio: 20 }, { period: '2026-01-01', ratio: 15 },
      { period: '2026-02-01', ratio: 10 }, { period: '2026-03-01', ratio: 30 }, { period: '2026-04-01', ratio: 40 },
      { period: '2026-05-01', ratio: 60 }, { period: '2026-06-01', ratio: 100 }, { period: '2026-07-01', ratio: 80 },
      { period: '2026-08-01', ratio: 50 }, { period: '2026-09-01', ratio: 30 }, { period: '2026-10-01', ratio: 10 },
      { period: '2026-11-01', ratio: 4 },
    ];
    expect(seasonIndex(dec, new Date('2026-12-15T12:00:00'))).toBeCloseTo(0.15, 5);
  });
  it('데이터 없음·정점 0 이면 undefined(판정 불가 → 게이트 생략)', () => {
    expect(seasonIndex([], new Date())).toBeUndefined();
    expect(seasonIndex([{ period: '2026-08-01', ratio: 0 }], new Date())).toBeUndefined();
  });
});

describe('demandScore — 정렬용 점수(순수)', () => {
  it('검색량이 크면 점수도 크다(계열 최대도 같은 자격)', () => {
    const a = demandScore(row({ keyword: 'a', volume: 30 }));
    const b = demandScore(row({ keyword: 'b', volume: 3000 }));
    const c = demandScore(row({ keyword: 'c', volume: 0, familyMax: 3000 }));
    expect(b).toBeGreaterThan(a);
    expect(c).toBeCloseTo(b, 10);
  });
  it('비수기(시즌 낮음)는 같은 검색량이라도 점수가 깎인다', () => {
    const hi = demandScore(row({ keyword: 'a', volume: 1000, seasonIdx: 1 }));
    const lo = demandScore(row({ keyword: 'a', volume: 1000, seasonIdx: 0.1 }));
    expect(lo).toBeLessThan(hi);
    expect(demandScore(row({ keyword: 'a', volume: 1000 }))).toBeCloseTo(hi, 10); // 시즌 미상 = 감점 없음
  });
});

describe('demandVerdict — 판정(순수)', () => {
  const cfg = { minVolume: 30, minSeason: 0.25 };
  it('하한 미달은 기각(계열 최대도 미달일 때만)', () => {
    expect(demandVerdict(row({ keyword: '가을 거름', volume: 0, familyMax: 0 }), cfg)).toBe('reject');
    expect(demandVerdict(row({ keyword: '가을 거름', volume: 0, familyMax: 90 }), cfg)).toBe('pass');
  });
  it('수요는 있으나 비수기면 후순위(기각 아님)', () => {
    expect(demandVerdict(row({ keyword: '비료', volume: 900, seasonIdx: 0.13 }), cfg)).toBe('demote');
  });
  it('수요·시즌 모두 충족이면 통과', () => {
    expect(demandVerdict(row({ keyword: '비료', volume: 900, seasonIdx: 0.8 }), cfg)).toBe('pass');
  });
  it('행이 없으면(조회 실패·미조회) unknown — fail-open 으로 통과시킨다', () => {
    expect(demandVerdict(undefined, cfg)).toBe('unknown');
  });
});

describe('formatDemandLine — 로그·프롬프트 공용 한 줄(순수)', () => {
  it('설계 예시와 바이트가 같다', () => {
    expect(formatDemandLine(row({
      keyword: '사과나무 비료', volume: 30, familyMax: 30, familyTop: '사과나무비료', seasonIdx: 0.13, direction: '하락',
    }))).toBe('"사과나무 비료" 30/월(계열 최대 30) · 시즌 0.13↓');
  });
  it('계열 최대가 후보 자신과 다르면 그 표기를 함께 보여준다', () => {
    expect(formatDemandLine(row({ keyword: '블루베리 비료', volume: 0, familyMax: 360, familyTop: '블루베리전용비료' })))
      .toBe('"블루베리 비료" 0/월(계열 최대 360 "블루베리전용비료")');
  });
  it('"10 미만" 표기는 가짜 정밀도 대신 그대로 남긴다', () => {
    expect(formatDemandLine(row({ keyword: '가을 거름', volume: 0, approx: true }))).toContain('10미만/월');
  });
});

describe('buildDemandBlock — 두뇌 주입 블록(순수)', () => {
  const snap: DemandSnap = {
    date: '2026-08-26',
    rows: [
      row({ keyword: '가을 거름', volume: 0, familyMax: 0 }),
      row({ keyword: '사과나무 비료', volume: 30, familyMax: 30, familyTop: '사과나무비료', seasonIdx: 0.13, direction: '하락' }),
      row({ keyword: '블루베리 묘목', volume: 2400, familyMax: 5400, familyTop: '블루베리묘목가격', seasonIdx: 0.7, direction: '상승' }),
    ],
  };
  const NOW = new Date('2026-08-26T12:00:00').getTime();
  it('점수 내림차순으로 나열하고 지시문을 붙인다', () => {
    const b = buildDemandBlock(snap, NOW);
    expect(b).toContain('[검색 수요 실측 — 2026-08-26]');
    expect(b.indexOf('블루베리 묘목')).toBeLessThan(b.indexOf('사과나무 비료'));
    expect(b.indexOf('사과나무 비료')).toBeLessThan(b.indexOf('가을 거름'));
    // 하한 숫자는 CONFIG 보간이라 여기선 문장만 확인한다(보간 검증은 아래 스냅샷 describe 에서 임계값을 바꿔 한다).
    // M4 — 연관어는 붙여쓰기 형태라 "그 표기를 우선하라"가 제목·태그에 '블루베리전용비료' 같은 표기를
    // 밀어넣었다. 관측(수요가 그쪽에 있다)만 전하고 표기는 자연스러운 띄어쓰기로 쓰게 한다.
    expect(b).toContain('미만 키워드로 주제를 세우지 마라. 수요가 있는 키워드는 그대로 keyword 로 쓰고, 계열 최대 연관어의 검색량이 더 크면 주제는 그 수요를 겨냥하되 표기는 자연스러운 띄어쓰기로 써라.');
    expect(b).not.toContain('그 표기를 우선하라');
  });
  it('상위 12줄까지만 담는다', () => {
    const many: DemandSnap = { date: '2026-08-26', rows: Array.from({ length: 20 }, (_, i) => row({ keyword: `k${i}`, volume: i * 100 })) };
    expect(buildDemandBlock(many, NOW).split('\n').filter((l) => l.startsWith('- ')).length).toBe(12);
  });
  it('계열 쿨다운 토큰이 든 행은 표에서 뺀다(트렌드 블록과 같은 필터)', () => {
    // 쿨다운으로 '제안 불가'인 계열을 수요 표에 남기면, 두뇌에 "수요 있는 소재"로 보여 금지와 정면 충돌한다.
    const b = buildDemandBlock(snap, NOW, ['비료']);
    expect(b).not.toContain('사과나무 비료');
    expect(b).toContain('블루베리 묘목');   // 쿨다운 아닌 행은 그대로
    expect(buildDemandBlock(snap, NOW, ['비료', '묘목', '거름'])).toBe('');  // 전부 빠지면 무주입
  });
  it('스냅샷 없음·빈 행·3일 초과는 무주입', () => {
    expect(buildDemandBlock(null, NOW)).toBe('');
    expect(buildDemandBlock({ date: '2026-08-26', rows: [] }, NOW)).toBe('');
    expect(buildDemandBlock({ ...snap, date: '2026-08-22' }, NOW)).toBe('');
    expect(buildDemandBlock({ ...snap, date: '2026-08-24' }, NOW)).not.toBe('');
  });
});

describe('assessCandidatesDemand — 커넥터 묶음 호출', () => {
  beforeEach(() => {
    H.adOn = true; H.dlOn = true; H.calls = []; H.dlCalls = []; H.volsErr = null; H.trendErr = null; H.volsSeq = null;
    H.vols = [vol('블루베리', 5400), vol('블루베리전용비료', 360), vol('사과나무비료', 30), vol('가을거름', 0, true), vol('밑거름', 1220)];
    H.trends = [{ keyword: '사과나무 비료', points: [{ period: '2026-03-01', ratio: 100 }, { period: '2026-08-01', ratio: 13 }], direction: '하락' }];
  });
  it('정확 일치 검색량·계열 최대·시즌을 후보별로 묶는다(검색광고 ≤2콜 + 데이터랩 1콜)', async () => {
    const m = await assessCandidatesDemand(['사과나무 비료', '블루베리 비료', '가을 거름']);
    expect(H.calls.length).toBe(1);
    expect(H.dlCalls).toEqual([{ kws: ['사과나무 비료', '블루베리 비료', '가을 거름'], months: 13 }]);
    expect(m.get('사과나무 비료')).toEqual({
      keyword: '사과나무 비료', volume: 30, approx: false, familyMax: 30, familyTop: '사과나무비료', seasonIdx: 0.13, direction: '하락',
    });
    expect(m.get('블루베리 비료')).toMatchObject({ volume: 0, familyMax: 360, familyTop: '블루베리전용비료' });
    expect(m.get('가을 거름')).toMatchObject({ volume: 0, approx: true, familyMax: 0 }); // '밑거름'은 계열 아님
  });
  it('중복은 합치고 11번째부터는 조회하지 않는다(미조회 후보는 unknown 으로 통과)', async () => {
    const kws = Array.from({ length: 12 }, (_, i) => `키워드${i}`);
    H.vols = kws.slice(0, 10).map((k) => vol(k, 100));   // 조회한 10개는 실제로 행이 온 상태(미측정과 구분)
    const m = await assessCandidatesDemand([...kws, '키워드0']);
    expect(H.calls.length).toBe(2);
    expect(H.calls.flat()).toEqual(kws.slice(0, 10));
    expect(m.size).toBe(10);
    expect(m.has('키워드10')).toBe(false);
    expect(demandVerdict(m.get('키워드10'), { minVolume: 30, minSeason: 0.25 })).toBe('unknown');
  });
  it('한 청크만 빈 응답이면 그 청크 후보만 미조회로 남긴다(살아남은 청크 덕에 통째로 기각되면 안 된다)', async () => {
    // 1번 묶음 성공(그 5개 후보 전부 행이 옴), 2번 묶음 실패([] 반환).
    H.volsSeq = [[vol('사과나무비료', 30), vol('블루베리전용비료', 360), vol('가을거름', 0, true), vol('감나무전정', 50), vol('배롱나무개화', 20)], []];
    const m = await assessCandidatesDemand(['사과나무 비료', '블루베리 비료', '가을 거름', '감나무 전정', '배롱나무 개화', '포도나무 접목']);
    expect(H.calls.length).toBe(2);
    expect(m.size).toBe(5);
    expect(m.has('포도나무 접목')).toBe(false);                                   // 2번 묶음 → unknown
    expect(demandVerdict(m.get('포도나무 접목'), { minVolume: 30, minSeason: 0.25 })).toBe('unknown');
    expect(m.get('사과나무 비료')).toMatchObject({ volume: 30 });
    expect(demandVerdict(m.get('가을 거름'), { minVolume: 30, minSeason: 0.25 })).toBe('reject'); // 응답 받은 묶음은 판정
    H.volsSeq = null;
  });
  // C2(2026-08-26 최종 리뷰) — 청크 응답은 왔지만 그 키워드 행이 없을 때 0/월을 지어내던 결함.
  // 모듈 헤더 불변식: '수요가 없다'는 단정은 실제로 그 키워드 행을 받았을 때만 한다.
  it('응답에 그 키워드 행이 없으면 Map 에서 아예 뺀다(0/월 날조 금지 — 미측정은 unknown)', async () => {
    H.vols = [vol('사과나무비료', 30)];
    const m = await assessCandidatesDemand(['사과나무 비료', '행이 없는 키워드']);
    expect(H.calls.length).toBe(1);                                   // 조회는 했고 응답도 왔다
    expect(m.has('행이 없는 키워드')).toBe(false);                      // 그래도 '검색량 0'이라 단정하지 않는다
    expect(demandVerdict(m.get('행이 없는 키워드'), { minVolume: 30, minSeason: 0.25 })).toBe('unknown');
    expect(m.get('사과나무 비료')).toMatchObject({ volume: 30 });        // 행이 온 후보는 종전대로 판정
  });
  it('정확 일치가 없어도 계열 최대가 있으면 남긴다(표기만 틀린 좋은 소재)', async () => {
    H.vols = [vol('블루베리전용비료', 360)];
    const m = await assessCandidatesDemand(['블루베리 비료']);
    expect(m.get('블루베리 비료')).toMatchObject({ volume: 0, familyMax: 360, familyTop: '블루베리전용비료' });
  });

  // I5(2026-08-26 최종 리뷰) — LLM 후보의 쉼표·개행이 hintKeywords 를 부풀려(1후보=여러 힌트) 400 을
  // 만들고, 그 라운드 게이트가 통째로 무력화되던 결함. 정제는 힌트에만, Map 키는 원문 그대로.
  it('쉼표·개행이 든 후보는 정제해서 힌트로 보낸다(1후보=1힌트) — Map 키는 원문 유지', async () => {
    H.vols = [vol('사과나무비료', 30)];
    const multi = '사과나무 비료,\n가을 시비, 밑거름';
    const trailing = '사과나무 비료,';
    const long = `${'가'.repeat(40)}, 뒤엣말`;
    const m = await assessCandidatesDemand([multi, trailing, long, '  , \n\r ']);
    expect(H.calls.length).toBe(1);
    expect(H.calls[0]!.length).toBe(3);                                  // 후보 3개 → 힌트 3개(빈 후보는 제외)
    expect(H.calls[0]![0]).toBe('사과나무 비료 가을 시비 밑거름');           // 쉼표·개행 → 공백, 중복 공백 압축
    expect(H.calls[0]![2]!.length).toBe(30);                             // 30자 상한
    expect(H.calls[0]!.some((h) => /[,\n\r]/.test(h))).toBe(false);
    expect(m.get(trailing)).toMatchObject({ keyword: trailing, volume: 30 }); // 키·표기는 원문(정제본 아님)
  });
  it('정제 후 같아지는 후보는 한 번만 조회한다(힌트 낭비 방지)', async () => {
    H.vols = [vol('가을거름', 0, true)];
    const m = await assessCandidatesDemand(['가을 거름,', '가을 거름']);
    expect(H.calls[0]).toEqual(['가을 거름']);
    expect(m.size).toBe(1);
  });

  it('커넥터 비활성·빈 응답·예외는 빈 Map(게이트 생략)', async () => {
    H.adOn = false;
    expect((await assessCandidatesDemand(['사과나무 비료'])).size).toBe(0);
    expect(H.calls.length).toBe(0);
    H.adOn = true; H.vols = [];
    expect((await assessCandidatesDemand(['사과나무 비료'])).size).toBe(0);
    H.vols = [vol('사과나무비료', 30)]; H.volsErr = new Error('HTTP 429');
    expect((await assessCandidatesDemand(['사과나무 비료'])).size).toBe(0);
  });
  it('데이터랩만 실패하면 검색량 행은 살린다(시즌 미상 = 후순위 판정 불가)', async () => {
    H.trendErr = new Error('datalab down');
    const m = await assessCandidatesDemand(['사과나무 비료']);
    expect(m.get('사과나무 비료')).toMatchObject({ volume: 30, familyMax: 30 });
    expect(m.get('사과나무 비료')!.seasonIdx).toBeUndefined();
  });
});

describe('스냅샷 IO — 킬스위치·시드 슬롯·하루 1회·실패 시 보존', () => {
  let tmp: string;
  const snapDir = (): string => path.join(tmp, 'analytics');
  const snapFile = (): string => path.join(snapDir(), fs.readdirSync(snapDir()).find((f) => f.startsWith('demand') && f.endsWith('.json'))!);
  const mockCfg = (over: Record<string, unknown> = {}): void => {
    vi.doMock('../config', () => ({
      CONFIG: { dataDir: tmp, topicDemandGate: true, topicDemandMinVolume: 30, topicDemandMinSeason: 0.25, ...over },
    }));
    vi.resetModules();
  };
  const writeBrand = (yaml: string): void => fs.writeFileSync(path.join(tmp, 'brand.yaml'), yaml, 'utf-8');
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demand-'));
    writeBrand('name: 테스트나무\nseedKeywords:\n  - 사과나무 비료\n  - 블루베리 비료\n');
    H.adOn = true; H.dlOn = true; H.calls = []; H.dlCalls = []; H.volsErr = null; H.trendErr = null; H.volsSeq = null;
    // 시드 3종 전부 행이 오는 픽스처 — 행이 없는 키워드는 Map 에서 빠지므로(C2) 스냅샷 구성 검증이
    // '측정 안 됨'과 뒤섞이지 않게 한다.
    H.vols = [vol('사과나무비료', 30), vol('블루베리전용비료', 360), vol('블루베리묘목', 900)];
    H.trends = [];
    mockCfg();
  });
  afterEach(() => { vi.doUnmock('../config'); vi.resetModules(); });

  it('시드(브랜드 + 성과 winners)로 스냅샷을 쓰고 같은 날 재호출은 no-op', async () => {
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'strategy-테스트나무.json'),
      JSON.stringify({ winners: [{ keyword: '블루베리 묘목' }, { keyword: '사과나무 비료' }] }), 'utf-8');
    const { refreshDemandSnapshot, demandSignalBlock } = await import('./topicDemand');
    await refreshDemandSnapshot();
    const snap = JSON.parse(fs.readFileSync(snapFile(), 'utf-8')) as DemandSnap;
    expect(snap.rows.map((r) => r.keyword)).toEqual(['사과나무 비료', '블루베리 비료', '블루베리 묘목']); // winners 중복은 합쳐짐
    expect(snap.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const before = H.calls.length;
    await refreshDemandSnapshot();
    expect(H.calls.length).toBe(before);
    expect(demandSignalBlock()).toContain('[검색 수요 실측');
  });
  it('전 묶음 실패면 기존 스냅샷을 덮어쓰지 않는다', async () => {
    fs.mkdirSync(snapDir(), { recursive: true });
    const keep = { date: '2026-01-01', rows: [row({ keyword: '지난 스냅샷', volume: 900 })] };
    fs.writeFileSync(path.join(snapDir(), 'demand-테스트나무.json'), JSON.stringify(keep), 'utf-8');
    H.volsErr = new Error('HTTP 429');
    const { refreshDemandSnapshot } = await import('./topicDemand');
    await refreshDemandSnapshot();
    expect(JSON.parse(fs.readFileSync(snapFile(), 'utf-8'))).toEqual(keep);
  });
  it('winners 는 소재 범위·시대 컷오프로 거르고, 사용자가 적은 브랜드 시드는 그대로 둔다', async () => {
    fs.writeFileSync(path.join(tmp, 'brand.yaml'),
      'name: 테스트나무\nperfEraSince: 2026-07-31\nbanned:\n  - 다육·채소 등 무관 주제\nseedKeywords:\n  - 다육이 화분\n  - 사과나무 비료\n', 'utf-8');
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'strategy-테스트나무.json'), JSON.stringify({
      winners: [
        { keyword: '다육 선인장', firstSeenAt: '2026-08-18T00:00:00.000Z' },   // 소재 범위 밖 → 제외
        { keyword: '배롱나무 전정', firstSeenAt: '2026-07-01T00:00:00.000Z' }, // 정체성 재정립 이전 → 제외
        { keyword: '블루베리 묘목', firstSeenAt: '2026-08-18T00:00:00.000Z' }, // 통과
        { keyword: '감나무 접목', score: 1 },                                   // 시각 불명 → 보수적 제외
      ],
    }), 'utf-8');
    const { demandSeeds } = await import('./topicDemand');
    // '다육이 화분'은 브랜드 banned 토큰('다육')에 걸리지만 사용자가 직접 적은 시드라 살아남는다.
    expect(demandSeeds(undefined, new Date('2026-08-26T12:00:00'))).toEqual(['다육이 화분', '사과나무 비료', '블루베리 묘목']);
  });
  it('킬스위치 off 면 커넥터 콜도 프롬프트 주입도 0(신선한 스냅샷이 있어도)', async () => {
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'demand-테스트나무.json'),
      JSON.stringify({ date: ymd, rows: [row({ keyword: '사과나무 비료', volume: 900 })] }), 'utf-8');
    mockCfg({ topicDemandGate: false });
    const { refreshDemandSnapshot, demandSignalBlock } = await import('./topicDemand');
    await refreshDemandSnapshot();
    expect(H.calls.length).toBe(0);
    expect(demandSignalBlock()).toBe('');
  });
  it('지시문의 하한은 설정값을 그대로 보간한다(프롬프트와 실제 게이트가 어긋나지 않게)', async () => {
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'demand-테스트나무.json'),
      JSON.stringify({ date: ymd, rows: [row({ keyword: '사과나무 비료', volume: 900 })] }), 'utf-8');
    mockCfg({ topicDemandMinVolume: 50, topicDemandMinSeason: 0.4 });
    const { demandSignalBlock } = await import('./topicDemand');
    expect(demandSignalBlock()).toContain('검색량 50/월 미만·시즌 지수 0.4 미만 키워드로 주제를 세우지 마라.');
  });
  it('시드 상한 15칸을 브랜드 회전 창 10 + winners 5 로 나눈다(브랜드 시드 21개가 winners 를 굶기던 결함)', async () => {
    writeBrand(`name: 테스트나무\nseedKeywords:\n${Array.from({ length: 21 }, (_, i) => `  - 시드${i}`).join('\n')}\n`);
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'strategy-테스트나무.json'), JSON.stringify({
      winners: Array.from({ length: 8 }, (_, i) => ({ keyword: `승자${i}`, score: i, firstSeenAt: '2026-08-18T00:00:00.000Z' })),
    }), 'utf-8');
    mockCfg();
    const { demandSeeds } = await import('./topicDemand');
    // 2026-08-26 = 연중 238일 → 238 % 21 = 7 → 시드7 부터 10개.
    const seeds = demandSeeds(undefined, new Date('2026-08-26T12:00:00'));
    expect(seeds.length).toBe(15);
    expect(seeds.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `시드${7 + i}`));
    expect(seeds.slice(10)).toEqual(['승자7', '승자6', '승자5', '승자4', '승자3']); // 점수 높은 순 5개
  });
  it('회전 창은 날짜마다 밀리고 끝에서 앞으로 감긴다(21개 시드가 ~3일이면 한 바퀴)', async () => {
    writeBrand(`name: 테스트나무\nseedKeywords:\n${Array.from({ length: 21 }, (_, i) => `  - 시드${i}`).join('\n')}\n`);
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'strategy-테스트나무.json'),
      JSON.stringify({ winners: [{ keyword: '승자0', score: 1, firstSeenAt: '2026-08-18T00:00:00.000Z' }] }), 'utf-8');
    mockCfg();
    const { demandSeeds } = await import('./topicDemand');
    expect(demandSeeds(undefined, new Date('2026-08-27T12:00:00'))[0]).toBe('시드8');
    const wrapped = demandSeeds(undefined, new Date('2026-09-03T12:00:00')); // 연중 246일 → 246 % 21 = 15
    expect(wrapped[0]).toBe('시드15');
    expect(wrapped.slice(0, 14)).toContain('시드0');                          // 끝(시드20) 다음은 앞으로 감긴다
    expect(new Set(wrapped.slice(0, 14)).size).toBe(14);                      // 감기면서 중복되지 않는다
  });
  it('winners 가 없으면 브랜드 시드가 15칸을 다 쓴다(빈 슬롯을 놀리지 않는다)', async () => {
    writeBrand(`name: 테스트나무\nseedKeywords:\n${Array.from({ length: 21 }, (_, i) => `  - 시드${i}`).join('\n')}\n`);
    mockCfg();
    const { demandSeeds } = await import('./topicDemand');
    expect(demandSeeds(undefined, new Date('2026-08-26T12:00:00')).length).toBe(15);
  });
  it('스냅샷이 3일 넘게 낡으면 블록은 빈 문자열(무주입)', async () => {
    fs.mkdirSync(snapDir(), { recursive: true });
    fs.writeFileSync(path.join(snapDir(), 'demand-테스트나무.json'),
      JSON.stringify({ date: '2020-01-01', rows: [row({ keyword: '옛날 키워드', volume: 900 })] }), 'utf-8');
    const { demandSignalBlock } = await import('./topicDemand');
    expect(demandSignalBlock()).toBe('');
  });
});

describe('수요 미달 기각 기억 — TTL·정규화 대조·킬스위치·제안 금지 블록', () => {
  let tmp: string;
  const rejFile = (slug = '테스트나무'): string => path.join(tmp, 'analytics', `demand-rejects-${slug}.json`);
  const mockCfg = (over: Record<string, unknown> = {}): void => {
    vi.doMock('../config', () => ({
      CONFIG: { dataDir: tmp, topicDemandGate: true, topicDemandMinVolume: 30, topicDemandMinSeason: 0.25, ...over },
    }));
    vi.resetModules();
  };
  const seedFile = (map: Record<string, { keyword: string; line: string; ts: string }>): void => {
    fs.mkdirSync(path.dirname(rejFile()), { recursive: true });
    fs.writeFileSync(rejFile(), JSON.stringify(map), 'utf-8');
  };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demand-rej-'));
    fs.writeFileSync(path.join(tmp, 'brand.yaml'), 'name: 테스트나무\n', 'utf-8');
    mockCfg();
  });
  afterEach(() => { vi.doUnmock('../config'); vi.resetModules(); });

  it('TTL 은 30일이고, 기록한 키워드를 그 실측 줄과 함께 되읽는다', async () => {
    const m = await import('./topicDemand');
    expect(m.DEMAND_REJECT_TTL_DAYS).toBe(30);
    m.rememberDemandReject('테스트나무', '가을 거름', '"가을 거름" 0/월(계열 최대 0)');
    expect(m.demandRejectFor('테스트나무', '가을 거름')).toMatchObject({
      keyword: '가을 거름', line: '"가을 거름" 0/월(계열 최대 0)',
    });
    expect(m.demandRejectFor('테스트나무', '봄 거름')).toBeNull();
  });

  it('정규화 대조 — "가을거름"과 "가을 거름"은 같은 키워드다', async () => {
    const m = await import('./topicDemand');
    m.rememberDemandReject('테스트나무', '가을 거름', 'L');
    expect(m.demandRejectFor('테스트나무', '가을거름')?.keyword).toBe('가을 거름');
    expect(m.demandRejectFor('테스트나무', '  가을   거름  ')?.keyword).toBe('가을 거름');
    expect(m.demandRejectFor('테스트나무', undefined)).toBeNull();
  });

  it('30일이 지나면 무시(null)하고 다음 쓰기에서 파일에서도 정리된다', async () => {
    const m = await import('./topicDemand');
    const t0 = new Date('2026-07-01T00:00:00.000Z');
    m.rememberDemandReject('테스트나무', '묵은 키워드', 'L', t0);
    expect(m.demandRejectFor('테스트나무', '묵은 키워드', new Date('2026-07-30T00:00:00.000Z'))).not.toBeNull();
    expect(m.demandRejectFor('테스트나무', '묵은 키워드', new Date('2026-08-05T00:00:00.000Z'))).toBeNull();
    m.rememberDemandReject('테스트나무', '새 키워드', 'L2', new Date('2026-08-05T00:00:00.000Z'));
    expect(Object.keys(JSON.parse(fs.readFileSync(rejFile(), 'utf-8')))).toEqual([m.normKw('새 키워드')]);
  });

  it('킬스위치 off 면 no-op — 파일을 만들지 않고 조회·블록도 침묵한다', async () => {
    mockCfg({ topicDemandGate: false });
    const m = await import('./topicDemand');
    m.rememberDemandReject('테스트나무', '가을 거름', 'L');
    expect(fs.existsSync(rejFile())).toBe(false);
    expect(m.demandRejectFor('테스트나무', '가을 거름')).toBeNull();
    expect(m.demandRejectBlock('테스트나무')).toBe('');
  });

  it('킬스위치 off 는 이미 쌓인 파일이 있어도 조회·블록을 침묵시킨다', async () => {
    seedFile({ 가을거름: { keyword: '가을 거름', line: 'L', ts: new Date().toISOString() } });
    mockCfg({ topicDemandGate: false });
    const m = await import('./topicDemand');
    expect(m.demandRejectFor('테스트나무', '가을 거름')).toBeNull();
    expect(m.demandRejectBlock('테스트나무')).toBe('');
  });

  it('항목이 없으면 블록은 빈 문자열(무주입)', async () => {
    const m = await import('./topicDemand');
    expect(m.demandRejectBlock('테스트나무')).toBe('');
  });

  it('블록은 헤더 + 최근순 15줄 상한 + 지침 1줄', async () => {
    const m = await import('./topicDemand');
    for (let i = 0; i < 20; i++) {
      m.rememberDemandReject('테스트나무', `키워드${i}`, `"키워드${i}" 0/월`, new Date(Date.UTC(2026, 7, 20, i)));
    }
    const b = m.demandRejectBlock('테스트나무', new Date(Date.UTC(2026, 7, 21)));
    expect(b).toContain('[검색 수요 미달로 기각된 키워드 — 30일간 제안 금지]');
    const items = b.split('\n').filter((l) => l.startsWith('- '));
    expect(items.length).toBe(15);
    expect(items[0]).toBe('- "키워드19" ("키워드19" 0/월)');   // 최근순
    expect(b).not.toContain('키워드0');                        // 가장 오래된 5개는 잘린다
    expect(b).toContain('이 키워드와 띄어쓰기만 다른 변형도 같은 키워드다. 대신 검색량이 있는 상위 카테고리어로 주제를 세워라.');
  });

  it('만료 항목은 블록에도 싣지 않는다(금지 지시와 실제 게이트가 어긋나면 안 된다)', async () => {
    seedFile({
      묵은키워드: { keyword: '묵은 키워드', line: 'L1', ts: '2026-07-01T00:00:00.000Z' },
      새키워드: { keyword: '새 키워드', line: 'L2', ts: '2026-08-20T00:00:00.000Z' },
    });
    const m = await import('./topicDemand');
    const b = m.demandRejectBlock('테스트나무', new Date('2026-08-21T00:00:00.000Z'));
    expect(b).toContain('새 키워드');
    expect(b).not.toContain('묵은');
  });

  it('브랜드별로 격리된다 — 다른 슬러그의 기억은 보이지 않는다', async () => {
    const m = await import('./topicDemand');
    m.rememberDemandReject('테스트나무', '가을 거름', 'L');
    expect(m.demandRejectFor('다른브랜드', '가을 거름')).toBeNull();
    expect(m.demandRejectBlock('다른브랜드')).toBe('');
    expect(fs.existsSync(rejFile('다른브랜드'))).toBe(false);
  });
});
