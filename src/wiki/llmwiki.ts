/**
 * LLM Wiki — Andrej Karpathy 의 "LLM Wiki" 패턴 구현 (2026-04).
 * 참고: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
 *
 * RAG(쿼리 시 임베딩 청크 검색)와 달리, 에이전트가 직접 유지하는 **마크다운 지식베이스**:
 *  - raw/        : 원본 소스(불변)
 *  - wiki/*.md   : LLM이 유지하는 엔티티/개념/소스요약 페이지. YAML 프런트매터 + `[[위키링크]]`.
 *  - wiki/index.md : 카탈로그(페이지 1줄 요약, 카테고리별) — 인덱스 우선 탐색의 진입점.
 *  - wiki/log.md   : append-only 타임라인 `## [YYYY-MM-DD] op | Title`.
 *  - WIKI_SCHEMA.md: 유지 규칙(스키마) 문서.
 * 지식은 한 번 컴파일해 계속 갱신(compounding) — ingest/query/lint 3워크플로우.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG } from '../config';
import { brandFileSuffixFor, activeBrandSlug, offBrandTerm } from '../content/brand';
import { llm } from '../llm/client';

export type PageType = 'entity' | 'concept' | 'source' | 'overview' | 'answer' | 'lesson' | 'debate' | 'performance';
// index 섹션 스펙 — Record<PageType,…> 전수 매핑이라 타입을 새로 추가하면 누락 시 컴파일 에러.
// 과거 lesson·performance, 2026-07-15 감사의 debate 처럼 '타입은 있는데 인덱스에 안 보이는' 재발 차단.
const INDEX_SECTIONS: Record<PageType, string> = {
  entity: '🔑 엔티티', concept: '💡 개념', source: '📄 소스 요약', overview: '🧭 종합',
  answer: '❓ 답변', lesson: '🎓 교훈', debate: '🗣 토론', performance: '📈 성과',
};

export interface WikiPage {
  title: string;
  slug: string;
  type: PageType;
  aliases: string[];
  sources: string[];
  contributors: string[];
  updated: string;
  summary: string;
  body: string;
  /** 본문의 [[링크]] 대상 슬러그들. */
  links: string[];
  /** 반박(rebuts) 대상 슬러그들 — 토론 노드 전용 타입드 엣지(graph 에서 kind:'rebuts' 빨강 엣지로 표출). */
  rebuts: string[];
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;
const LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const ARRAY_KEYS = new Set(['aliases', 'sources', 'contributors', 'rebuts']);
// wiki 루트의 비-페이지 파일(평면 구조에서 페이지와 구분) — 카탈로그·타임라인·스키마.
const RESERVED_FILES = new Set(['index.md', 'log.md', 'WIKI_SCHEMA.md', 'README.md']);

// macOS(HFS+·iCloud 동기화)는 파일명을 NFD 기준 ~255바이트에서 자르고 충돌 시 'x 2.md'로 복제해,
// 한글 장제목 슬러그가 잘린 파일명·중복 파일로 깨졌다(2026-07-13 실측: 한글 80자는 NFD 최대 720바이트).
// NFD 바이트로 캡하고 잘린 몫은 원 슬러그 해시 8자로 구분 — 같은 입력이면 항상 같은 슬러그(결정적).
const MAX_SLUG_NFD_BYTES = 180;
const nfdBytes = (s: string): number => Buffer.byteLength(s.normalize('NFD'), 'utf-8');
function capSlugBytes(slug: string): string {
  if (nfdBytes(slug) <= MAX_SLUG_NFD_BYTES) return slug;
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  const budget = MAX_SLUG_NFD_BYTES - hash.length - 1; // '-<hash8>' 몫
  let prefix = '';
  for (const ch of slug) {
    if (nfdBytes(prefix + ch) > budget) break;
    prefix += ch;
  }
  return `${prefix.replace(/-+$/, '')}-${hash}`;
}
export function slugify(s: string): string {
  const full = (s || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
  let base = full.slice(0, 80) || 'page';
  // 80자 문자 절단이 일어나면 절단 전 원문 해시8을 붙인다 — 같은 80자 접두의 서로 다른 장제목
  // (입장/비평 등)이 같은 슬러그로 붕괴해 서로를 덮어쓰던(본문 소실·자기반박 루프) 충돌 차단.
  // 같은 입력=같은 슬러그(결정적)는 유지된다.
  if (full.length > 80) {
    const hash = createHash('sha256').update(full).digest('hex').slice(0, 8);
    base = `${base.slice(0, 80 - hash.length - 1).replace(/-+$/, '')}-${hash}`;
  }
  return capSlugBytes(base);
}
/** 표기 변형 흡수 키(2026-07-16 근사중복 병합) — NFC·소문자·문자/숫자 외 제거. '가을 등산'='가을등산'. */
function compactKey(s: string): string {
  return (s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
/** 구 슬러그 알고리즘 재현(1회 수선 판정용) — v1: 80자 절단만, v2: 절단+NFD 캡. */
function legacySlugsOf(title: string): Set<string> {
  const base = (title || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').slice(0, 80) || 'page';
  return new Set([base, capSlugBytes(base)]);
}
/** 로컬 타임존 기준 YYYY-MM-DD (UTC 자정 어긋남 방지). */
function nowDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s: string): string { return s.replace(/\n+/g, ' ').trim(); }

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(FM_RE);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v: string = line.slice(i + 1).trim();
    if (ARRAY_KEYS.has(k)) {
      // 배열 키만 배열로 — summary/title 등 스칼라가 대괄호로 시작해도 오파싱 안 됨.
      try {
        const j = JSON.parse(v);
        meta[k] = Array.isArray(j) ? j : [String(j)];
      } catch {
        meta[k] = v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
      }
    } else {
      meta[k] = v;
    }
  }
  return { meta, body: text.slice(m[0].length) };
}
function serialize(p: WikiPage): string {
  const fm = [
    '---',
    `title: ${esc(p.title)}`,
    `slug: ${p.slug}`,
    `type: ${p.type}`,
    `aliases: ${JSON.stringify(p.aliases)}`,
    `sources: ${JSON.stringify(p.sources)}`,
    `contributors: ${JSON.stringify(p.contributors)}`,
    // rebuts 는 토론 노드에만 있음 — 비어있으면 프런트매터에 안 써 기존 페이지 형식 불변(churn 0).
    ...(p.rebuts.length ? [`rebuts: ${JSON.stringify(p.rebuts)}`] : []),
    `updated: ${p.updated}`,
    `summary: ${esc(p.summary)}`,
    '---',
    '',
  ].join('\n');
  return fm + p.body.trim() + '\n';
}
function outboundLinks(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(body)) !== null) out.add(slugify(m[1]!));
  return [...out];
}

/** 지식 노드 타입 — 별칭으로 개념 정체성을 주장할 수 있고, 표기변형 흡수(upsert)의 대상이 되는 타입.
 *  나머지(source·overview·lesson·debate·performance)는 '기록'이라 개념을 대표하지 않는다. */
const KNOWLEDGE_TYPES = new Set<PageType>(['entity', 'concept', 'answer']);

/** 지표성(측정 스냅샷) 요약 판별 — 검색량·검색수·조회수·월간 검색·노출·클릭·CTR·"N회" 등 성과 수치 패턴.
 *  지식 노드의 개념 요약이 이런 스냅샷으로 덮이면 index.md 미러를 타고 검색 최전선이 오염된다
 *  (2026-07-31 타입 게이트와 같은 뿌리 — 성과 기록이 개념 정체성을 선점하는 문제의 summary 판). */
function isMetricSummary(s: string): boolean {
  if (!s) return false;
  return /검색량|검색수|조회수|월간\s*검색|노출|클릭|CTR|\d[\d,.]*\s*회/i.test(s);
}

/** LLM 거절·되물음 텍스트 판별 — stub 생성 LLM 이 본문 대신 "항목을 알려주시면…" 류 안내문을 반환한 경우.
 *  실측 사고(2026-08-14): '데이터 없음' 페이지가 "항목이 지정되지 않았습니다. 위키 본문을 작성할
 *  구체적인 개념/엔티티를 알려주시면…" 요약으로 생성돼 두뇌에 무의미 노드가 영속됐다. */
function isLlmRefusalText(s: string): boolean {
  if (!s) return false;
  return /항목이\s*지정되지|지정되지\s*않았습니다|알려\s*주시(면|겠)|작성할\s*수\s*없|구체적인\s*(개념|엔티티|항목|주제)|무엇을\s*작성|어떤\s*(개념|항목|주제)[을를]?\s*(원하|작성)/.test(s);
}

/**
 * 링크 대상 해석 인덱스(순수) — 슬러그·별칭(aliases)을 모두 canonical 슬러그로 매핑.
 * 규칙: (1) 실제 페이지 슬러그가 항상 우선 — 별칭이 실 페이지를 가리지 못한다.
 *       (2) 두 페이지 이상이 주장하는 별칭은 모호 → 제외(예: 37개 토론 페이지의 'debate').
 *           readdir 순서에 좌우되지 않게 '주장 수'로 판정 — 결정적.
 * 배경(2026-07-31 실측): 링크 해석이 aliases 를 보지 않아 [[별칭]] 이 전부 끊긴 링크로 잡혔고,
 * maintain 이 그 '빈틈'을 메우려 이미 존재하는 개념의 중복 페이지를 LLM 으로 새로 만들었다
 * (별칭 '블루베리나무' 류 — 표기 변형이 아니라 별칭이라 upsert 의 compactKey 흡수도 못 잡는다).
 * lint 의 가짜 고아·가짜 끊긴 링크, graph 의 유령 stub 노드도 같은 뿌리.
 */
export function buildLinkResolver(pages: Array<{ slug: string; aliases: string[]; type?: PageType }>): Map<string, string> {
  const realSlugs = new Set(pages.map((p) => p.slug));
  const claims = new Map<string, Set<string>>(); // 별칭키 → 주장한 페이지 슬러그들
  for (const p of pages) {
    // 기록형 페이지는 별칭으로 '정체성'을 주장하지 못한다 — 성과(performance) 페이지가
    // aliases:[타겟키워드] 를 달고 있어(analytics/*Perf·reinforce), 이를 허용하면 개념 링크가
    // 조회수 스냅샷으로 해석되고 진짜 지식 갭이 은폐된다(2026-07-31 리뷰 실측).
    if (p.type && !KNOWLEDGE_TYPES.has(p.type)) continue;
    for (const a of p.aliases) {
      // 문자·숫자가 없는 별칭(빈 값·공백·기호만)은 버린다 — slugify 가 'page' 로 폴백해
      // [[page]] 를 엉뚱한 페이지로 해석시킬 수 있다(테스트가 잡은 실제 구멍).
      if (!/[\p{L}\p{N}]/u.test(a || '')) continue;
      const k = slugify(a);
      if (!k || realSlugs.has(k)) continue; // 실 페이지 슬러그는 별칭이 못 덮는다
      let owners = claims.get(k);
      if (!owners) { owners = new Set(); claims.set(k, owners); }
      owners.add(p.slug);
    }
  }
  const out = new Map<string, string>();
  for (const s of realSlugs) out.set(s, s);
  for (const [k, owners] of claims) if (owners.size === 1) out.set(k, [...owners][0]!);
  return out;
}

