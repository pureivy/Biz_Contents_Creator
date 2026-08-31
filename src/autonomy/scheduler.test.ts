import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAutoCycle, startDaily, derivedContentDue, seedKeywordBlock, eligibleWinners, dailyDue, lacksSpeciesAnchor, normalizeIdeaCandidates, demandGateDecision, pickDemoted, pickRoundAdoption, shouldRememberDemandReject } from './scheduler';
import type { DemandRow } from '../analytics/topicDemand';

describe('startAutoCycle (유휴 게이트 자율 사이클)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('intervalMs<=0 이면 no-op (스케줄조차 안 함)', () => {
    const launch = vi.fn();
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => false, pickWork: async () => 'x', launch });
    vi.advanceTimersByTime(60_000);
    expect(launch).not.toHaveBeenCalled();
    stop();
  });

  it('사용자 런 진행 중이면 제안·실행하지 않는다(양보)', async () => {
    const launch = vi.fn();
    const pickWork = vi.fn(async () => 'task');
    const stop = startAutoCycle({ intervalMs: 1000, isBusy: () => true, pickWork, launch });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pickWork).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    stop();
  });

  it('유휴 + 제안 있으면 그 주제로 launch', async () => {
    const launch = vi.fn();
    const stop = startAutoCycle({ intervalMs: 1000, isBusy: () => false, pickWork: async () => '신규 자율 작업', launch });
    await vi.advanceTimersByTimeAsync(1000);
    expect(launch).toHaveBeenCalledWith('신규 자율 작업');
    stop();
  });

  it('제안이 null/빈값이면 launch 안 함', async () => {
    const launch = vi.fn();
    const stop = startAutoCycle({ intervalMs: 1000, isBusy: () => false, pickWork: async () => null, launch });
    await vi.advanceTimersByTimeAsync(1000);
    expect(launch).not.toHaveBeenCalled();
    stop();
  });

  it('이전 tick 미완(느린 pickWork) 중 다음 tick 은 재진입하지 않는다', async () => {
    let resolveProposal: (v: string | null) => void = () => {};
    const pickWork = vi.fn(() => new Promise<string | null>((r) => { resolveProposal = r; }));
    const launch = vi.fn();
    const stop = startAutoCycle({ intervalMs: 1000, isBusy: () => false, pickWork, launch, log: () => {} });
    await vi.advanceTimersByTimeAsync(1000); // tick1 시작 → pickWork await 에서 멈춤
    await vi.advanceTimersByTimeAsync(1000); // tick2 발화하나 ticking 가드로 차단
    expect(pickWork).toHaveBeenCalledTimes(1); // 재진입 안 함
    resolveProposal('작업');
    await vi.advanceTimersByTimeAsync(0);
    expect(launch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('pickWork 가 throw 해도 죽지 않는다(다음 틱 지속)', async () => {
    const launch = vi.fn();
    const stop = startAutoCycle({
      intervalMs: 1000, isBusy: () => false,
      pickWork: async () => { throw new Error('boom'); }, launch,
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(2000); // 두 틱
    expect(launch).not.toHaveBeenCalled();
    stop();
  });
});

describe('startDaily (일일 브리핑 스케줄)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('시각 형식이 잘못되면 no-op', () => {
    const run = vi.fn();
    const stop = startDaily({ time: 'bad', run });
    vi.advanceTimersByTime(3 * 86_400_000);
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it('지정 시각에 1회 발송하고 같은 날 재발송하지 않는다', () => {
    vi.setSystemTime(new Date(2026, 5, 19, 8, 59, 0)); // 08:59 로컬
    const run = vi.fn();
    const stop = startDaily({ time: '09:00', run });
    vi.advanceTimersByTime(60_000); // → 09:00, 발화
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000 * 30); // 09:30 까지 — 당일 1회 가드
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it('지정 시각 전에는 발송하지 않는다', () => {
    vi.setSystemTime(new Date(2026, 5, 19, 7, 0, 0)); // 07:00
    const run = vi.fn();
    const stop = startDaily({ time: '09:00', run });
    vi.advanceTimersByTime(60_000 * 30); // 07:30 — 아직 전
    expect(run).not.toHaveBeenCalled();
    stop();
  });
});

// 오토런 온/오프 토글(사용자 요청 2026-07-16) — 꺼짐 상태면 틱이 아무 일도 하지 않는다.
describe('startAutoCycle — isEnabled 게이트(오토런 토글)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('isEnabled=false 면 pickWork 호출 없음, 켜면 다음 틱부터 재개', async () => {
    const pickWork = vi.fn(async () => 'x');
    const launch = vi.fn();
    let enabled = false;
    const stop = startAutoCycle({ intervalMs: 1000, isBusy: () => false, isEnabled: () => enabled, pickWork, launch });
    await vi.advanceTimersByTimeAsync(3000);
    expect(pickWork).not.toHaveBeenCalled();
    enabled = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(pickWork).toHaveBeenCalled();
    stop();
  });
});

