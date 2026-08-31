/**
 * Piece 저장소 — 콘텐츠 1건의 라이프사이클(idea→research→draft→ready→published→measured→reflected)을
 * 런과 별개로 영속한다. 완전 자율 캘린더가 여러 런·재시작에 걸쳐 piece 를 이동시키므로, 스테이지를 디스크에
 * (data/pieces/index.json, 원자적 tmp+rename) 지속해 재시작·중단 후에도 stranded 되지 않게 한다.
 *
 * 초안 asset(draft.{json,md,html})은 이미 finalize 가 data/sessions/<runId>/ 에 쓰므로(6c), piece 는 runId
 * 참조만 들고 초안은 디스크에서 재로드한다 — 메모리 전용 positions 의존(재시작 409)을 피한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { genId } from '../util/ids';
import type { FactGateInfo } from './factGate';

export type PieceStage =
  | 'idea' | 'research' | 'draft' | 'ready' | 'published' | 'measured' | 'reflected' | 'error';

/** 비종료 스테이지 — 자율 사이클이 '재개' 대상으로 스캔(런이 죽어 stranded 된 piece 회수). */
export const RESUMABLE_STAGES: readonly PieceStage[] = ['idea', 'research', 'draft'];

export interface Piece {
  id: string;
  /** 초안을 생산한 org 런 id — draft.* 는 data/sessions/<runId>/ 에서 재로드. */
  runId?: string;
  /** 브랜드(고객사) 슬러그 — 생성 시점의 활성 브랜드. 범용 모드 생성물은 undefined. */
  brand?: string;
  title: string;
  keyword?: string;
  subNiche?: string;
  stage: PieceStage;
  publishedUrl?: string;
  /**
   * 비공개 발행 글 주소(2026-08-29) — 네이버 '비공개 발행'은 임시저장과 달리 진짜 글 주소(logNo=…)를
   * 만들지만, 아직 **공개된 글은 아니다**. publishedUrl 에 넣었더니 두 가지가 깨졌다(실측):
   *   ① RSS 발행 감지가 이 필드를 '이미 처리됨' 표시로 써서, 사람이 전체공개로 바꿔도 감지가 건너뛴다.
   *   ② stage 가 'published' 가 아닌데 publishedUrl 만 차 있어 두 값이 어긋난다.
   * 그래서 별도 필드로 둔다 — 파생물 캡션 링크는 이 값도 쓸 수 있지만(주소는 유효하다), 발행 여부
   * 판정은 오직 publishedUrl 이 한다.
   */
  privateUrl?: string;
  /** 네이버 임시저장 성공 시 편집기 URL(발행 아님 — 사람이 네이버에서 확인 후 발행). */
  naverDraftUrl?: string;
  /** 마지막 네이버 임시저장 시각(ISO). */
  naverDraftTs?: string;
  /** 네이버 발행 성공 시각(ISO) — 성과 대시보드 '발행일'·날짜 정렬 기준(2026-07-20). 최초 발행 1회 기록. */
  publishedTs?: string;
  seoScore?: number;
  /** 실런 실패 횟수(사용자 양보=취소는 제외) — 폭주 방지 캡. */
  errors?: number;
  /** SEO 미달로 자동 리비전을 돌린 횟수 — 자동 임시저장 게이트의 무한 루프 방지(캡 1). */
  autoRevisions?: number;
  /** 검토 대기(ready) 알림 발송 시각 — 미기록이면 부팅 복구 스윕이 재발송(재시작으로 fire-and-forget 유실 대비, 2026-07-31). */
  notifiedTs?: string;
  /** 자율 사이클이 만든 것인지(수동 생성과 카덴스 쿼터 분리용). */
  auto?: boolean;
  /**
   * 사용자가 직접 촉발한 틱의 산출물(2026-08-29 사용자 확정) — "자율런"·"오토런" 지시문이나
   * 수동 틱 버튼으로 만든 조각. auto 는 그대로 true 지만(자율 선정 산출물이 맞다) **케이던스 쿼터에는
   * 넣지 않는다**: 사용자가 "지금 하나 더" 하고 시킨 것이 다음 정각 슬롯을 밀어내면 안 된다.
   * 실측: 08-29 07:28 생성분이 기준점이 되어 17:00 정각 오토런이 12시간 간격에 막혔다.
   * 미발행 초안 캡(contentReadyCap)에는 그대로 포함된다 — 그건 검토 홍수를 막는 별개 축이다.
   */
  userTriggered?: boolean;
  /** 클러스터 형제 소진으로 생성된 piece 의 출처(ClusterTopic.id) — 같은 시드 쿨다운 판정·성과 귀속용. */
  clusterSeedId?: string;
  /** 사실 게이트 결과(2026-08-26) — hold/error 면 자동 네이버 임시저장을 건너뛴다(수동 버튼은 유지). */
  factGate?: FactGateInfo;
  createdTs: string;
  updatedTs: string;
}