/** 그라운딩 컨텍스트 머리말용 출처 라벨(순수, 스펙 §4) — 작가·판정기가 "LLM 이 만든 것"과 "실측·원문"을 구분하게. */
export function provenanceLabel(p: Pick<WikiPage, 'type' | 'sources'>): string {
  if (p.sources.some((s) => s.startsWith('raw/'))) return '원문(raw)';
  if (p.type === 'performance') return '실측 성과';
  if (p.sources.includes('maintain:auto')) return 'LLM 생성 스텁';
  if (p.sources.includes('stub:source')) return '원문 발췌 스텁';
  if (p.type === 'debate' || p.type === 'overview' || p.type === 'lesson') return '토론·종합(출처 없음)';
  if (p.sources.some((s) => s.startsWith('run:'))) return '런 산출 요약';
  return '출처 미상';
}
// 집필용 forFacts 질의에서 제외할 타입 — 성과 수치·토론 종합·개요·교훈은 방향 참고일 뿐 인용 가능한 사실이 아니다.
const FACT_EXCLUDED_TYPES: ReadonlySet<PageType> = new Set(['performance', 'debate', 'overview', 'lesson']);

export class LlmWiki {
  readonly dir: string;
  readonly rawDir: string;
  private readonly pagesDir: string;
  private chain: Promise<unknown> = Promise.resolve();

  /** 위키 변경 작업을 직렬화 — 동시 런/maintain/sources 의 read-modify-write 경합 방지. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  constructor(dir: string = CONFIG.wikiDir) {
    this.dir = dir;
    this.pagesDir = dir; // 평면 — 페이지를 wiki 루트에 직접(obsidian vault 호환). index/log/schema 는 RESERVED_FILES.
    // 브랜드(고객사)별 자료 격리 — 위키 접미사를 raw 에 미러링(data/wiki-<slug> ↔ data/raw-<slug>).
    // 원칙(사용자 확정 2026-07-06): 자료는 브랜드별로 따로 정리한다. 페이지의 raw/ 참조는 논리
    // 접두사라 그대로 두고, 해석만 각자의 rawDir 로 한다(referencedRawHashes).
    const base = path.basename(dir);
    const suffix = base.startsWith('wiki') ? base.slice('wiki'.length) : '';
    this.rawDir = path.join(path.dirname(dir), `raw${suffix}`);
    fs.mkdirSync(this.pagesDir, { recursive: true });
    fs.mkdirSync(this.rawDir, { recursive: true });
    this.migrateFlat();
    if (suffix) this.migrateLegacyRaw(path.join(path.dirname(dir), 'raw'));
    this.repairSlugsAndRefs();
    this.ensureSchema();
  }

  /** 슬러그 변천 1회 수선 — (a) 캡 도입(07-13) 전 잘린 파일명(basename≠slug), (b) 80자 절단 해시
   *  (07-15) 도입 전 구슬러그(제목 유래) 페이지를 현행 슬러그로 개명하고, (c) 전 페이지의 rebuts 참조를
   *  재매핑(개명 맵 → 캡 폴백)·자기반박 제거한다. 참조를 안 고치면 pagePath 기반 조회·prune 이 실파일과
   *  어긋나고 토론 그래프 빨강 엣지가 유령을 가리킨다(2026-07-15 감사: rebuts 10/30 끊김). */
  private repairSlugsAndRefs(): void {
    try {
      const renamed = new Map<string, string>();
      for (const f of fs.readdirSync(this.pagesDir)) {
        if (!f.endsWith('.md') || RESERVED_FILES.has(f)) continue;
        const fp = path.join(this.pagesDir, f);
        let page: WikiPage;
        try { page = this.readPage(fp); } catch { continue; }
        if (!page.slug || /[/\\]|\.\./.test(page.slug)) continue;
        // 제목 유래 슬러그(구 알고리즘 흔적)면 현행 slugify(title) 로, 아니면 캡만 보정.
        const fromTitle = slugify(page.title);
        const canonical = page.slug !== fromTitle && legacySlugsOf(page.title).has(page.slug)
          ? fromTitle : capSlugBytes(page.slug);
        if (canonical === page.slug && f === `${canonical}.md`) continue;
        const dst = this.pagePath(canonical);
        if (path.resolve(dst) !== path.resolve(fp) && fs.existsSync(dst)) continue; // 충돌 — 기존 페이지 보존
        if (canonical !== page.slug) renamed.set(page.slug, canonical);
        page.slug = canonical;
        fs.writeFileSync(dst, serialize(page), 'utf-8');
        if (path.resolve(dst) !== path.resolve(fp)) fs.unlinkSync(fp);
      }
      // rebuts 재매핑 — 실존하면 유지, 개명 맵 → 캡 폴백 순으로 복원, 자기참조 제거. 진짜 미존재
      // 대상은 그대로 둔다(graph 의 missing 스텁 lint 대상 — 참조를 지어내지 않는다).
      let touched = 0;
      for (const p of this.allPages()) {
        if (!p.rebuts.length) continue;
        const fixed = [...new Set(p.rebuts.map((r) => {
          if (this.getPage(r)) return r;
          const m = renamed.get(r);
          if (m && this.getPage(m)) return m;
          const c = capSlugBytes(r);
          if (c !== r && this.getPage(c)) return c;
          return r;
        }))].filter((r) => r !== p.slug);
        if (fixed.length !== p.rebuts.length || fixed.some((v, i) => v !== p.rebuts[i])) {
          p.rebuts = fixed;
          this.writePage(p);
          touched++;
        }
      }
      if (renamed.size || touched) {
        this.rebuildIndex();
        this.appendLog('maintain', `슬러그·참조 1회 수선 — 개명 ${renamed.size}건 · rebuts 정리 ${touched}건`);
      }
    } catch { /* 무해 — 다음 인스턴스 생성 때 재시도 */ }
  }

  /** 브랜드 raw 분리(2026-07-06) 이전 자료 1회 이관 — 이 위키의 source 페이지가 참조하는 raw/ 원문이
   *  아직 공용 data/raw 에 있으면 브랜드 rawDir 로 이동한다(원본 originals 동반, 베스트에포트).
   *  참조 기반이라 타 브랜드·범용 자료는 건드리지 않고, 이관 없인 중복 업로드 차단·재처리가 빈 폴더를 봤다. */
  private migrateLegacyRaw(legacyDir: string): void {
    try {
      if (!fs.existsSync(legacyDir) || path.resolve(legacyDir) === path.resolve(this.rawDir)) return;
      const legacyRoot = path.resolve(legacyDir) + path.sep;
      for (const p of this.list('source')) {
        for (const ref of p.sources) {
          if (!ref.startsWith('raw/') || ref.includes('..')) continue;
          const rel = ref.slice('raw/'.length);
          const src = path.join(legacyDir, rel);
          if (!path.resolve(src).startsWith(legacyRoot)) continue; // 경로 이탈 방지
          const dst = path.join(this.rawDir, rel);
          if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.renameSync(src, dst);
          // 원본 바이너리(originals/<파일명>)도 동반 이동 — 재추출 프로비넌스 유지.
          const oSrc = path.join(path.dirname(src), 'originals', path.basename(src));
          const oDst = path.join(path.dirname(dst), 'originals', path.basename(dst));
          if (fs.existsSync(oSrc) && !fs.existsSync(oDst)) {
            fs.mkdirSync(path.dirname(oDst), { recursive: true });
            fs.renameSync(oSrc, oDst);
          }
        }
      }
    } catch { /* 무해 — 이관 실패분은 다음 인스턴스 생성 때 재시도 */ }
  }

  /** 기존 pages/ 하위 페이지를 wiki 루트로 1회 평면 이동(구조 변경 마이그레이션). */
  private migrateFlat(): void {
    const old = path.join(this.dir, 'pages');
    if (!fs.existsSync(old)) return;
    try {
      for (const f of fs.readdirSync(old)) {
        if (!f.endsWith('.md')) continue;
        const dst = path.join(this.dir, f);
        if (!fs.existsSync(dst)) fs.renameSync(path.join(old, f), dst);
      }
      fs.rmdirSync(old);
    } catch { /* 무해 */ }
  }

  private pagePath(slug: string): string { return path.join(this.pagesDir, `${slug}.md`); }

  private ensureSchema(): void {
    const sp = path.join(this.dir, 'WIKI_SCHEMA.md');
    // 엔진 소유 문서(RESERVED) — 현행판과 다르면 동기화. 구판은 pages/ 레이아웃·5타입만 기술해
    // 실제(평면·8타입)와 어긋났고, LLM 이 이 문서를 읽고 위키를 유지하므로 방치 시 오분류를 유발한다.
    try { if (fs.readFileSync(sp, 'utf-8') === SCHEMA_DOC) return; } catch { /* 없음 → 작성 */ }
    fs.writeFileSync(sp, SCHEMA_DOC, 'utf-8');
  }

