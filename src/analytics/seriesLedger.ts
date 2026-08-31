/**
 * 계열 원장 v2(2026-08-25 사용자 승인 "풀 설계") — 편중 쿨다운의 본체.
 *
 * v1(정규식·수동 사전 집계)의 한계 4가지를 교체한다:
 *  ① 수동 차원(새 편중마다 코드 수정) → micro 배치 분류로 {수종, 행위} 라벨을 원장에 적재(결정적 폴백 동반).
 *  ② 이분법 강도 → 지수 감쇠 점수(반감기 3.5일, 절벽 해제 없음) + 소프트/하드 2단계.
 *  ③ 거친 해상도 → 수종×행위 '조합'은 엄격(최근 2편급), 수종·행위 '단독'은 느슨(최근 3편급) —
 *     "포도×전정은 막되 포도×월동은 소프트만"이 된다.
 *  ④ 기각만 있고 유도 없음 → 소프트는 기각이 아니라 프롬프트 회피+트렌드·기회 신호 제외로만 작용.
 *
 * 비용: 미분류 편 배치 분류 micro 1콜(대개 하루 2편=하루 1콜) + 기획 라운드당 후보 5건 일괄 분류 1콜.
 * 전량 fail-open — 분류 실패 시 결정적 폴백 라벨(seriesCooldown)로 계산이 이어진다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { activeBrandSlug, brandFileSuffixFor } from '../content/brand';
import { pieceStore } from '../content/pieces';
import { fallbackSeriesLabels, ACTIVITY_AXES } from '../content/seriesCooldown';
import { microJSON } from '../orchestrator/agent';
import { resolveAssignment } from '../llm/setting';

export interface SeriesLabel { pieceId: string; species: string | null; activity: string | null; source: 'llm' | 'fallback' }
export interface SeriesEntry { species: string | null; activity: string | null; ts: string }
export interface SeriesScores {
  species: Map<string, number>; activity: Map<string, number>; combo: Map<string, number>;
  /** 7일 창 단순 횟수(감쇠 무관) — 리뷰 확정 회귀 대응: 격일 케이던스에선 감쇠 합이 하드 임계에
   *  영원히 못 미친다(점근합 2.06<2.4). v1 의미론의 결정적 바닥선용. */
  n7species: Map<string, number>; n7activity: Map<string, number>; n7combo: Map<string, number>;
  /** 3일 내 같은 수종 편수(2026-08-27). */
  n3species: Map<string, number>;
}
export type SeriesGate = { level: 'hard' | 'soft' | 'none'; key?: string; why?: string };

/** 감쇠 상수 — 반감기 3.5일(τ=3.5/ln2). 오늘 1.0 · 어제 0.82 · 3.5일 전 0.5 · 7일 전 0.25. */
const TAU_DAYS = 3.5 / Math.LN2;
const HORIZON_DAYS = 21;          // 이보다 오래된 편은 계산에서 제외(0.016 이하라 무의미)
/** 감쇠 임계 — 소프트 ≈ 최근 1.5편, 하드는 '최신 편 0일령 기준' 조합 이틀 2편 · 단독 사흘 3편.
 *  격일 간격에선 감쇠 합이 임계에 못 미치므로(리뷰 실측) 아래 N7 바닥선이 결정적 백스톱을 이룬다:
 *  7일 내 같은 조합 2편+ 또는 같은 수종/행위 3편+ 이면 점수와 무관하게 하드(창설 사고 4편/6일을 4편째 차단). */
export const SERIES_SOFT = 1.2;
export const SERIES_HARD_COMBO = 1.6;
export const SERIES_HARD_SINGLE = 2.4;
export const SERIES_N7_COMBO = 2;
export const SERIES_N7_SINGLE = 3;
/** 같은 수종 3일 내 1편+ 이면 하드(2026-08-27 사용자: "며칠 전에 올리브 글을 썼는데" — 3일 만의 같은 수종 재등장 차단). */
export const SERIES_N3_DAYS = 3;
export const SERIES_N3_SPECIES = 1;
const N7_DAYS = 7;
const MAX_LEDGER = 300;

/** 계열이 될 수 없는 총칭·범주어(리뷰 지적) — LLM 오라벨이 원장·후보 양쪽에 상관 편향으로 실리면
 *  브랜드 핵심 소재('묘목' 등)가 체계적으로 눌린다. 프롬프트 지시의 코드 백스톱. */
