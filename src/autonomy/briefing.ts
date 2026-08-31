/**
 * 일일 브리핑 — 조직의 하루 활동 다이제스트(Connect AI 모닝 브리핑 대응). LLM 없이 기존 데이터만으로 구성:
 * 위키 현황 · 최근 결정(decisions.md) · 최근 학습(lesson 페이지) · 대기 승인. 알림 채널로 전송된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { brandFileSuffix, activeBrandSlug } from '../content/brand';
import { pieceStore } from '../content/pieces';
import { markdownHeadings } from '../content/priorCoverage';
import { readNaverIndexingReport, GRACE_DAYS } from '../analytics/naverIndexing';
import { llmWiki } from '../wiki/llmwiki';
import { approvalStore } from '../approvals/store';
import { followersSection } from '../analytics/followers';
import { titleTimingSection } from '../analytics/titleTiming';
import { promiseStore } from '../content/promises';
import type { NotifyMessage } from './notify';
import { kstDate } from '../util/time';

function readTail(p: string, max: number): string {
  try {
    const t = fs.readFileSync(p, 'utf-8').trim();
    return t.length > max ? '…\n' + t.slice(-max) : t;
  } catch {
    return '';
  }
}

/** 순수 — 수집된 섹션을 브리핑 메시지로 조립(테스트 용이). 빈 섹션은 제외. */
export function composeBriefing(date: string, sections: Array<{ heading: string; body: string }>): NotifyMessage {
  const body =
    sections.filter((s) => s.body.trim()).map((s) => `${s.heading}\n${s.body.trim()}`).join('\n\n') ||
    '오늘 기록된 특별한 활동이 없습니다.';
  return { title: `📋 일일 브리핑 · ${date}`, body };
}

interface DiversityBaseline {
  date: string; blog_count: number; existing_runIds: string[];
  metrics: { closer_cliche: number; contrarian_hook: number; nstep_check: number; total: number };
  reportedTs?: string;
}
/**
 * 콘텐츠 다양성 감시(사용자 요청 2026-07-23 "완전 무인") — data/_shared/diversity-baseline.json 이 있으면
 * 기준선 이후 활성 브랜드 신규 블로그(본문 有)를 세어, 6편+ 쌓이면 상투 지표(마무리·대비훅·N단계)를 기준선과
 * before/after 로 비교해 브리핑에 넣는다. 한 번 보고하면 reportedTs 를 남겨 반복하지 않는다(요약만). 전량 fail-open.
 * 지표 규칙은 기준선 산정(파이썬)과 동일 — 마무리 소제목/본문 정규식으로 결정적 계산.
 */
function diversityWatchSection(): { heading: string; body: string } | null {
  const p = path.join(CONFIG.dataDir, '_shared', 'diversity-baseline.json');
  let base: DiversityBaseline;
  try { base = JSON.parse(fs.readFileSync(p, 'utf-8')) as DiversityBaseline; } catch { return null; } // 기준선 없음 = 감시 off
  if (!Array.isArray(base.existing_runIds) || !base.metrics) return null;
  const seen = new Set(base.existing_runIds);
  const brand = activeBrandSlug() || '';
  const bodies: Array<{ title: string; body: string }> = [];
  try {
    for (const pc of pieceStore().list()) {
      if ((pc.brand ?? '') !== brand || !pc.runId || seen.has(pc.runId)) continue; // 활성 브랜드 · 기준선 이후 신규만
      try {
        const b = (JSON.parse(fs.readFileSync(path.join(CONFIG.sessionsDir, pc.runId, 'draft.json'), 'utf-8')) as { bodyMarkdown?: string }).bodyMarkdown ?? '';
        if (b.trim()) bodies.push({ title: pc.title ?? '', body: b });
      } catch { /* draft 없음(브리프/리서치 등) 스킵 */ }
    }
  } catch { return null; }
  const N = bodies.length;
  if (base.reportedTs) return { heading: '🎨 콘텐츠 다양성', body: `개선 점검 완료(${base.reportedTs.slice(0, 10)}). 이후 신규 블로그 ${N}편 누적.` };
  if (N < 6) return { heading: '🎨 콘텐츠 다양성', body: `개선 효과 점검 대기 — 기준선(${base.date}) 이후 신규 블로그 ${N}/6편.` };
  const closer = bodies.filter(({ body }) => { const h = markdownHeadings(body); return h.length > 0 && /오늘\s*바로|정리|요약|한 일/.test(h[h.length - 1]!); }).length;
  const nstep = bodies.filter(({ body }) => /\d\s*단계\s*체크|단계 체크법/.test(body)).length;
  const contra = bodies.filter(({ title, body }) => /아니라|보다\s*\S+\s*(먼저|중요)/.test(`${title} ${body.slice(0, 400)}`)).length;
  const m = base.metrics; const bt = m.total || base.blog_count || 1;
  const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);
  const row = (label: string, bn: number, nn: number): string =>
    `- ${label}: 기준선 ${pct(bn, bt)}% → 신규 ${pct(nn, N)}% ${nn / N < bn / bt ? '✓개선' : '↑악화/동일'}`;
  const lines = [
    row('상투 마무리(오늘/정리/요약)', m.closer_cliche, closer),
    row('대비 훅(아니라/보다먼저)', m.contrarian_hook, contra),
    row('N단계 체크 반복', m.nstep_check, nstep),
  ];
  try { fs.writeFileSync(p, JSON.stringify({ ...base, reportedTs: kstDate() })); } catch { /* 영속 실패 무해 — 다음 날 재보고 */ }
  return {
    heading: `🎨 콘텐츠 다양성 개선 점검 (신규 ${N}편)`,
    body: ['다양성 개선(2026-07-23) 전후 비교:', ...lines, '3지표 모두 ✓개선이면 효과 확인. 안 낮아졌으면 임계값·킬스위치를 세션에서 상의하세요.'].join('\n'),
  };
}

