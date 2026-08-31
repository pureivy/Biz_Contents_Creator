/**
 * 리서치 판정 역류 배선(2026-08-20 조회수 감사) — 리서치 직원(seo_strategist·trend_researcher·
 * research_lead)의 실측 판정이 메모리 파일에만 쌓이고 주제 선정에 역류하지 않던 공백을 봉합한다.
 * 실측 사례: 08-16 "처서 자동완성 직결률 0%" 폐기 판정 후에도 처서 주제 3건 재배정, 08-19 "조경수
 * 축이 최대 공백(월 8,630회)" 발굴 후에도 조경수 주제 0건, "가을 나무 심기" 월 20회 무볼륨 실측 후
 * 같은 날 메인 채택.
 *
 * 흐름: 일일 perf-sync 틱 → harvestTopicVerdicts(micro 추출, 실측 근거 있는 판정만) →
 * data/topics/verdicts{brand}.json → 주제 두뇌 프롬프트(topicVerdictBlock) + 코드 하드 게이트
 * (avoidVerdictFor — avoid 키워드 정규화 일치 시 후보 기각). 전량 fail-open — 추출 실패는 무주입일 뿐.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug, brandFileSuffixFor } from '../content/brand';
import { microJSON } from '../orchestrator/agent';
import { resolveAssignment } from '../llm/setting';
import { asString } from '../util/str';

export interface TopicVerdict {
  keyword: string;
  verdict: 'avoid' | 'opportunity';
  /** 근거 요약 — 실측 수치 포함(예: "월 검색 20회 무볼륨·경쟁 높음"). */
  reason: string;
  ts: string;
  source?: string;
  /** 기회 소진 시각(2026-08-24) — 이 기회로 실제 글이 채택된 순간 기록. 소진된 기회는 프롬프트에
   *  다시 주입되지 않는다(실사고: '포도나무 가지치기' 기회가 채택 다음 날에도 우선 검토로 남아 반복 유발). */
  consumedTs?: string;
}

const TTL_DAYS = 45;        // 실측도 낡는다 — 계절·경쟁이 바뀌면 판정 무효(시즌 한 바퀴 조금 넘게 유지)
const MAX_ENTRIES = 40;

const normKw = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase();

function verdictsPath(slug?: string): string {
  const s = slug ?? activeBrandSlug();
  return path.join(CONFIG.dataDir, 'topics', `verdicts${brandFileSuffixFor(s || undefined)}.json`);
}

export function readTopicVerdicts(slug?: string): TopicVerdict[] {
  try {
    const raw = JSON.parse(fs.readFileSync(verdictsPath(slug), 'utf-8')) as { verdicts?: unknown };
    const list = Array.isArray(raw.verdicts) ? raw.verdicts : [];
    const cutoff = Date.now() - TTL_DAYS * 86_400_000;
    return list
      .map((v) => v as TopicVerdict)
      .filter((v) => v && typeof v.keyword === 'string' && v.keyword.trim()
        && (v.verdict === 'avoid' || v.verdict === 'opportunity')
        && typeof v.reason === 'string'
        && Number.isFinite(new Date(v.ts).getTime()) && new Date(v.ts).getTime() >= cutoff);
  } catch { return []; }
}

function writeTopicVerdicts(verdicts: TopicVerdict[], slug?: string): void {
  const f = verdictsPath(slug);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // 원자적 쓰기(tmp+rename) — 쓰기 도중 자율 틱의 readTopicVerdicts 가 찢어진 JSON 으로 게이트가 무장해제되지 않게.
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ verdicts: verdicts.slice(0, MAX_ENTRIES) }, null, 2), 'utf-8');
  fs.renameSync(`${f}.tmp`, f);
}

