/**
 * 브랜드(고객사) 프로필 — 이 스튜디오가 '누구를 위해' 콘텐츠를 만드는지 정의하는 계층.
 *
 * company.yaml(AI 직원 조직)과 별개다: 직원은 범용 스킬을 갖고, 브랜드는 런타임 컨텍스트로
 * 주입된다 — 그래야 기업 전환이 프롬프트 수정 없이 데이터(brand.yaml) 교체만으로 된다.
 *
 * 파일이 없으면 null(미설정) — 모든 주입 지점이 빈 문자열을 받아 기존 동작 100% 불변.
 * 인스턴스 분리(GEPA_DATA_DIR 스왑) 시 brand.yaml 도 데이터 디렉토리를 따라간다.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CONFIG } from '../config';

export interface BrandProduct {
  name: string;
  /** 특징·강점 한 줄(콘텐츠에 녹일 셀링 포인트). */
  features?: string;
  /** 이 제품의 타겟 고객(전체 타겟과 다르면). */
  target?: string;
}

export interface BrandProfile {
  /** 업체명(필수). */
  name: string;
  industry?: string;
  /** 한 줄 소개 — 무엇을 하는 회사인가. */
  description?: string;
  products: BrandProduct[];
  /** 타겟 고객(연령·상황·니즈). */
  audience?: string;
  /** 지역(로컬 비즈니스면 상권·배달권 등). */
  region?: string;
  /** 톤앤매너(예: 친근한 존댓말, 전문적, 유머러스). */
  tone?: string;
  /** 금지 표현·다루지 않을 주제. */
  banned?: string[];
  /** 시드 키워드 — 성과 데이터가 없는 콜드스타트 주제 탐색의 출발점. */
  seedKeywords?: string[];
  /** 글의 장르 축 — 콘텐츠가 한 장르(예: 구매 체크리스트)로 수렴하는 것을 막으려고 작가에게 제시한다.
   *  브랜드마다 다르므로 설정에 둔다(미설정이면 장르 지침 생략 — 종전 동작). 2026-08-01 신설. */
  genreAxes?: string[];
  /** 한국어 합성어 안에서 추가로 크레딧할 도메인 어간(예: '감나무묘목'→'묘목').
   *  포화 탐지가 합성어를 못 쪼개 수렴 축을 놓치는 문제 대응 — 업종어라 브랜드별로 둔다(미설정=확장 없음). */
  compoundStems?: string[];
  /**
   * 성과 학습의 시대 컷오프(YYYY-MM-DD) — 이 날짜 **이전에 처음 측정된** 성과 키워드는 주제 조향에서 뺀다.
   * 브랜드 정체성을 재정립하면 그 이전 성과는 '지금의 우리'가 아니라 '이전의 우리'가 번 것이라,
   * 그대로 두면 주제 두뇌를 옛 정체성으로 되끌어간다(실측 2026-08-01: bionditree 상위 8개 중 5개가
   * 재정립 전 꽃·화분 키워드 — banned 게이트는 '꽃'이 스톱워드라 못 거른다).
   * 미설정이면 필터 없음(종전 동작) — 정체성을 바꾼 적 없는 브랜드는 영향받지 않는다.
   */
  perfEraSince?: string;
  /** 어휘 함정 목록(2026-08-08 어휘 감사) — 일반 독자가 다른 뜻으로 먼저 읽거나 모르는 업종 한자어와
   *  그 대체 표현. 작가·기획자·패키저 지침(lexiconGuide)과 어휘 린트가 공용. 업종어라 브랜드별로 둔다. */
  avoidJargon?: Array<{ term: string; use: string }>;
  /** 상용어 허용 목록(2026-08-28 사용자 확정) — 업종 독자에겐 일상어인 말. avoidJargon 의 반대 방향 신호다.
   *  배경(실측): "전정"은 avoidJargon 에 없는데도 최근 글에서 통째로 사라졌다 — 제목·키워드에 박힌 글만
   *  5회 쓰고, 자유 집필에선 0회에 "가위를 들다"·"다듬다"로 우회했다("1년에 가위를 몇 번 들 수 있는가").
   *  원인은 금지 목록이 아니라 lexiconGuide ①(압축 한자어는 풀어 써라)·⑦(한 이름으로 통일하라)과
   *  lexemeAvoid("일상 대화에서 안 쓰는 어휘는 어색함의 주범")의 **누적 압력**이다. 각각은 옳은데 합쳐지면
   *  "한자어=위험" 신호가 돼 원예 상용어까지 우회한다. 금지만 있고 허용이 없던 구조가 문제였다.
   *  업종 어휘라 브랜드별로 둔다(미설정=허용 블록 없음, 종전 동작). */
  keepTerms?: string[];
  /** 시기 소재 달력(2026-08-27 단풍 실사고) — 제목에 이 말이 들어간 주제는 months(1~12) 가 '이번 달 또는
   *  다음 달'일 때만 채택한다. 검색량 게이트는 keyword 만 재서 "활엽수" 키워드에 단풍 글이 묻어 나갔다.
   *  업종 달력이라 브랜드별로 둔다(미설정=게이트 없음). */
  seasonalSubjects?: Array<{ term: string; months: number[] }>;
  /** 취급 수종 카탈로그(2026-08-27) — 주제 두뇌의 수종 로테이션·월 상한 게이트 기준. 분류별 정식명+별칭.
   *  업종 목록이라 브랜드별로 둔다(미설정=로테이션 없음, 종전 동작). */
  speciesCatalog?: Array<{ group: string; species: Array<{ name: string; aliases?: string[] }> }>;
  /** 주제 축 카탈로그(2026-08-27) — 수종과 별개 축(심기·구매·거름·전정·병충해·번식·정원 조성…). seeds 는 발굴 검색어,
   *  match 는 제목 대조 토큰. 로테이션·월 상한 게이트 기준. 업종 목록이라 브랜드별(미설정=축 로테이션 없음). */
  topicThemes?: Array<{ theme: string; seeds: string[]; match: string[] }>;
  /** 채널 설명(예: 네이버 블로그 — 제품 활용 하우투·후기 중심). */
  channel?: string;
  // ── 업종 어휘 프로필(2026-09-07 범용화) — 종전엔 원예 브랜드의 낱말이 코드에 박혀 있었다(나무·묘목·전정…).
  //    이 저장소는 브랜드 전 단계의 범용 스튜디오라 업종 낱말은 전부 브랜드 설정으로 뺀다. 미설정=업종 중립 기본.
  /** 소재를 부르는 총칭 명사(예: 식물·수종 / 제품 / 메뉴). 프롬프트의 "대상 ○○" 자리. 미설정='소재'. */
  subjectNoun?: string;
  /** 그림으로 구별되는 소재의 특징 축(예: '잎 모양·잎차례·수형·계절 색' / '형태·색·재질·로고 위치'). 이미지 앵커 지시문에 쓴다. */
  subjectTraits?: string;
  /** 업종 일반어 — 소재 이름으로 오면 사전을 오염시키고, 주장 대조에서 변별력이 없는 말(예: 나무·묘목·전정·화분). */
  subjectStopwords?: string[];
  /** 소재 총칭어(예: 나무·묘목·유실수·조경수 / 제품·상품·모델) — 총칭만으로 된 주제 제한, 소재 앵커 판정, 계열 분류의 범주 제외에 쓴다. */
  subjectGenericTerms?: string[];
  /** 검색어 예시(2~3어절, 사람이 실제로 검색창에 치는 꼴 — 예: "매실나무 가지치기"). 주제 제안 프롬프트의 예시. 미설정이면 seedKeywords 앞 3개. */
  keywordExamples?: string[];
  /** 검색 의도어(정규식 대안 문자열 목록 — 예: 심기·가지치기·물주기…). 발굴 시드에서 '이 업종 의도가 담긴 검색어'를 고르는 기준. 미설정=범용 의도어. */
  subjectIntentTerms?: string[];
  /** 소재 앵커 정규식(선택, 예: '[가-힣]{1,6}나무'). 이름·유래형 주제에 소재가 명시됐는지 판정. 미설정이면 카탈로그 이름으로 판정한다. */
  subjectAnchorPattern?: string;
  /** 행위 축 동의어 묶음(예: [[전정, 가지치기], [물주기, 급수]]) — 각 묶음의 첫 항이 표준형. 계열 쿨다운의 결정적 라벨 폴백·매칭 토큰 전개에 쓴다. 미설정=행위 축 없음. */
  activityAxes?: string[][];
  /** 카드뉴스 기본 이미지 스타일 프리셋(브랜드 고정, 2026-07-22) — 수동·검토탭·자동 파생 전부 적용.
   *  미설정 = 디자이너가 주제 보고 자동 선택. 값 검증은 소비처(resolveForcedPreset)가 담당. */
  cardStyle?: string;
}