  // ---- 읽기 ----
  getPage(slug: string): WikiPage | undefined {
    // 경로 탈출 방지(외부 입력 /wiki/page/:id, refs) — 슬러그에 구분자·.. 금지 + 컨테인먼트.
    if (!slug || /[/\\]|\.\./.test(slug)) return undefined;
    if (RESERVED_FILES.has(`${slug}.md`)) return undefined; // 예약 파일(index/log/schema)은 페이지 아님
    const fp = this.pagePath(slug);
    if (!path.resolve(fp).startsWith(path.resolve(this.pagesDir) + path.sep)) return undefined;
    if (!fs.existsSync(fp)) return undefined;
    return this.readPage(fp);
  }
  private readPage(fp: string): WikiPage {
    const text = fs.readFileSync(fp, 'utf-8');
    const { meta, body } = parseFrontmatter(text);
    const arr = (k: string): string[] => Array.isArray(meta[k]) ? (meta[k] as string[]) : [];
    const slug = (meta.slug as string) || path.basename(fp, '.md');
    return {
      title: (meta.title as string) || slug,
      slug,
      type: ((meta.type as string) || 'concept') as PageType,
      aliases: arr('aliases'),
      sources: arr('sources'),
      contributors: arr('contributors'),
      updated: (meta.updated as string) || '',
      summary: (meta.summary as string) || '',
      body,
      links: outboundLinks(body),
      rebuts: arr('rebuts'),
    };
  }
  allPages(): WikiPage[] {
    if (!fs.existsSync(this.pagesDir)) return [];
    return fs.readdirSync(this.pagesDir)
      .filter((f) => f.endsWith('.md') && !RESERVED_FILES.has(f))
      .map((f) => this.readPage(path.join(this.pagesDir, f)));
  }
  list(type?: PageType): WikiPage[] {
    let ps = this.allPages();
    if (type) ps = ps.filter((p) => p.type === type);
    return ps.sort((a, b) => b.updated.localeCompare(a.updated));
  }
  stats(): { pages: number; entities: number; concepts: number; sources: number; lessons: number; links: number } {
    const ps = this.allPages();
    return {
      pages: ps.length,
      entities: ps.filter((p) => p.type === 'entity').length,
      concepts: ps.filter((p) => p.type === 'concept').length,
      sources: ps.filter((p) => p.type === 'source').length,
      lessons: ps.filter((p) => p.type === 'lesson').length,
      links: ps.reduce((n, p) => n + p.links.length, 0),
    };
  }

  // ---- 쓰기(페이지 머지) ----
  private writePage(p: WikiPage): void {
    fs.writeFileSync(this.pagePath(p.slug), serialize(p), 'utf-8');
  }
  /** 같은 슬러그가 있으면 본문에 '갱신' 섹션을 덧대고 메타 합집합(Karpathy: kept current). */
  upsertPage(input: {
    title: string; type: PageType; body: string; summary?: string;
    sources?: string[]; contributors?: string[]; aliases?: string[]; rebuts?: string[];
  }): WikiPage {
    const slug = slugify(input.title);
    let existing = this.getPage(slug);
    // 표기 변형 근사중복 흡수(2026-07-16) — 공백·특수문자만 다른 제목이 slugify 정확 일치를 비껴가
    // 병렬 페이지가 되던 문제(감사: 가을-등산/가을등산 등). compact 키가 같은 기존 페이지(제목·별칭)가
    // 있으면 새 페이지 대신 그쪽으로 머지한다. 결정적 계층 — 의미 중복 판정·병합은 mergePages 몫.
    if (!existing) {
      const key = compactKey(input.title);
      // 흡수 대상은 '같은 타입' 또는 '지식 노드'만 — 기록형(성과·원문·교훈·토론·개요)은 제외.
      // 실측 사고(2026-07-31): 성과 페이지가 aliases:[키워드] 를 달고 있어, maintain 이 만든 지식
      // 페이지('블루베리나무')가 릴스 성과 스냅샷으로 흡수돼 summary 가 백과사전 정의로 덮이고
      // 갱신 섹션이 6번 누적됐다(measurement 기록 오염).
      const absorbable = (p: WikiPage): boolean => p.type === input.type || KNOWLEDGE_TYPES.has(p.type);
      existing = this.allPages().find((p) => absorbable(p)
        && (compactKey(p.title) === key || p.aliases.some((al) => compactKey(al) === key)));
    }
    const today = nowDate();
    if (existing) {
      // 지표 요약이 지식 요약을 덮지 못한다 — 성과 경로(reinforce 등)가 지식 노드(entity/concept/answer)에
      // 검색량·조회수 스냅샷 요약을 upsert 하면 개념 요약이 측정치로 덮이고 index.md 미러로 전파된다
      // (2026-07-31 타입 게이트의 summary 판). 기존 요약도 지표성이면 종전대로 갱신 허용(성과 페이지 무해).
      const keepKnowledgeSummary = KNOWLEDGE_TYPES.has(existing.type) && !!existing.summary
        && !!input.summary && isMetricSummary(input.summary) && !isMetricSummary(existing.summary);
      if (keepKnowledgeSummary) this.appendLog('upsert', `지표 요약 차단 — "${existing.title}" 지식 요약 유지`);
      const merged: WikiPage = {
        ...existing,
        // source → entity/concept 승격은 허용(반대 강등은 막음).
        type: existing.type === 'source' && input.type !== 'source' ? input.type : existing.type,
        summary: keepKnowledgeSummary ? existing.summary : (input.summary || existing.summary),
        sources: [...new Set([...existing.sources, ...(input.sources ?? [])])],
        contributors: [...new Set([...existing.contributors, ...(input.contributors ?? [])])],
        aliases: [...new Set([...existing.aliases, ...(input.aliases ?? []),
          ...(input.title !== existing.title ? [input.title] : [])])], // 흡수된 표기는 별칭으로 보존
        rebuts: [...new Set([...existing.rebuts, ...(input.rebuts ?? [])])],
        updated: today,
        body: existing.body.trim() + `\n\n## 갱신 (${today})\n${input.body.trim()}\n`,
        links: [],
      };
      merged.links = outboundLinks(merged.body);
      this.writePage(merged);
      return merged;
    }
    const page: WikiPage = {
      title: input.title, slug, type: input.type,
      aliases: [...new Set(input.aliases ?? [])], sources: [...new Set(input.sources ?? [])],
      contributors: [...new Set(input.contributors ?? [])], updated: today,
      summary: input.summary ?? esc(input.body).slice(0, 120),
      body: input.body.trim() + '\n', links: outboundLinks(input.body),
      rebuts: [...new Set(input.rebuts ?? [])],
    };
    this.writePage(page);
    return page;
  }

  /**
   * 토론(비평→반박)을 두뇌에 1급 노드·엣지로 영속화 — 비평 노드가 각 팀 입장 노드를 rebuts(빨강 엣지)로
   * 가리키고, 입장 노드는 산출 개념([[relates]])으로 연결돼 '토론 과정' 자체가 그래프에 보인다.
   * 토픽이 반복되는 자율 사이클에서도 run 별로 구분되게 slug 에 runId 단편을 넣는다(머지 방지).
   * 과적재 방지: type:'debate' 페이지를 run 그룹 단위로 최근 KEEP_RUNS 개만 유지(현재 run 보호).
   * 동시 런 경합 방지를 위해 위키 쓰기 체인(serialize)에 올린다. relatesTo 는 '제목 또는 슬러그' 모두 허용
   * (outboundLinks 가 다시 slugify 하므로 동일 페이지로 해석됨). 반환=생성된 슬러그들.
   */
  recordDebate(input: {
    topic: string; runId: string;
    critique?: { name: string; text: string };
    positions: Array<{ name: string; text: string }>;
    relatesTo?: string[];
  }): Promise<string[]> {
    return this.serialize(async () => {
      const rid = (input.runId || '').slice(0, 8);
      const tag = `run:${input.runId}`;
      const rel = [...new Set((input.relatesTo ?? []).filter(Boolean))].slice(0, 6);
      const relBlock = rel.length ? `\n\n## 관련\n${rel.map((s) => `- [[${s}]]`).join('\n')}` : '';
      const created: string[] = [];
      // 1) 입장 노드(팀/직원별) — 산출 개념으로 relates 연결돼 지식 그래프에 합류
      const posSlugs: string[] = [];
      for (const p of input.positions) {
        const name = (p.name || '').trim();
        const text = (p.text || '').trim();
        if (!name || !text) continue;
        const page = this.upsertPage({
          title: `${input.topic} · ${name} 입장 (${rid})`, type: 'debate',
          body: text.slice(0, 1200) + relBlock,
          contributors: [name], aliases: [tag, 'debate'],
          summary: `[${name} 입장] ${esc(text).slice(0, 80)}`,
        });
        posSlugs.push(page.slug); created.push(page.slug);
      }
      // 2) 비평 노드 — 각 입장을 rebuts(빨강 엣지). 입장이 없으면 반박 관계가 성립 안 하므로 생성 안 함.
      const crit = input.critique;
      if (crit && (crit.text || '').trim() && posSlugs.length) {
        const cp = this.upsertPage({
          title: `${input.topic} · 비평 (${rid})`, type: 'debate',
          body: crit.text.trim().slice(0, 1500) + relBlock,
          contributors: [(crit.name || '비평가').trim()], aliases: [tag, 'debate'],
          rebuts: posSlugs,
          summary: `[비평] ${esc(crit.text).slice(0, 80)}`,
        });
        created.push(cp.slug);
      }
      if (created.length) this.pruneDebate(30, input.runId);
      return created;
    });
  }