/** 병합(순수, 테스트 대상) — 키워드 정규화 동치는 새 판정이 이긴다(리서치가 재실측하면 갱신).
 *  단 판정·근거가 동일한 재추출은 기존 ts 를 보존한다 — 메모리에 문구가 남아 있는 한 일일 수확이 매일
 *  같은 항목을 재추출해 ts 를 갱신하면 TTL 45일이 영구히 도래하지 않는다(리뷰 지적). */
export function mergeVerdicts(prev: TopicVerdict[], next: TopicVerdict[]): TopicVerdict[] {
  const prevByKey = new Map(prev.map((v) => [normKw(v.keyword), v] as const));
  const out: TopicVerdict[] = [];
  const seen = new Set<string>();
  for (const v of [...next, ...prev]) { // next 우선 — next 내부 중복도 첫 항목만 남는다
    const k = normKw(v.keyword);
    if (seen.has(k)) continue;
    seen.add(k);
    const old = prevByKey.get(k);
    out.push(old && old !== v && old.verdict === v.verdict && old.reason === v.reason ? old : v);
  }
  return out.slice(0, MAX_ENTRIES);
}

/** avoid 판정 조회(하드 게이트용) — 후보 keyword 와 정규화 완전 일치만 기각(과차단 방지: "처서"는
 *  기각하되 "처서 이후 가을 식재" 같은 파생 주제는 두뇌 프롬프트 지침에 맡긴다). */
export function avoidVerdictFor(keyword: string | undefined, slug?: string): TopicVerdict | null {
  const k = normKw(keyword ?? '');
  if (!k) return null;
  return readTopicVerdicts(slug).find((v) => v.verdict === 'avoid' && normKw(v.keyword) === k) ?? null;
}

/** 블록 조립(순수, 테스트 대상) — topicVerdictBlock 의 코어. */
export function buildVerdictBlock(verdicts: TopicVerdict[]): string {
  if (!verdicts.length) return '';
  const line = (v: TopicVerdict): string => `- ${v.keyword} — ${v.reason.slice(0, 80)} (${v.ts.slice(0, 10)})`;
  const avoid = verdicts.filter((v) => v.verdict === 'avoid').slice(0, 8);
  const opp = verdicts.filter((v) => v.verdict === 'opportunity' && !v.consumedTs).slice(0, 8); // 소진된 기회 제외
  if (!avoid.length && !opp.length) return '';
  return `[리서치 실측 판정 — 반드시 반영하라]\n` +
    (opp.length ? `검증된 기회(검색 수요·경쟁 공백이 실측된 키워드 — 우선 검토):\n${opp.map(line).join('\n')}\n` : '') +
    (avoid.length ? `실측 폐기(검색량·의도 불일치가 실측된 키워드 — 이 키워드와 그 표기 변형을 keyword 로 제안하지 마라):\n${avoid.map(line).join('\n')}\n` : '') +
    '\n';
}

/** 주제 두뇌 주입용 블록 — 판정 없으면 빈 문자열(무주입).
 *  excludeTokens(2026-08-25): 계열 쿨다운 토큰 — 그 계열의 opportunity 는 '우선 검토' 주입에서 제외
 *  (avoid 는 유지 — 금지는 쿨다운과 무관하게 항상 유효). */
export function topicVerdictBlock(slug?: string, excludeTokens: string[] = []): string {
  try {
    const list = readTopicVerdicts(slug).filter((v) =>
      !(v.verdict === 'opportunity' && excludeTokens.some((t) => v.keyword.replace(/\s+/g, '').includes(t))));
    return buildVerdictBlock(list);
  } catch { return ''; }
}

/** 기회 소진 — 이 키워드(정규화 완전 일치)로 글이 실제 채택된 순간 호출. 이후 프롬프트 주입에서 빠진다.
 *  일일 수확이 같은 문구를 재추출해도 mergeVerdicts 가 동일 판정·근거면 기존 항목(소진 상태)을 보존한다. */
