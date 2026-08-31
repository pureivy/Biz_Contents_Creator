/**
 * 카드뉴스 레코드 스토어 — pieces.ts 와 동일한 파일 영속 패턴(원자적 교체).
 * 산출물(slide_NN.png·caption.txt·plan.json)은 data/cardnews/<id>/ 에 저장되고,
 * 인덱스(index.json)는 목록·상태 폴링용 메타만 담는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug } from './brand';
import { genId } from '../util/ids';
import type { FactGateInfo } from './factGate';

export type CardNewsStage = 'planning' | 'designing' | 'rendering' | 'ready' | 'error';

export interface CardNews {
  id: string;
  /** 검토 대기(ready) 알림 발송 시각 — 미기록+미발행이면 부팅 복구 스윕이 재발송(재시작 유실 대비, 2026-07-31). */
  notifiedTs?: string;
  /** 브랜드(고객사) 슬러그 — 생성 시점의 활성 브랜드(범용이면 undefined). */
  brand?: string;
  /** 주제(독립 생성) 또는 원본 블로그 제목(파생). */
  topic: string;
  keyword?: string;
  /** 블로그 초안에서 파생된 경우 원본 piece id. */
  sourcePieceId?: string;
  /** 자율 사이클이 만든 것인지(수동 생성과 카덴스 쿼터 분리용). */
  auto?: boolean;
  stage: CardNewsStage;
  /** 완성 슬라이드 수(ready 시). */
  slides?: number;
  /** 배경 폴백(그라데이션)으로 렌더된 장 수 — 이미지 생성 실패 진단용. */
  bgFallbacks?: number;
  caption?: string;
  hashtags?: string[];
  /** 담당자 실명(기획·디자인) — UI 표기. */
  planner?: string;
  designer?: string;
  /** 원문 정합 판정(2026-08-26) — 수정 라운드 뒤 잔존한 원문 밖 사실·결론 반전. 표시 전용(파생은 자동 발행 없음). */
  factGate?: FactGateInfo;
  /** 메타 발행 결과(인스타 캐러셀 미디어 id·퍼머링크, 페북 게시물 id). 부분 성공 시 채널별 개별 기록. */
  igMediaId?: string;
  igPermalink?: string;
  fbPostId?: string;
  /** 페이스북 페이지 게시 시각 — 인스타와 다른 날에 올릴 수 있어 채널별로 따로 기록. */
  fbPostTs?: string;
  /** 첫 채널 발행 성공 시각 — 성과 측정 창 기준점. */
  publishedTs?: string;
  /** 측정 창 경과 후 강화 1회 완료(멱등 플래그) — shorts.perfReflected 미러. */
  perfReflected?: boolean;
  /** 비전 QA가 재생성 2라운드로도 못 고친 슬라이드 번호(slide_NN 순번) — 발행 게이트가 소비.
   *  실사고(2026-08-10): 미해결이 로그로만 남아 오타 슬라이드가 인스타에 그대로 발행됐다. */
  qaUnresolved?: number[];
  error?: string;
  createdTs: string;
  updatedTs: string;
}

/** QA 미해결 발행 차단 사유(순수) — 미해결 슬라이드가 있고 사용자 확인(force)이 없으면 차단 사유를,
 *  아니면 null. 발행 라우트가 모든 경로(UI 버튼·텔레그램)의 관문이므로 여기 한 곳만 지키면 된다. */
export function qaPublishBlockReason(card: Pick<CardNews, 'qaUnresolved'>, force = false): string | null {
  const bad = card.qaUnresolved ?? [];
  if (!bad.length || force) return null;
  return `QA가 슬라이드 ${bad.join(',')}을(를) 오타 가능성 미해결로 남겼습니다 — 슬라이드를 확인한 뒤 발행을 확정하세요`;
}

export interface CreateCardNewsInput {
  topic: string;
  keyword?: string;
  sourcePieceId?: string;
  planner?: string;
  designer?: string;
  auto?: boolean;
}

export class CardNewsStore {
  private file: string;
  private items = new Map<string, CardNews>();
  constructor(private dir: string = path.join(CONFIG.dataDir, 'cardnews')) {
    this.file = path.join(dir, 'index.json');
    this.load();
  }
  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as CardNews[];
      if (Array.isArray(raw)) for (const c of raw) if (c && c.id) this.items.set(c.id, c);
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
  /** 카드뉴스 산출물 디렉토리(data/cardnews/<id>). */
  dirFor(id: string): string { return path.join(this.dir, id); }
  create(input: CreateCardNewsInput): CardNews {
    const now = new Date().toISOString();
    const c: CardNews = {
      id: genId('card'),
      brand: activeBrandSlug() || undefined, topic: input.topic.trim(),
      keyword: input.keyword?.trim() || undefined,
      sourcePieceId: input.sourcePieceId, auto: input.auto,
      planner: input.planner, designer: input.designer,
      stage: 'planning', createdTs: now, updatedTs: now,
    };
    this.items.set(c.id, c);
    this.persist();
    return c;
  }
  get(id: string): CardNews | undefined { return this.items.get(id); }
  /** 최신순 정렬 사본. */
  list(): CardNews[] { return [...this.items.values()].sort((a, b) => b.createdTs.localeCompare(a.createdTs)); }
  update(id: string, patch: Partial<CardNews>): CardNews | undefined {
    const c = this.items.get(id);
    if (!c) return undefined;
    const next: CardNews = { ...c, ...patch, id: c.id, createdTs: c.createdTs, updatedTs: new Date().toISOString() };
    this.items.set(id, next);
    this.persist();
    return next;
  }
  /** 카드 제거 — 산출물 파일(slide/caption)은 남긴다(비파괴: 인덱스에서만 제거, pieces 와 동일 원칙). */
  remove(id: string): boolean {
    const existed = this.items.delete(id);
    if (existed) this.persist();
    return existed;
  }
}

let _store: CardNewsStore | null = null;
export function cardNewsStore(): CardNewsStore {
  if (!_store) _store = new CardNewsStore();
  return _store;
}
