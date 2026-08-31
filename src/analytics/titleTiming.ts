/**
 * 제목 유형·발행 시각 A/B 분석 — 후속 카드(사용자 예약 2026-07-29 "필요할 때 알려줘", 넛지 44f226e →
 * 14일 축적 도래로 이행 2026-08-12). 발행된 블로그·쇼츠·릴스·카드뉴스의 제목 유형(정보/후킹/질문)과
 * 발행 시각(KST 슬롯)별 성과를 실측 지표로 집계하고, 팔로워 일일 스냅샷과 교차해 "팔로워를 만드는
 * 콘텐츠 유형"의 초기 신호를 만든다.
 *
 * 소비처 3곳: ① 일일 브리핑 섹션(사람 — 발행 버튼 누르는 시각 조정) ② proposeContentIdeas 프롬프트
 * (두뇌 — 다음 기획의 제목 유형 참고) ③ GET /analytics/title-timing (수동 조회·대시보드).
 * 성과 신호는 채널별 기존 정의를 재사용(블로그 performanceSignal · 쇼츠 shortsSignal · IG cardnewsSignal)
 * — 새 지표를 만들면 강화 루프와 눈금이 어긋난다. 전량 읽기 전용·fail-open.
 *
 * 통계 정직성 규약(리뷰 확정 2026-08-12):
 * - 신호 평균(byType·bySlot)은 **측정창 경과(성숙)분만** — 누적 지표라 어린 표본(D+1~2)이 최근 유형·슬롯을
 *   계통적으로 저평가하고, 그 순위가 기획 프롬프트로 되먹임되면 자기강화 왜곡이 된다. 성숙 기준은 강화
 *   루프와 동일(블로그 performanceWindowDays=14일 · 쇼츠/릴스/카드 shortsPerfDays=7일).
 * - 팔로워 교차는 **채널을 섞지 않는다** — 채널별 성장률 차이(IG 급성장 vs 네이버 정체)가 유형 우열로
 *   둔갑하는 교란을 차단. 귀속 분모는 그날 그 채널의 **발행 전체**(미측정분 포함 — 측정분만 세면 과대 귀속).
 */
import { CONFIG } from '../config';
import { pieceStore } from '../content/pieces';
import { shortsStore } from '../content/shorts';
import { cardNewsStore } from '../content/cardnews';
import { activeBrandSlug } from '../content/brand';
import { readMetrics, latestSampleBySource, type MetricSample } from './performance';
import { performanceSignal } from './reinforce';
import { shortsSignal } from './shortsPerf';
import { cardnewsSignal } from './cardnewsPerf';
import { readSnapshots, type FollowerSnapshot } from './followers';
import { kstDate } from '../util/time';

export type TitleType = 'question' | 'hook' | 'info';
export const TITLE_TYPE_KO: Record<TitleType, string> = { question: '질문형', hook: '후킹형', info: '정보형' };

export type ContentKind = 'blog' | 'shorts' | 'reels' | 'cardnews';
export const KIND_KO: Record<ContentKind, string> = { blog: '블로그', shorts: '쇼츠(유튜브)', reels: '릴스(IG)', cardnews: '카드뉴스(IG)' };
export type FollowerChannel = 'naver' | 'youtube' | 'instagram';
const CHANNEL_KO: Record<FollowerChannel, string> = { naver: '네이버', youtube: '유튜브', instagram: '인스타' };
/** 콘텐츠 종류 → 팔로워 스냅샷 채널 키(교차 분석용). */
const KIND_CHANNEL: Record<ContentKind, FollowerChannel> = {
  blog: 'naver', shorts: 'youtube', reels: 'instagram', cardnews: 'instagram',
};

/**
 * 제목 유형 분류(순수·결정적) — LLM 없이 표식으로 판정해야 매일 같은 제목이 같은 유형으로 집계된다.
 * 우선순위 질문>후킹>정보: "왜 안 달리는 이유"처럼 겹치면 질문 의도가 클릭 심리를 지배한다고 본다.
 * 질문 어미는 'ㄹ까' 축약형(될까·뭘까·다를까·필까…)까지 일반화하되 이유 종결 '니까'는 배제, 후킹의
 * 'N가지'는 소재어 '가지치기'와 충돌하지 않게 부정 전방탐색(리뷰 확정 2026-08-12 — 열거 누락·오탐 교정).
 * 그 외 표식은 보수적으로 — 애매하면 정보형(기본값)이 받는 게 A/B 통계를 덜 오염시킨다.
 */