describe('startAutoCycle — runNow 결과값·runNowPersistent 재시도(슬롯 침묵 소멸 방지)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('runNow 는 결과를 돌려준다 — launched/idle/busy', async () => {
    const launch = vi.fn();
    let busy = false; let work: string | null = 'w';
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => busy, pickWork: async () => work, launch });
    expect(await stop.runNow()).toBe('launched');
    work = null;
    expect(await stop.runNow()).toBe('idle');
    busy = true;
    expect(await stop.runNow()).toBe('busy');
    stop();
  });
  it('runNowPersistent — busy 면 재시도해 런 종료 후 launch(정각 슬롯·오토런 지시 유실 봉합)', async () => {
    const launch = vi.fn();
    let busy = true;
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => busy, pickWork: async () => 'w', launch });
    const p = stop.runNowPersistent({ retryMs: 1000, maxAttempts: 5 });
    await vi.advanceTimersByTimeAsync(1000); // 1차 busy → 대기
    busy = false;
    await vi.advanceTimersByTimeAsync(1000); // 재시도 → launch
    expect(await p).toBe('launched');
    expect(launch).toHaveBeenCalledWith('w');
    stop();
  });
  it('runNowPersistent — 상시 busy 면 maxAttempts 소진 후 포기, 중복 대기는 1건만', async () => {
    const launch = vi.fn();
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => true, pickWork: async () => 'w', launch });
    const p = stop.runNowPersistent({ retryMs: 1000, maxAttempts: 2 });
    const dup = stop.runNowPersistent({ retryMs: 1000, maxAttempts: 2 }); // 대기 중 중복 요청
    expect(await dup).toBe('busy');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe('busy');
    expect(launch).not.toHaveBeenCalled();
    stop();
  });
  it('runNowPersistent — respectToggle 은 대기 중 토글 오프를 존중한다', async () => {
    const launch = vi.fn();
    let enabled = true;
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => true, isEnabled: () => enabled, pickWork: async () => 'w', launch });
    const p = stop.runNowPersistent({ retryMs: 1000, maxAttempts: 5, respectToggle: true });
    await vi.advanceTimersByTimeAsync(500);
    enabled = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('idle');
    expect(launch).not.toHaveBeenCalled();
    stop();
  });
});

// 토글 영속 — 재시작에도 유지(data/_shared/autorun.json), 기본값은 온(기존 동작 불변).
describe('autoRunEnabled/setAutoRunEnabled — 영속 라운드트립', () => {
  it('기본 온 → 끄면 파일 영속 → 모듈 재로드에도 꺼짐 유지', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const pathm = await import('node:path');
    const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), 'autorun-'));
    process.env.GEPA_DATA_DIR = tmp;
    vi.resetModules();
    let mod = await import('./scheduler');
    expect(mod.autoRunEnabled()).toBe(true); // 기본 온
    mod.setAutoRunEnabled(false);
    expect(mod.autoRunEnabled()).toBe(false);
    vi.resetModules();
    mod = await import('./scheduler'); // 재시작 시뮬레이션
    expect(mod.autoRunEnabled()).toBe(false);
    mod.setAutoRunEnabled(true);
    delete process.env.GEPA_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// 파생 콘텐츠 일일 케이던스(사용자 지시 2026-07-16: 쇼츠·카드뉴스 매일 1편) — 24h/N 간격 게이트.