const brandPath = (): string => path.join(CONFIG.dataDir, 'brand.yaml');
const brandsDir = (): string => path.join(CONFIG.dataDir, 'brands');

let _cached: BrandProfile | null | undefined; // undefined=미로드, null=파일 없음/무효

export function reloadBrand(): void { _cached = undefined; }

/** 브랜드명 → 파일/태깅용 슬러그(결정적) — new_studio.mjs 와 동일 규칙. */
export function brandSlug(name: string): string {
  // NFC 정규화 — macOS/iCloud 가 파일명을 NFD 로 되돌려도(위키 장슬러그 사고와 동일 축)
  // 이름 유래 슬러그(activeBrandSlug)와 파일명 유래 슬러그(listBrands)가 같은 바이트로 만난다.
  return name.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'brand';
}

/**
 * 슬러그 안전 검증 — brandSlug() 가 생성 가능한 문자만(유니코드 문자·숫자·하이픈, 64자 캡).
 * 외부 입력(POST /brands/activate)·영속 데이터(piece.brand)가 파일 경로에 닿기 전의 관문:
 * '.'·'/'·'\' 가 문자 집합에 없어 경로 탈출(path traversal)이 원천 차단된다.
 */
export function isSafeBrandSlug(slug: string): boolean {
  return /^[\p{L}\p{N}-]{1,64}$/u.test(slug);
}