export function classifyTitleType(title: string): TitleType {
  const t = title.trim();
  if (/[?？]/.test(t)
    || /(?:(?!니)[가-힣])까(?:요)?(?=[^가-힣]|$)/.test(t)
    || /(나요|는가|은가|인가)(?=[^가-힣]|$)/.test(t)) return 'question';
  if (/(\d+\s*가지(?!치)|이유|비밀|실수|함정|모르면|절대|금지|후회|손해|답이다|하지 마)/.test(t)) return 'hook';
  return 'info';
}

/** KST 시(hour 0~23) — 서버 타임존 무관(util/time 규약). 파싱 불가는 null. */
export function kstHourOf(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).find((p) => p.type === 'hour')?.value;
  const n = Number(h);
  return Number.isFinite(n) ? n : null;
}

/** 발행 시각 슬롯(KST) — 한국 생활 리듬 기준 6칸. 표본이 얇은 칸은 집계에서 n 으로 드러난다. */
export function slotOf(hour: number): string {
  if (hour < 6) return '새벽(0~6시)';
  if (hour < 10) return '아침(6~10시)';
  if (hour < 14) return '낮(10~14시)';
  if (hour < 18) return '오후(14~18시)';
  if (hour < 22) return '저녁(18~22시)';
  return '밤(22~24시)';
}

export interface PublishedItem {
  kind: ContentKind;
  id: string;
  title: string;
  publishedTs: string;
  titleType: TitleType;
  /** 채널별 기존 성과신호(0~1) — 채널 간 절대 비교 금지(눈금이 다름), 같은 채널 안의 상대 비교용. */
  signal: number;
  views: number;
  /** 지표 표본 존재 여부 — 신호 평균은 측정분만, 팔로워 귀속 분모는 발행 전체(미측정 포함)를 쓴다. */
  measured: boolean;
  /** 측정창 경과(성숙) 여부 — 어린 누적 표본의 나이 편향 차단(신호 평균은 성숙분만). */
  mature: boolean;
}

/** 신호 평균(byType·bySlot·기획 주입)에 넣을 수 있는 표본인가 — 측정됨 + 측정창 경과. */
const scorable = (i: PublishedItem): boolean => i.measured && i.mature;

/**
 * 발행 콘텐츠 수집 — 팔로워 귀속 분모를 위해 미측정분도 담고(measured=false), 신호 평균 쪽은
 * scorable 필터가 거른다. 릴스는 쇼츠와 같은 원본이라도 채널이 달라 별도 항목(채널별 A/B 가 목적이라
 * 이중 계상이 아니다). 릴스 발행 시각은 metaPublishedTs(메타 **첫 채널** 게시 시각, write-once) —
 * IG 전용 시각 필드가 없어 FB 전용 연결로 먼저 게시된 뒤 IG 를 나중에 붙인 릴스는 날짜가 FB 게시일로
 * 근사된다(통상 흐름은 IG 우선이라 분 단위 오차, 데이터 모델 한계로 기록해 둠).
 */