describe('derivedContentDue — 일일 N편 케이던스(순수)', () => {
  const now = new Date('2026-07-16T12:00:00Z').getTime();
  it('perDay<=0 은 off, 기록 없음·손상 ts 는 즉시 due', () => {
    expect(derivedContentDue(0, '2026-07-01T00:00:00Z', now)).toBe(false);
    expect(derivedContentDue(1, undefined, now)).toBe(true);
    expect(derivedContentDue(1, '깨진값', now)).toBe(true);
  });
  it('매일 1편: 24h 경과 전 false, 이후 true', () => {
    expect(derivedContentDue(1, '2026-07-15T13:00:00Z', now)).toBe(false); // 23h
    expect(derivedContentDue(1, '2026-07-15T11:00:00Z', now)).toBe(true);  // 25h
  });
});

// 시드 키워드 무음 유실(2026-08-01 실측) — 프롬프트가 `winners || coldstart` 라서 성과 키워드가
// 한 줄만 있어도 브랜드 시드가 통째로 사라졌다. 새 축을 yaml 시드에 넣어도 주제 선정이 안 바뀌던 원인.
describe('seedKeywordBlock — 성과 키워드가 있어도 시드가 사라지지 않는다', () => {
  const seeds = ['도토리나무 구별', '겨울눈으로 나무 알아보기'];
  it('winners 가 있으면 시드를 나란히 준다(종전엔 여기서 유실됐다)', () => {
    const b = seedKeywordBlock('- 여름꽃종류 (점수 0.80)', seeds);
    for (const k of seeds) expect(b).toContain(k);
  });
  it('winners 가 비면 빈 문자열 — coldstart 가 이미 같은 시드를 담아 중복 주입이 된다', () => {
    expect(seedKeywordBlock('', seeds)).toBe('');
  });
  it('시드가 없으면 빈 문자열 — 미설정 브랜드는 종전 동작 그대로', () => {
    expect(seedKeywordBlock('- 무언가', [])).toBe('');
  });
});

