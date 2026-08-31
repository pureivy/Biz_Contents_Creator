/**
 * 네이버 검색광고(SearchAd) 키워드도구 커넥터 — 실제 월간 검색량 + 경쟁지수.
 * 활성: NAVER_SEARCHAD_API_KEY + NAVER_SEARCHAD_SECRET_KEY + NAVER_SEARCHAD_CUSTOMER_ID.
 * 발급: https://searchad.naver.com → 도구 → API 사용 관리 (광고비 불필요).
 *
 * 인증(HMAC-SHA256): message = `${timestamp}.${method}.${uri}` (uri=쿼리 제외 경로),
 *   signature = Base64(HMAC-SHA256(message, secretKey)). 헤더 X-Timestamp/X-API-KEY/X-Customer/X-Signature.
 */
import crypto from 'node:crypto';
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { registerConnector } from './registry';
import { seedKeyword, toInt, GROUND_CAP } from './naver_common';

const APIKEY = 'NAVER_SEARCHAD_API_KEY';
const SECRET = 'NAVER_SEARCHAD_SECRET_KEY';
const CUSTOMER = 'NAVER_SEARCHAD_CUSTOMER_ID';
const BASE = 'https://api.searchad.naver.com';

export function searchAdEnabled(): boolean {
  return !!getSecret(APIKEY) && !!getSecret(SECRET) && !!getSecret(CUSTOMER);
}