export function collectPublishedItems(brand: string, now: number = Date.now()): PublishedItem[] {
  const out: PublishedItem[] = [];
  const windowMs: Record<ContentKind, number> = {
    blog: CONFIG.performanceWindowDays * 86_400_000,
    shorts: CONFIG.shortsPerfDays * 86_400_000,
    reels: CONFIG.shortsPerfDays * 86_400_000,
    cardnews: CONFIG.shortsPerfDays * 86_400_000,
  };
  const push = (kind: ContentKind, id: string, title: string, ts: string, sample: MetricSample | null, signal: number): void => {
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return;
    out.push({
      kind, id, title, publishedTs: ts, titleType: classifyTitleType(title),
      signal: sample ? signal : 0, views: sample?.views ?? 0,
      measured: !!sample, mature: now - t >= windowMs[kind],
    });
  };
  try {
    for (const p of pieceStore().list()) {
      if ((p.brand ?? '') !== brand || !p.publishedTs) continue;
      if (!['published', 'measured', 'reflected'].includes(p.stage)) continue;
      const samples = readMetrics(p.id);
      const last = samples.length ? samples[samples.length - 1]! : null; // 블로그 시계열은 전부 네이버 표본
      push('blog', p.id, p.title, p.publishedTs, last, last ? performanceSignal(last) : 0);
    }
  } catch { /* 스토어 없음 무해 */ }
  try {
    for (const s of shortsStore().list()) {
      if ((s.brand ?? '') !== brand) continue;
      const title = s.title ?? s.topic;
      const samples = readMetrics(s.id);
      if (s.youtubeId && s.youtubeTs) {
        const m = latestSampleBySource(samples, 'youtube:api');
        push('shorts', s.id, title, s.youtubeTs, m, m ? shortsSignal(m.views, m.likes ?? 0) : 0);
      }
      if (s.igReelId && s.metaPublishedTs) {
        const m = latestSampleBySource(samples, 'meta:ig');
        push('reels', s.id, title, s.metaPublishedTs, m, m ? cardnewsSignal(m.reach ?? 0, m.saved ?? 0, m.shares ?? 0) : 0);
      }
    }
  } catch { /* 무해 */ }
  try {
    for (const c of cardNewsStore().list()) {
      if ((c.brand ?? '') !== brand || !c.igMediaId || !c.publishedTs) continue;
      const m = latestSampleBySource(readMetrics(c.id), 'meta:ig');
      push('cardnews', c.id, c.topic, c.publishedTs, m, m ? cardnewsSignal(m.reach ?? 0, m.saved ?? 0, m.shares ?? 0) : 0);
    }
  } catch { /* 무해 */ }
  return out;
}

export interface AggRow { key: string; count: number; avgSignal: number; avgViews: number }

/** 그룹 집계(순수) — 평균신호 내림차순, 동률은 표본 수 많은 쪽 우선. */
export function aggregate(items: PublishedItem[], keyFn: (it: PublishedItem) => string | null): AggRow[] {
  const acc = new Map<string, { n: number; sig: number; views: number }>();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null) continue;
    const a = acc.get(k) ?? { n: 0, sig: 0, views: 0 };
    a.n += 1; a.sig += it.signal; a.views += it.views;
    acc.set(k, a);
  }
  return [...acc.entries()]
    .map(([key, a]) => ({ key, count: a.n, avgSignal: a.sig / a.n, avgViews: a.views / a.n }))
    .sort((x, y) => (y.avgSignal - x.avgSignal) || (y.count - x.count));
}

/**
 * 팔로워 일일 증감(순수) — 연속(하루 간격) 스냅샷 쌍의 차이를 앞 날짜(D)에 귀속: "D에 발행한 콘텐츠가
 * D→D+1 증감을 만들었다"는 소박한 귀속. 결측일로 간격이 벌어진 쌍은 어느 하루의 몫인지 알 수 없어 버린다.
 */
export function dailyFollowerDeltas(snaps: FollowerSnapshot[]): Map<string, Partial<Record<FollowerChannel, number>>> {
  const sorted = [...snaps].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map<string, Partial<Record<FollowerChannel, number>>>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    if (new Date(b.date).getTime() - new Date(a.date).getTime() !== 86_400_000) continue;
    const delta: Partial<Record<FollowerChannel, number>> = {};
    for (const ch of ['naver', 'youtube', 'instagram'] as const) {
      const va = a[ch], vb = b[ch];
      if (typeof va === 'number' && typeof vb === 'number') delta[ch] = vb - va;
    }
    out.set(a.date, delta);
  }
  return out;
}

export interface FollowerCrossRow {
  channel: FollowerChannel; type: TitleType; items: number; totalDelta: number; perItem: number;
}

/**
 * 채널×제목 유형 × 팔로워 증감 교차(순수) — **채널 안에서만** 유형을 비교한다(채널 성장률 차이가 유형
 * 우열로 둔갑하는 교란 차단). 발행일의 채널 증감을 그날 같은 채널 **발행 전체**(미측정 포함)로 균등
 * 분할해 귀속 — 소박하지만 정직한 방식, 표본이 쌓이면 유형 차이가 드러난다. 스냅샷 범위 밖 발행분은 제외.
 */
