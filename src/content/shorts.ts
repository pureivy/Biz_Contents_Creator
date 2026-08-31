/**
 * 숏폼 레코드 스토어 — cardnews.ts 와 동일한 파일 영속 패턴(원자적 교체).
 * 산출물(final.mp4·subtitles.srt·caption.txt·plan.json·scenes/)은 data/shorts/<id>/ 에,
 * 인덱스(index.json)는 목록·상태 폴링용 메타만 담는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug } from './brand';
import { genId } from '../util/ids';
import type { FactGateInfo } from './factGate';

export type ShortsStage = 'planning' | 'designing' | 'rendering' | 'ready' | 'error';

export interface Shorts {
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
  /** 부팅 복구 자동 재개 횟수(2026-08-20) — 서버 재시작으로 중단된 잡을 error 대신 재실행하되
   *  크래시 루프 방지 캡(2회). 생성 실패 금지(사용자 확정) 원칙의 재시작 축 방어. */
  recoveries?: number;
  stage: ShortsStage;
  /** 대표 제목(ready 시 — 기획 확정 제목). */
  title?: string;
  /** 제목 후보 3종 — 유형은 런마다 유형 풀에서 고른다(정보형·후킹형·질문형·결론형·장면형 중 3개,
   *  질문형은 최근 3편 중 1편 이하. 2026-08-27 권고 5 — 종전 고정 3종은 채널 지문이 됐다). */
  titles?: string[];
  description?: string;
  hashtags?: string[];
  /** 완성 영상 길이(초)·씬 수(ready 시). */
  durationSec?: number;
  scenes?: number;
  /** 배경 폴백(그라데이션)으로 렌더된 씬 수 — 이미지 생성 실패 진단용. */
  bgFallbacks?: number;
  /** 담당자 실명(작가·디렉터) — UI 표기. */
  writer?: string;
  director?: string;
  /** 원문 정합 판정(2026-08-26) — 수정 라운드 뒤 잔존한 원문 밖 사실·결론 반전. 표시 전용(파생은 자동 발행 없음). */
  factGate?: FactGateInfo;
  error?: string;
  /** 유튜브 비공개 업로드 결과(발행은 사람이 유튜브 스튜디오에서 공개 전환). */
  youtubeId?: string;
  youtubeUrl?: string;
  /** 업로드 성공 시각 — 성과 측정창(SHORTS_PERF_DAYS) 기준점. */
  youtubeTs?: string;
  /** 성과 강화(1회) 완료 마킹 — 멱등 게이트. */
  perfReflected?: boolean;
  /** 메타 발행 결과(인스타 릴스 미디어 id·퍼머링크, 페북 릴스 video id) — 유튜브 발행과 독립. */
  igReelId?: string;
  igPermalink?: string;
  fbReelId?: string;
  /** 페이스북 릴스 게시 시각 — 인스타와 다른 날에 올릴 수 있어 채널별로 따로 기록한다.
   *  (metaPublishedTs 는 '메타 채널 최초 게시' = 측정창 기준이라 페북 게시일과 다를 수 있다.) */
  fbReelTs?: string;
  /** FB 릴스 커버(썸네일)를 지정한 시각 — 릴스 발행 API 에 커버 파라미터가 없어 별 호출로 붙이므로,
   *  이 값이 없으면 '커버 미적용' 상태로 보고 재시도가 보강한다(매 재시도마다 재업로드하지 않게 기록). */
  fbReelCoverTs?: string;
  /** 메타 첫 채널 발행 성공 시각 — 메타 성과 측정 창 기준점(youtubeTs 와 독립). */
  metaPublishedTs?: string;
  /** 메타 측정 창 경과 후 강화 1회 완료(멱등) — perfReflected(유튜브)와 독립. */
  metaPerfReflected?: boolean;
  createdTs: string;
  updatedTs: string;
}

export interface CreateShortsInput {
  topic: string;
  keyword?: string;
  sourcePieceId?: string;
  writer?: string;
  director?: string;
  auto?: boolean;
}

export class ShortsStore {
  private file: string;
  private items = new Map<string, Shorts>();
  constructor(private dir: string = path.join(CONFIG.dataDir, 'shorts')) {
    this.file = path.join(dir, 'index.json');
    this.load();
  }
  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Shorts[];
      if (Array.isArray(raw)) for (const s of raw) if (s && s.id) this.items.set(s.id, s);
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
  /** 숏폼 산출물 디렉토리(data/shorts/<id>). */
  dirFor(id: string): string { return path.join(this.dir, id); }
  create(input: CreateShortsInput): Shorts {
    const now = new Date().toISOString();
    const s: Shorts = {
      id: genId('short'),
      brand: activeBrandSlug() || undefined, topic: input.topic.trim(),
      keyword: input.keyword?.trim() || undefined,
      sourcePieceId: input.sourcePieceId, auto: input.auto,
      writer: input.writer, director: input.director,
      stage: 'planning', createdTs: now, updatedTs: now,
    };
    this.items.set(s.id, s);
    this.persist();
    return s;
  }
  get(id: string): Shorts | undefined { return this.items.get(id); }
  /** 최신순 정렬 사본. */
  list(): Shorts[] { return [...this.items.values()].sort((a, b) => b.createdTs.localeCompare(a.createdTs)); }
  update(id: string, patch: Partial<Shorts>): Shorts | undefined {
    const s = this.items.get(id);
    if (!s) return undefined;
    const next: Shorts = { ...s, ...patch, id: s.id, createdTs: s.createdTs, updatedTs: new Date().toISOString() };
    this.items.set(id, next);
    this.persist();
    return next;
  }
  /** 카드 제거 — 산출물 파일은 남긴다(비파괴: 인덱스에서만 제거, pieces·cardnews 와 동일 원칙). */
  remove(id: string): boolean {
    const existed = this.items.delete(id);
    if (existed) this.persist();
    return existed;
  }
}

let _store: ShortsStore | null = null;
export function shortsStore(): ShortsStore {
  if (!_store) _store = new ShortsStore();
  return _store;
}