const NON_SERIES = new Set(['묘목', '유실수', '조경수', '정원수', '과실수', '과실나무', '유실수묘목', '나무', '식물', '수목']);
const NON_ACTIVITY = new Set(['관리', '재배', '키우기', '가꾸기', '기르기']);

const normSpecies = (s: unknown): string | null => {
  const raw = String((s as string | number | null | undefined) ?? '').trim().normalize('NFC').replace(/\s+/g, '');
  if (!raw || raw === 'null') return null;
  const stem = raw.replace(/나무$/, '');
  // 단음절 어간 수종(감나무·배나무·소나무 등)은 스트립하면 키가 소멸한다(리뷰 확정 메이저) — 원형 유지.
  // LLM 이 '감'처럼 1자 순수형을 내면 '감나무'로 승격해 키 공간을 통일한다.
  const key = stem.length >= 2 ? stem : (raw.length >= 2 ? raw : `${raw}나무`);
  if (NON_SERIES.has(key) || NON_SERIES.has(raw)) return null;
  return key.length >= 2 && key.length <= 12 ? key : null;
};
const normActivity = (s: unknown): string | null => {
  const t = String((s as string | number | null | undefined) ?? '').trim().normalize('NFC').replace(/\s+/g, '');
  if (t.length < 2 || t.length > 10 || t === 'null' || NON_ACTIVITY.has(t)) return null;
  // 동의어를 표준형(terms[0])으로 접기 — LLM·폴백·수동 표기가 같은 키 공간을 쓰게.
  for (const a of ACTIVITY_AXES) if (a.terms.some((term) => t === term.replace(/\s+/g, ''))) return a.terms[0]!;
  return t;
};

function ledgerPath(slug?: string): string {
  const s = slug ?? activeBrandSlug();
  return path.join(CONFIG.dataDir, 'topics', `series-ledger${brandFileSuffixFor(s || undefined)}.json`);
}
function readLedger(slug?: string): SeriesLabel[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(slug), 'utf-8')) as { labels?: unknown };
    return (Array.isArray(raw.labels) ? raw.labels : [])
      .map((l) => l as SeriesLabel)
      .filter((l) => l && typeof l.pieceId === 'string');
  } catch { return []; }
}
function writeLedger(labels: SeriesLabel[], slug?: string): void {
  const f = ledgerPath(slug);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ labels: labels.slice(-MAX_LEDGER) }, null, 2), 'utf-8');
  fs.renameSync(`${f}.tmp`, f);
}

/** 점수 계산(순수, 테스트 대상) — 라벨별 Σ exp(-경과일/τ). 조합 키는 "수종×행위". */
export function computeSeriesScores(entries: SeriesEntry[], now = Date.now()): SeriesScores {
  const s: SeriesScores = {
    species: new Map(), activity: new Map(), combo: new Map(),
    n7species: new Map(), n7activity: new Map(), n7combo: new Map(),
    n3species: new Map(),
  };
  const add = (m: Map<string, number>, k: string, w: number): void => { m.set(k, (m.get(k) ?? 0) + w); };
  for (const e of entries) {
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    const ageDays = (now - t) / 86_400_000;
    if (ageDays < 0 || ageDays > HORIZON_DAYS) continue;
    const w = Math.exp(-ageDays / TAU_DAYS);
    const in7 = ageDays <= N7_DAYS;
    const in3 = ageDays <= SERIES_N3_DAYS;
    if (e.species) { add(s.species, e.species, w); if (in7) add(s.n7species, e.species, 1); if (in3) add(s.n3species, e.species, 1); }
    if (e.activity) { add(s.activity, e.activity, w); if (in7) add(s.n7activity, e.activity, 1); }
    if (e.species && e.activity) { const k = `${e.species}×${e.activity}`; add(s.combo, k, w); if (in7) add(s.n7combo, k, 1); }
  }
  return s;
}