/** 현재 활성 브랜드의 슬러그 — 콘텐츠(pieces·cardnews·shorts) 태깅·필터의 기준. 범용 모드면 ''. */
export function activeBrandSlug(): string {
  const b = getBrand();
  return b ? brandSlug(b.name) : '';
}

/** 슬러그 → 브랜드 파일 접미(순수). undefined/''(범용) → ''. */
export function brandFileSuffixFor(slug: string | undefined): string {
  return slug ? `-${slug}` : '';
}
export function brandFileSuffix(): string { return brandFileSuffixFor(activeBrandSlug()); }

/** 브랜드 프로필 로드(캐시) — 없거나 name 이 비면 null(미설정). */
export function getBrand(): BrandProfile | null {
  if (_cached !== undefined) return _cached;
  try {
    const raw = YAML.parse(fs.readFileSync(brandPath(), 'utf-8')) as Partial<BrandProfile> | null;
    _cached = normalizeBrand(raw);
  } catch { _cached = null; }
  return _cached;
}

/** 저장(원자적 교체) + 캐시 무효화 — 활성(brand.yaml)과 레지스트리(brands/<slug>.yaml)에 함께 기록. */
export function saveBrand(b: BrandProfile): void {
  const norm = normalizeBrand(b);
  if (!norm) return;
  const text = YAML.stringify(norm);
  fs.mkdirSync(brandsDir(), { recursive: true });
  const tmp = `${brandPath()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, brandPath());
  fs.writeFileSync(path.join(brandsDir(), `${brandSlug(norm.name)}.yaml`), text, 'utf-8');
  reloadBrand();
}

/** 저장된 브랜드 목록(레지스트리) — 활성 brand.yaml 이 레지스트리에 없으면 자동 이관(하위 호환). */
export function listBrands(): Array<{ slug: string; name: string; industry?: string }> {
  const active = getBrand();
  if (active && !fs.existsSync(path.join(brandsDir(), `${brandSlug(active.name)}.yaml`))) saveBrand(active);
  let files: string[] = [];
  try { files = fs.readdirSync(brandsDir()).filter((f) => f.endsWith('.yaml')); } catch { /* 없음 */ }
  const out: Array<{ slug: string; name: string; industry?: string }> = [];
  for (const f of files) {
    try {
      const b = normalizeBrand(YAML.parse(fs.readFileSync(path.join(brandsDir(), f), 'utf-8')));
      if (b) out.push({ slug: f.replace(/\.yaml$/, '').normalize('NFC'), name: b.name, industry: b.industry });
    } catch { /* 무효 파일 스킵 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/**
 * 브랜드 전환 — slug 지정 시 레지스트리에서 활성(brand.yaml)으로 복사, null 이면 범용 모드(활성 해제).
 * 주입부(buildSystemPrompt 등)는 계속 brand.yaml 만 읽으므로 전환 즉시 다음 런부터 반영된다.
 */
export function activateBrand(slug: string | null): BrandProfile | null {
  if (!slug) {
    try { fs.rmSync(brandPath()); } catch { /* 이미 없음 */ }
    reloadBrand();
    return null;
  }
  if (!isSafeBrandSlug(slug)) throw new Error(`무효한 슬러그: ${slug}`);
  // 심층 방어 — 검증을 통과했더라도 최종 경로가 brands/ 안인지 재확인.
  const src = path.resolve(brandsDir(), `${slug}.yaml`);
  if (!src.startsWith(path.resolve(brandsDir()) + path.sep)) throw new Error(`무효한 슬러그: ${slug}`);
  const b = normalizeBrand(YAML.parse(fs.readFileSync(src, 'utf-8'))); // 없으면 throw — 호출부가 404 처리
  if (!b) throw new Error(`무효한 브랜드 파일: ${slug}`);
  fs.copyFileSync(src, brandPath());
  reloadBrand();
  return getBrand();
}

/**
 * 브랜드 삭제 — 레지스트리에서 제거(원본은 brands/.trash/ 로 이동해 복구 여지 보존).
 * 활성 브랜드였다면 범용 모드로 전환. 콘텐츠·성과 파일은 건드리지 않는다(비파괴) —
 * 같은 이름으로 브랜드를 다시 만들면 태그가 같은 슬러그라 자료가 그대로 복귀한다.
 */
export function deleteBrand(slug: string): boolean {
  if (!isSafeBrandSlug(slug)) throw new Error(`무효한 슬러그: ${slug}`);
  const file = path.resolve(brandsDir(), `${slug}.yaml`);
  if (!file.startsWith(path.resolve(brandsDir()) + path.sep)) throw new Error(`무효한 슬러그: ${slug}`);
  if (!fs.existsSync(file)) return false;
  const trash = path.join(brandsDir(), '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(file, path.join(trash, `${slug}-${Date.now()}.yaml`));
  if (activeBrandSlug() === slug) {
    try { fs.rmSync(brandPath()); } catch { /* 이미 없음 */ }
    reloadBrand();
  }
  return true;
}

/** 입력 정규화(순수) — name 없으면 null. 문자열 트림·배열 필터·길이 캡(프롬프트 폭주 방지). */
export function normalizeBrand(raw: Partial<BrandProfile> | null | undefined): BrandProfile | null {
  const name = String(raw?.name ?? '').trim().slice(0, 60);
  if (!name) return null;
  const s = (v: unknown, cap: number): string | undefined => {
    const t = String(v ?? '').trim().slice(0, cap);
    return t || undefined;
  };
  const arr = (v: unknown, cap: number, itemCap = 40): string[] =>
    (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim().slice(0, itemCap)).filter(Boolean).slice(0, cap);
  const products = (Array.isArray(raw?.products) ? raw!.products : [])
    .map((p) => ({
      name: String((p as BrandProduct)?.name ?? '').trim().slice(0, 60),
      features: s((p as BrandProduct)?.features, 200),
      target: s((p as BrandProduct)?.target, 120),
    }))
    .filter((p) => p.name)
    .slice(0, 12);
  return {
    name,
    industry: s(raw?.industry, 60),
    description: s(raw?.description, 300),
    products,
    audience: s(raw?.audience, 200),
    region: s(raw?.region, 100),
    tone: s(raw?.tone, 200),
    banned: arr(raw?.banned, 20, 60),
    seedKeywords: arr(raw?.seedKeywords, 30),
    genreAxes: arr(raw?.genreAxes, 8),
    compoundStems: arr(raw?.compoundStems, 40),
    // YYYY-MM-DD 만 받는다 — 형식이 틀리면 조용히 전체를 거르거나 전혀 안 거르는 사고가 나므로 무시한다.
    perfEraSince: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.perfEraSince ?? '').trim())
      ? String(raw?.perfEraSince).trim() : undefined,
    avoidJargon: (Array.isArray(raw?.avoidJargon) ? raw.avoidJargon as unknown[] : [])
      .map((x) => ({ term: s((x as { term?: unknown })?.term, 20) ?? '', use: s((x as { use?: unknown })?.use, 40) ?? '' }))
      .filter((x) => x.term && x.use)
      .slice(0, 30),
    // 허용 목록은 금지 목록과 **겹치면 안 된다** — 같은 말이 "쓰지 마라"와 "그대로 써라"로 동시에 나가면
    // 작가는 둘 중 아무거나 고른다(가드가 무작위가 된다). avoidJargon 이 이긴다: 명시적 금지가 기본 허용보다 강하다.
    keepTerms: (() => {
      const banned = new Set((Array.isArray(raw?.avoidJargon) ? raw.avoidJargon as unknown[] : [])
        .map((x) => s((x as { term?: unknown })?.term, 20) ?? '').filter(Boolean));
      return arr(raw?.keepTerms, 40).filter((t) => !banned.has(t));
    })(),
    seasonalSubjects: (Array.isArray(raw?.seasonalSubjects) ? raw.seasonalSubjects as unknown[] : [])
      .map((x) => ({
        term: s((x as { term?: unknown })?.term, 20) ?? '',
        months: (Array.isArray((x as { months?: unknown })?.months) ? (x as { months: unknown[] }).months : [])
          .map((m) => Number(m)).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12),
      }))
      .filter((x) => x.term && x.months.length)
      .slice(0, 40),
    speciesCatalog: (Array.isArray(raw?.speciesCatalog) ? raw.speciesCatalog as unknown[] : [])
      .map((g) => ({
        group: s((g as { group?: unknown })?.group, 30) ?? '',
        species: (Array.isArray((g as { species?: unknown })?.species) ? (g as { species: unknown[] }).species : [])
          .map((x) => typeof x === 'string'
            ? { name: x.trim().slice(0, 20) }
            : { name: s((x as { name?: unknown })?.name, 20) ?? '', aliases: arr((x as { aliases?: unknown })?.aliases, 6, 20) })
          .filter((x) => x.name)
          .slice(0, 60),
      }))
      .filter((g) => g.group && g.species.length)
      .slice(0, 12),
    topicThemes: (Array.isArray(raw?.topicThemes) ? raw.topicThemes as unknown[] : [])
      .map((t) => ({
        theme: s((t as { theme?: unknown })?.theme, 30) ?? '',
        seeds: arr((t as { seeds?: unknown })?.seeds, 20, 40),
        match: arr((t as { match?: unknown })?.match, 30, 20),
      }))
      .filter((t) => t.theme && (t.seeds.length || t.match.length))
      .slice(0, 24),
    channel: s(raw?.channel, 200),
    subjectNoun: s(raw?.subjectNoun, 20),
    subjectTraits: s(raw?.subjectTraits, 120),
    subjectStopwords: arr(raw?.subjectStopwords, 80, 20),
    subjectGenericTerms: arr(raw?.subjectGenericTerms, 30, 20),
    keywordExamples: arr(raw?.keywordExamples, 10, 40),
    subjectIntentTerms: arr(raw?.subjectIntentTerms, 80, 20),
    // 정규식은 컴파일이 되는 것만 받는다 — 깨진 패턴이 런타임에 throw 하면 자율 사이클이 통째로 죽는다.
    activityAxes: (Array.isArray(raw?.activityAxes) ? raw.activityAxes as unknown[] : [])
      .map((g) => arr(g, 8, 20))
      .filter((g) => g.length)
      .slice(0, 20),
    subjectAnchorPattern: (() => {
      const v = s(raw?.subjectAnchorPattern, 120);
      if (!v) return undefined;
      try { new RegExp(v, 'u'); return v; } catch { return undefined; }
    })(),
    cardStyle: s(raw?.cardStyle, 40),
  };
}

// ── 업종 어휘 프로필 접근자(2026-09-07) — 코드는 이 함수들만 보고, 낱말은 브랜드 설정이 준다 ─────────
/** 소재 총칭 명사 — 프롬프트의 "대상 ○○" 자리. */
export function subjectNoun(b: BrandProfile | null = getBrand()): string { return b?.subjectNoun || '소재'; }
/** 소재의 시각 특징 축 — 이미지 앵커 지시문. */
export function subjectTraits(b: BrandProfile | null = getBrand()): string { return b?.subjectTraits || '형태·색·크기·재질'; }
/** 업종 표기 — 사실 검증·분류 프롬프트의 역할 문장("너는 ○○ 콘텐츠 …"). */
export function industryLabel(b: BrandProfile | null = getBrand()): string { return b?.industry?.trim() || '이 브랜드'; }
/** 업종 중립 기본 불용어 — 어느 업종에서도 소재 이름일 수 없는 말. */
export const SUBJECT_STOPWORDS_BASE: readonly string[] = [
  '소재', '제품', '상품', '품종', '종류', '관리', '사용', '방법', '추천', '비교', '후기',
  '봄', '여름', '가을', '겨울',
];
/** 소재 별칭 거절·주장 토큰 제외에 쓰는 업종 일반어 = 기본 + 브랜드 설정 + 총칭어. */
export function subjectStopwords(b: BrandProfile | null = getBrand()): string[] {
  return [...new Set([...SUBJECT_STOPWORDS_BASE, ...(b?.subjectStopwords ?? []), ...(b?.subjectGenericTerms ?? [])])];
}
/** 소재 총칭어(브랜드 설정). 미설정=빈 목록 → 총칭 규칙은 생략된다. */
export function subjectGenericTerms(b: BrandProfile | null = getBrand()): string[] { return b?.subjectGenericTerms ?? []; }
/** 주제 제안 프롬프트의 검색어 예시 — 설정 > 시드 키워드 앞 3개 > 빈 목록(예시 문장 생략). */
export function keywordExamples(b: BrandProfile | null = getBrand()): string[] {
  const ex = b?.keywordExamples ?? [];
  return ex.length ? ex : (b?.seedKeywords ?? []).slice(0, 3);
}
/** 업종 중립 검색 의도어 — 어느 업종이든 "정보를 찾는" 검색어에 흔한 말. */
export const SUBJECT_INTENT_BASE: readonly string[] = [
  '방법', '추천', '비교', '가격', '종류', '관리', '시기', '고르', '선택', '후기', '사용법', '차이', '장단점',
  '주의', '준비', '순서', '기준', '체크', '팁', '문제', '해결', '효과', '기간',
];
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 검색 의도어 정규식 = 브랜드 의도어(있으면 그것만) 또는 범용 기본. */
export function subjectIntentRegex(b: BrandProfile | null = getBrand()): RegExp {
  const terms = (b?.subjectIntentTerms?.length ? b.subjectIntentTerms : SUBJECT_INTENT_BASE).map(escapeRe);
  return new RegExp(terms.join('|'));
}
/** 행위 축 동의어 묶음(브랜드 설정). terms[0] 이 표준형. 미설정=빈 목록. */
export function activityAxes(b: BrandProfile | null = getBrand()): Array<{ terms: string[] }> {
  return (b?.activityAxes ?? []).filter((g) => g.length).map((g) => ({ terms: [...g] }));
}
/** 소재 카탈로그의 이름·별칭 → 정식명 표(브랜드 설정 + 소재 사전은 부르는 쪽이 합친다). 긴 이름이 먼저 오게 정렬. */
export function subjectNameTable(b: BrandProfile | null = getBrand()): Array<{ key: string; name: string }> {
  const out: Array<{ key: string; name: string }> = [];
  for (const g of b?.speciesCatalog ?? []) for (const sp of g.species) {
    out.push({ key: sp.name, name: sp.name });
    for (const a of sp.aliases ?? []) out.push({ key: a, name: sp.name });
  }
  return out.filter((x) => x.key).sort((a, c) => c.key.length - a.key.length);
}
/** 소재 앵커 판정기 — 설정 정규식 > 카탈로그 이름·별칭 포함 > null(판정 불가 = 통과시켜라). */
export function subjectAnchorTest(b: BrandProfile | null = getBrand()): ((text: string) => boolean) | null {
  if (b?.subjectAnchorPattern) {
    try { const re = new RegExp(b.subjectAnchorPattern, 'u'); return (t) => re.test(t); } catch { /* normalize 가 걸렀어야 한다 */ }
  }
  const names = (b?.speciesCatalog ?? []).flatMap((g) => g.species.flatMap((sp) => [sp.name, ...(sp.aliases ?? [])])).filter(Boolean);
  if (!names.length) return null;
  return (t) => names.some((n) => t.includes(n));
}

/**
 * 어휘 가드(2026-08-08 어휘 감사) — 코퍼스 34편 감사에서 확정된 29건의 원인 대응. 블로그 작가·
 * 카드/쇼츠 기획자·제목 패키저 공용(org.ts 가드들과 달리 output 도 쓰므로 순환 없는 여기에 둔다).
 * avoid(브랜드 avoidJargon)는 업종 함정어 목록 — 미설정이면 일반 원칙만.
 */
export function lexiconGuide(
  avoid?: Array<{ term: string; use: string }> | null,
  /** 상용어 허용 목록 — ①⑦·lexemeAvoid 의 누적 압력이 업종 일상어까지 밀어내는 것을 막는다(2026-08-28). */
  keep?: string[] | null,
): string {
  return '[어휘 — 일반 독자 눈높이] '
    + '① 일반 독자가 모르는 압축 한자어는 쉬운 말로 풀어 쓴다. 특히 다른 뜻으로 먼저 읽히는 말 금지'
    + '(실측 유출: 방조→범죄로, 시비→싸움으로, 동해→바다로 먼저 읽힌다). '
    + '② 사전에 없는 조어·억지 명사화 금지(실측: "무개화", "첫 식재자들", "네 가지 쉬움"). '
    + '③ 핵심 키워드는 명사구 그대로 자연스럽게 넣는다 — 키워드에 어미를 붙여 동사화하지 마라("소재선별하면" 식 금지). '
    + '④ 요약·마무리에서 서로 무관한 두 내용을 "-고"로 잇지 마라(지시문+설명문 접합 비문 실측). '
    + '조사 결합이 다른 말로 읽히면 어순을 바꿔라("뿌리혹은"→"혹은"으로 오독). '
    + '⑤ 강의 소개투·면책 문구 금지 — "~의 3가지를 배웁니다"·"~실용 가이드입니다"·"어떤 주장도 하지 않습니다" 류'
    + '(본문·메타 설명 모두 — 실측: 가드 후에도 메타에 "배웁니다" 잔존). '
    // 요약투 예시 교체(2026-08-27 말투 감사 권고 2) — 종전 예시("정리했습니다/알아봅니다처럼 블로그 말투로")가
    // 오히려 메타 요약투를 권장해 검색 스니펫·유튜브 설명이 통째로 템플릿이 됐다. 강의 소개투 금지(⑤)는 그대로 유지.
    + '메타 요약투 금지 — "정리했습니다/담았어요/알아봅니다/알아보세요/살펴봅니다/소개합니다" 로 요약·설명을 끝내지 마라. 요약·설명은 "결론 한 줄 + 조건 한 줄" 꼴로 쓴다(예: "겉만 보고 고르면 두 달 안에 후회합니다. 규격표의 두 줄부터 보세요."). '
    // ⑥⑦: 난이도·어투 감사(2026-08-12, 사용자 제보 "갈립니다" 실측 — 두 편에서 4회 반복된 채널 지문) 대응.
    + '⑥ 문어 판정어는 일상어로 — "갈리다/갈라지다"(구별 뜻)→"구분돼요/달라져요", "판별·판가름·가늠"→"가려내다/확인하다", '
    + '"특정하다"→"콕 집어 확인하다", "개체"→"그 하나", "공정"→"과정". '
    + '"~하는 판단도 있습니다"·"~느냐 아니냐" 같은 명사화·논설 종결도 말로 풀어라("~하는 것도 한 방법이에요"). '
    + '⑦ 실무 용어는 처음 나올 때 반 문장으로 풀어라 — "전문어(쉬운 말 풀이)" 꼴 — '
    + '판단 기준·행동 지시 자리에 미해설 용어를 두지 마라(실측: 미해설 용어가 든 지시문이 초보를 세운다). '
    + '같은 작업을 다른 이름으로 바꿔 부르지 마라(실측: 한 글에서 같은 작업을 세 이름으로 혼용).'
    // ⑧ 허용 목록(2026-08-28 사용자 확정) — ①⑦ 과 lexemeAvoid 가 합쳐지면 "한자어=위험" 신호가 돼 업종
    // 상용어까지 우회한다. 실측: "전정" 0회 · "1년에 가위를 몇 번 들 수 있는가"(한국어에 없는 표현).
    // ①⑦ 바로 뒤에 둬 그 압력을 받는 자리에서 곧바로 예외를 세운다 — 떨어뜨리면 앞의 금지가 이긴다.
    + (keep?.length
      ? `\n⑧ 다만 아래는 이 분야 독자에겐 일상어다 — 한자어라는 이유로 우회하지 말고 그대로 써라(①⑦·과사용 어휘 지침보다 이 항목이 우선한다): ${keep.join(', ')}. `
        + '이 말들을 "가위를 들다"·"손이 가다" 같은 완곡한 풀이로 바꾸면 오히려 어색하다(실측: "1년에 가위를 몇 번 들 수 있는가" — 일상에선 "1년에 몇 번 전정하는지"라고 말한다). '
        + '⑦(한 이름으로 통일)은 여기에도 적용된다 — 이 목록에서 하나를 골라 글 전체에서 일관되게 쓰되, 고르는 후보에서 빼지는 마라.'
      : '')
    + (avoid?.length ? `\n다음 말은 본문·제목·카피 어디에도 쓰지 말고 화살표 오른쪽처럼 풀어 쓴다: ${avoid.map((a) => `${a.term}→${a.use}`).join(', ')}` : '');
}

/**
 * 어휘 린트(순수, 2차 방어) — 본문·제목에 남은 함정어(avoidJargon)를 찾는다. 프롬프트 예방(lexiconGuide)이
 * 뚫렸을 때 SEO 리비전 피드백에 교정 항목을 동봉하는 용도(호출부 seoReviseFeedback).
 * 매칭: 함정어 바로 앞이 한글이면 다른 단어의 일부로 본다(실측 함정: '감동해'의 '동해') — 뒤는 허용
 * (조사 결합 '동해가'·복합어 '방조망'도 같은 함정어 계열이라 함께 잡는 게 맞다).
 */
export function lintLexicon(
  text: string, avoid?: Array<{ term: string; use: string }> | null,
): Array<{ term: string; use: string }> {
  if (!avoid?.length || !text) return [];
  return avoid.filter(({ term }) => {
    if (!term) return false;
    for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) {
      const prev = i > 0 ? text[i - 1]! : '';
      if (!/[가-힣]/.test(prev)) return true; // 단어 시작 위치의 등장만 함정어로 판정
    }
    return false;
  });
}

/**
 * 주입용 [브랜드 컨텍스트] 블록(순수) — buildSystemPrompt·microJSON 직행 지점들이 공용.
 * 미설정이면 '' (모든 호출부가 빈 문자열을 안전 처리 → 기존 동작 불변).
 */
export function brandContext(b: BrandProfile | null = getBrand()): string {
  if (!b) return '';
  const lines: string[] = [
    `[브랜드 컨텍스트 — 이 스튜디오는 아래 기업의 콘텐츠를 만든다]`,
    `업체: ${b.name}${b.industry ? ` (${b.industry})` : ''}${b.region ? ` · ${b.region}` : ''}`,
  ];
  if (b.description) lines.push(`소개: ${b.description}`);
  if (b.products.length) {
    lines.push('주요 제품/서비스:');
    for (const p of b.products) {
      lines.push(`- ${p.name}${p.features ? ` — ${p.features}` : ''}${p.target ? ` (타겟: ${p.target})` : ''}`);
    }
  }
  if (b.audience) lines.push(`타겟 고객: ${b.audience}`);
  if (b.channel) lines.push(`채널: ${b.channel}`);
  if (b.tone) lines.push(`톤앤매너: ${b.tone}`);
  if (b.banned?.length) lines.push(`금지: ${b.banned.join(' · ')}`);
  lines.push('콘텐츠는 독자에게 유용한 정보가 우선이며, 제품은 자연스러운 맥락에서만 연결한다(노골적 광고 금지).');
  return lines.join('\n');
}

/** 제품 라인 이름 목록 — subNiche 를 제품 라인으로 제약(성과 EWMA = 제품 라인별 학습)할 때 사용. */
export function brandProductLines(b: BrandProfile | null = getBrand()): string[] {
  return (b?.products ?? []).map((p) => p.name);
}

/** 콜드스타트 시드 키워드 — 성과 winners 가 비었을 때 주제 탐색 출발점. */
export function brandSeedKeywords(b: BrandProfile | null = getBrand()): string[] {
  return b?.seedKeywords ?? [];
}

// ── 브랜드 소재 범위 게이트(2026-07-31, 사용자 "정체성 각인" 요청) ─────────────────
// banned 는 종전 프롬프트 문자열 유도뿐이라 코드 게이트가 없었고, 실제로 나무·묘목 브랜드에서
// 채소·화초 콘텐츠가 계속 생산됐다(실측). banned 프로즈에서 기계 대조용 토큰을 도출해
// 주제 발굴·리서치 미션·예고 등록/이행에서 하드 차단한다.
/** banned 프로즈 → 대조 토큰(순수). 브랜드의 정상 소재어와 겹칠 수 있는 범용어는 제외. */
// 업종 중립 기본 — banned 프로즈의 문장 성분. 브랜드의 정상 소재어(원예라면 나무·묘목·식물·화분·꽃·모종 —
// 실측 2026-08-01: '모종'이 새어 "8월 과실나무 모종…" 류를 기각했다)는 subjectGenericTerms·subjectStopwords 가 준다.
const SCOPE_STOPWORDS_BASE = ['주제', '콘텐츠', '브랜드', '무관', '금지', '등', '및', '아닌', '봄', '여름', '가을', '겨울'];
function scopeStopwords(b: BrandProfile | null): Set<string> {
  return new Set([...SCOPE_STOPWORDS_BASE, ...(b?.subjectGenericTerms ?? []), ...(b?.subjectStopwords ?? [])]);
}
export function bannedTopicTerms(b: BrandProfile | null = getBrand()): string[] {
  // 조사 붙은 형태("나무가"·"브랜드와")가 토큰으로 새면 정상 소재("배롱나무 가을…")를 오탐한다(실측) —
  // 토큰 자체 또는 끝 한 글자(조사) 뗀 형태가 스톱워드면 제외.
  const SCOPE_STOPWORDS = scopeStopwords(b);
  const isStop = (t: string): boolean => SCOPE_STOPWORDS.has(t) || (t.length > 2 && SCOPE_STOPWORDS.has(t.slice(0, -1)));
  const out = new Set<string>();
  for (const s of b?.banned ?? []) {
    for (const tok of s.split(/[^가-힣a-zA-Z0-9]+/)) {
      const t = tok.trim();
      if (t.length >= 2 && !isStop(t)) out.add(t);
    }
  }
  return [...out];
}
/** 텍스트(제목·키워드)가 금지 소재를 담으면 걸린 토큰, 아니면 null(순수 — 공백 무시 부분일치). */
export function offBrandTerm(text: string, b: BrandProfile | null = getBrand()): string | null {
  const hay = (text || '').replace(/\s+/g, '');
  if (!hay) return null;
  for (const t of bannedTopicTerms(b)) {
    if (hay.includes(t.replace(/\s+/g, ''))) return t;
  }
  return null;
}
