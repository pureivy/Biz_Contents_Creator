/**
 * 콘텐츠 전략(data/analytics/strategy.json) — 실측 성과의 EWMA 누적. 키워드/서브니치 점수를 유지하고,
 * scheduler.proposeContentIdeas 가 [성과 상위 키워드]로 읽어 다음 기획을 조향한다(compounding 루프의 상태).
 * 콜드스타트(측정 piece < N)는 탐색(다양화), 이후 exploit — proposeContentIdeas 프롬프트가 이 신호를 반영.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { isSafeBrandSlug } from '../content/brand';

export interface KeywordScore {
  keyword: string; score: number; samples: number;
  /** 마지막 측정 시각 — 재측정마다 갱신된다(신선도). 시대 구분에 쓰면 안 된다. */
  updatedAt: string;
  /**
   * 이 키워드가 winners 에 **처음 들어온** 시각 — 재측정에도 불변(시대 스탬프).
   * 브랜드 정체성이 바뀌면 그 이전에 쌓인 성과는 지금 정체성의 근거가 아니다. 그걸 걸러내려면
   * '언제 측정됐나'가 아니라 '어느 시대 콘텐츠인가'가 필요한데, updatedAt 은 측정창(14일) 안에서
   * 매일 갱신돼 컷오프를 스스로 무너뜨린다(실측 2026-08-01: 화분곰팡이·반려동물 안전한 식물이
   * 07-27 갱신 상태라 하루만 지나면 어떤 컷오프든 통과). 구파일은 읽기 시 updatedAt 으로 백필.
   */
  firstSeenAt?: string;
}
export interface Strategy {
  winners: KeywordScore[];
  subNiches: Record<string, number>;
  measuredPieces: number;
  updatedAt: string;
}

const EWMA_ALPHA = 0.3;      // 최신 성과 반영률(과거 0.7 유지) — 수주 지연·교란 신호라 급변동 억제.
const COLD_START_N = 12;     // 측정 piece 이 이만큼 쌓이기 전까진 탐색(다양화) 우선.
const MAX_WINNERS = 50;

// 브랜드(고객사)별 전략 분리 — slug 없으면 종전 파일(범용 모드 하위 호환).
// brand 는 파일명에 들어가므로 안전 슬러그만 통과(손편집된 piece.brand 등의 경로 탈출 차단).
function strategyFile(brand = ''): string {
  if (brand && !isSafeBrandSlug(brand)) throw new Error(`무효한 브랜드 슬러그: ${brand}`);
  return path.join(CONFIG.dataDir, 'analytics', brand ? `strategy-${brand}.json` : 'strategy.json');
}

export function readStrategy(brand = ''): Strategy {
  try {
    const s = JSON.parse(fs.readFileSync(strategyFile(brand), 'utf-8')) as Partial<Strategy>;
    return {
      // firstSeenAt 백필 — 이 필드 도입(2026-08-01) 전 항목은 updatedAt 이 유일한 시각 정보다.
      // 지금 시점의 updatedAt 은 '측정창 안에서 마지막으로 갱신된 때'라 정확한 최초 등장은 아니지만,
      // 한 번 굳으면 이후 재측정에 흔들리지 않으므로 컷오프가 안정된다.
      winners: (Array.isArray(s.winners) ? s.winners : [])
        .map((w) => ({ ...w, firstSeenAt: w.firstSeenAt || w.updatedAt })),
      subNiches: (s.subNiches && typeof s.subNiches === 'object') ? s.subNiches : {},
      measuredPieces: typeof s.measuredPieces === 'number' ? s.measuredPieces : 0,
      updatedAt: s.updatedAt ?? '',
    };
  } catch { return { winners: [], subNiches: {}, measuredPieces: 0, updatedAt: '' }; }
}

function writeStrategy(s: Strategy, brand = ''): void {
  try {
    const file = strategyFile(brand);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // 원자적 교체.
  } catch { /* 영속 실패 무해 */ }
}

/**
 * 성과 신호로 EWMA 갱신 — 키워드/서브니치 1차 귀속(작가 등 에이전트 2차·약: reinforce 에서 별도).
 * measuredPieces 증가(incMeasured)는 **piece 당 정확히 1회**만 호출자가 보장(멱등 — reinforce stage 게이트).
 */
export function updateStrategy(input: { keyword?: string; subNiche?: string; signal: number; incMeasured?: boolean; brand?: string }): Strategy {
  const s = readStrategy(input.brand ?? '');
  const now = new Date().toISOString();
  const kw = input.keyword?.trim();
  if (kw) {
    const w = s.winners.find((x) => x.keyword === kw);
    if (w) { w.score = EWMA_ALPHA * input.signal + (1 - EWMA_ALPHA) * w.score; w.samples += 1; w.updatedAt = now; }
    else s.winners.push({ keyword: kw, score: input.signal, samples: 1, updatedAt: now, firstSeenAt: now });
    s.winners.sort((a, b) => b.score - a.score);
    if (s.winners.length > MAX_WINNERS) s.winners = s.winners.slice(0, MAX_WINNERS);
  }
  const sn = input.subNiche?.trim();
  if (sn) {
    const prev = s.subNiches[sn];
    s.subNiches[sn] = prev != null ? EWMA_ALPHA * input.signal + (1 - EWMA_ALPHA) * prev : input.signal;
  }
  if (input.incMeasured) s.measuredPieces += 1;
  s.updatedAt = now;
  writeStrategy(s, input.brand ?? '');
  return s;
}

/** 콜드스타트 여부 — 측정 piece 이 임계 미만이면 탐색(다양화) 국면. */
export function isColdStart(brand = ''): boolean { return readStrategy(brand).measuredPieces < COLD_START_N; }
