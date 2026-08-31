import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PieceStore, selectResumablePiece, blogUrlForPiece, normalizeBlogUrl, cadenceBaselineTs, autoDraftBlockedByFactGate, planAutoNaverDraft, shouldAutoDeriveOnDecision } from './pieces';
import type { Piece } from './pieces';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pieces-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe('PieceStore (라이프사이클 영속)', () => {
  it('create → get/list 왕복 + 디스크 지속(원자적 index.json)', () => {
    const s = new PieceStore(dir);
    const p = s.create({ title: '초보자 홈카페 원두 고르는 법', keyword: '원두 고르는 법', subNiche: '홈카페' });
    expect(p.stage).toBe('idea');
    expect(p.errors).toBe(0);
    expect(s.get(p.id)?.title).toBe('초보자 홈카페 원두 고르는 법');
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);

    // 새 인스턴스가 디스크에서 재로드(재시작 내구성)
    const reloaded = new PieceStore(dir);
    expect(reloaded.get(p.id)?.keyword).toBe('원두 고르는 법');
    expect(reloaded.list()).toHaveLength(1);
  });

  it('clusterSeedId — 생성 시 기록되고 재로드에도 유지된다', () => {
    const s = new PieceStore(dir);
    const p = s.create({ title: '추희자두 후숙, 며칠이면 될까', keyword: '추희자두 후숙', clusterSeedId: 'cluster_abc' });
    expect(s.get(p.id)?.clusterSeedId).toBe('cluster_abc');
    expect(new PieceStore(dir).get(p.id)?.clusterSeedId).toBe('cluster_abc');
  });

  it('setStage / setPublished — 발행 시 stage=published + url', () => {
    const s = new PieceStore(dir);
    const p = s.create({ title: 'x' });
    s.setStage(p.id, 'ready');
    expect(s.get(p.id)?.stage).toBe('ready');
    const pub = s.setPublished(p.id, 'https://blog.naver.com/foo/123');
    expect(pub?.stage).toBe('published');
    expect(pub?.publishedUrl).toBe('https://blog.naver.com/foo/123');
  });

  it('recordError — 캡(3회) 초과 시 error 로 종료(폭주 방지)', () => {
    const s = new PieceStore(dir);
    const p = s.create({ title: 'x', stage: 'draft' });
    expect(s.recordError(p.id)?.stage).toBe('draft'); // 1
    expect(s.recordError(p.id)?.stage).toBe('draft'); // 2
    const capped = s.recordError(p.id); // 3 → 종료
    expect(capped?.errors).toBe(3);
    expect(capped?.stage).toBe('error');
  });

  it('update 는 createdTs 보존 + updatedTs 갱신', () => {
    const s = new PieceStore(dir);
    const p = s.create({ title: 'x' });
    const u = s.update(p.id, { seoScore: 72 });
    expect(u?.createdTs).toBe(p.createdTs);
    expect(u?.seoScore).toBe(72);
  });
});

describe('selectResumablePiece (재개 우선 — 완전 자율 내구성)', () => {
  const mk = (over: Partial<Piece>): Piece => ({
    id: over.id ?? 'p', title: 't', stage: 'idea', createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z', ...over,
  });

  it('비종료(idea/research/draft) & 라이브 런 없음 → 재개 선택', () => {
    const p = mk({ id: 'a', stage: 'idea' });
    expect(selectResumablePiece([p], () => false)?.id).toBe('a');
  });

  it('사용자 양보로 죽은 draft(런 종료) → 재개 대상(고아 방지)', () => {
    const stranded = mk({ id: 'a', stage: 'draft', runId: 'dead-run' });
    const isLive = (rid?: string) => rid === 'live-run'; // dead-run 은 살아있지 않음
    expect(selectResumablePiece([stranded], isLive)?.id).toBe('a');
  });

  it('라이브 런이 붙은 draft → 재개 안 함(진행 중이니 대기)', () => {
    const running = mk({ id: 'a', stage: 'draft', runId: 'live-run' });
    const isLive = (rid?: string) => rid === 'live-run';
    expect(selectResumablePiece([running], isLive)).toBeNull();
  });

  it('종료 스테이지(ready/published/error)는 절대 재개 안 함', () => {
    const pieces = [mk({ id: 'r', stage: 'ready' }), mk({ id: 'p', stage: 'published' }), mk({ id: 'e', stage: 'error' })];
    expect(selectResumablePiece(pieces, () => false)).toBeNull();
  });

  it('재개 대상 여럿이면 가장 오래된 것', () => {
    const older = mk({ id: 'old', stage: 'idea', createdTs: '2026-01-01T00:00:00.000Z' });
    const newer = mk({ id: 'new', stage: 'draft', createdTs: '2026-02-01T00:00:00.000Z' });
    expect(selectResumablePiece([newer, older], () => false)?.id).toBe('old');
  });
});

