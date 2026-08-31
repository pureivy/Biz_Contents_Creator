import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeWindow, currentOccurrence, nextOccurrence, isDue, sanitizeTopic, PromiseStore, MAX_PENDING, SEASON_WINDOW_DAYS, EXPIRE_AFTER_DAYS } from './promises';

describe('normalizeWindow', () => {
  it('"N월"과 계절어를 도래 월로 정규화한다', () => {
    expect(normalizeWindow('9월')).toBe(9);
    expect(normalizeWindow('12 월')).toBe(12);
    expect(normalizeWindow('가을')).toBe(9);
    expect(normalizeWindow('내년 봄')).toBe(3);
  });
  it('미지정·해석 불가는 null(자동 이행 제외 — 수동 처리)', () => {
    expect(normalizeWindow(undefined)).toBeNull();
    expect(normalizeWindow('적절한 때')).toBeNull();
    expect(normalizeWindow('13월')).toBeNull();
  });
});

describe('sanitizeTopic — 예고 주제는 다음 런의 프롬프트가 된다', () => {
  it('이모지·제어문자 제거, 콜론 제거(그라운딩 seedKeyword 절단 방지), 공백 접기, 80자 캡', () => {
    expect(sanitizeTopic('가을 파종: 배추 심기 🌱')).toBe('가을 파종 배추 심기');
    expect(sanitizeTopic('제목：전각 콜론')).toBe('제목 전각 콜론');
    expect(sanitizeTopic('줄\n바꿈\t문자')).toBe('줄 바꿈 문자');
    expect(sanitizeTopic('가'.repeat(120)).length).toBe(80);
  });
});

describe('isDue — 시즌 창(도래 월 1일부터 60일)', () => {
  const sep = { dueMonth: 9 };
  it('창 도래 전 false, 창 안 true, 창(60일) 지나면 false', () => {
    expect(isDue(sep, new Date('2026-08-15T00:00:00+09:00'))).toBe(false);
    expect(isDue(sep, new Date('2026-09-01T00:00:00+09:00'))).toBe(true);
    expect(isDue(sep, new Date('2026-10-20T00:00:00+09:00'))).toBe(true);  // 60일 창 안
    expect(isDue(sep, new Date('2026-11-15T00:00:00+09:00'))).toBe(false); // 창 경과 — 철 지난 발화 방지
  });
  it('창을 놓치면 이듬해 같은 창에 재도래', () => {
    expect(isDue(sep, new Date('2027-09-02T00:00:00+09:00'))).toBe(true);
    expect(nextOccurrence(sep, new Date('2026-11-15T00:00:00+09:00'))!.toISOString().slice(0, 7)).toBe('2027-08'); // KST 2027-09-01 = UTC 08-31
  });
  it('12월 창은 이듬해 1월까지 이어진다(연도 랩)', () => {
    expect(isDue({ dueMonth: 12 }, new Date('2027-01-15T00:00:00+09:00'))).toBe(true); // 2026-12-01 창의 60일 안
  });
  it('시기 미상(null)은 자동 이행 대상이 아니다', () => {
    expect(isDue({ dueMonth: null }, new Date('2026-09-01T00:00:00+09:00'))).toBe(false);
  });
  it('손상 dueMonth(범위 밖)는 도래하지 않는다', () => {
    expect(isDue({ dueMonth: 0 as unknown as number }, new Date())).toBe(false);
    expect(currentOccurrence(13, new Date())).toBeNull();
  });
});