/** 게이트 판정(순수, 테스트 대상) — 하드 = 감쇠 임계 또는 N7 바닥선(둘 중 하나), 조합 엄격 > 단독 느슨 > 소프트. */
export function gateForLabels(l: { species: string | null; activity: string | null }, sc: SeriesScores): SeriesGate {
  const sp = l.species ? sc.species.get(l.species) ?? 0 : 0;
  const ac = l.activity ? sc.activity.get(l.activity) ?? 0 : 0;
  const comboKey = l.species && l.activity ? `${l.species}×${l.activity}` : null;
  const cb = comboKey ? sc.combo.get(comboKey) ?? 0 : 0;
  const spN = l.species ? sc.n7species.get(l.species) ?? 0 : 0;
  const acN = l.activity ? sc.n7activity.get(l.activity) ?? 0 : 0;
  const cbN = comboKey ? sc.n7combo.get(comboKey) ?? 0 : 0;
  const sp3 = l.species ? sc.n3species?.get(l.species) ?? 0 : 0;
  if (comboKey && (cb >= SERIES_HARD_COMBO || cbN >= SERIES_N7_COMBO)) {
    return { level: 'hard', key: comboKey, why: cbN >= SERIES_N7_COMBO ? `조합 7일 ${cbN}편` : `조합 ${cb.toFixed(1)}` };
  }
  if (l.species && (sp >= SERIES_HARD_SINGLE || spN >= SERIES_N7_SINGLE)) {
    return { level: 'hard', key: l.species, why: spN >= SERIES_N7_SINGLE ? `수종 7일 ${spN}편` : `수종 ${sp.toFixed(1)}` };
  }
  // 3일 바닥선(2026-08-27) — 감쇠 합·7일 3편에 못 미쳐도 같은 수종이 3일 안에 1편이라도 있으면 하드.
  if (l.species && sp3 >= SERIES_N3_SPECIES) {
    return { level: 'hard', key: l.species, why: `수종 3일 ${sp3}편` };
  }
  if (l.activity && (ac >= SERIES_HARD_SINGLE || acN >= SERIES_N7_SINGLE)) {
    return { level: 'hard', key: l.activity, why: acN >= SERIES_N7_SINGLE ? `행위 7일 ${acN}편` : `행위 ${ac.toFixed(1)}` };
  }
  const softHits: Array<[string, number]> = [];
  if (comboKey && cb >= SERIES_SOFT) softHits.push([comboKey, cb]);
  if (l.species && sp >= SERIES_SOFT) softHits.push([l.species, sp]);
  if (l.activity && ac >= SERIES_SOFT) softHits.push([l.activity, ac]);
  if (softHits.length) {
    softHits.sort((a, b) => b[1] - a[1]);
    return { level: 'soft', key: softHits[0]![0], why: `점수 ${softHits[0]![1].toFixed(1)}` };
  }
  return { level: 'none' };
}

/** 라벨 보강(순수, 테스트 대상) — 폴백 라벨이 비었을 때 원장에 이미 있는 계열 키를 후보 텍스트와
 *  포함 대조로 채운다(v1의 상호 대조 복원 — "포도 수확 후 저장법"이 '포도' 계열로 잡히게). */
export function fillLabelsFromKnown(
  text: string, labels: { species: string | null; activity: string | null }, sc: SeriesScores,
): { species: string | null; activity: string | null } {
  const stripped = (text || '').normalize('NFC').replace(/\s+/g, '');
  const findIn = (keys: Iterable<string>): string | null => {
    let best: string | null = null;
    for (const k of keys) if (k.length >= 2 && stripped.includes(k) && (!best || k.length > best.length)) best = k;
    return best;
  };
  return {
    species: labels.species ?? findIn(sc.species.keys()),
    activity: labels.activity ?? findIn(sc.activity.keys()),
  };
}

/** 브랜드의 점수 계산 입력 — 원장 라벨 우선, 미분류 편은 결정적 폴백 라벨(즉석). */
function entriesForBrand(slug?: string, now = Date.now()): SeriesEntry[] {
  const byId = new Map(readLedger(slug).map((l) => [l.pieceId, l] as const));
  const cutoff = now - HORIZON_DAYS * 86_400_000;
  const out: SeriesEntry[] = [];
  for (const p of pieceStore().list()) {
    if ((p.brand ?? '') !== (slug ?? '')) continue;
    const t = new Date(p.createdTs).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const l = byId.get(p.id);
    const labels = l ? { species: l.species, activity: l.activity } : fallbackSeriesLabels(`${p.title} ${p.keyword ?? ''}`);
    out.push({ species: normSpecies(labels.species), activity: normActivity(labels.activity), ts: p.createdTs });
  }
  return out;
}

/** 현재 브랜드 점수(실적재) — 실패는 빈 점수(전 게이트 통과, fail-open). */
export function seriesScoresFor(slug?: string, now = Date.now()): SeriesScores {
  try { return computeSeriesScores(entriesForBrand(slug, now), now); }
  catch { return { species: new Map(), activity: new Map(), combo: new Map(), n7species: new Map(), n7activity: new Map(), n7combo: new Map(), n3species: new Map() }; }
}