describe('autoDraftBlockedByFactGate — 자동 임시저장 차단 판정(사용자 확정: 자동 경로만 차단)', () => {
  const info = (status: 'pass' | 'hold' | 'error') => ({ status, unsupported: [], contradicted: [], checkedTs: 't' });
  it('hold·error 는 차단, pass·미실행은 통과', () => {
    expect(autoDraftBlockedByFactGate({ factGate: info('hold') })).toBe(true);
    expect(autoDraftBlockedByFactGate({ factGate: info('error') })).toBe(true);
    expect(autoDraftBlockedByFactGate({ factGate: info('pass') })).toBe(false);
    expect(autoDraftBlockedByFactGate({})).toBe(false);
  });
});

// 2026-08-27 사용자 확정 — 블로그는 근거 유무와 무관하게 전부 수동 검토 대기(자동 임시저장 기본 off).
// 결정 로직은 순수 함수 하나에만 있어야 한다(main.ts 는 이 결정에 따라 효과만 수행) — 여기서 네 갈래를 고정한다.
describe('planAutoNaverDraft — 자동 임시저장·리비전 결정(전면 수동 검토)', () => {
  const base = { runId: 'r1', stage: 'ready' as const };
  const on = { autoNaverDraft: true, seoMin: 80 };
  const off = { autoNaverDraft: false, seoMin: 80 };
  const hold = { status: 'hold' as const, unsupported: ['근거 없는 문장'], contradicted: [], checkedTs: 't' };

  it('off + SEO 통과 → 임시저장 호출 대신 draft-off(수동 검토 대기), on 이면 기존대로 draft', () => {
    expect(planAutoNaverDraft({ ...base, seoScore: 90 }, off)).toBe('draft-off');
    expect(planAutoNaverDraft({ ...base, seoScore: 90 }, on)).toBe('draft');
  });

  it('off 여도 SEO 판단·자동 리비전 결정은 그대로 수행한다(리비전은 유지)', () => {
    expect(planAutoNaverDraft({ ...base, seoScore: 70 }, off)).toBe('revise');
    expect(planAutoNaverDraft({ ...base, seoScore: 70 }, on)).toBe('revise');
    expect(planAutoNaverDraft({ ...base, seoScore: 70, autoRevisions: 1 }, off)).toBe('revise-exhausted');
    expect(planAutoNaverDraft({ ...base }, off)).toBe('revise-exhausted'); // SEO 미측정
  });

  it('off 면 사실 게이트 보류보다 먼저 걸러진다 — hold 로그는 on 일 때만 의미', () => {
    expect(planAutoNaverDraft({ ...base, seoScore: 90, factGate: hold }, off)).toBe('draft-off');
    expect(planAutoNaverDraft({ ...base, seoScore: 90, factGate: hold }, on)).toBe('fact-hold');
  });

  it('런 없음·ready 아님·이미 네이버 초안 있음은 skip(꺼짐 로그도 내지 않는다)', () => {
    expect(planAutoNaverDraft({ stage: 'ready', seoScore: 90 }, off)).toBe('skip');
    expect(planAutoNaverDraft({ ...base, stage: 'draft', seoScore: 90 }, off)).toBe('skip');
    expect(planAutoNaverDraft({ ...base, seoScore: 90, naverDraftUrl: 'https://blog.naver.com/x/1' }, off)).toBe('skip');
  });
});