  /**
   * 토론(입장·비평)을 '<topic> (종합)' overview 페이지로 증분 컴파일(2026-07-16 설계) — 런별 토론이
   * pruneDebate 상한에서 증발하기 전에 지식으로 응축한다. 같은 topic 재런은 upsertPage 머지(갱신 섹션
   * 누적) = 컴파일 1회 + 지속 갱신(카파시). LLM 호출은 쓰기 체인(serialize) 밖에서 — 실패는 무해(fail-open).
   */
  async compileDebateOverview(input: {
    topic: string; model: string;
    positions: Array<{ name: string; text: string }>;
    critique?: { name: string; text: string };
    relatesTo?: string[]; signal?: AbortSignal;
  }): Promise<string | null> {
    const pos = input.positions.filter((p) => (p.name || '').trim() && (p.text || '').trim());
    if (!pos.length) return null;
    const sys =
      '너는 팀 토론을 지식으로 응축하는 편집자다. 입장들과 비평을 종합해 ① 합의·검증된 것(근거 포함) ' +
      '② 반박·기각된 주장 ③ 열린 질문을 6~10문장으로 정리하라. 본문의 핵심 개념은 [[위키링크]]로 감싼다(1개 이상). ' +
      '근거 없는 절대수치 단정은 쓰지 않는다. 마크다운 본문만 출력한다.';
    const user =
      `주제: ${input.topic}\n\n` +
      pos.map((p) => `[${p.name} 입장]\n${p.text.slice(0, 1500)}`).join('\n\n') +
      (input.critique?.text?.trim() ? `\n\n[비평 — ${(input.critique.name || '비평가').trim()}]\n${input.critique.text.slice(0, 1500)}` : '');
    try {
      const res = await llm.chat({
        model: input.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        maxOutputTokens: 800, temperature: 0.3, think: false, signal: input.signal,
      });
      const text = (res.text || '').trim();
      if (!text) return null;
      return await this.serialize(async () => {
        const rel = [...new Set((input.relatesTo ?? []).filter(Boolean))].slice(0, 4);
        const page = this.upsertPage({
          title: `${input.topic} (종합)`, type: 'overview',
          body: text + this.relatedLine(rel, [`${input.topic} (요약)`]),
          contributors: [...new Set([...pos.map((p) => p.name.trim()), ...(input.critique?.name ? [input.critique.name.trim()] : [])])],
          summary: esc(text).replace(/#+\s*/g, '').replace(/\*\*/g, '').slice(0, 100), // 마크다운 헤더·볼드 제거(1줄 요약용)
        });
        this.rebuildIndex();
        this.appendLog('ingest', `${input.topic} (종합) — 토론 컴파일`);
        return page.slug;
      });
    } catch { return null; /* 컴파일 실패는 런·토론 기록을 막지 않는다 */ }
  }

  /**
   * type:'debate' 페이지를 run 그룹 단위로 최근 keepRuns 개만 유지(그래프·디스크 과적재 방지).
   *  - 그룹 단위 삭제: 같은 run 의 입장+비평을 통째로 유지/삭제 → 비평의 rebuts 가 살아남은 입장만 가리켜
   *    dangling 엣지·유령 stub 노드가 안 생긴다(개별 노드 prune 의 그룹 분할 문제 해소).
   *  - 최근성: updated 는 날짜 단위라 같은 날 다수 런을 구분 못함 → 파일 mtime(ms)으로 정렬.
   *  - 현재 run(protectRunId)은 절대 삭제 안 함(같은 날 캡 도달 시 방금 만든 토론이 지워지는 문제 해소).
   */
  private pruneDebate(keepRuns: number, protectRunId?: string): void {
    const deb = this.allPages().filter((p) => p.type === 'debate');
    if (!deb.length) return;
    const groupOf = (p: WikiPage): string => p.aliases.find((a) => a.startsWith('run:')) ?? `slug:${p.slug}`;
    const groups = new Map<string, { mtime: number; slugs: string[] }>();
    for (const p of deb) {
      const g = groupOf(p);
      let mt = 0; try { mt = fs.statSync(this.pagePath(p.slug)).mtimeMs; } catch { /* 삭제됨 등 — 0 */ }
      const e = groups.get(g) ?? { mtime: 0, slugs: [] };
      e.mtime = Math.max(e.mtime, mt); e.slugs.push(p.slug); groups.set(g, e);
    }
    const protectKey = protectRunId ? `run:${protectRunId}` : '';
    const others = [...groups.entries()].filter(([k]) => k !== protectKey)
      .sort((a, b) => b[1].mtime - a[1].mtime); // 최근 그룹 우선
    const keepOthers = Math.max(0, keepRuns - (groups.has(protectKey) ? 1 : 0));
    for (const [, e] of others.slice(keepOthers)) for (const s of e.slugs) this.deletePage(s);
  }

  saveRaw(name: string, content: string): string {
    const day = nowDate();
    const dir = path.join(this.rawDir, day);
    fs.mkdirSync(dir, { recursive: true });
    // 경로 제거(폴더 업로드 시 상대경로 유입) + 확장자 보존하며 본체 길이 제한(긴 파일명 잘림 방지).
    const base = path.basename((name || 'source').replace(/\\/g, '/')) || 'source';
    const ext = path.extname(base).slice(0, 12);
    const stem = (base.slice(0, base.length - path.extname(base).length).replace(/\s+/g, '_').slice(0, 80)) || 'source';
    let safe = stem + ext;
    // 원문 불변 보존 — 같은 날 같은 이름이지만 '다른 내용'이 오면 기존 raw 를 덮어쓰지 않고 내용 해시
    // 접미사로 유니크화한다(덮어쓰면 v1 원문이 소실돼 v1 재업로드를 못 잡는다). 같은 내용이면 같은 이름 재사용.
    let fp = path.join(dir, safe);
    if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf-8') !== content) {
      const h8 = createHash('sha1').update(content).digest('hex').slice(0, 8);
      safe = stem + '-' + h8 + ext;
      fp = path.join(dir, safe);
    }
    const rel = `raw/${day}/${safe}`;
    fs.writeFileSync(fp, content, 'utf-8');
    return rel;
  }

  /** 원본 바이너리 보존(프로비넌스) — raw/<day>/originals/ 에 원본을 그대로 저장. 추출이 부실해도 나중에
   *  더 나은 추출기로 재처리할 수 있게 한다(이전엔 추출 텍스트만 저장 → 원본 소실로 재추출 불가했음). */
  saveOriginal(name: string, data: Buffer): string {
    try {
      const day = nowDate();
      const dir = path.join(this.rawDir, day, 'originals');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename((name || 'source').replace(/\\/g, '/')) || 'source';
      const ext = path.extname(base).slice(0, 12);
      const stem = (base.slice(0, base.length - path.extname(base).length).replace(/\s+/g, '_').slice(0, 80)) || 'source';
      const safe = stem + ext;
      fs.writeFileSync(path.join(dir, safe), data);
      return `raw/${day}/originals/${safe}`;
    } catch { return ''; }
  }

  /** 업로드 원문(raw) 내용 해시 집합 — '동일 내용' 재업로드 판정용(/sources). 살아있는 source 페이지가
   *  참조하는 raw/ 원문만 읽어 sha1(본문 trim)한다. 페이지 본문이 갱신으로 누적되거나 청크로 쪼개져도
   *  '원문' 기준이라 재업로드를 안정적으로 잡고, 삭제된 자료의 고아 raw 는 참조가 끊겨 제외된다
   *  (삭제 후 같은 파일 재업로드 허용). */
  referencedRawHashes(): Set<string> {
    const out = new Set<string>();
    const rawRoot = path.resolve(this.rawDir) + path.sep;
    for (const p of this.list('source')) {
      for (const ref of p.sources) {
        if (!ref.startsWith('raw/') || ref.includes('..')) continue;
        // 'raw/' 는 논리 접두사 — 실 디렉토리는 브랜드별 rawDir(raw 또는 raw-<slug>)로 해석.
        const fp = path.join(this.rawDir, ref.slice('raw/'.length));
        if (!path.resolve(fp).startsWith(rawRoot)) continue; // 경로 이탈 방지
        try { out.add(createHash('sha1').update(fs.readFileSync(fp, 'utf-8').trim()).digest('hex')); }
        catch { /* 이동·삭제된 raw — 무해 */ }
      }
    }
    return out;
  }

  /** 원문 source 저장 — 대형이면 청크 페이지로 분할(검색이 깊은 행까지 닿게). 첫 페이지를 반환(분류·ingest 용). */
  addSourceDoc(input: { title: string; body: string; sources?: string[]; aliases?: string[] }): WikiPage {
    const chunks = chunkBody(input.body);
    if (chunks.length === 1) return this.upsertPage({ ...input, type: 'source' });
    let first: WikiPage | null = null;
    for (let k = 0; k < chunks.length; k++) {
      const title = k === 0 ? input.title : `${input.title} (${k + 1}/${chunks.length})`;
      const p = this.upsertPage({ title, type: 'source', body: chunks[k]!, sources: input.sources, aliases: input.aliases });
      if (k === 0) first = p;
    }
    return first!;
  }

  /** 페이지 1건 삭제(파일 제거) — 선택적 재정비(대형 원문 재청크) 등에서 원본 교체용. */
  /**
   * 근사중복 병합(2026-07-16, 감사 잔여 ①) — loser 를 winner 로 흡수: 본문은 '병합' 섹션으로 덧대고
   * 메타(aliases·sources·contributors·rebuts)는 합집합, 전 페이지의 [[링크]](파이프 표시명 보존)와
   * rebuts 를 winner 로 재지정한 뒤 loser 를 삭제한다. '같은 개념인가'의 판정은 호출자(LLM 판정 백필·
   * 표기 흡수는 upsertPage) 책임 — 엔진은 실행만. 실패·미존재는 false(무해).
   */
  mergePages(winnerSlug: string, loserSlug: string): Promise<boolean> {
    return this.serialize(async () => {
      if (!winnerSlug || !loserSlug || winnerSlug === loserSlug) return false;
      const w = this.getPage(winnerSlug);
      const l = this.getPage(loserSlug);
      if (!w || !l) return false;
      const today = nowDate();
      const merged: WikiPage = {
        ...w,
        aliases: [...new Set([...w.aliases, ...l.aliases, l.title])].filter((al) => al !== w.title),
        sources: [...new Set([...w.sources, ...l.sources])],
        contributors: [...new Set([...w.contributors, ...l.contributors])],
        rebuts: [...new Set([...w.rebuts, ...l.rebuts])].filter((r) => r !== winnerSlug && r !== loserSlug),
        updated: today,
        body: w.body.trim() + `\n\n## 병합 (${today} — "${l.title}" 흡수)\n${l.body.trim()}\n`,
        links: [],
      };
      // 승자 자신의 본문·요약 속 loser 링크는 자기참조가 되므로 평문으로 치환.
      const LINKS = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g;
      const unlinkLoser = (s: string): string =>
        s.replace(LINKS, (m0, target: string, pipe?: string) =>
          slugify(target) === loserSlug ? ((pipe ?? '').slice(1) || w.title) : m0);
      merged.body = unlinkLoser(merged.body);
      merged.summary = unlinkLoser(merged.summary);
      merged.links = outboundLinks(merged.body);
      this.writePage(merged);
      // 참조 재지정 — 본문·요약의 [[링크]] 해석이 loser 인 것과 rebuts 배열(파이프 표시명 보존).
      for (const p of this.allPages()) {
        if (p.slug === winnerSlug) continue;
        let changed = false;
        const relink = (s: string): string => s.replace(LINKS, (m0, target: string, pipe?: string) => {
          if (slugify(target) !== loserSlug) return m0;
          changed = true;
          return `[[${w.title}${pipe ?? ''}]]`;
        });
        const body = relink(p.body);
        const summary = relink(p.summary);
        const rebuts = [...new Set(p.rebuts.map((r) => (r === loserSlug ? winnerSlug : r)))].filter((r) => r !== p.slug);
        const rebChanged = rebuts.length !== p.rebuts.length || rebuts.some((r, i) => r !== p.rebuts[i]);
        if (changed || rebChanged) {
          p.body = body;
          p.summary = summary;
          p.rebuts = rebuts;
          p.links = outboundLinks(body);
          this.writePage(p);
        }
      }
      this.deletePage(loserSlug);
      this.rebuildIndex();
      this.appendLog('maintain', `근사중복 병합 — "${l.title}" → "${w.title}"`);
      return true;
    });
  }

