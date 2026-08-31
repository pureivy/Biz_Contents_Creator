/**
 * 플랫폼 출력 포매터 — 오케스트레이터 본문(org 산출물)을 '발행용 초안 자산'으로 포장하는 계층.
 * 본문을 생성하지 않고 포장만 한다(제목·메타·태그·이미지 슬롯·SEO 점수·렌더). 그라운딩 레지스트리와 동형.
 *
 * Phase 2: youtube/instagram 포매터를 registerFormatter 로 추가하면 캘린더가 platform 으로 팬아웃.
 */
import type { SeoResult } from './seo';

/** 발행 초안 — 사람이 검토·수정 후 네이버에 게시. */
export interface BlogDraft {
  topic: string;
  primaryKeyword: string;
  titleCandidates: string[];               // SEO 제목 후보(첫 번째=권장)
  metaDescription: string;                 // 100~200자 요약(검색 스니펫용)
  tags: string[];                          // 5~10 태그
  imageSlots: Array<{ alt: string; prompt: string }>; // v1 placeholder(사람이 실제 이미지 삽입)
  internalLinks: string[];                 // 내부링크 제안(콜드스타트엔 비어있음, compounding)
  bodyMarkdown: string;                    // org 본문(마크다운)
  seo: SeoResult;                          // 결정적 SEO 점수·체크리스트
}

/** 포매터 산출 — finalize 가 files 를 세션 dir 에 저장, meta 를 run_done 에 실어보냄. */
export interface AssetBundle {
  platform: string;                        // 'naver_blog' | (phase2) 'youtube' | ...
  files: Array<{ name: string; content: string }>; // draft.json/md/html/image-prompts.md
  meta: Record<string, unknown>;           // title/titleCandidates/seoScore/tags — UI·분석용
  draft: BlogDraft;                        // 구조화 초안(프론트 DraftReview 용)
}

export interface FormatterInput {
  topic: string;
  body: string;               // org 최종 본문(마크다운)
  researchBrief?: string;     // 리서치·SEO 팀 브리프(키워드·검색의도)
  serpText?: string;          // 네이버 블로그 상위 노출 실측(제목 목록) — 인기 제목 패턴 참고용
  /** 핵심 타겟 키워드 고정(piece.keyword) — 지정 시 패키저가 재추출하지 않고 이 표기를 그대로 쓴다.
   *  런마다 키워드가 바뀌면 SEO 게이트·리비전이 움직이는 과녁을 쫓게 된다(실사고: 78→56→67 하락 루프). */
  keyword?: string;
  model: string;             // 구조작업용 모델(micro/haiku)
  internalLinks?: string[];
  signal?: AbortSignal;
}
export type PlatformFormatter = (input: FormatterInput) => Promise<AssetBundle>;

const _reg = new Map<string, PlatformFormatter>();
export function registerFormatter(platform: string, fn: PlatformFormatter): void {
  if (!_reg.has(platform)) _reg.set(platform, fn);
}
/** 플랫폼 포매터 조회 — 없으면 기본 naver_blog. */
export function formatterFor(platform?: string): PlatformFormatter {
  return _reg.get(platform ?? 'naver_blog') ?? _reg.get('naver_blog')!;
}