// 시대 컷오프(2026-08-01) — 정체성 재정립 전 성과가 주제 두뇌를 옛 정체성으로 되끌던 문제.
// updatedAt 은 측정창 안에서 매일 갱신돼 컷오프를 무너뜨리므로 firstSeenAt(불변)을 본다.
describe('eligibleWinners — 소재 게이트 + 시대 컷오프', () => {
  const W = [
    { keyword: '여름꽃종류', firstSeenAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' },
    { keyword: '화분곰팡이', firstSeenAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
    { keyword: '신비복숭아묘목', firstSeenAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  ];
  it('since 미설정이면 시대 필터 없음 — 정체성을 바꾼 적 없는 브랜드는 종전 동작', () => {
    expect(eligibleWinners(W, undefined).map((w) => w.keyword)).toEqual(['여름꽃종류', '화분곰팡이', '신비복숭아묘목']);
  });
  it('컷오프 이전에 처음 측정된 것은 제외', () => {
    expect(eligibleWinners(W, '2026-07-31').map((w) => w.keyword)).toEqual(['신비복숭아묘목']);
  });
  it('재측정으로 updatedAt 이 컷오프를 넘어도 되살아나지 않는다 — 이게 firstSeenAt 을 둔 이유', () => {
    // 화분곰팡이: updatedAt 08-01(컷오프 이후)이지만 firstSeenAt 07-27 → 계속 제외
    expect(eligibleWinners(W, '2026-07-31').some((w) => w.keyword === '화분곰팡이')).toBe(false);
  });
  it('firstSeenAt 이 없는 구파일 항목은 updatedAt 으로 판정', () => {
    const old = [{ keyword: '모감주나무', updatedAt: '2026-07-20T00:00:00.000Z' }];
    expect(eligibleWinners(old, '2026-07-31')).toHaveLength(0);
    expect(eligibleWinners(old, '2026-07-01')).toHaveLength(1);
  });
  it('시각 정보가 전혀 없으면 옛 것으로 본다(보수적)', () => {
    expect(eligibleWinners([{ keyword: '모감주나무' }], '2026-07-31')).toHaveLength(0);
  });
});

// 일일 작업 유실(2026-08-02 실측) — 종전 조건은 예정 시각이 든 '그 한 시간' 안에 프로세스가 살아
// 있어야만 발동했다(07:30 이면 07:30~07:59). tsx watch 재기동이 그 창을 놓치면 그날 팔로워
// 스냅샷·성과 동기화가 통째로 사라진다(followers 가 07-31 에서 멈춰 08-01 이 비었다).
describe('dailyDue — 예정 시각 이후 부팅해도 그날 몫을 따라잡는다', () => {
  const at = (h: number, m: number) => new Date(2026, 7, 2, h, m);
  it('예정 시각 전에는 발동 안 함', () => {
    expect(dailyDue(at(7, 29), 7, 30, 'D', '')).toBe(false);
    expect(dailyDue(at(3, 0), 7, 30, 'D', '')).toBe(false);
  });
  it('예정 시각 정각에 발동', () => {
    expect(dailyDue(at(7, 30), 7, 30, 'D', '')).toBe(true);
  });
  it('예정 시각이 든 시간대를 지나 부팅해도 발동 — 이게 종전에 유실되던 경우', () => {
    expect(dailyDue(at(9, 0), 7, 30, 'D', '')).toBe(true);
    expect(dailyDue(at(23, 59), 7, 30, 'D', '')).toBe(true);
  });
  it('오늘 이미 발동했으면 재발동 안 함 — 재기동 시 중복 방지(영속 lastFired)', () => {
    expect(dailyDue(at(9, 0), 7, 30, 'D', 'D')).toBe(false);
  });
  it('날짜가 바뀌면 다시 발동', () => {
    expect(dailyDue(at(9, 0), 7, 30, 'D2', 'D')).toBe(true);
  });
});

// 주제창 지시문 함정(실측 3회: "자율런 실행"·"오토런 실행해줘"×2) — 오토런 지시가 콘텐츠 런이 되어
// 지시문 제목의 글이 검토함에 쌓였다. 지시문이면 런 대신 자율 틱으로 라우팅하기 위한 판별식.
describe('isAutorunDirective — 오토런 지시문 판별(순수)', () => {
  it('실측 지시문들을 잡는다', async () => {
    const { isAutorunDirective } = await import('./scheduler');
    for (const t of ['오토런 실행해줘', '자율런 실행', '오토런 돌려줘', '자율 사이클 시작', '오토런', '자율런 돌려']) {
      expect(isAutorunDirective(t), t).toBe(true);
    }
  });
  it('정상 주제·유사어는 통과시킨다', async () => {
    const { isAutorunDirective } = await import('./scheduler');
    for (const t of ['참나무 6형제 구별법, 잎 뒷면 하나로 끝내기', '자율주행 시대의 가로수', '오토런 기능을 소개하는 블로그 글 작성', '배롱나무 개화시기']) {
      expect(isAutorunDirective(t), t).toBe(false);
    }
  });
});

// 5번째 변형 실측(2026-08-09 "콘텐츠 란 실행" → 참나무 자기강화 런) — 지시 명사부를 콘텐츠런 계열까지 확장.
describe('isAutorunDirective — 콘텐츠런 계열 확장', () => {
  it('콘텐츠 런/란 지시 변형을 잡는다', async () => {
    const { isAutorunDirective } = await import('./scheduler');
    for (const t of ['콘텐츠 란 실행', '콘텐츠런 실행해줘', '콘텐츠 런 돌려줘', '콘텐츠런 시작']) {
      expect(isAutorunDirective(t), t).toBe(true);
    }
  });
  it('콘텐츠 일반어·긴 주제는 통과', async () => {
    const { isAutorunDirective } = await import('./scheduler');
    for (const t of ['콘텐츠 전략', '콘텐츠 다양성 가드 소개', '콘텐츠 런 실행 절차를 설명하는 글', '가을 콘텐츠 준비']) {
      expect(isAutorunDirective(t), t).toBe(false);
    }
  });
});

// 사용자 결정(2026-08-09): 사용자가 직접 실행한 오토런(runNow)은 케이던스를 기다리지 않고 즉시 생산한다.
// 타이머 자동 틱은 종전대로(force 없음) — 무인 도배 방지 목적 유지.
describe('runNow force — 수동 즉시 생산 플래그', () => {
  it('runNow 는 pickWork 에 force=true 를 전달한다(사용자 촉발이므로 userTriggered 도 true)', () => {
    const pickWork = vi.fn(async () => null);
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => false, pickWork, launch: vi.fn() });
    return stop.runNow().then(() => {
      expect(pickWork).toHaveBeenCalledWith(undefined, true, true);
      stop();
    });
  });

  // 2026-08-29 — 사용자가 시킨 틱과 정각 슬롯을 구분한다. force 로는 갈리지 않는다(둘 다 간격을 우회한다).
  it('runNowPersistent 는 userTriggered 를 그대로 흘린다', async () => {
    const pickWork = vi.fn(async () => null);
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => false, pickWork, launch: vi.fn() });
    await stop.runNowPersistent({ label: '오토런 지시', userTriggered: true });
    expect(pickWork).toHaveBeenCalledWith(undefined, true, true);
    stop();
  });

  it('정각 슬롯(userTriggered 미지정)은 false 로 간다 — 그게 쿼터의 주체다', async () => {
    const pickWork = vi.fn(async () => null);
    const stop = startAutoCycle({ intervalMs: 0, isBusy: () => false, pickWork, launch: vi.fn() });
    await stop.runNowPersistent({ label: '정각 슬롯(17:00)' });
    expect(pickWork).toHaveBeenCalledWith(undefined, true, false);
    stop();
  });
});

