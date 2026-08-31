/**
 * 키워드 클러스터 백로그 — 대표 편의 연관 검색어(자동완성) 형제들을 '재고'로 쌓고, 자율 틱이 간격을
 * 두고 소진한다(스펙 docs/superpowers/specs/2026-08-06-keyword-cluster-backlog-design.md).
 * 한 주제 입력 = 여러 편의 씨앗 — 지금까지는 자동완성 목록이 그라운딩 텍스트로 뭉개져 한 편에만 쓰였다.
 *
 * 예고 대장(promises)과 왜 별도인가:
 *   - promises 의 MAX_PENDING=12 는 브랜드 공유 캡 — 클러스터가 잠식하면 파생 콘텐츠의 "다음 편" 예고가
 *     초과 시점에 조용히 유실된다(create 가 null).
 *   - dueMonth 없는 항목은 isDue 가 영구 false — 형제 검색어엔 자연스러운 달(月)이 없다.
 *   - 의미가 다르다: 예고는 갚아야 할 빚(시즌 창·시청자 신뢰), 클러스터는 재고(기회·무기한).
 * 파일 영속 패턴(원자적 tmp+rename, brand 필드 격리)만 promises 에서 복사한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { offBrandTerm } from './brand';
import { genId } from '../util/ids';

export interface ClusterTopic {
  id: string;
  /** 브랜드 슬러그 — 시드 piece 의 브랜드(범용이면 undefined). */
  brand?: string;
  /** 클러스터 시드 키워드("추희자두") — 쿨다운·소진 상한의 그룹 키. */
  seedKeyword: string;
  /** 대표 편 piece id — 소진 재검증에서 '시드 편 제외' 대조에 쓴다. */
  seedPieceId?: string;
  /** 형제 검색어("추희자두 후숙") — 소진 시 piece.keyword 가 된다(SEO 과녁). */
  keyword: string;
  /** 가제 — 소진 시 piece 제목(런 주제). 채굴 시 micro 가 제안. */
  title: string;
  /** 검색 의도 한 줄(표시·참고용). */
  angle?: string;
  status: 'pending' | 'consumed' | 'dropped';
  consumedPieceId?: string;
  createdTs: string;
  updatedTs: string;
}

/** 시드당 형제 저장 상한 — 자동완성 최대 15개 중 판정 통과 상위만(과적재 방지). */
export const SIBLINGS_PER_SEED = 6;
/** 브랜드 pending 총량 캡 — 초과 채굴은 버린다(백로그 폭주 방지). */
export const PENDING_CAP = 24;
/** 클러스터당 소진 상한(시드 제외) — 한 시드가 캘린더를 독식하지 않게. */
export const CONSUME_CAP_PER_SEED = 4;
/** 같은 시드 쿨다운 — 최근 자율 blog N편 안에 같은 시드 형제가 있으면 이번 틱은 건너뜀(도배 방지). */
export const SEED_COOLDOWN_PIECES = 3;

const normKw = (s: string): string => (s || '').replace(/\s+/g, '').toLowerCase();