  deletePage(slug: string): boolean {
    try { fs.unlinkSync(this.pagePath(slug)); return true; } catch { return false; }
  }

  /** 그래프 연결용 '관련' 링크 줄 — 교훈·성과 페이지가 작성자·태그로만 연결된 위성 섬이 되던 문제
   *  (2026-07-16 그래프 검토) 해소. always=무조건 링크(미생성이면 스텁=정직한 생성 후보 신호),
   *  ifExists=실재 페이지만(스텁 남발 방지). 링크가 없으면 빈 문자열. */
  relatedLine(always: Array<string | undefined>, ifExists: Array<string | undefined>): string {
    const links: string[] = [];
    for (const t of always) if (t?.trim()) links.push(`[[${t.trim()}]]`);
    for (const t of ifExists) if (t?.trim() && this.getPage(slugify(t.trim()))) links.push(`[[${t.trim()}]]`);
    return links.length ? `\n\n관련: ${[...new Set(links)].join(' · ')}` : '';
  }

  appendLog(op: string, title: string): void {
    const line = `## [${nowDate()}] ${op} | ${esc(title)}\n`;
    fs.appendFileSync(path.join(this.dir, 'log.md'), line, 'utf-8');
  }

  rebuildIndex(): void {
    const ps = this.allPages();
    const byType = new Map<PageType, WikiPage[]>();
    for (const p of ps) { const a = byType.get(p.type); if (a) a.push(p); else byType.set(p.type, [p]); }
    const sect = (label: string, arr: WikiPage[]): string =>
      arr.length ? `\n## ${label}\n` + arr.sort((a, b) => a.title.localeCompare(b.title))
        .map((p) => `- [[${p.title}]] — ${esc(p.summary).slice(0, 100)}${p.sources.length ? ` (sources: ${p.sources.length})` : ''}`).join('\n') + '\n' : '';
    const md =
      `# 📇 LLM Wiki 인덱스\n\n> 페이지 ${ps.length}개 · 갱신 ${nowDate()} · Karpathy LLM Wiki 패턴\n` +
      (Object.keys(INDEX_SECTIONS) as PageType[]).map((t) => sect(INDEX_SECTIONS[t], byType.get(t) ?? [])).join('');
    fs.writeFileSync(path.join(this.dir, 'index.md'), md, 'utf-8');
  }

  // ---- INGEST (LLM 주도): 소스/산출물 → 요약 + 엔티티/개념 페이지 + 인덱스 + 로그 ----
  async ingest(input: {
    title: string; content: string; model: string;
    sources?: string[]; contributors?: string[]; isRawSource?: boolean; skipSummary?: boolean; signal?: AbortSignal;
  }): Promise<{ summary: string; pages: string[] }> {
   return this.serialize(async () => {
    const sources = [...(input.sources ?? [])];
    if (input.isRawSource) sources.push(this.saveRaw(input.title, input.content));

    // 전체 내용을 윈도우로 나눠 개념 추출(이전엔 앞 6000자만 봐 대형 문서의 깊은 데이터가 개념화 안 됐다).
    //   윈도우당 extract 1회, 같은 제목 개념은 병합(링크 union). 대형 문서 비용은 윈도우 상한으로 통제.
    const WIN = 6000, MAX_WIN = 20;
    const windows: string[] = [];
    for (let i = 0; i < input.content.length && windows.length < MAX_WIN; i += WIN) windows.push(input.content.slice(i, i + WIN));
    if (!windows.length) windows.push(input.content);
    const merged = new Map<string, { title: string; type: PageType; body: string; links: Set<string> }>();
    let summary = '';
    for (const win of windows) {
      if (input.signal?.aborted) break;
      const ex = await this.extract(input.model, input.title, win, input.signal);
      if (!ex) continue;
      if (!summary && ex.summary) summary = ex.summary;
      for (const pg of ex.pages ?? []) {
        if (!pg.title || !pg.body) continue;
        const key = slugify(pg.title);
        const e = merged.get(key) ?? { title: pg.title, type: (pg.type === 'entity' ? 'entity' : 'concept') as PageType, body: pg.body.trim(), links: new Set<string>() };
        for (const l of pg.links ?? []) if (l) e.links.add(l);
        merged.set(key, e);
      }
    }
    summary = summary || esc(input.content).slice(0, 160);

    // 1) 소스 요약 페이지(자료 업로드는 원본 페이지가 따로 있어 skipSummary 로 생략 — 중복 방지)
    const written: string[] = [];
    if (!input.skipSummary) {
      this.upsertPage({
        title: `${input.title} (요약)`, type: 'source', body: summary,
        summary, sources, contributors: input.contributors,
      });
      written.push(`${input.title} (요약)`);
    }

    // 2) 병합된 엔티티/개념 페이지 — 본문에 [[링크]]('## 관련') 보존
    for (const e of merged.values()) {
      const linked = [...e.links];
      const body = e.body + (linked.length ? `\n\n## 관련\n${linked.map((l) => `- [[${l}]]`).join('\n')}` : '');
      this.upsertPage({
        title: e.title, type: e.type, body,
        summary: esc(e.body).slice(0, 120), sources, contributors: input.contributors,
      });
      written.push(e.title);
    }

    this.rebuildIndex();
    this.appendLog('ingest', input.title);
    return { summary, pages: written };
   });
  }

  private async extract(model: string, title: string, content: string, signal?: AbortSignal): Promise<ExtractResult | null> {
    const sys = '너는 LLM Wiki 관리자다. 주어진 내용에서 위키 페이지로 만들 핵심 엔티티(사람/조직/도구/개념)와 개념을 뽑는다. 각 페이지는 사실 위주 2~4문장 본문과, 관련된 다른 엔티티명(links)을 포함한다. ' +
      '각 페이지의 links 에는 본문에 실제로 언급된 개념·같은 묶음의 다른 title 만 넣는다. 관련 개념이 본문에 없으면 빈 배열을 허용한다(없는 개념을 만들어 링크하지 마라).';
    const user =
      `제목: ${title}\n\n내용:\n${content.slice(0, 6000)}\n\n` +
      'JSON만 출력: {"summary":"한 줄 요약","pages":[{"title":"엔티티명","type":"entity|concept","body":"2~4문장","links":["다른엔티티명"]}]}. 페이지는 3~6개. ' +
      '각 page 의 links 에는 본문에 실제 언급된 것만 넣고, 없으면 빈 배열.';
    try {
      const res = await llm.chat({
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        maxOutputTokens: 1200, temperature: 0.3, think: false, signal, // 엔티티 추출은 구조적 작업 — 추론 끔(윈도우당 저지연)
      });
      return extractJson<ExtractResult>(res.text);
    } catch {
      return null;
    }
  }

  /** 링크 없는 concept/entity 페이지에 토큰 유사도로 관련 페이지를 찾아 '## 관련' 보충.
   *  (임베딩 미구현 대체 — query() 와 같은 토큰화로 겹침 점수.) 보충된 페이지 수 반환. */
  backfillRelated(topK = 3, minOverlap = 2): number {
    const pages = this.allPages().filter((p) => p.type === 'entity' || p.type === 'concept');
    const toks = new Map<string, Set<string>>();
    for (const p of pages) toks.set(p.slug, new Set([...tokenize(p.title), ...tokenize(p.body)].filter((t) => t.length >= 2)));
    let filled = 0;
    for (const p of pages) {
      if (p.links.length || p.body.includes('## 관련')) continue; // 이미 관련 링크가 있으면 스킵
      const pt = toks.get(p.slug)!;
      const scored = pages
        .filter((q) => q.slug !== p.slug)
        .map((q) => { let s = 0; const qt = toks.get(q.slug)!; for (const t of pt) if (qt.has(t)) s++; return { q, s }; })
        .filter((x) => x.s >= minOverlap)
        .sort((a, b) => b.s - a.s || a.q.title.localeCompare(b.q.title))
        .slice(0, topK);
      if (!scored.length) continue;
      const body = p.body.trim() + `\n\n## 관련\n${scored.map((x) => `- [[${x.q.title}]]`).join('\n')}`;
      this.writePage({ ...p, body, links: outboundLinks(body), updated: nowDate() });
      filled++;
    }
    if (filled) this.rebuildIndex();
    return filled;
  }

  /** 고아(인바운드 없는 concept/entity)를 그래프에 연결 — 고아가 이미 [[링크]]한 대상에 역링크([[고아]])를
   *  추가해 양방향화한다(토큰 추측이 아니라 고아 자신이 선언한 관계 사용). 가능하면 비-고아(이미 연결된)
   *  대상에 역링크해 고아가 본 그래프에 합류하게 한다. 해소한 고아 수 반환. */
  linkOrphans(): number {
    const all = this.allPages();
    const bySlug = new Map(all.map((p) => [p.slug, p] as const));
    const resolve = buildLinkResolver(all); // 별칭 링크도 실 대상으로 해석(고아가 선언한 관계 살리기)
    const inbound = new Set<string>();
    for (const p of all) for (const l of p.links) inbound.add(resolve.get(l) ?? l);
    const orphans = all.filter((p) => (p.type === 'entity' || p.type === 'concept') && !inbound.has(p.slug));
    let fixed = 0;
    for (const o of orphans) {
      const targets = o.links.map((l) => bySlug.get(resolve.get(l) ?? l)).filter((t): t is WikiPage => !!t && t.slug !== o.slug);
      if (!targets.length) continue;
      // 비-고아(연결된) 대상 우선 → 고아가 본 그래프에 합류.
      const target = targets.find((t) => inbound.has(t.slug)) ?? targets[0]!;
      if (!target.links.includes(o.slug)) {
        const body = target.body.includes('## 관련')
          ? target.body.replace('## 관련', `## 관련\n- [[${o.title}]]`)
          : target.body.trim() + `\n\n## 관련\n- [[${o.title}]]`;
        this.writePage({ ...target, body, links: outboundLinks(body), updated: nowDate() });
        target.body = body; target.links = outboundLinks(body); // in-memory 갱신(후속 반복 반영)
      }
      inbound.add(o.slug);
      fixed++;
    }
    if (fixed) this.rebuildIndex();
    return fixed;
  }