describe('lacksSpeciesAnchor — 이름·꽃말·유래 축 수종 앵커 게이트(순수)', () => {
  it('수종 앵커(○○나무)가 있으면 통과', () => {
    expect(lacksSpeciesAnchor('회화나무 꽃말과 선비 이야기')).toBe(false);
    expect(lacksSpeciesAnchor('은행나무 이름 유래')).toBe(false);
    expect(lacksSpeciesAnchor('단풍나무 꽃말')).toBe(false);
  });
  it('총칭·화초 꽃말은 기각(실측: 나무 이름 유래 총칭 검색 0, 화초 미끄러짐은 소재 게이트가 못 막음)', () => {
    expect(lacksSpeciesAnchor('나무 이름 유래 모음')).toBe(true);   // 총칭 — '나무' 단독은 앵커 아님
    expect(lacksSpeciesAnchor('장미 꽃말과 전설')).toBe(true);       // 화초 미끄러짐
    expect(lacksSpeciesAnchor('가을꽃 꽃말 알아보기')).toBe(true);
  });
  it('유래·꽃말 주제가 아니면 무관(수사적 상징 포함)', () => {
    expect(lacksSpeciesAnchor('가을 정원의 상징, 단풍 감상법')).toBe(false);
    expect(lacksSpeciesAnchor('묘목 고르는 법')).toBe(false);
  });
});

describe('normalizeIdeaCandidates — 8후보 응답 파서(순수)', () => {
  it('ideas 배열을 정리해 돌려준다(제목 정리·상한 8 — 2026-08-27 사용자 확정 5→8)', () => {
    const out = normalizeIdeaCandidates({ ideas: [
      { title: '  - "은행나무 이름 유래"', keyword: '은행나무 유래', subNiche: '수종 이야기' },
      { title: '단풍 드는 순서', keyword: '' },
      { title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }, { title: 'f' }, { title: 'g' },
    ] });
    expect(out).toHaveLength(8);
    expect(out[0]!.title.startsWith('은행나무')).toBe(true); // 선행 기호·따옴표 정리
    expect(out[0]!.keyword).toBe('은행나무 유래');
    expect(out[0]!.subNiche).toBe('수종 이야기');
    expect(out[1]).toEqual({ title: '단풍 드는 순서' }); // 빈 keyword 생략
  });
  it('중복 제목 제거·무효 항목 건너뜀', () => {
    const out = normalizeIdeaCandidates({ ideas: [{ title: '같은 제목' }, { title: '같은 제목' }, { title: '' }, null, { title: '다른 제목' }] });
    expect(out.map((x) => x.title)).toEqual(['같은 제목', '다른 제목']);
  });
  it('구형 단일 오브젝트 응답도 1건으로 수용(하위호환)', () => {
    expect(normalizeIdeaCandidates({ title: '단일 제안', keyword: 'k' })).toEqual([{ title: '단일 제안', keyword: 'k' }]);
    expect(normalizeIdeaCandidates(null)).toEqual([]);
  });
});