describe('PromiseStore', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'promises-'));
  it('생성·sourceId 재등록 방지·이행 후 30일 재약속 루프 방지', () => {
    const s = new PromiseStore(tmp());
    const a = s.create({ topic: '배롱나무 가을 식재법', window: '9월', sourceKind: 'shorts', sourceId: 'short_1', brand: 'b' })!;
    expect(a.dueMonth).toBe(9);
    expect(s.create({ topic: '전혀 다른 주제', sourceKind: 'shorts', sourceId: 'short_1', brand: 'b' })!.id).toBe(a.id); // 같은 출처는 1약속
    expect(s.create({ topic: '배롱나무 가을식재법', window: '10월', sourceKind: 'cardnews', brand: 'b' })!.id).toBe(a.id); // 동일 주제 병합
    s.update(a.id, { status: 'fulfilled', fulfilledPieceId: 'piece_x' });
    expect(s.create({ topic: '배롱나무 가을 식재법', sourceKind: 'cardnews', brand: 'b' })!.id).toBe(a.id); // 방금 갚은 약속 재등록 → 병합
  });
  it('브랜드 명시(null=범용)와 미이행 캡', () => {
    const s = new PromiseStore(tmp());
    expect(s.create({ topic: 'T', sourceKind: 'shorts', brand: null })!.brand).toBeUndefined();
    for (let i = 0; i < MAX_PENDING; i++) s.create({ topic: `주제 ${i}`, sourceKind: 'manual', brand: 'b' });
    expect(s.create({ topic: '초과 등록', sourceKind: 'manual', brand: 'b' })).toBeNull(); // 남발 가드
  });
  it('dropBySource — 소스 폐기 시 그 소스의 pending 만 dropped(다른 소스·비 pending 불변)', () => {
    const s = new PromiseStore(tmp());
    const a = s.create({ topic: '폐기될 카드의 예고', window: '9월', sourceKind: 'cardnews', sourceId: 'card_x', brand: 'b' })!;
    const b = s.create({ topic: '살아있는 쇼츠의 예고', window: '10월', sourceKind: 'shorts', sourceId: 'short_y', brand: 'b' })!;
    expect(s.dropBySource('card_x')).toBe(1);
    expect(s.list().find((p) => p.id === a.id)?.status).toBe('dropped');
    expect(s.list().find((p) => p.id === b.id)?.status).toBe('pending');
    expect(s.dropBySource('card_x')).toBe(0); // 멱등 — 이미 dropped 는 재계수 안 함
  });
  it('nextDue — 시기 명시+창 안만, 도래 이른 순; pending 정렬도 같은 기준(시기 미상은 뒤)', () => {
    const s = new PromiseStore(tmp());
    s.create({ topic: '시기 미상 건', sourceKind: 'manual', brand: 'b' });
    s.create({ topic: '가을 건', window: '9월', sourceKind: 'manual', brand: 'b' });
    const jul = new Date('2026-07-30T12:00:00+09:00');
    expect(s.nextDue('b', jul)).toBeUndefined();                    // 9월 창 전 + 미상 건은 자동 대상 아님
    const sep = new Date('2026-09-02T12:00:00+09:00');
    expect(s.nextDue('b', sep)?.topic).toBe('가을 건');
    expect(s.pending('b', sep).map((p) => p.topic)).toEqual(['가을 건', '시기 미상 건']); // 브리핑 표시도 픽커와 일치
  });
  it('reconcile — 이행 piece 가 사라지거나 error 면 pending 복원', () => {
    const s = new PromiseStore(tmp());
    const a = s.create({ topic: 'A', window: '7월', sourceKind: 'manual', brand: 'b' })!;
    const b = s.create({ topic: 'B', window: '7월', sourceKind: 'manual', brand: 'b' })!;
    s.update(a.id, { status: 'fulfilled', fulfilledPieceId: 'piece_dead' });
    s.update(b.id, { status: 'fulfilled', fulfilledPieceId: 'piece_ok' });
    const reverted = s.reconcile('b', (id) => (id === 'piece_dead' ? 'missing' : 'ok'));
    expect(reverted).toBe(1);
    expect(s.get(a.id)?.status).toBe('pending');
    expect(s.get(b.id)?.status).toBe('fulfilled');
  });
});