export interface CreatePieceInput { title: string; keyword?: string; subNiche?: string; stage?: PieceStage; brand?: string; auto?: boolean; userTriggered?: boolean; clusterSeedId?: string; }

const MAX_ERRORS = 3;

export class PieceStore {
  private file: string;
  private items = new Map<string, Piece>();
  constructor(dir: string = path.join(CONFIG.dataDir, 'pieces')) {
    this.file = path.join(dir, 'index.json');
    this.load();
  }
  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Piece[];
      if (Array.isArray(raw)) for (const p of raw) if (p && p.id) this.items.set(p.id, p);
    } catch { /* 없으면 빈 스토어 */ }
  }
  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 2), 'utf-8');
      fs.renameSync(tmp, this.file); // 원자적 교체 — 부분 쓰기로 인덱스 오염 방지.
    } catch { /* 영속 실패 무해(다음 변경에서 재시도) */ }
  }
  create(input: CreatePieceInput): Piece {
    const now = new Date().toISOString();
    const p: Piece = {
      id: genId('piece'), title: input.title.trim(),
      keyword: input.keyword?.trim() || undefined, subNiche: input.subNiche?.trim() || undefined,
      brand: input.brand?.trim() || undefined, auto: input.auto,
      ...(input.userTriggered ? { userTriggered: true } : {}),
      clusterSeedId: input.clusterSeedId || undefined,
      stage: input.stage ?? 'idea', errors: 0, createdTs: now, updatedTs: now,
    };
    this.items.set(p.id, p);
    this.persist();
    return p;
  }
  get(id: string): Piece | undefined { return this.items.get(id); }
  /** 생성순(오래된→최신) 정렬 사본. */
  list(): Piece[] { return [...this.items.values()].sort((a, b) => a.createdTs.localeCompare(b.createdTs)); }
  update(id: string, patch: Partial<Piece>): Piece | undefined {
    const p = this.items.get(id);
    if (!p) return undefined;
    const next: Piece = { ...p, ...patch, id: p.id, createdTs: p.createdTs, updatedTs: new Date().toISOString() };
    this.items.set(id, next);
    this.persist();
    return next;
  }
  setStage(id: string, stage: PieceStage): Piece | undefined { return this.update(id, { stage }); }
  setPublished(id: string, url: string, publishedTs?: string): Piece | undefined {
    const cur = this.items.get(id);
    // publishedTs 는 최초 발행 1회만 기록(재감지·URL 갱신에도 최초 발행일 보존). RSS 감지는 실제
    // 발행시각(pubDate)을 넘겨 정확한 발행일이 되고, 수동 발행은 미지정 → now(발행 등록 시각).
    return this.update(id, { stage: 'published', publishedUrl: url, ...(cur?.publishedTs ? {} : { publishedTs: publishedTs || new Date().toISOString() }) });
  }
  /** piece 삭제(카드 제거) — 산출물 파일(sessions·성과 샘플)은 남긴다(비파괴: 인덱스에서만 제거). */
  remove(id: string): boolean {
    const existed = this.items.delete(id);
    if (existed) this.persist();
    return existed;
  }
  /** 실런 실패 기록 — 사용자 양보(취소)에는 호출하지 않는다. 캡 초과 시 'error' 로 종료(폭주 방지). */
  recordError(id: string): Piece | undefined {
    const p = this.items.get(id);
    if (!p) return undefined;
    const errors = (p.errors ?? 0) + 1;
    return this.update(id, errors >= MAX_ERRORS ? { errors, stage: 'error' } : { errors });
  }
}

/**
 * 재개 대상 선택(순수 — 테스트 가능) — 비종료 스테이지 & 라이브 런 없음 중 가장 오래된 piece. 없으면 null.
 * 자율 틱은 '새 아이디어 제안'보다 이 재개를 먼저 처리해, 사용자 런 양보·재시작으로 죽은 piece 를 회수한다.
 */