// 후보 수요 판정(2026-08-26) — 실측: 우리 문구의 월 검색량이 0~30 이었고('가을 거름' 0·'사과나무 비료' 30),
// '비료' 계열 데이터랩은 8월이 3월의 13% 였다. 그 두 축을 후보 단계에서 코드로 보게 하는 판정부.
describe('demandGateDecision — 후보 검색 수요 판정(순수)', () => {
  const cfg = { minVolume: 30, minSeason: 0.25 };
  const mk = (over: Partial<DemandRow> & { keyword: string }): DemandRow => ({ volume: 0, approx: false, familyMax: 0, ...over });

  it('검색량 하한 미달은 reject — 문구에 실측 검색량과 계열 최대가 남는다', () => {
    const rows = new Map<string, DemandRow>([['가을 거름', mk({ keyword: '가을 거름', volume: 12, familyMax: 12 })]]);
    const d = demandGateDecision(rows, '가을 거름', cfg);
    expect(d.verdict).toBe('reject');
    expect(d.line).toContain('12/월');       // 기각 사유가 숫자로 남아야 재제안 억제에 쓰인다
    expect(d.line).toContain('계열 최대');    // 표기 교체 후보(연관어)까지 봐도 미달이었음을 남긴다
  });

  it('계열 최대가 하한을 넘으면 기각하지 않는다(표기만 다른 수요는 살린다)', () => {
    // familyTop 은 내용 토큰(가을·거름)을 전부 포함하는 표기여야 실제 familyVolume 산출물과 일치한다
    // ('밑거름'은 '가을'을 포함하지 않아 애초에 계열로 잡히지 않는 값이었다 — 픽스처 교정).
    const rows = new Map<string, DemandRow>([['가을 거름', mk({ keyword: '가을 거름', volume: 0, familyMax: 1220, familyTop: '가을 밑거름 주는 시기' })]]);
    expect(demandGateDecision(rows, '가을 거름', cfg).verdict).toBe('pass');
  });

  it('공백만 다른 표기로 조회해도 같은 행을 찾는다(정규화 폴백)', () => {
    const rows = new Map<string, DemandRow>([['가을 거름', mk({ keyword: '가을 거름', volume: 12, familyMax: 12 })]]);
    const d = demandGateDecision(rows, '가을거름', cfg);
    expect(d.verdict).toBe('reject');
    expect(d.line).toContain('"가을 거름"');   // 문구는 조회한 표기가 아니라 실측 행의 표기를 쓴다
  });

  it('relax 면 하한 미달 기각이 후순위로 바뀐다(마지막 라운드 기아 방지 밸브)', () => {
    const rows = new Map<string, DemandRow>([['가을 거름', mk({ keyword: '가을 거름', volume: 12, familyMax: 12 })]]);
    expect(demandGateDecision(rows, '가을 거름', cfg, { relax: true })).toMatchObject({ verdict: 'demote', relaxed: true });
    expect(demandGateDecision(rows, '가을 거름', cfg).verdict).toBe('reject'); // 기본값은 종전대로 하드 기각
  });

  it('relax 는 통과·비수기 판정을 바꾸지 않는다(밸브는 기각에만 작용)', () => {
    const rows = new Map<string, DemandRow>([
      ['배롱나무 가을 식재', mk({ keyword: '배롱나무 가을 식재', volume: 480, familyMax: 480, seasonIdx: 0.62 })],
      ['사과나무 비료', mk({ keyword: '사과나무 비료', volume: 300, familyMax: 300, seasonIdx: 0.13 })],
    ]);
    expect(demandGateDecision(rows, '배롱나무 가을 식재', cfg, { relax: true })).toMatchObject({ verdict: 'pass' });
    expect(demandGateDecision(rows, '배롱나무 가을 식재', cfg, { relax: true }).relaxed).toBeUndefined();
    const off = demandGateDecision(rows, '사과나무 비료', cfg, { relax: true });
    expect(off.verdict).toBe('demote');
    expect(off.relaxed).toBeUndefined();   // 비수기는 원래 후순위 — 밸브가 만든 게 아니다(채택 로그가 갈린다)
  });

  it('비수기(시즌 지수 하한 미달)는 기각이 아니라 demote', () => {
    const rows = new Map<string, DemandRow>([['사과나무 비료', mk({ keyword: '사과나무 비료', volume: 300, familyMax: 300, seasonIdx: 0.13, direction: '하락' })]]);
    const d = demandGateDecision(rows, '사과나무 비료', cfg);
    expect(d.verdict).toBe('demote');
    expect(d.line).toContain('시즌 0.13');
  });

  it('검색량·시즌 둘 다 충분하면 pass', () => {
    const rows = new Map<string, DemandRow>([['배롱나무 가을 식재', mk({ keyword: '배롱나무 가을 식재', volume: 480, familyMax: 480, seasonIdx: 0.62, direction: '상승' })]]);
    expect(demandGateDecision(rows, '배롱나무 가을 식재', cfg).verdict).toBe('pass');
  });

  it('rows 에 없는 키워드는 unknown + 빈 문구(미조회는 수요 0 이 아니다 — fail-open)', () => {
    const rows = new Map<string, DemandRow>([['다른 키워드', mk({ keyword: '다른 키워드', volume: 900, familyMax: 900 })]]);
    expect(demandGateDecision(rows, '조회 안 한 키워드', cfg)).toEqual({ verdict: 'unknown', line: '' });
    expect(demandGateDecision(new Map(), '아무거나', cfg)).toEqual({ verdict: 'unknown', line: '' });
  });

  it('keyword 자체가 없는 후보도 unknown(게이트 생략)', () => {
    expect(demandGateDecision(new Map(), undefined, cfg)).toEqual({ verdict: 'unknown', line: '' });
  });
});

