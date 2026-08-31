/**
 * 결정적(zero-LLM) 네이버 블로그 SEO 스코어러 + 체크리스트.
 * 네이버 C-Rank/DIA 는 비공개 + 과최적화 역효과 → 이 점수는 '가이드'(패널티 밴드)이지 극대화 타겟이 아니다.
 */
import { findTemplateNumbers } from '../orchestrator/agent';

export interface SeoCheck { label: string; ok: boolean; note?: string }
export interface SeoResult { score: number; checklist: SeoCheck[] }

/** 한국어 대략 글자수(공백 제외 아님 — 전체 길이). */
function len(s: string): number { return (s || '').length; }

/** 본문 내 키워드 출현 횟수(단순 substring — 형태소 분석 없음, 근사). */
function countKeyword(body: string, kw: string): number {
  if (!kw) return 0;
  let n = 0, i = 0;
  while ((i = body.indexOf(kw, i)) >= 0) { n++; i += kw.length; }
  return n;
}

export function scoreSeo(input: {
  title: string;
  body: string;
  primaryKeyword: string;
  tags: string[];
  imageSlots: number;
}): SeoResult {
  const { title, body, primaryKeyword: kw, tags, imageSlots } = input;
  const checks: SeoCheck[] = [];
  const add = (label: string, ok: boolean, note?: string) => checks.push({ label, ok, note });

  // 제목
  const tl = len(title);
  add('제목 길이 적정(15~40자)', tl >= 15 && tl <= 40, `${tl}자`);
  add('제목에 핵심 키워드 포함', !!kw && title.includes(kw));

  // 본문 구조
  const h2 = (body.match(/^##\s/gm) || []).length;
  const h3 = (body.match(/^###\s/gm) || []).length;
  add('소제목(H2) 3개 이상', h2 >= 3, `H2 ${h2} · H3 ${h3}`);
  const bl = len(body);
  add('본문 분량 적정(1,500~4,000자)', bl >= 1500 && bl <= 4000, `${bl}자`);

  // 키워드 배치·밀도
  const firstPara = body.split(/\n\n/).find((p) => p.trim() && !p.startsWith('#')) ?? '';
  add('첫 문단에 핵심 키워드', !!kw && firstPara.includes(kw));
  const occ = countKeyword(body, kw);
  const density = bl > 0 && kw ? (occ * kw.length) / bl * 100 : 0;
  add('키워드 밀도 0.5~2.5%(과최적화 경계)', density >= 0.5 && density <= 2.5, `${density.toFixed(1)}% (${occ}회)`);

  // 태그·이미지
  add('태그 5~10개', tags.length >= 5 && tags.length <= 10, `${tags.length}개`);
  add('이미지 슬롯 1개 이상', imageSlots >= 1, `${imageSlots}개`);

  // 플레이스홀더/가짜수치 없음
  const ph = findTemplateNumbers(body);
  add('플레이스홀더/가짜수치 없음', ph.length === 0, ph.length ? ph.slice(0, 4).join(', ') : undefined);

  const passed = checks.filter((c) => c.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  return { score, checklist: checks };
}