  // ---- QUERY (인덱스 우선): 질의 관련 페이지 본문을 그라운딩 컨텍스트로 반환 ----
  query(question: string, limit = 4, opts: { forFacts?: boolean } = {}): { hits: WikiPage[]; context: string } {
    const qt = tokenize(question);
    if (!qt.length) return { hits: [], context: '' };
    const scored = this.allPages()
      .filter((p) => !opts.forFacts || !FACT_EXCLUDED_TYPES.has(p.type)) // 집필용 사실 조회 — 성과·토론·개요·교훈 제외(스펙 §4)
      .map((p) => {
        const title = p.title; const a = tokenize(p.aliases.join(' ')); const b = new Set(tokenize(p.body));
        let s = 0;
        for (const tok of qt) {
          // 제목은 '부분일치' — 업로드 원문 제목이 '2026년도세출예산집행현황...'처럼 공백 없이 붙어 있어
          // 토큰 일치로는 '세출'/'집행'이 안 걸린다. substring 으로 타깃 원문이 상위로 오게 한다.
          if (tok.length >= 2 && title.includes(tok)) s += 8;
          if (a.includes(tok)) s += 4;
          if (b.has(tok)) s += 1;        // 본문은 '빈도'가 아니라 '존재' 1점 — 거대 문서(회의록 등)가 토큰 빈도로 랭킹 지배 방지.
        }
        // 업로드된 원문(source) 우대 — 실제 수치·표는 source 본문에 있고, 파생 요약(concept/entity)에는 없다(이슈12).
        if (p.type === 'source') s *= 1.4;
        // 실측 성과(performance) 근거 우대 — 다음 콘텐츠 기획이 '무엇이 실제로 노출됐는지'를 참조하게(compounding).
        if (p.type === 'performance') s *= 1.3;
        // 업로드 1차 원문(sources=raw/...) 을 런 파생 요약(sources=run:...)·생성 concept 보다 강하게 우대 —
        // 실제 결산 수치(세출예산집행현황 등)가 런이 만든 요약 페이지에 밀려 검색에서 빠지던 문제(이슈12) 해결.
        if (p.sources.some((src) => src.startsWith('raw/'))) s *= 2;
        // 런 파생 요약(sources=run:...)은 역가중 — 이전 런 보고서의 순환 요약이 1차 원문을 밀어내지 않게.
        if (p.sources.some((src) => src.startsWith('run:'))) s *= 0.5;
        if (p.sources.includes('maintain:auto')) s *= 0.5; // LLM 기억 스텁 — 순수 스텁이 상위 랭크되던 감사 실측
        if (p.sources.includes('stub:source')) s *= 0.5; // 원문 발췌 스텁 — LLM 이 만든 것이므로 maintain:auto 와 동일 감가
        return { p, s };
      }).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.p.updated.localeCompare(a.p.updated) || a.p.title.localeCompare(b.p.title))
      .slice(0, limit);
    const hits = scored.map((x) => x.p);
    // 관련 구간 발췌 — 헤더만 잘려 실수치가 안 닿던 문제(이슈12) 해소: source 는 헤더+데이터행 발췌(3500자), 그 외 800자.
    // 머리말에 출처 라벨을 달아 작가·판정기가 "실측·원문"과 "LLM 이 만든 것"을 구분하게(스펙 §4).
    const context = hits.map((p) => `### ${p.title} [${provenanceLabel(p)}]\n${excerpt(p.body, qt, p.type === 'source' ? 3500 : 800)}`).join('\n\n');
    return { hits, context };
  }

  // ---- 의미검색(임베딩 rerank) — retrieve(휴리스틱 recall) → rerank(코사인). 임베딩 모델 없으면 query() 로 폴백. ----
  //  전 위키를 임베딩하지 않고, 값싼 휴리스틱으로 후보 K개를 먼저 뽑은 뒤 그 후보만 임베딩해 재정렬한다
  //  (수천 페이지 일괄 임베딩 회피 + 캐시). USE_EMBEDDINGS=false 또는 모델 미설치면 휴리스틱과 동일(회귀 0).
  // 인사·직무 질의 보강 — 사용자가 "직원별 업무"처럼 물으면 업로드된 '업무분장표'가 검색돼야 하는데,
  // 질의 토큰(업무에/직원별)이 표 자료 제목·본문과 어휘적으로 안 맞고, 임베딩도 장문 서술 보고서
  // (주요업무보고 등)에 밀려 표가 top-k 에서 빠진다(업무분장 8팀 0건 인출 → "62명·데이터 없음"). 인사/
  // 직무 의도가 감지되면 표 자료를 가리키는 앵커 용어를 보태 recall·임베딩을 그 자료로 끌어온다. 보고서·
  // 예산 질의는 의도 미감지 → 무변경(회귀 0).
  private static readonly DUTY_INTENT_RE = /직원|전직원|인원|인력|담당자|인사|팀원|정원|명단|누구|누가|업무분장|담당업무|직무|분장|담당\s*업무|업무\s*담당/;
  private static readonly DUTY_ANCHORS = ['업무분장', '담당업무'];
  private static readonly DUTY_EXPANSION = '업무분장 담당업무 담당자 직책';
  private expandIntent(question: string): { q: string; intent: boolean } {
    const intent = LlmWiki.DUTY_INTENT_RE.test(question);
    return { q: intent ? `${question} ${LlmWiki.DUTY_EXPANSION}` : question, intent };
  }
  // 앵커 set-pull — 의도질의에서 앵커 문서(업무분장표 등)가 상위에 잡히면 후보 풀의 동형 자료를 모두
  // 보충한다. 8개 팀 업무분장표는 별개 파일이라 limit(=6)에 다 못 들어오는 구조적 누락이 있는데(완벽한
  // rerank 라도 6/8), 이를 limit 밖에서 메워 '전직원' 질의가 8팀을 모두 본다. 의도 미감지/앵커 부재면 무변경.
  private pullAnchorSet(hits: WikiPage[], pool: WikiPage[], intent: boolean, cap = 12): WikiPage[] {
    if (!intent) return hits;
    const anchored = (p: WikiPage): boolean => LlmWiki.DUTY_ANCHORS.some((a) => p.title.includes(a));
    if (!hits.some(anchored)) return hits; // 앵커가 상위에 전혀 없으면(무관 질의) 보충 안 함
    const seen = new Set(hits.map((p) => p.slug));
    const extra = pool.filter((p) => !seen.has(p.slug) && anchored(p)).slice(0, cap);
    return extra.length ? [...hits, ...extra] : hits;
  }

  async semanticQuery(question: string, limit = 4, _signal?: AbortSignal, opts: { forFacts?: boolean } = {}): Promise<{ hits: WikiPage[]; context: string }> {
    // 인사·직무 의도면 표 자료(업무분장표 등) 앵커로 질의 확장 — recall·발췌 모두 확장질의 기준.
    // Ollama 임베딩 rerank 는 백엔드 제거(2026-07-06)와 함께 삭제 — 휴리스틱 랭킹 단일 경로.
    // (query() 휴리스틱이 이미 출처 가중 raw/×2·run:×0.5 로 1차 원문을 우대한다.)
    const { q, intent } = this.expandIntent(question);
    const qt = tokenize(q);
    const buildCtx = (hh: WikiPage[]): string =>
      hh.map((p) => `### ${p.title} [${provenanceLabel(p)}]\n${excerpt(p.body, qt, p.type === 'source' ? 3500 : 800)}`).join('\n\n');
    const base = this.query(q, limit, opts).hits;
    const pool = intent ? this.query(q, Math.max(limit * 8, 48), opts).hits : base;
    const hits = this.pullAnchorSet(base, pool, intent);
    return { hits, context: buildCtx(hits) };
  }


  /** store.ts 호환 검색(슬러그/점수). */
  search(q: string, limit = 8): Array<{ page_id: string; title: string; score: number }> {
    return this.query(q, limit).hits.map((p) => ({ page_id: p.slug, title: p.title, score: 1 }));
  }

  // ---- LINT: 고아·중복·교차참조 누락 점검 ----
  lint(): { orphans: string[]; danglingLinks: Array<{ from: string; to: string }>; total: number } {
    const ps = this.allPages();
    const resolve = buildLinkResolver(ps); // 별칭 링크도 인바운드로 인정(가짜 고아 방지)
    const inbound = new Set<string>();
    for (const p of ps) for (const l of p.links) inbound.add(resolve.get(l) ?? l);
    // 원문(source)·교훈(lesson)·개요(overview)는 인바운드 링크 대상이 아니므로 고아 점검에서 제외
    //   — 원문 데이터·교훈은 개념 노드가 아니다. 의미있는 고아 = 아무도 안 가리키는 concept/entity/answer.
    const ORPHAN_SKIP = new Set(['overview', 'source', 'lesson']);
    const orphans = ps.filter((p) => !ORPHAN_SKIP.has(p.type) && !inbound.has(p.slug)).map((p) => p.title);
    // danglingTargets 가 원제목을 보존 → from/to 둘 다 제목으로 일관(슬러그 노출 방지).
    const danglingLinks: Array<{ from: string; to: string }> = [];
    for (const t of this.danglingTargets().values()) for (const from of t.refs) danglingLinks.push({ from, to: t.title });
    return { orphans, danglingLinks, total: ps.length };
  }

  // ---- MAINTAIN(자가수선): lint 의 끊긴 링크(지식 갭)를 LLM 으로 채워 그래프를 연결 ----
  /** 페이지가 없는 [[링크]] 대상 → {원제목, 참조 페이지들}. (lint 의 dangling 을 보충 가능한 형태로) */
  private danglingTargets(): Map<string, { title: string; refs: string[] }> {
    const pages = this.allPages();
    // 별칭까지 해석 — 별칭으로 도달 가능한 대상은 '갭'이 아니다(maintain 이 중복 페이지를 만들던 구멍).
    const resolve = buildLinkResolver(pages);
    const map = new Map<string, { title: string; refs: string[] }>();
    for (const p of pages) {
      const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(p.body)) !== null) {
        const title = m[1]!.trim();
        const slug = slugify(title);
        if (resolve.has(slug)) continue; // 이미 페이지 존재(슬러그 또는 별칭으로 도달)
        const e = map.get(slug) ?? { title, refs: [] };
        if (!e.refs.includes(p.title)) e.refs.push(p.title);
        map.set(slug, e);
      }
    }
    return map;
  }

  private async generateStub(model: string, title: string, refs: string[], signal?: AbortSignal): Promise<string | null> {
    const sys = '너는 LLM Wiki 관리자다. 주어진 개념/엔티티의 위키 페이지 본문을 사실 위주 2~3문장으로 쓴다. 본문에서 관련 개념은 [[이름]]으로 링크한다. 잘 모르면 일반적 정의만 간결히.';
    const user = `항목: ${title}\n맥락(이 항목을 참조하는 페이지): ${refs.slice(0, 4).join(', ') || '없음'}\n\n본문만 출력(머리말·맺음말 없이).`;
    try {
      const res = await llm.chat({
        model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        maxOutputTokens: 300, temperature: 0.3, signal,
      });
      const t = res.text.trim();
      return t || null;
    } catch {
      return null;
    }
  }

  /** 지식 갭(끊긴 링크) 상위 maxFill 개를 LLM 으로 보충 → 페이지 생성 → index/log. compounding 가속. */
  async maintain(model: string, opts: { maxFill?: number; signal?: AbortSignal } = {}): Promise<{ filled: string[]; gaps: number }> {
   return this.serialize(async () => {
    const targets = this.danglingTargets();
    // 브랜드 소재 하드 게이트 — 금지 소재(채소·화초·다육 등)는 페이지를 만들지 않는다. 만들면 query()
    // 그라운딩을 통해 금지 소재가 두뇌에 재파종된다(리뷰 실측: dangling 324건 중 72건이 금지 토큰).
    // 갭 '보고'(lint)는 그대로 두고 '생성'만 막는다. maintain 은 항상 활성 브랜드 위키에서 호출된다.
    // 가장 많이 참조되는 갭부터(가치 높은 빈틈 우선).
    const sorted = [...targets.values()]
      .filter((t) => !offBrandTerm(t.title))
      .sort((a, b) => b.refs.length - a.refs.length).slice(0, opts.maxFill ?? 4);
    const filled: string[] = [];
    for (const t of sorted) {
      const body = await this.generateStub(model, t.title, t.refs, opts.signal);
      if (body) {
        // LLM 이 본문 대신 거절·되물음 안내문을 반환하면 페이지를 만들지 않는다 — 만들면 "항목이
        // 지정되지 않았습니다…" 요약의 무의미 노드가 두뇌에 영속된다(실측: '데이터 없음' 페이지).
        if (isLlmRefusalText(body)) {
          this.appendLog('maintain', `stub 생성 거부 — "${t.title}" LLM 거절·되물음 응답(페이지 미생성)`);
          continue;
        }
        this.upsertPage({ title: t.title, type: 'entity', body, sources: ['maintain:auto'], summary: esc(body).slice(0, 120) });
        filled.push(t.title);
      }
    }
    if (filled.length) {
      this.rebuildIndex();
      this.appendLog('maintain', `지식 갭 ${filled.length}건 보충: ${filled.join(', ')}`);
    }
    return { filled, gaps: targets.size };
   });
  }

  /** 끊긴 링크 대상이 원문(source)에서 언급된 발췌를 모은다(조작 방지 — 추측 대신 원문 근거). */
  private sourceMentions(title: string, maxExcerpts = 5, window = 220): string[] {
    const out: string[] = [];
    const lc = title.toLowerCase();
    if (lc.length < 2) return out;
    for (const p of this.allPages()) {
      if (p.type !== 'source') continue;
      const low = p.body.toLowerCase();
      let idx = low.indexOf(lc); let n = 0;
      while (idx >= 0 && out.length < maxExcerpts && n < 2) {
        out.push(p.body.slice(Math.max(0, idx - window), Math.min(p.body.length, idx + window)).replace(/\s+/g, ' ').trim());
        idx = low.indexOf(lc, idx + lc.length); n++;
      }
      if (out.length >= maxExcerpts) break;
    }
    return out;
  }

  /** 원문 발췌에 있는 사실만으로 stub 본문 생성(추측·일반상식 금지). 발췌 없으면 null. */
  private async stubFromSource(model: string, title: string, excerpts: string[], refs: string[], signal?: AbortSignal): Promise<string | null> {
    if (!excerpts.length) return null;
    const sys = '너는 LLM Wiki 관리자다. 아래 [원문 발췌]에 실제로 있는 사실만으로 항목의 위키 본문을 2~3문장으로 쓴다. ' +
      '발췌에 없는 정보는 절대 지어내지 마라(추측·일반상식으로 채우지 말 것). 관련 개념은 [[이름]]으로 링크한다. ' +
      '발췌가 단순 언급뿐이면 "원문 상 <맥락>으로 언급됨"처럼 정직하게 쓴다.';
    const user = `항목: ${title}\n참조 페이지: ${refs.slice(0, 4).join(', ') || '없음'}\n\n[원문 발췌]\n${excerpts.map((e, i) => `(${i + 1}) …${e}…`).join('\n')}\n\n본문만 출력(머리말·맺음말 없이).`;
    try {
      const res = await llm.chat({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxOutputTokens: 300, temperature: 0.2, signal });
      return res.text.trim() || null;
    } catch { return null; }
  }

  /** 끊긴 링크를 원문 근거로 채운다 — 원문 언급이 있는 대상만 그 맥락으로 stub 생성(조작 금지).
   *  원문 맥락이 없는 대상은 건드리지 않고 dangling 으로 둔다(정직한 '미정의' 회색 노드). */
  async fillDanglingFromSource(model: string, opts: { maxFill?: number; signal?: AbortSignal } = {}): Promise<{ filled: number; noSource: number }> {
   return this.serialize(async () => {
    const targets = [...this.danglingTargets().values()]
      .filter((t) => !offBrandTerm(t.title)) // 브랜드 소재 하드 게이트(maintain 과 동일 — 금지 소재 재파종 방지)
      .sort((a, b) => b.refs.length - a.refs.length);
    const max = opts.maxFill ?? Number.POSITIVE_INFINITY;
    let filled = 0; let noSource = 0;
    for (const t of targets) {
      if (opts.signal?.aborted || filled >= max) break;
      const excerpts = this.sourceMentions(t.title);
      if (!excerpts.length) { noSource++; continue; } // 원문 근거 없음 → 조작 금지, dangling 유지
      const body = await this.stubFromSource(model, t.title, excerpts, t.refs, opts.signal);
      if (body) {
        this.upsertPage({ title: t.title, type: 'entity', body, sources: ['stub:source'], summary: esc(body).slice(0, 120) });
        filled++;
      } else noSource++;
    }
    if (filled) { this.rebuildIndex(); this.appendLog('maintain', `소스 근거 stub ${filled}건 생성(원문 발췌 기반)`); }
    return { filled, noSource };
   });
  }

  // ---- AUDIT(모순 검출): 토픽이 겹치는 페이지 쌍을 LLM 으로 비교해 상충 주장 탐지 ----
  /** 후보 쌍: 상호 링크 또는 공유 링크가 있는(토픽 겹치는) 페이지 쌍, 겹침 큰 순. */
  private contradictionCandidates(maxPairs: number): Array<[WikiPage, WikiPage]> {
    const pages = this.allPages().filter((p) => p.type !== 'source' && p.body.trim().length > 40);
    const scored: Array<{ a: WikiPage; b: WikiPage; s: number }> = [];
    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 1; j < pages.length; j++) {
        const a = pages[i]!; const b = pages[j]!;
        const linked = a.links.includes(b.slug) || b.links.includes(a.slug);
        const shared = a.links.filter((l) => b.links.includes(l)).length;
        const s = (linked ? 3 : 0) + shared;
        if (s > 0) scored.push({ a, b, s });
      }
    }
    scored.sort((x, y) => y.s - x.s);
    return scored.slice(0, maxPairs).map((p) => [p.a, p.b] as [WikiPage, WikiPage]);
  }

  private async checkPair(model: string, a: WikiPage, b: WikiPage, signal?: AbortSignal): Promise<{ contradicts: boolean; issue: string; reconciliation: string } | null> {
    const sys = '너는 LLM Wiki 감사자다. 두 위키 페이지가 같은 사실에 대해 서로 모순되는 주장을 하는지만 판단한다. 단순히 다른 주제면 모순이 아니다.';
    const user =
      `[A: ${a.title}]\n${a.body.slice(0, 1200)}\n\n[B: ${b.title}]\n${b.body.slice(0, 1200)}\n\n` +
      'JSON만: {"contradicts": true/false, "issue": "무엇이 충돌하는지 한 줄(없으면 빈칸)", "reconciliation": "어느 쪽이 맞는지/어떻게 통합할지 한 줄"}';
    try {
      const res = await llm.chat({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxOutputTokens: 300, temperature: 0.2, signal });
      const j = extractJson<{ contradicts?: boolean; issue?: string; reconciliation?: string }>(res.text);
      if (!j) return null;
      return { contradicts: !!j.contradicts, issue: j.issue ?? '', reconciliation: j.reconciliation ?? '' };
    } catch {
      return null;
    }
  }

  private appendNote(slug: string, note: string): void {
    const p = this.getPage(slug);
    if (!p) return;
    const today = nowDate();
    p.body = p.body.trim() + `\n\n## ⚖️ 모순 해소 (${today})\n${note}\n`;
    p.updated = today;
    this.writePage({ ...p, links: outboundLinks(p.body) });
  }

  /** 모순 감사: 후보 쌍을 LLM 비교 → 상충 보고. resolve 면 해소 노트를 페이지에 기록. */
  async findContradictions(model: string, opts: { maxChecks?: number; resolve?: boolean; signal?: AbortSignal } = {}): Promise<{ checked: number; contradictions: Array<{ pages: string[]; titles: string[]; issue: string; reconciliation: string }> }> {
   return this.serialize(async () => {
    const cands = this.contradictionCandidates(opts.maxChecks ?? 6);
    const found: Array<{ pages: string[]; titles: string[]; issue: string; reconciliation: string }> = [];
    for (const [a, b] of cands) {
      const r = await this.checkPair(model, a, b, opts.signal);
      if (r?.contradicts) {
        found.push({ pages: [a.slug, b.slug], titles: [a.title, b.title], issue: r.issue, reconciliation: r.reconciliation });
        if (opts.resolve && r.reconciliation) {
          // 양쪽 페이지 모두에 해소 노트 — 어느 쪽을 봐도 보이게(그래프 대칭).
          this.appendNote(a.slug, `[[${b.title}]]와(과)의 모순: ${r.issue}\n→ ${r.reconciliation}`);
          this.appendNote(b.slug, `[[${a.title}]]와(과)의 모순: ${r.issue}\n→ ${r.reconciliation}`);
        }
      }
    }
    if (opts.resolve && found.length) {
      this.rebuildIndex();
      this.appendLog('audit', `모순 ${found.length}건 해소`);
    }
    return { checked: cands.length, contradictions: found };
   });
  }

  // ---- GRAPH: [[위키링크]] → 노드/엣지(프론트 /wiki/graph) ----
  graph(): { nodes: unknown[]; links: unknown[]; stats: Record<string, number> } {
    const ps = this.allPages();
    const bySlug = new Map(ps.map((p) => [p.slug, p]));
    const nodes: Array<Record<string, unknown>> = ps.map((p) => ({
      id: p.slug, type: 'page', label: p.title, // 모든 위키 페이지를 page 노드로(자료·지식은 category 로 구분) — 두뇌 기본 뷰 표출
      slug: p.slug, category: p.type, stance: 'neutral', status: 'active',
      contributors: p.contributors, source_count: p.sources.length,
      degree: p.links.length, summary: p.summary, updated_ts: p.updated, tags: p.aliases,
    }));
    const links: Array<Record<string, unknown>> = [];
    let pageLinks = 0;
    const stubs = new Set<string>();
    // 별칭 링크는 실 노드로 해석 — 종전엔 별칭마다 유령 stub 노드가 생겨 그래프가 부풀었다.
    const resolve = buildLinkResolver(ps);
    for (const p of ps) for (const l of p.links) {
      if (!l) continue;
      const t = resolve.get(l) ?? l;
      if (!bySlug.has(t)) stubs.add(t); // dangling — 아직 생성 안 된 대상(미생성 페이지)
      links.push({ source: p.slug, target: t, kind: 'relates' }); pageLinks++;
    }
    // 반박(rebuts) 타입드 엣지 — 토론 노드의 비평→입장 관계(프런트 빨강 시냅스). 페이지 링크로 카운트(pageLinks).
    for (const p of ps) for (const r of p.rebuts) {
      if (!r) continue;
      const t = resolve.get(r) ?? r;
      if (!bySlug.has(t)) stubs.add(t);
      links.push({ source: p.slug, target: t, kind: 'rebuts' }); pageLinks++;
    }
    // 미생성 페이지(dangling)도 노드로 표시해 [[링크]] 연결을 보존(obsidian 회색 노드 식, category:stub).
    for (const s of stubs) nodes.push({ id: s, type: 'page', label: s, category: 'stub', stance: 'neutral', status: 'missing', degree: 0, source_count: 0 });
    // 직원(작성자) 노드 + author 링크 — 프론트 '직원' 레이어 토글
    const agents = new Set<string>();
    for (const p of ps) for (const a of p.contributors) if (a) agents.add(a);
    for (const a of agents) nodes.push({ id: `agent:${a}`, type: 'agent', label: a });
    for (const p of ps) for (const a of p.contributors) if (a) links.push({ source: `agent:${a}`, target: p.slug, kind: 'author' });
    // 자료(출처) 노드 + source 링크 — 프론트 '자료' 레이어 토글
    const sources = new Set<string>();
    for (const p of ps) for (const s of p.sources) if (s) sources.add(s);
    for (const s of sources) nodes.push({ id: `source:${s}`, type: 'source', label: s });
    for (const p of ps) for (const s of p.sources) if (s) links.push({ source: p.slug, target: `source:${s}`, kind: 'source' });
    // 태그(별칭) 노드 + tag 링크 — 프론트 '태그' 레이어 토글
    const tags = new Set<string>();
    for (const p of ps) for (const t of p.aliases) if (t) tags.add(t);
    for (const t of tags) nodes.push({ id: `tag:${t}`, type: 'tag', label: t });
    for (const p of ps) for (const t of p.aliases) if (t) links.push({ source: `tag:${t}`, target: p.slug, kind: 'tag' });
    return { nodes, links, stats: { pages: ps.length, tags: tags.size, sources: sources.size, agents: agents.size, links: pageLinks } };
  }
}