export function crossFollowerByType(items: PublishedItem[], snaps: FollowerSnapshot[]): FollowerCrossRow[] {
  const deltas = dailyFollowerDeltas(snaps);
  const dayChCount = new Map<string, number>(); // `${date}|${channel}` → 그날 그 채널 발행 수
  const covered: Array<{ it: PublishedItem; date: string; ch: FollowerChannel }> = [];
  for (const it of items) {
    const date = kstDate(new Date(it.publishedTs));
    const ch = KIND_CHANNEL[it.kind];
    if (deltas.get(date)?.[ch] == null) continue;
    covered.push({ it, date, ch });
    const k = `${date}|${ch}`;
    dayChCount.set(k, (dayChCount.get(k) ?? 0) + 1);
  }
  const acc = new Map<string, { n: number; delta: number }>(); // `${channel}|${type}`
  for (const { it, date, ch } of covered) {
    const share = (deltas.get(date)![ch] ?? 0) / dayChCount.get(`${date}|${ch}`)!;
    const k = `${ch}|${it.titleType}`;
    const a = acc.get(k) ?? { n: 0, delta: 0 };
    a.n += 1; a.delta += share;
    acc.set(k, a);
  }
  return [...acc.entries()]
    .map(([k, a]) => {
      const [channel, type] = k.split('|') as [FollowerChannel, TitleType];
      return { channel, type, items: a.n, totalDelta: a.delta, perItem: a.delta / a.n };
    })
    .sort((x, y) => x.channel.localeCompare(y.channel) || y.perItem - x.perItem);
}

export interface TitleTimingReport {
  brand: string;
  itemsTotal: number;
  itemsScorable: number;
  /** 집계 규약 — 소비자(대시보드·API 이용자)가 표본 조건을 오해하지 않게 리포트 자체에 명시. */
  note: string;
  byType: Array<{ kind: ContentKind; kindKo: string; rows: Array<AggRow & { typeKo: string }> }>;
  bySlot: Array<{ kind: ContentKind; kindKo: string; rows: AggRow[] }>;
  followerByChannel: Array<{ channel: FollowerChannel; channelKo: string; rows: Array<FollowerCrossRow & { typeKo: string }> }>;
}

/** 전체 리포트 — 브리핑·엔드포인트 공용. 표본 없는 종류는 생략. */
export function buildTitleTimingReport(brand: string): TitleTimingReport {
  const items = collectPublishedItems(brand);
  const scored = items.filter(scorable);
  const kinds: ContentKind[] = ['blog', 'shorts', 'reels', 'cardnews'];
  const byType = kinds
    .map((kind) => ({
      kind, kindKo: KIND_KO[kind],
      rows: aggregate(scored.filter((i) => i.kind === kind), (i) => i.titleType)
        .map((r) => ({ ...r, typeKo: TITLE_TYPE_KO[r.key as TitleType] ?? r.key })),
    }))
    .filter((g) => g.rows.length);
  const bySlot = kinds
    .map((kind) => ({
      kind, kindKo: KIND_KO[kind],
      rows: aggregate(scored.filter((i) => i.kind === kind), (i) => {
        const h = kstHourOf(i.publishedTs);
        return h == null ? null : slotOf(h);
      }),
    }))
    .filter((g) => g.rows.length);
  const cross = crossFollowerByType(items, readSnapshots(brand));
  const followerByChannel = (['naver', 'youtube', 'instagram'] as const)
    .map((channel) => ({
      channel, channelKo: CHANNEL_KO[channel],
      rows: cross.filter((r) => r.channel === channel).map((r) => ({ ...r, typeKo: TITLE_TYPE_KO[r.type] })),
    }))
    .filter((g) => g.rows.length);
  return {
    brand, itemsTotal: items.length, itemsScorable: scored.length,
    note: `신호 평균은 측정창 경과분만(블로그 ${CONFIG.performanceWindowDays}일·쇼츠/릴스/카드 ${CONFIG.shortsPerfDays}일). ` +
      '팔로워 교차는 채널 내 비교 전용이며 발행일 D→D+1 증감을 그날 그 채널 발행 전체로 균등 분할한 소박 귀속.',
    byType, bySlot, followerByChannel,
  };
}

const fmt = (n: number): string => n.toFixed(2);
/** 브리핑 한 줄에 담을 만큼 견고한 유형 표본 최소치 — 슬롯 줄과 동일 눈금. */
const MIN_ROW_N = 3;