// 킬스위치 회귀 가드(2026-08-26 최종 리뷰 F1) — FACT_GATE=off 로 돌린 런은 fact_gate.json 을 남기지
// 않는다. advancePieceReady 가 그때 키를 아예 안 실으면 직전 런의 hold 가 그대로 남아 자동 임시저장이
// 계속 막힌다("off 인데 안 꺼짐"). update 는 스프레드라 undefined 도 키로 실려 실제로 지워진다.
describe('PieceStore.update — factGate: undefined 로 이전 보류 해제', () => {
  it('hold 였던 piece 에 undefined 패치를 주면 자동 임시저장 차단이 풀린다(디스크에도 미영속)', () => {
    const s = new PieceStore(dir);
    const p = s.create({ title: '감나무 가을 전정' });
    s.update(p.id, { factGate: { status: 'hold', unsupported: ['근거 없는 문장'], contradicted: [], checkedTs: 't' } });
    expect(autoDraftBlockedByFactGate(s.get(p.id)!)).toBe(true);

    s.update(p.id, { factGate: undefined });
    expect(s.get(p.id)!.factGate).toBeUndefined();
    expect(autoDraftBlockedByFactGate(s.get(p.id)!)).toBe(false);
    // 재시작 후에도 풀린 상태여야 한다(JSON.stringify 가 undefined 키를 떨군다).
    expect(autoDraftBlockedByFactGate(new PieceStore(dir).get(p.id)!)).toBe(false);
  });
});

// 2026-08-28 사용자 확정 — 파생은 '네이버 비공개 저장 뒤'. 저장 시점에 진짜 글 주소(logNo=…)가 나오고,
// 그때 파생해야 파생물 캡션에 원본 블로그 링크가 붙는다. 08-27 의 'ready 즉시'는 링크를 잃어 되돌렸다.
const ALL_DECISIONS = ['draft-off', 'revise-exhausted', 'draft', 'fact-hold', 'revise', 'skip'] as const;

describe('shouldAutoDeriveOnDecision — 세트 파생 시점(네이버 비공개 저장 뒤)', () => {
  afterEach(() => { delete process.env.DERIVE_ON_READY; });

  it('어떤 결정에서도 여기선 파생하지 않는다 — 저장 성공 훅이 전담한다', () => {
    for (const d of ALL_DECISIONS) {
      expect(shouldAutoDeriveOnDecision(d, false)).toBe(false);
      expect(shouldAutoDeriveOnDecision(d, true)).toBe(false);
    }
  });

  it('DERIVE_ON_READY=1 이면 종전(08-27) 동작으로 되돌아간다 — 링크는 포기', () => {
    process.env.DERIVE_ON_READY = '1';
    expect(shouldAutoDeriveOnDecision('draft-off', false)).toBe(true);
    expect(shouldAutoDeriveOnDecision('revise-exhausted', false)).toBe(true);
    expect(shouldAutoDeriveOnDecision('revise', false)).toBe(false);
    expect(shouldAutoDeriveOnDecision('skip', false)).toBe(false);
    // 자동 저장이 켜져 있으면 킬스위치와 무관하게 저장 훅이 담당한다(종전 계약 그대로).
    for (const d of ALL_DECISIONS) expect(shouldAutoDeriveOnDecision(d, true)).toBe(false);
  });
});