export class ClusterStore {
  private file: string;
  private items = new Map<string, ClusterTopic>();
  constructor(dir: string = path.join(CONFIG.dataDir, 'topics')) {
    this.file = path.join(dir, 'backlog.json');
    this.load();
  }
  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ClusterTopic[];
      if (Array.isArray(raw)) for (const t of raw) if (t && t.id) this.items.set(t.id, t);
    } catch { /* 없으면 빈 스토어 */ }
  }
  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 2), 'utf-8');
      fs.renameSync(tmp, this.file); // 원자적 교체
    } catch { /* 영속 실패 무해(다음 변경에서 재시도) */ }
  }
  list(): ClusterTopic[] { return [...this.items.values()]; }
  get(id: string): ClusterTopic | undefined { return this.items.get(id); }

  /**
   * 형제 일괄 등록 — 가드 3중: ①오프브랜드 형제만 제외(전체는 계속) ②같은 brand·keyword 의
   * 기존 항목(pending/consumed) 중복 제외 ③시드당 SIBLINGS_PER_SEED·브랜드 PENDING_CAP.
   * brand 는 명시값만 신뢰(null=범용) — 채굴 시점의 piece 브랜드가 라이브 activeBrand 로 오귀속되지 않게.
   */
  createMany(input: {
    brand?: string | null; seedKeyword: string; seedPieceId?: string;
    siblings: Array<{ keyword: string; title: string; angle?: string }>;
  }): ClusterTopic[] {
    const brand = input.brand || undefined;
    const seedKw = input.seedKeyword.trim().slice(0, 40);
    if (!seedKw) return [];
    const existingKws = new Set(
      this.list().filter((t) => (t.brand ?? '') === (brand ?? '') && t.status !== 'dropped').map((t) => normKw(t.keyword)),
    );
    const seedCount = this.list().filter((t) => (t.brand ?? '') === (brand ?? '') && t.seedKeyword === seedKw && t.status !== 'dropped').length;
    let pendingCount = this.pending(brand ?? '').length;
    const out: ClusterTopic[] = [];
    const now = new Date().toISOString();
    for (const s of input.siblings) {
      if (seedCount + out.length >= SIBLINGS_PER_SEED) break;
      if (pendingCount >= PENDING_CAP) break; // 초과 채굴은 버림(로그는 호출부)
      const keyword = (s.keyword || '').trim().slice(0, 80);
      const title = (s.title || '').trim().slice(0, 80);
      if (!keyword || !title) continue;
      if (existingKws.has(normKw(keyword))) continue; // 중복
      const off = offBrandTerm(`${title} ${keyword}`);
      if (off) { console.log(`[cluster] 형제 등록 거부(브랜드 범위 밖) — "${keyword}" (소재 "${off}")`); continue; }
      const t: ClusterTopic = {
        id: genId('cluster'), brand, seedKeyword: seedKw, seedPieceId: input.seedPieceId,
        keyword, title, angle: s.angle?.trim().slice(0, 120) || undefined,
        status: 'pending', createdTs: now, updatedTs: now,
      };
      this.items.set(t.id, t);
      existingKws.add(normKw(keyword));
      pendingCount++;
      out.push(t);
    }
    if (out.length) this.persist();
    return out;
  }

  update(id: string, patch: Partial<Omit<ClusterTopic, 'id' | 'createdTs'>>): ClusterTopic | undefined {
    const cur = this.items.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updatedTs: new Date().toISOString() };
    this.items.set(id, next);
    this.persist();
    return next;
  }

  /** 소진 대기 목록(브랜드 정확 일치) — 등록 오래된 순. */
  pending(brand: string): ClusterTopic[] {
    return this.list()
      .filter((t) => t.status === 'pending' && (t.brand ?? '') === brand)
      .sort((a, b) => a.createdTs.localeCompare(b.createdTs));
  }
}

let store: ClusterStore | null = null;
export function clusterStore(): ClusterStore { return (store ??= new ClusterStore()); }

/**
 * 소진 후보 1건 선택(순수) — 쿨다운·클러스터 소진 상한을 적용해 등록 오래된 순 1건.
 * recentAutoBlogSeeds: 최근 자율 blog piece 들의 clusterSeedId(최신순) — 앞 SEED_COOLDOWN_PIECES 개 안에
 * 같은 시드 그룹의 형제가 있으면 그 시드는 이번 틱에서 제외한다("추희자두 주간" 방지).
 * 시드 그룹 판정: clusterSeedId 는 ClusterTopic.id 라서 all 에서 id→seedKeyword 를 역참조해 비교.
 */
export function pickNextSibling(
  pending: ClusterTopic[],
  all: ClusterTopic[],
  recentAutoBlogSeeds: Array<string | undefined>,
): ClusterTopic | null {
  const byId = new Map(all.map((t) => [t.id, t]));
  const cooled = new Set<string>(); // 쿨다운 걸린 seedKeyword
  for (const sid of recentAutoBlogSeeds.slice(0, SEED_COOLDOWN_PIECES)) {
    const seed = sid ? byId.get(sid)?.seedKeyword : undefined;
    if (seed) cooled.add(seed);
  }
  const consumedBySeed = new Map<string, number>();
  for (const t of all) {
    if (t.status === 'consumed') consumedBySeed.set(t.seedKeyword, (consumedBySeed.get(t.seedKeyword) ?? 0) + 1);
  }
  return [...pending]
    .filter((t) => t.status === 'pending')
    .filter((t) => !cooled.has(t.seedKeyword))
    .filter((t) => (consumedBySeed.get(t.seedKeyword) ?? 0) < CONSUME_CAP_PER_SEED)
    .sort((a, b) => a.createdTs.localeCompare(b.createdTs))[0] ?? null;
}