export function consumeOpportunityVerdict(keyword: string, slug?: string): void {
  try {
    const list = readTopicVerdicts(slug);
    const k = normKw(keyword);
    let hit = false;
    for (const v of list) {
      if (v.verdict === 'opportunity' && !v.consumedTs && normKw(v.keyword) === k) {
        v.consumedTs = new Date().toISOString();
        hit = true;
      }
    }
    if (hit) {
      writeTopicVerdicts(list, slug);
      console.log(`[verdicts] 기회 소진 — "${keyword}" (채택됨, 이후 주입 제외)`);
    }
  } catch { /* 무해 */ }
}

function readTail(p: string, chars: number): string {
  try { return fs.readFileSync(p, 'utf-8').slice(-chars); } catch { return ''; }
}

/**
 * 일일 수확 — 리서치 직원 기록의 최근 조각에서 '실측 판정'만 micro 로 추출해 저장소에 병합.
 * 실측 = 검색량·자동완성·SERP 등 도구 수치가 근거로 적힌 것만(추측·계획·일반론 제외를 프롬프트로 강제).
 * perf-sync 일일 틱에서 fire-and-forget 호출 — 실패해도 다음 날 재시도될 뿐.
 */
export async function harvestTopicVerdicts(signal?: AbortSignal): Promise<number> {
  try {
    const slug = activeBrandSlug();
    if (!slug) return 0;
    const suffix = brandFileSuffixFor(slug);
    const roles = ['seo_strategist', 'trend_researcher', 'research_lead'];
    const chunks: string[] = [];
    for (const role of roles) {
      for (const file of [`verified${suffix}.md`, `memory${suffix}.md`]) {
        const t = readTail(path.join(CONFIG.dataDir, 'agents', role, file), 4000);
        if (t.trim()) chunks.push(`### ${role}/${file}\n${t}`);
      }
    }
    if (!chunks.length) return 0;
    const o = await microJSON<{ verdicts?: Array<{ keyword?: unknown; verdict?: unknown; reason?: unknown } | null> }>(
      resolveAssignment().micro,
      '너는 리서치 기록 감사원이다. 직원 기록에서 검색 키워드 단위의 **실측 판정**만 추출한다. ' +
      '실측 = 검색량·자동완성·SERP·데이터랩 같은 도구 수치가 근거로 적힌 것. 추측·계획·일반론·문체 학습 메모는 제외한다.',
      `[직원 기록(최근 조각)]\n${chunks.join('\n\n')}\n\n` +
      '위 기록에서 다음 두 유형만 최대 8건 추출하라:\n' +
      '- avoid: 실측으로 폐기·부적합 판정된 키워드(무볼륨, 검색 의도 불일치, 오염 등)\n' +
      '- opportunity: 실측으로 검증된 공백·기회 키워드(검색량 있음 + 경쟁 빈틈)\n' +
      'reason 에는 근거 수치를 그대로 담아라(예: "월 8,630회·상위 경쟁 약함"). 수치 근거가 없는 항목은 내지 마라.\n' +
      '형식: {"verdicts":[{"keyword":"...","verdict":"avoid|opportunity","reason":"..."}]}',
      { maxOutputTokens: 700, signal },
    ).catch(() => null);
    const next = (o?.verdicts ?? [])
      .map((v) => ({
        keyword: asString(v?.keyword).trim().slice(0, 40),
        verdict: asString(v?.verdict).trim() as TopicVerdict['verdict'],
        reason: asString(v?.reason).trim().slice(0, 120),
        ts: new Date().toISOString(),
        source: 'research-harvest',
      }))
      .filter((v) => v.keyword && v.reason && (v.verdict === 'avoid' || v.verdict === 'opportunity'));
    if (!next.length) return 0;
    const merged = mergeVerdicts(readTopicVerdicts(slug), next);
    writeTopicVerdicts(merged, slug);
    console.log(`[verdicts] 리서치 판정 수확 — 신규 ${next.length}건, 보유 ${merged.length}건`);
    return next.length;
  } catch (e) {
    console.log(`[verdicts] 수확 실패(무해): ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}