// 비공개 발행 URL 정규화(2026-08-28) — 파이썬 기본 모드가 '비공개 발행'이라 저장 직후 에디터가 돌려주는
// 긴 PostView 주소가 들어온다. 캡션에 그대로 넣으면 한 줄을 잡아먹고 편집 세션 파라미터까지 노출된다.
describe('blogUrlForPiece — 캡션용 링크 정규화', () => {
  it('비공개 발행 직후 긴 PostView 주소를 짧은 정규 주소로 줄인다', () => {
    // 실측 문자열(data/sessions/ba522a39fa7d/07_publish_result.json)
    expect(normalizeBlogUrl('https://blog.naver.com/PostView.naver?blogId=biondi_tree&Redirect=View&logNo=224392805567&categoryNo=1&isAfterWrite=true'))
      .toBe('https://blog.naver.com/biondi_tree/224392805567');
  });

  it('이미 짧은 주소는 그대로 둔다', () => {
    expect(normalizeBlogUrl('https://blog.naver.com/biondi_tree/224345904342')).toBe('https://blog.naver.com/biondi_tree/224345904342');
  });

  it('RSS 추적 파라미터를 떼어 낸다 — 캡션 링크에 남의 유입 코드를 달고 다니지 않게', () => {
    expect(normalizeBlogUrl('https://blog.naver.com/biondi_tree/224393518611?fromRss=true&trackingCode=rss'))
      .toBe('https://blog.naver.com/biondi_tree/224393518611');
  });

  it('m.blog 는 데스크톱도 여는 주소로 바꾼다(기존 계약)', () => {
    expect(normalizeBlogUrl('https://m.blog.naver.com/biondi_tree/224345904342')).toBe('https://blog.naver.com/biondi_tree/224345904342');
  });

  it('공개 전이면 비공개 발행 주소를 쓴다 — 주소 자체는 유효하다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pieces-priv-'));
    const st = new PieceStore(dir);
    const p = st.create({ title: 'T' });
    st.update(p.id, { privateUrl: 'https://blog.naver.com/PostView.naver?blogId=biondi_tree&logNo=224393518611&isAfterWrite=true' });
    // 전역 스토어를 쓰는 blogUrlForPiece 대신 순수 변환으로 규칙만 확인(스토어 주입 경로는 없음).
    expect(normalizeBlogUrl(st.get(p.id)!.privateUrl)).toBe('https://blog.naver.com/biondi_tree/224393518611');
  });

  it('발행 전·비URL이면 링크가 없다', () => {
    expect(normalizeBlogUrl(undefined)).toBeUndefined();
    expect(normalizeBlogUrl('')).toBeUndefined();
    expect(normalizeBlogUrl('postwrite')).toBeUndefined();
    expect(blogUrlForPiece(undefined)).toBeUndefined();
  });
});

// 케이던스 기준점(2026-08-29 사용자 확정) — "자율런" 지시문·수동 틱으로 만든 조각은 쿼터에서 뺀다.
// 실사고: 08-29 07:28 생성분이 기준점이 되어 17:00 정각 오토런이 12시간 최소 간격에 막혔다.
describe('cadenceBaselineTs — 쿼터 기준점', () => {
  const p = (createdTs: string, auto: boolean, userTriggered = false) => ({ auto, userTriggered, createdTs });

  it('사용자 촉발분은 기준점이 되지 않는다 — "지금 하나 더"가 정각 슬롯을 밀어내면 안 된다', () => {
    expect(cadenceBaselineTs([
      p('2026-08-28T21:06:00Z', true),               // 정각 슬롯 산출물
      p('2026-08-29T07:28:00Z', true, true),         // 사용자가 시킨 것 — 더 최신이지만 제외
    ])).toBe('2026-08-28T21:06:00Z');
  });

  it('수동 생성(auto=false)도 종전대로 제외', () => {
    expect(cadenceBaselineTs([
      p('2026-08-28T21:06:00Z', true),
      p('2026-08-29T09:00:00Z', false),
    ])).toBe('2026-08-28T21:06:00Z');
  });

  it('쿼터 대상이 없으면 빈 문자열(무제한 통과)', () => {
    expect(cadenceBaselineTs([p('2026-08-29T07:28:00Z', true, true)])).toBe('');
    expect(cadenceBaselineTs([])).toBe('');
  });

  it('쿼터 대상 중 가장 최신을 고른다', () => {
    expect(cadenceBaselineTs([
      p('2026-08-27T10:00:00Z', true),
      p('2026-08-28T21:06:00Z', true),
      p('2026-08-28T06:06:00Z', true),
    ])).toBe('2026-08-28T21:06:00Z');
  });
});