interface ExtractResult {
  summary?: string;
  pages?: Array<{ title?: string; type?: string; body?: string; links?: string[] }>;
}

// 관련 구간 발췌 — body 가 budget 보다 길면 앞부분(헤더/총괄) + 쿼리 토큰이 등장하는 구간 윈도우를 모은다.
// 거대한 표/문서(세출예산집행현황 1.1MB 등)에서 앞부분만 잘려 실제 데이터 행·수치가 에이전트에 안 닿던
// 문제(이슈12) 완화 — 데이터 행을 포함하도록.
function excerpt(body: string, qt: string[], budget: number): string {
  if (body.length <= budget) return body;
  const headLen = Math.min(1600, budget);
  const head = body.slice(0, headLen);
  let rest = budget - headLen;
  if (rest <= 0) return head;
  const low = body.toLowerCase();
  const wins: string[] = [];
  for (const tok of qt) {
    if (rest <= 0) break;
    if (tok.length < 2) continue;
    const idx = low.indexOf(tok.toLowerCase(), headLen);
    if (idx < 0) continue;
    const w = body.slice(Math.max(headLen, idx - 150), Math.min(body.length, idx + 350));
    wins.push(w); rest -= w.length;
  }
  return wins.length ? head + '\n…\n' + wins.join('\n…\n') : head;
}