// 후순위 보관함의 채택 순서(순수) — 비수기(rank 0)가 기아 방지(rank 1)를 항상 이기고, 같은 rank 는 후보 순서.
describe('pickDemoted — 후순위 후보 선택(순수)', () => {
  const e = (title: string, rank: number) => ({ idea: { title }, rank });

  it('rank 오름차순 — 기아 방지(1)가 먼저 담겨도 비수기(0)가 이긴다', () => {
    expect(pickDemoted([e('기아', 1), e('비수기', 0)])?.idea.title).toBe('비수기');
  });
  it('같은 rank 면 먼저 담긴 후보(두뇌 제안 순서)를 유지한다', () => {
    expect(pickDemoted([e('첫째', 0), e('둘째', 0)])?.idea.title).toBe('첫째');
  });
  it('비어 있으면 undefined(폴백 없음)', () => {
    expect(pickDemoted([])).toBeUndefined();
    expect(pickDemoted([e('유일', 1)])?.idea.title).toBe('유일');
  });
});

// 라운드 끝 채택 경합(2026-08-26 최종 리뷰 I3) — 후순위 보관함 vs 유사 폴백. rank 1(기아 방지 밸브)은
// '이 표기로는 아무도 안 찾는다'가 실측된 후보라, 검색량이 있을 수 있는 유사 폴백보다 약하다.
describe('pickRoundAdoption — 후순위 vs 유사 폴백(순수)', () => {
  const e = (title: string, rank: number) => ({ idea: { title }, rank });

  it('rank 1(수요 하한 미달)은 유사 폴백에 진다 — 0/월 신규가 검색량 있는 소재를 이기면 안 된다', () => {
    expect(pickRoundAdoption([e('수요미달', 1)], true)).toEqual({ source: 'fallback' });
  });
  it('rank 0(비수기)은 유사 폴백을 이긴다 — 소재 자체엔 수요가 있고 아직 안 다룬 새 소재다', () => {
    expect(pickRoundAdoption([e('비수기', 0)], true)).toEqual({ source: 'demoted', pick: e('비수기', 0) });
  });
  it('폴백이 없으면 rank 1 도 채택된다(좌초 대신 생산)', () => {
    expect(pickRoundAdoption([e('수요미달', 1)], false)).toEqual({ source: 'demoted', pick: e('수요미달', 1) });
  });
  it('후순위가 비고 폴백만 있으면 폴백', () => {
    expect(pickRoundAdoption([], true)).toEqual({ source: 'fallback' });
  });
  it('둘 다 없으면 undefined(이번 라운드 채택 없음)', () => {
    expect(pickRoundAdoption([], false)).toBeUndefined();
  });
  it('rank 0 이 섞여 있으면 폴백이 있어도 rank 0 을 고른다(pickDemoted 순서 그대로)', () => {
    expect(pickRoundAdoption([e('수요미달', 1), e('비수기', 0)], true)).toEqual({ source: 'demoted', pick: e('비수기', 0) });
  });
});