/** 텍스트 후보 게이트(폴백 라벨 경로) — 클러스터 소진 등 라벨 분류가 없는 지점용. 원장 키 포함 대조로 보강. */
export function seriesGateForText(text: string, slug?: string): SeriesGate {
  try {
    const sc = seriesScoresFor(slug);
    const f = fallbackSeriesLabels(text);
    const labels = fillLabelsFromKnown(text, { species: normSpecies(f.species), activity: normActivity(f.activity) }, sc);
    return gateForLabels(labels, sc);
  } catch { return { level: 'none' }; }
}

/** 쿨다운 요약(프롬프트·신호 제외용) — hard/soft 표시 목록 + 매칭 토큰(동의어 전개).
 *  excludeTokens=소프트 포함 전체(트렌드 자동완성 — 약한 신호), excludeTokensHard=하드만
 *  (실측 검증된 opportunity 는 소프트 계열이면 살려 둔다 — 리뷰 지적: 소프트가 준하드로 작동하던 중첩). */
export function cooldownSummary(slug?: string): { hard: string[]; soft: string[]; excludeTokens: string[]; excludeTokensHard: string[] } {
  try {
    const sc = seriesScoresFor(slug);
    const hard: string[] = []; const soft: string[] = [];
    const tokens = new Set<string>(); const hardTokens = new Set<string>();
    const expand = (set: Set<string>, key: string, kind: 'species' | 'activity'): void => {
      set.add(key);
      if (kind === 'activity') for (const a of ACTIVITY_AXES) if (a.terms[0] === key) a.terms.forEach((t) => set.add(t));
    };
    const push = (key: string, score: number, n7: number, kind: 'species' | 'activity' | 'combo'): void => {
      const isHard = kind === 'combo'
        ? (score >= SERIES_HARD_COMBO || n7 >= SERIES_N7_COMBO)
        : (score >= SERIES_HARD_SINGLE || n7 >= SERIES_N7_SINGLE);
      if (isHard) hard.push(`${key}(${score.toFixed(1)})`);
      else if (score >= SERIES_SOFT) soft.push(`${key}(${score.toFixed(1)})`);
      if (kind !== 'combo' && (isHard || score >= SERIES_SOFT)) {
        expand(tokens, key, kind);
        if (isHard) expand(hardTokens, key, kind);
      }
    };
    for (const [k, v] of sc.species) push(k, v, (sc.n3species?.get(k) ?? 0) >= SERIES_N3_SPECIES ? SERIES_N7_SINGLE : sc.n7species.get(k) ?? 0, 'species'); // 3일 내 재등장은 하드로 표시
    for (const [k, v] of sc.activity) push(k, v, sc.n7activity.get(k) ?? 0, 'activity');
    for (const [k, v] of sc.combo) push(k, v, sc.n7combo.get(k) ?? 0, 'combo');
    return { hard, soft, excludeTokens: [...tokens], excludeTokensHard: [...hardTokens] };
  } catch { return { hard: [], soft: [], excludeTokens: [], excludeTokensHard: [] }; }
}

const CLASSIFY_SYSTEM =
  '너는 원예 콘텐츠 사서다. 각 글 제목·키워드를 두 축으로 분류한다. ' +
  "species: 특정 식물·수종의 고유명을 '한 단어'로(예: 포도, 배롱, 블루베리, 올리브, 감나무 — '나무' 접미는 어간이 두 글자 이상이면 떼라: 배롱나무→배롱, 감나무는 그대로). " +
  '유실수·조경수·묘목·나무 같은 총칭·범주는 null. ' +
  "activity: 글의 행위·주제 축을 표준 한 단어로(예: 전정, 식재, 물주기, 월동, 병충해, 시비, 고르기, 구별, 수확, 배치, 꽃눈) — " +
  "'관리'처럼 무의미하게 넓은 말은 피하고 더 구체 축을 골라라. 정말 없으면 null. 요청된 JSON 스키마만 출력한다.";