/** 브리핑 섹션 — 표본이 충분할 때만(성숙·측정 20편+). 채널당 제목·시각 한 줄씩 + 팔로워 교차로 압축. */
export function titleTimingSection(): { heading: string; body: string } | null {
  try {
    const rep = buildTitleTimingReport(activeBrandSlug() || '');
    if (rep.itemsScorable < 20) return null;
    const lines: string[] = [];
    for (const g of rep.byType) {
      if (g.rows.reduce((s, r) => s + r.count, 0) < 8) continue; // 채널 표본 8편 미만은 한 줄도 이르다
      const solid = g.rows.filter((r) => r.count >= MIN_ROW_N); // 얇은 유형이 선두로 읽히는 것 방지
      if (solid.length >= 2) lines.push(`${g.kindKo} 제목: ${solid.map((r) => `${r.typeKo} ${fmt(r.avgSignal)}(${r.count}편)`).join(' > ')}`);
      const slots = rep.bySlot.find((s) => s.kind === g.kind)?.rows.filter((r) => r.count >= MIN_ROW_N) ?? [];
      if (slots.length >= 2) lines.push(`${g.kindKo} 시각: ${slots.slice(0, 3).map((r) => `${r.key} ${fmt(r.avgSignal)}(${r.count}편)`).join(' > ')}`);
    }
    // 팔로워 교차 — 커버 표본이 가장 두꺼운 채널 하나만, 유형당 3편+ 이 2종 이상일 때(잡음이 1위로 읽히는 것 방지).
    const best = [...rep.followerByChannel]
      .sort((a, b) => b.rows.reduce((s, r) => s + r.items, 0) - a.rows.reduce((s, r) => s + r.items, 0))[0];
    const crossSolid = best?.rows.filter((r) => r.items >= MIN_ROW_N) ?? [];
    if (crossSolid.length >= 2) {
      lines.push(`팔로워 교차(${best!.channelKo}, 발행일 D→D+1 소박 귀속): ${crossSolid
        .map((r) => `${r.typeKo} ${r.perItem >= 0 ? '+' : ''}${r.perItem.toFixed(1)}명/편(${r.items}편)`).join(' · ')}`);
    }
    if (!lines.length) return null;
    lines.push('측정창 경과분만 집계 · 신호는 채널별 눈금이라 채널 간 비교는 금물 — 같은 줄 안에서만 우열을 읽으세요.');
    return { heading: '🧪 제목 유형·발행 시각 A/B (실측)', body: lines.join('\n') };
  } catch { return null; }
}

/**
 * 기획 프롬프트 주입 블록 — 블로그 제목 유형의 실측 우열을 두뇌에 참고로 준다(후속 카드의 "기획 강화 연결").
 * 게이트: 성숙·측정 블로그 15편+ 그리고 표본 5편+ 유형 2개 이상 — 얇은 표본으로 유형을 조향하면 그게 곧
 * 편향이라, 비교 라인은 견고한 유형만으로 만들고 얇은 유형은 '표본 부족'으로만 언급(실측 2026-08-12:
 * 질문형 2편이 선두라는 이유로 21편 vs 26편의 견고한 후킹·정보 비교까지 통째로 버려지던 게이트를 교정).
 * 유형 강제가 아니라 참고 신호로만 준다(소재·정확성 우선 — 다양성 가드와 충돌 금지).
 */
export function titleTypeGuidanceBlock(brand: string): string {
  try {
    const rows = aggregate(
      collectPublishedItems(brand).filter((i) => i.kind === 'blog' && scorable(i)), (i) => i.titleType);
    const total = rows.reduce((s, r) => s + r.count, 0);
    const solid = rows.filter((r) => r.count >= 5);
    if (total < 15 || solid.length < 2) return '';
    const line = solid.map((r) => `${TITLE_TYPE_KO[r.key as TitleType] ?? r.key} ${fmt(r.avgSignal)}(n=${r.count})`).join(' · ');
    const thin = rows.filter((r) => r.count < 5).map((r) => TITLE_TYPE_KO[r.key as TitleType] ?? r.key);
    return `[제목 유형 실측 성과(블로그, 성과신호 평균) — 참고]\n${line}` +
      (thin.length ? ` · ${thin.join('·')}은 표본 부족(판단 보류 — 써보는 것도 실험이 된다)` : '') + '\n' +
      '- title 작성 시 우위 유형을 참고하라. 단 유형 강제 아님 — 소재 적합성과 검색 의도가 우선이고, 같은 유형만 반복하지 마라.\n\n';
  } catch { return ''; }
}