export function selectResumablePiece(pieces: Piece[], isLive: (runId?: string) => boolean): Piece | null {
  const resumable = pieces
    .filter((p) => RESUMABLE_STAGES.includes(p.stage) && !isLive(p.runId))
    .sort((a, b) => a.createdTs.localeCompare(b.createdTs));
  return resumable[0] ?? null;
}

let _store: PieceStore | null = null;
/** 프로세스 공유 단일 스토어. */
export function pieceStore(): PieceStore { return (_store ??= new PieceStore()); }

/** 파생물(쇼츠·카드뉴스) 캡션용 원본 블로그 링크 — 소스 피스가 네이버 발행된 경우만 URL(아니면 undefined).
 *  발행 '시점'에 조회해야 한다: 파생물 생성 시점엔 블로그가 발행 전이라 publishedUrl 이 비어 있다(2026-07-31). */
export function blogUrlForPiece(pieceId?: string): string | undefined {
  if (!pieceId) return undefined;
  const p = pieceStore().get(pieceId);
  // 공개 주소 우선. 없으면 비공개 발행 주소 — 주소 자체는 유효하고, 사람이 전체공개로 바꾸면
  // 같은 주소가 그대로 열린다(파생물이 블로그보다 먼저 나가도 링크가 죽지 않는다).
  return normalizeBlogUrl(p?.publishedUrl) ?? normalizeBlogUrl(p?.privateUrl);
}

/**
 * 케이던스 쿼터 기준점(순수 — 테스트 대상): 가장 최근 '쿼터에 잡히는' 자율 조각의 createdTs.
 *
 * 사용자가 직접 촉발한 틱(userTriggered)의 산출물은 제외한다(2026-08-29 사용자 확정) — "지금 하나 더"
 * 하고 시킨 것이 다음 정각 슬롯을 밀어내면 안 된다. 실측: 07:28 생성분이 기준점이 되어 17:00 정각
 * 오토런이 12시간 최소 간격에 막혔다. 없으면 '' (호출부가 무제한 통과로 해석).
 */
export function cadenceBaselineTs(pieces: ReadonlyArray<Pick<Piece, 'auto' | 'userTriggered' | 'createdTs'>>): string {
  return pieces
    .filter((p) => p.auto && !p.userTriggered)
    .reduce((mx, p) => (p.createdTs > mx ? p.createdTs : mx), '');
}