/** 미분류 편 배치 분류 — 기획 직전·일일 틱에서 호출(대개 no-op 또는 micro 1콜). fail-open. */
export async function ensureSeriesLabels(slug?: string, signal?: AbortSignal): Promise<number> {
  try {
    const byId = new Map(readLedger(slug).map((l) => [l.pieceId, l] as const));
    const cutoff = Date.now() - HORIZON_DAYS * 86_400_000;
    // 미분류 + 폴백 기록분 재분류(리뷰 지적: 부분 응답 폴백이 영구 동결되면 폴백 매처의 사각이 굳는다).
    const missing = pieceStore().list()
      .filter((p) => (p.brand ?? '') === (slug ?? ''))
      .filter((p) => { const l = byId.get(p.id); return !l || l.source === 'fallback'; })
      .filter((p) => { const t = new Date(p.createdTs).getTime(); return Number.isFinite(t) && t >= cutoff; })
      .slice(-20);
    if (!missing.length) return 0;
    const o = await microJSON<{ labels?: Array<{ id?: unknown; species?: unknown; activity?: unknown } | null> }>(
      resolveAssignment().micro, CLASSIFY_SYSTEM,
      `[글 목록]\n${missing.map((p) => `- id=${p.id} | ${p.title}${p.keyword ? ` (키워드: ${p.keyword})` : ''}`).join('\n')}\n\n` +
      '형식: {"labels":[{"id":"piece_...","species":"...|null","activity":"...|null"}]} — 전 항목 포함.',
      { maxOutputTokens: 700, signal },
    ).catch(() => null);
    if (!o?.labels) return 0; // 호출 실패 — 기록하지 않고 다음 기회에 재시도(폴백 즉석 계산이 메운다)
    // id 는 숫자로 올 수 있다(리뷰 지적) — String 코어스로 키를 보존.
    const got = new Map(o.labels.map((l) => [String((l as { id?: unknown } | null)?.id ?? '').trim(), l] as const));
    let added = 0;
    for (const p of missing) {
      const g = got.get(p.id);
      const label: SeriesLabel = g
        ? { pieceId: p.id, species: normSpecies((g as { species?: unknown }).species), activity: normActivity((g as { activity?: unknown }).activity), source: 'llm' }
        : (() => { const f = fallbackSeriesLabels(`${p.title} ${p.keyword ?? ''}`); return { pieceId: p.id, species: normSpecies(f.species), activity: normActivity(f.activity), source: 'fallback' as const }; })();
      byId.set(p.id, label);
      added++;
    }
    // 쓰기 직전 재읽기 병합(리뷰 지적: 프로세스 간 last-write-wins 유실 창 축소) — llm 라벨이 폴백보다 우선.
    const merged = new Map(readLedger(slug).map((l) => [l.pieceId, l] as const));
    for (const [id, l] of byId) {
      const prev = merged.get(id);
      if (!prev || prev.source === 'fallback' || l.source === 'llm') merged.set(id, l);
    }
    writeLedger([...merged.values()], slug);
    console.log(`[series] 계열 분류 적재 — ${added}건(원장 ${merged.size})`);
    return added;
  } catch { return 0; }
}

/** 기획 후보 일괄 분류(라운드당 micro 1콜) — 실패 시 후보별 결정적 폴백. */
export async function classifyCandidates(
  cands: Array<{ title: string; keyword?: string }>, signal?: AbortSignal,
): Promise<Array<{ species: string | null; activity: string | null }>> {
  const fallback = cands.map((c) => {
    const f = fallbackSeriesLabels(`${c.title} ${c.keyword ?? ''}`);
    return { species: normSpecies(f.species), activity: normActivity(f.activity) };
  });
  try {
    if (!cands.length) return [];
    const o = await microJSON<{ labels?: Array<{ id?: unknown; species?: unknown; activity?: unknown } | null> }>(
      resolveAssignment().micro, CLASSIFY_SYSTEM,
      `[글 목록]\n${cands.map((c, i) => `- id=${i} | ${c.title}${c.keyword ? ` (키워드: ${c.keyword})` : ''}`).join('\n')}\n\n` +
      '형식: {"labels":[{"id":"0","species":"...|null","activity":"...|null"}]} — 전 항목 포함.',
      { maxOutputTokens: 500, signal },
    ).catch(() => null);
    if (!o?.labels) return fallback;
    // id 숫자 응답 대비 String 코어스(리뷰 지적) — 아니면 전 후보가 조용히 폴백으로 강등된다.
    const got = new Map(o.labels.map((l) => [String((l as { id?: unknown } | null)?.id ?? '').trim(), l] as const));
    return cands.map((_, i) => {
      const g = got.get(String(i));
      return g
        ? { species: normSpecies((g as { species?: unknown }).species), activity: normActivity((g as { activity?: unknown }).activity) }
        : fallback[i]!;
    });
  } catch { return fallback; }
}