// 대형 원문(거대 표 등)을 검색 가능한 청크로 분할 — 청크당 ~minSize, 문서당 최대 maxChunks(위키 팽창 억제).
// 각 청크가 작아 query 발췌가 깊은 행·수치까지 닿는다(1.1MB 표가 head 발췌로 안 닿던 이슈12 잔여 해소).
// 표 행(| a | b | …)이 '컬럼 헤더 행'인지 내용으로 판정 — 라벨 셀(한글/영문 텍스트, 순수 숫자 아님)이
// 다수면 헤더. 결산표는 데이터 행이 숫자 위주(과목명 1~2개 라벨 + 숫자 다수)라 헤더와 구분된다.
function isHeaderRow(l: string): boolean {
  if (!l.includes('|')) return false;
  const cells = l.split('|').map((c) => c.trim()).filter(Boolean);
  if (cells.length < 3) return false;
  const labels = cells.filter((c) => /[가-힣A-Za-z]/.test(c) && !/^[\d,.\s()\-+]+$/.test(c));
  return labels.length >= Math.max(2, Math.ceil(cells.length * 0.5));
}
export function chunkBody(body: string, maxChunks = 60, minSize = 3500): string[] {
  if (body.length <= minSize) return [body];
  const lines = body.split('\n');
  // xlsx/결산표는 여러 표(세입·세출·기금 등)가 각자 컬럼 헤더를 가지며, 헤더는 각 표 섹션 앞에 한 번만 나온다.
  // 문자 단위로 자르면 데이터 청크에 헤더가 사라져 '라벨 없는 숫자벽'이 된다. 그래서 (1) 행 경계로 분할하고
  // (2) '직전에 본 헤더 행'을 carry-forward 해 각 청크 첫머리에 주입 → 청크 데이터가 속한 표의 헤더가 항상 붙는다.
  const size = Math.max(minSize, Math.ceil(body.length / maxChunks));
  const chunks: string[] = [];
  let cur = '';
  let lastHeader = '';
  for (const line of lines) {
    if (isHeaderRow(line)) lastHeader = line;
    if (cur && cur.length + line.length + 1 > size) {
      chunks.push(cur);
      cur = lastHeader ? lastHeader + '\n' : ''; // 새 청크는 직전 헤더로 시작(데이터가 속한 표의 컬럼 맥락)
    }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length ? chunks : [body];
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
}
function extractJson<T>(raw: string): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start]!; const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc2 = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) { if (esc2) esc2 = false; else if (ch === '\\') esc2 = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)) as T; } catch { return null; } } }
  }
  return null;
}

const SCHEMA_DOC = `# LLM Wiki 스키마 (Karpathy 패턴)

이 폴더는 에이전트가 유지하는 **LLM Wiki** 다. RAG 가 아니라, 지식을 한 번 컴파일해 계속 갱신한다.

## 레이아웃
- \`../raw/<날짜>/\` — 원본 소스(불변)
- \`*.md\`(위키 루트, 평면) — 페이지. YAML 프런트매터 + 본문 \`[[위키링크]]\`. (\`index.md\`·\`log.md\`·\`WIKI_SCHEMA.md\` 는 예약 파일)
- \`index.md\` — 전 페이지 카탈로그(카테고리별, 1줄 요약). 인덱스 우선 탐색의 진입점.
- \`log.md\` — append-only 타임라인 \`## [YYYY-MM-DD] op | Title\`.

## 페이지 타입
entity(사람·조직·도구) · concept(개념·주제) · source(소스 요약) · overview(종합) · answer(질의 답변) · lesson(직원 교훈) · debate(런별 토론 입장·비평 — rebuts 엣지) · performance(성과 신호)

## 워크플로우
- ingest: 소스/산출물 읽기 → 요약 페이지 작성 → 엔티티/개념 페이지 생성·갱신([[링크]] 유지) → index 재생성 → log 추가
- query: index 로 관련 페이지 탐색 → 본문으로 답 종합(인용) → 좋은 답은 answer 페이지로 환류
- lint: 고아 페이지·끊긴 링크·모순·오래된 주장 점검

## 원칙
지식은 컴파일 1회 + 지속 갱신(compounding). 작은 위키는 임베딩 없이 index 우선 탐색으로 충분.
`;

// 디렉터리별 인스턴스 캐시 — 브랜드 교차 호출(강화 vs 활성 런)에도 디렉터리별 쓰기 직렬화 체인 보존.
const _wikis = new Map<string, LlmWiki>();
/**
 * 명시 브랜드의 위키 인스턴스 — 강화 등 "콘텐츠 브랜드 ≠ 활성 브랜드" 일 수 있는 경로용.
 * 주의: undefined = 범용(활성 브랜드 아님 — appendMemory 의 brand? 와 의미가 다르다).
 */
export function llmWikiFor(brand: string | undefined): LlmWiki {
  const suffix = brandFileSuffixFor(brand);
  const dir = suffix ? path.join(path.dirname(CONFIG.wikiDir), `${path.basename(CONFIG.wikiDir)}${suffix}`) : CONFIG.wikiDir;
  let w = _wikis.get(dir);
  if (!w) { w = new LlmWiki(dir); _wikis.set(dir, w); }
  return w;
}
export function llmWiki(): LlmWiki { return llmWikiFor(activeBrandSlug() || undefined); }