/** 캡션용 링크 정규화(순수 — 테스트 대상). 스토어 조회와 분리해 표기 규칙만 검증할 수 있게 한다. */
export function normalizeBlogUrl(u?: string): string | undefined {
  if (!u || !/^https?:\/\//.test(u)) return undefined;
  // 정규형으로 — RSS 감지가 m.blog 를 저장하기도 하는데, blog.naver.com 은 모바일을 자동 리다이렉트하지만
  // m.blog 는 데스크톱을 못 돌려보낸다(캡션 링크는 양쪽 시청자 모두 클릭).
  const flat = u.replace(/^https?:\/\/m\.blog\.naver\.com\//, 'https://blog.naver.com/');
  // 비공개 발행 직후 URL 은 에디터가 돌려주는 긴 꼴이다(2026-08-28 실측):
  //   https://blog.naver.com/PostView.naver?blogId=biondi_tree&Redirect=View&logNo=224392805567&categoryNo=1&isAfterWrite=true&…
  // 캡션에 그대로 넣으면 한 줄을 통째로 잡아먹고 isAfterWrite 같은 편집 세션 파라미터까지 노출된다.
  // blogId + logNo 만 뽑아 짧은 정규 주소로 되돌린다(RSS 감지가 채우는 꼴과 같아져 표기도 일관된다).
  const m = /[?&]blogId=([^&]+)[\s\S]*?[?&]logNo=(\d+)/.exec(flat);
  if (m) return `https://blog.naver.com/${m[1]}/${m[2]}`;
  // RSS 감지가 채운 주소는 짧지만 추적 파라미터가 붙어 온다(2026-08-29 실측):
  //   https://blog.naver.com/biondi_tree/224393518611?fromRss=true&trackingCode=rss
  // 캡션에 그대로 나가면 우리 링크에 남의 유입 코드를 달고 다니는 꼴이라 쿼리를 떼어 낸다.
  const short = /^(https:\/\/blog\.naver\.com\/[^/?#]+\/\d+)(?:[?#]|$)/.exec(flat);
  return short ? short[1]! : flat;
}

/** 자동 임시저장 차단 판정 — hold(무근거·모순 잔존)·error(판정 실패, fail-closed). 사용자 확정: 자동 경로만 차단. */
export function autoDraftBlockedByFactGate(p: { factGate?: FactGateInfo }): boolean {
  return p.factGate?.status === 'hold' || p.factGate?.status === 'error';
}

/**
 * ready 조각에 대한 자동 임시저장·자동 리비전 결정(순수, 2026-08-27 사용자 확정).
 *
 * 결정은 여기 한 곳에만 둔다 — 호출측(main.ts `maybeAutoNaverDraft`)은 이 태그에 따라 효과(로그·잡 기동·
 * 리비전 런)만 수행한다. 핵심 갈래: 자동 임시저장이 꺼져 있어도 SEO 판단과 자동 리비전은 예전 그대로 돈다.
 * 임시저장 '호출'만 막혀 사람이 텔레그램·검토 탭 버튼으로 저장한다.
 */
export type AutoDraftDecision =
  /** 대상 아님 — 런 없음·ready 아님·이미 네이버 초안 있음(재저장은 사람이 판단). */
  | 'skip'
  /** SEO 통과 + 자동 임시저장 on + 사실 게이트 통과 → 임시저장 기동. */
  | 'draft'
  /** SEO 통과했지만 자동 임시저장 off → 수동 검토 대기(조각당 1회 안내). */
  | 'draft-off'
  /** SEO 통과 + on 이지만 사실 게이트 보류·판정 실패 → 자동 저장만 건너뜀. */
  | 'fact-hold'
  /** SEO 미측정이거나 자동 리비전 소진 → 수동 검토 대기. */
  | 'revise-exhausted'
  /** SEO 미달 + 리비전 여유 있음 → 자동 리비전 런 후보(효과측 게이트는 호출측에서). */
  | 'revise';

/**
 * 카드뉴스·숏폼 세트를 언제 파생하나.
 *
 * 2026-08-28 사용자 확정 — **네이버 비공개 저장 뒤**에 파생한다. 이유는 캡션 링크다: 파이썬 발행은
 * 기본이 '비공개 발행'이라 저장 시점에 진짜 글 주소(logNo=…)가 나오고, 그때 파생하면 파생물 캡션에
 * 원본 블로그 링크를 걸 수 있다. 08-27 자동저장 off 전환 때 이 훅이 'ready 즉시'로 앞당겨지면서
 * 파생물이 블로그 주소보다 먼저 만들어졌고, 링크가 붙지 않는다는 제보로 되돌린다.
 *
 * 항상 false 를 돌려주고, 파생은 저장 성공 훅(main.ts publishDraftToNaver.then → autoDeriveSet)이
 * 전담한다 — 자동 저장이 켜졌든 꺼졌든 '저장된 뒤'라는 조건은 같다. 사람이 검토 탭 버튼으로 저장한
 * 글도 같은 훅을 타므로 수동 운영(2026-08-27 전량 수동 검토)에서도 세트는 정상 생성된다.
 *
 * 킬스위치 DERIVE_ON_READY=1 — 저장을 기다리지 않고 종전처럼 본문 확정 즉시 파생(링크는 포기).
 */
export function shouldAutoDeriveOnDecision(decision: AutoDraftDecision, autoNaverDraft: boolean): boolean {
  if (process.env.DERIVE_ON_READY !== '1') return false;
  if (autoNaverDraft) return false;
  return decision === 'draft-off' || decision === 'revise-exhausted';
}

export function planAutoNaverDraft(
  p: Pick<Piece, 'factGate'> & Partial<Pick<Piece, 'runId' | 'stage' | 'naverDraftUrl' | 'seoScore' | 'autoRevisions'>>,
  opts: { autoNaverDraft: boolean; seoMin: number },
): AutoDraftDecision {
  if (!p.runId || p.stage !== 'ready') return 'skip';
  if (p.naverDraftUrl) return 'skip'; // 이미 네이버에 초안 있음 — 재저장은 사람이 판단(중복 초안 방지)
  const seo = p.seoScore;
  if (typeof seo === 'number' && seo >= opts.seoMin) {
    // off 가 사실 게이트보다 먼저 — 꺼진 상태에서는 보류 여부를 따질 이유가 없다(어차피 사람이 본다).
    if (!opts.autoNaverDraft) return 'draft-off';
    if (autoDraftBlockedByFactGate(p)) return 'fact-hold';
    return 'draft';
  }
  if (typeof seo !== 'number' || (p.autoRevisions ?? 0) >= 1) return 'revise-exhausted';
  return 'revise';
}