// 만료 청소(2026-08-28) — 실측: 7/29~8/1 12건 적재 후 27일간 fulfilled 0건, 캡 만석으로 그 사이
// 모든 신규 예고가 조용히 거절됐다. 창을 놓친 약속이 이듬해까지 슬롯을 점유하던 구조가 원인.
describe('PromiseStore.expire — 만료 자동 청소', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'promises-exp-'));
  const d = (iso: string): Date => new Date(`${iso}T03:00:00Z`); // KST 정오 — 경계 애매함 회피

  /** 등록 시각을 과거로 되돌린 스토어 — 실제 백로그(7월 말 등록)를 재현한다. */
  const storeCreatedAt = (createdIso: string, windows: string[]): PromiseStore => {
    const dir = tmp();
    const s0 = new PromiseStore(dir);
    for (const w of windows) s0.create({ topic: `주제 ${w}`, window: w, sourceKind: 'shorts', brand: 'b' });
    const file = path.join(dir, 'index.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<{ createdTs: string }>;
    for (const r of raw) r.createdTs = createdIso;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');
    return new PromiseStore(dir);
  };

  it('유예 기간이 지난 pending 을 dropped 로 비운다', () => {
    const s = new PromiseStore(tmp());
    const p = s.create({ topic: '8월 소재', window: '8월', sourceKind: 'shorts', brand: 'b' })!;
    // 8/1 도래 + 90일(창 60 + 유예 30) → 10월 말 이후 만료
    expect(s.expire('b', d('2026-10-01'))).toEqual([]);       // 아직 유예 안
    const gone = s.expire('b', d('2026-11-15'));
    expect(gone.map((x) => x.id)).toEqual([p.id]);
    expect(s.get(p.id)!.status).toBe('dropped');
  });

  // 실사고(2026-08-28) — 첫 자율 틱이 9·10·11월 약속 8건을 "창 경과"로 통째 폐기했다. 원인은 기준 시각을
  // currentOccurrence 로 잡은 것: 8월에 9월을 물으면 **작년 9월**이 나와 도래 전 약속이 만료로 판정됐다.
  // 기준은 '등록 후 처음 오는 도래'여야 한다 — 약속은 그 창을 한 번 통과해 봐야 놓쳤다고 말할 수 있다.
  it('아직 도래하지 않은 약속은 지우지 않는다(7월 등록 · 8월 시점의 9~11월 약속)', () => {
    const s = storeCreatedAt('2026-07-29T00:00:00.000Z', ['9월', '10월', '11월']);
    expect(s.expire('b', d('2026-08-28'))).toEqual([]);
    for (const p of s.list()) expect(p.status).toBe('pending');
  });

  it('등록 후 첫 창이 열리고 유예까지 지나야 만료된다', () => {
    const s = storeCreatedAt('2026-07-29T00:00:00.000Z', ['9월', '11월']);
    // 9월 창(9/1~10/30) + 유예 30일 → 11/30 이후. 11월 약속은 아직 창 안.
    expect(s.expire('b', d('2026-11-15'))).toEqual([]);
    expect(s.expire('b', d('2026-12-15')).map((x) => x.topic)).toEqual(['주제 9월']);
    // 11월 창(11/1~12/31) + 유예 → 이듬해 1/30 이후
    expect(s.expire('b', d('2027-03-01')).map((x) => x.topic)).toEqual(['주제 11월']);
  });

  it('등록 달과 도래 달이 같으면 그 달의 창을 첫 창으로 본다', () => {
    const s = storeCreatedAt('2026-08-20T00:00:00.000Z', ['8월']);
    expect(s.expire('b', d('2026-10-01'))).toEqual([]);        // 창 안
    expect(s.expire('b', d('2026-11-15'))).toHaveLength(1);    // 창 + 유예 경과
  });

  it('시즌 창 안(이행 기회가 살아 있는 동안)에는 절대 지우지 않는다', () => {
    const s = new PromiseStore(tmp());
    const p = s.create({ topic: '9월 소재', window: '9월', sourceKind: 'shorts', brand: 'b' })!;
    for (const day of ['2026-09-01', '2026-09-15', '2026-10-20']) {
      expect(s.expire('b', d(day))).toEqual([]);
      expect(s.get(p.id)!.status).toBe('pending');
    }
    expect(isDue(s.get(p.id)!, d('2026-09-15'))).toBe(true); // 같은 창 정의를 공유한다
  });

  it('유예는 창보다 길다 — 며칠 늦었다고 약속을 버리지 않는다', () => {
    expect(EXPIRE_AFTER_DAYS).toBeGreaterThan(SEASON_WINDOW_DAYS);
  });

  it('시기 미상은 건드리지 않는다 — 사람이 처리하기로 한 목록을 뺏지 않는다', () => {
    const s = new PromiseStore(tmp());
    const p = s.create({ topic: '시기 없음', sourceKind: 'manual', brand: 'b' })!;
    expect(p.dueMonth).toBeNull();
    expect(s.expire('b', d('2030-01-01'))).toEqual([]);
    expect(s.get(p.id)!.status).toBe('pending');
  });

  it('다른 브랜드·비 pending 은 불변', () => {
    const s = new PromiseStore(tmp());
    const other = s.create({ topic: '남의 브랜드', window: '8월', sourceKind: 'shorts', brand: 'other' })!;
    const done = s.create({ topic: '이미 이행', window: '8월', sourceKind: 'shorts', brand: 'b' })!;
    s.update(done.id, { status: 'fulfilled', fulfilledPieceId: 'piece_x' });
    expect(s.expire('b', d('2026-12-01'))).toEqual([]);
    expect(s.get(other.id)!.status).toBe('pending');
    expect(s.get(done.id)!.status).toBe('fulfilled');
  });

  it('만료로 슬롯이 비면 새 예고가 다시 등록된다 — 이 기능의 존재 이유', () => {
    const s = new PromiseStore(tmp());
    for (let i = 0; i < MAX_PENDING; i++) s.create({ topic: `묵은 주제 ${i}`, window: '8월', sourceKind: 'shorts', brand: 'b' });
    const late = d('2026-12-01');
    expect(s.create({ topic: '새 예고', window: '12월', sourceKind: 'shorts', brand: 'b' })).toBeNull(); // 만석
    expect(s.expire('b', late)).toHaveLength(MAX_PENDING);
    expect(s.create({ topic: '새 예고', window: '12월', sourceKind: 'shorts', brand: 'b' })).not.toBeNull();
  });
});