function sign(timestamp: string, method: string, uri: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${method}.${uri}`).digest('base64');
}

export interface KeywordVolume {
  keyword: string;
  pc: number;          // 월간 PC 검색수 — "< 10"(10 미만) 응답은 0 으로 취급(하한 불명, 과대평가 방지)
  mobile: number;      // 월간 모바일 검색수 — 위와 동일
  total: number;       // pc + mobile
  comp: string;        // 경쟁정도(낮음/중간/높음)
  pcApprox: boolean;    // pc 가 "10 미만" 표기였나(정확값 아님 — 표시·판단 시 구분 필요)
  mobileApprox: boolean;
}

// 네이버 키워드도구는 월 10 미만 검색량을 숫자가 아니라 "< 10" 문자열로 준다. 일반 숫자 파서(toInt)로
// 이 문자열의 숫자만 뽑으면 10 으로 둔갑해 "월 20회(PC10+모바일10)" 같은 가짜 실측값이 된다(실측
// 2026-07-28 — SEO 전략가가 이 가짜 20회를 근거로 사실상 검색되지 않는 표현을 계속 선정했다).
// "10 미만"은 진짜 값이 0~9 중 어디인지 알 수 없으므로 0(가장 보수적인 하한)으로 두고, approx 플래그로
// "정확값 아님"을 downstream(ground 문구·정렬)에 전달한다.
export function toVolume(v: unknown): { value: number; approx: boolean } {
  if (typeof v === 'string' && v.trim().startsWith('<')) return { value: 0, approx: true };
  return { value: toInt(v), approx: false };
}

/**
 * 힌트 키워드로 연관 키워드 + 월간 검색량·경쟁도 조회. discover 파이프라인·ground() 공용.
 * hintKeywords 는 공백 없는 키워드(최대 5개). 실패 시 []. (연관어 포함 다수 반환 → total 내림차순)
 */
export async function searchAdVolumes(hints: string[], signal?: AbortSignal): Promise<KeywordVolume[]> {
  if (!searchAdEnabled()) return [];
  const seeds = hints.map((h) => h.replace(/\s+/g, '')).filter(Boolean).slice(0, 5);
  if (!seeds.length) return [];
  const uri = '/keywordstool';
  const ts = Date.now().toString();
  const sig = sign(ts, 'GET', uri, getSecret(SECRET)!);
  const url = `${BASE}${uri}?hintKeywords=${encodeURIComponent(seeds.join(','))}&showDetail=1`;
  const r = await fetchTimeout(url, {
    headers: {
      'X-Timestamp': ts,
      'X-API-KEY': getSecret(APIKEY)!,
      'X-Customer': getSecret(CUSTOMER)!,
      'X-Signature': sig,
    },
  }, signal);
  if (!r.ok) {
    // 인증 실패(잘린 키 등)가 '무응답'으로 오인되지 않게 서버 로그에 원인 노출(2026-07-22 실사고:
    // .env 세 자격증명이 앞 2자만 남아 403인데 직원은 '절대검색량 확보 불가'로만 보고).
    const body = await r.text().catch(() => '');
    console.log(`[searchad] keywordstool HTTP ${r.status} — ${body.slice(0, 120) || '응답 없음'}${r.status === 401 || r.status === 403 ? ' (키 설정 확인: searchad.naver.com → 도구 → API 사용 관리)' : ''}`);
    return [];
  }
  const j = await r.json() as { keywordList?: Array<{ relKeyword?: string; monthlyPcQcCnt?: unknown; monthlyMobileQcCnt?: unknown; compIdx?: string }> };
  return (j.keywordList ?? [])
    .map((k) => {
      const pc = toVolume(k.monthlyPcQcCnt);
      const mobile = toVolume(k.monthlyMobileQcCnt);
      return {
        keyword: (k.relKeyword ?? '').trim(), pc: pc.value, mobile: mobile.value, total: pc.value + mobile.value,
        comp: (k.compIdx ?? '').trim() || '-', pcApprox: pc.approx, mobileApprox: mobile.approx,
      };
    })
    .filter((k) => k.keyword)
    .sort((a, b) => b.total - a.total);
}

/** "10 미만"이면 정확한 숫자 대신 그 사실을 그대로 문구로 남긴다 — 가짜 정밀도(예: "20회")를 만들지 않는다. */
export function fmtVolume(n: number, approx: boolean): string {
  return approx ? '10미만' : n.toLocaleString();
}

async function ground(query: string, signal?: AbortSignal): Promise<string> {
  if (!searchAdEnabled()) return '';
  const seed = seedKeyword(query);
  try {
    const vols = await searchAdVolumes([seed], signal);
    if (!vols.length) return '';
    const rows = vols.slice(0, 8).map((v) => {
      // PC·모바일 둘 다 10 미만이면 총량도 진짜 숫자가 아니라 "사실상 검색되지 않는다"는 판단 자체를
      // 명시해 SEO 전략가가 이런 키워드를 실검색량 있는 것처럼 선정하지 않게 한다.
      const total = v.pcApprox && v.mobileApprox ? '10미만(사실상 무의미)' : `${v.total.toLocaleString()}회`;
      return `· ${v.keyword} — 월 ${total}(PC ${fmtVolume(v.pc, v.pcApprox)}/모바일 ${fmtVolume(v.mobile, v.mobileApprox)}), 경쟁 ${v.comp}`;
    }).join('\n');
    return `검색광고 실검색량 — 시드 "${seed}"의 연관 키워드(월간 검색수·경쟁도):\n${rows}`.slice(0, GROUND_CAP);
  } catch { return ''; }
}

registerConnector({
  id: 'naver_searchad',
  keyDef: {
    key: APIKEY,
    label: '네이버 검색광고 — 액세스 라이선스',
    icon: '📈',
    desc: '검색광고 키워드도구(실제 월간 검색량·경쟁도). 비밀키·고객번호와 셋 다 설정해야 활성',
    placeholder: 'SearchAd 액세스 라이선스',
  },
  // 검색광고 API 는 자격증명이 3개 — 카드도 3장 전부 노출(비밀키·고객번호가 UI 에서 빠져 있던 갭 보완).
  keyDefs: [
    {
      key: APIKEY,
      label: '네이버 검색광고 — 액세스 라이선스',
      icon: '📈',
      desc: '검색광고 키워드도구(실제 월간 검색량·경쟁도). 비밀키·고객번호와 셋 다 설정해야 활성',
      placeholder: 'SearchAd 액세스 라이선스',
    },
    {
      key: SECRET,
      label: '네이버 검색광고 — 비밀키',
      icon: '📈',
      desc: '검색광고 API 비밀키(Secret Key) — HMAC 서명에 사용',
      placeholder: 'SearchAd 비밀키',
    },
    {
      key: CUSTOMER,
      label: '네이버 검색광고 — 고객번호',
      icon: '📈',
      desc: '검색광고 계정의 CUSTOMER_ID(숫자)',
      placeholder: '예: 1234567',
    },
  ],
  blockLabel: '[검색광고 실검색량]',
  scope: ['naver_searchad'], // SEO 역할(naver_searchad 툴 보유)에만 주입
  enabled: searchAdEnabled,
  ground,
});
