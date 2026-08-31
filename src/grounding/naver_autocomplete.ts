/**
 * 네이버 자동완성(연관 검색어) 커넥터 — 키 불필요(비공식 엔드포인트).
 * 용도: 시드 키워드의 연관·확장 검색어 채굴(콜드스타트 키워드 발굴). 비공식이라 fail-open('').
 * (ac.search.naver.com/nx/ac — 언제든 형식이 바뀔 수 있으니 방어적 파싱 + 실패 무해.)
 */
import { fetchTimeout } from '../util/fetch';
import { registerConnector } from './registry';
import { seedKeyword, GROUND_CAP } from './naver_common';

/** 시드 → 연관 검색어 목록(비공식). 실패 시 []. */
export async function naverAutocomplete(seed: string, signal?: AbortSignal): Promise<string[]> {
  const q = seed.trim();
  if (!q) return [];
  const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(q)}&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&st=100`;
  try {
    const r = await fetchTimeout(url, { headers: { Referer: 'https://www.naver.com/' } }, signal, 6000);
    if (!r.ok) return [];
    const j = await r.json() as { items?: unknown };
    // items: [[[kw, ...], [kw, ...]], ...] 형태 — 방어적으로 문자열 첫 요소만 수집.
    const out: string[] = [];
    const groups = Array.isArray(j.items) ? j.items : [];
    for (const g of groups) {
      if (!Array.isArray(g)) continue;
      for (const row of g) {
        const kw = Array.isArray(row) ? row[0] : row;
        if (typeof kw === 'string' && kw.trim() && kw.trim() !== q) out.push(kw.trim());
      }
    }
    return [...new Set(out)].slice(0, 15);
  } catch { return []; }
}

async function ground(query: string, signal?: AbortSignal): Promise<string> {
  const seed = seedKeyword(query);
  try {
    const related = await naverAutocomplete(seed, signal);
    if (!related.length) return '';
    return `연관 검색어(자동완성) — "${seed}":\n${related.slice(0, 12).map((k) => `· ${k}`).join('\n')}`.slice(0, GROUND_CAP);
  } catch { return ''; }
}

registerConnector({
  id: 'naver_autocomplete',
  keyDef: {
    key: 'NAVER_AUTOCOMPLETE', // 키 불필요 — 항상 활성. UI 카드는 표시용(값 없어도 동작).
    label: '네이버 자동완성 (연관어)',
    icon: '🔎',
    desc: '연관 검색어 채굴(키 불필요·비공식). 항상 활성',
    placeholder: '(키 불필요)',
  },
  blockLabel: '[연관 검색어(자동완성)]',
  scope: ['naver_autocomplete'],
  enabled: () => true, // 키 불필요
  ground,
});