/**
 * 네이버 색인 점검(사용자 요청 2026-07-23) — 캐시(refreshNaverIndexingCache 가 채움)를 읽어, 발행 글이
 * 네이버 블로그 검색에 자기 postId 로 뜨는지 요약. **없음(발행 GRACE_DAYS+ 경과)=저품질 강한 음성 신호**,
 * 있음=약한 양성(통합검색 색인보다 관대하므로 "정상" 단정 아님). 발행 직후는 '색인 대기'로 구분.
 */
function naverIndexingSection(): { heading: string; body: string } | null {
  const rep = readNaverIndexingReport();
  if (!rep || !rep.results.length) return null;
  const found = rep.results.filter((r) => r.found);
  const suspect = rep.results.filter((r) => !r.found && r.checkable && r.ageDays >= GRACE_DAYS);
  const waiting = rep.results.filter((r) => !r.found && r.checkable && r.ageDays < GRACE_DAYS);
  const lines = [`발행 ${rep.results.length}편 · 검색결과 있음 ${found.length} · 저품질 의심 ${suspect.length} · 색인 대기 ${waiting.length}`];
  for (const r of suspect) lines.push(`✗ "${r.title.slice(0, 26)}" — 자기 제목 검색에도 없음(발행 ${r.ageDays}일차) · 저품질 의심`);
  if (!suspect.length) lines.push('저품질 의심 없음 — 오래된 글이 자기 제목 검색에 노출됨(있음=약한 양성이지 "정상" 단정은 아님).');
  return { heading: '🔍 네이버 색인 점검', body: lines.join('\n') };
}

/** 실제 데이터(위키·결정·학습·승인)에서 일일 브리핑을 구성. */
export function buildBriefing(): NotifyMessage {
  const date = kstDate();
  const sections: Array<{ heading: string; body: string }> = [];
  try {
    const w = llmWiki().stats();
    sections.push({ heading: '📚 지식베이스', body: `${w.pages}페이지 (개념 ${w.concepts} · 소스 ${w.sources} · 링크 ${w.links})` });
  } catch { /* 위키 없음 무해 */ }
  const dec = readTail(path.join(CONFIG.dataDir, '_shared', `decisions${brandFileSuffix()}.md`), 1200);
  if (dec) sections.push({ heading: '⚖️ 최근 결정', body: dec });
  try {
    const lessons = llmWiki().list('lesson').slice(0, 5).map((p) => `- ${p.summary || p.title}`).join('\n');
    if (lessons) sections.push({ heading: '🎓 최근 학습', body: lessons });
  } catch { /* */ }
  try {
    const n = approvalStore().list().length;
    if (n > 0) sections.push({ heading: '🔔 대기 승인', body: `${n}건 — 결재 대기 중` });
  } catch { /* */ }
  try { const fw = followersSection(); if (fw) sections.push(fw); } catch { /* 팔로워 섹션 실패 무해 */ }
  // 후속 카드 이행(2026-08-12): 넛지(followersFollowupNudge) 자리를 실제 A/B 분석 섹션이 대체.
  try { const ab = titleTimingSection(); if (ab) sections.push(ab); } catch { /* A/B 섹션 실패 무해 */ }
  try {
    // 예고 대장 — 콘텐츠가 시청자에게 한 "다음 편" 약속의 미이행 현황(자율 틱이 시기 도래 시 이행).
    const pend = promiseStore().pending(activeBrandSlug() || '');
    if (pend.length) {
      const nxt = pend[0]!;
      sections.push({
        heading: '🤝 예고 대장',
        body: `미이행 ${pend.length}건 — 다음: ${nxt.window ? `${nxt.window} ` : '다음 슬롯 '}"${nxt.topic.slice(0, 40)}"`,
      });
    }
  } catch { /* 예고 섹션 실패 무해 */ }
  try { const dv = diversityWatchSection(); if (dv) sections.push(dv); } catch { /* 감시 실패 무해 */ }
  try { const ix = naverIndexingSection(); if (ix) sections.push(ix); } catch { /* 색인 섹션 실패 무해 */ }
  return composeBriefing(date, sections);
}