describe('demandGateDecision — 기억된 수요 미달(opts.remembered)', () => {
  const cfg = { minVolume: 30, minSeason: 0.25 };
  const rich = new Map<string, DemandRow>([
    ['가을 거름', { keyword: '가을 거름', volume: 5400, approx: false, familyMax: 5400 }],
  ]);

  it('remembered 가 있으면 rows 를 무시하고 그때의 실측 줄로 기각한다(재조회 0)', () => {
    expect(demandGateDecision(rich, '가을 거름', cfg, { remembered: { line: '"가을 거름" 0/월(계열 최대 0)' } }))
      .toEqual({ verdict: 'reject', line: '"가을 거름" 0/월(계열 최대 0)' });
  });

  it('마지막 라운드 완화(relax)는 기억에도 그대로 적용된다 — 후순위(relaxed)', () => {
    expect(demandGateDecision(new Map(), '가을 거름', cfg, { relax: true, remembered: { line: 'L' } }))
      .toEqual({ verdict: 'demote', line: 'L', relaxed: true });
  });

  it('remembered 가 없으면 종전 동작 그대로', () => {
    expect(demandGateDecision(rich, '가을 거름', cfg).verdict).toBe('pass');
  });
});

// 기억 기록 자격(순수) — 호출부의 `!remembered` 가드를 테스트로 고정한다. 이 가드가 지워지면 후보 루프가
// 매 틱 ts 를 갱신해 TTL 30일이 영영 만료되지 않는 '조용한 영구 금지'가 된다(읽기가 쓰기를 부르는 사고).
describe('shouldRememberDemandReject — 기각 기억 기록 자격(순수)', () => {
  it('이미 기억된 건은 다시 쓰지 않는다 — 읽기가 쓰기를 부르면 TTL 이 영영 갱신된다', () => {
    expect(shouldRememberDemandReject({ verdict: 'reject' }, { keyword: '가을 거름', line: 'L', ts: '2026-08-01T00:00:00.000Z' }, '가을 거름')).toBe(false);
    // 마지막 라운드 밸브가 기억을 후순위로 낮춘 경우도 마찬가지(relaxed 만 보고 쓰면 같은 사고가 난다).
    expect(shouldRememberDemandReject({ verdict: 'demote', relaxed: true }, { keyword: '가을 거름', line: 'L', ts: '2026-08-01T00:00:00.000Z' }, '가을 거름')).toBe(false);
  });

  it('이번 틱의 API 하드 기각은 기억한다', () => {
    expect(shouldRememberDemandReject({ verdict: 'reject' }, null, '가을 거름')).toBe(true);
  });

  it('마지막 라운드 밸브가 낮춘 후순위(relaxed)도 기억한다 — 원 판정이 reject 였다', () => {
    expect(shouldRememberDemandReject({ verdict: 'demote', relaxed: true }, null, '가을 거름')).toBe(true);
  });

  it('순수 비수기 demote 는 기억하지 않는다 — 수요는 있고 지금이 아닐 뿐, 다음 시즌에 다시 제안돼야 한다', () => {
    expect(shouldRememberDemandReject({ verdict: 'demote' }, null, '사과나무 비료')).toBe(false);
  });

  it('통과는 기억하지 않는다', () => {
    expect(shouldRememberDemandReject({ verdict: 'pass' }, null, '배롱나무 가을 식재')).toBe(false);
  });

  it('unknown(미조회·조회 실패)은 기억하지 않는다 — 측정 안 한 것을 30일 금지로 굳히면 안 된다(fail-open)', () => {
    expect(shouldRememberDemandReject({ verdict: 'unknown' }, null, '조회 안 한 키워드')).toBe(false);
  });

  it('keyword 가 없으면 기록 대상이 아니다(기억 키가 없다)', () => {
    expect(shouldRememberDemandReject({ verdict: 'reject' }, null, undefined)).toBe(false);
  });
});
