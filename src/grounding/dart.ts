/**
 * DART(전자공시·OpenDART) 커넥터 — DART_API_KEY(crtfc_key) 설정 시 활성.
 * 주제에 등장하는 기업명을 corpCode 로 매핑해 기업개황(상장·대표·업종·결산월 등)을 그라운딩 주입.
 * corpCode 매핑은 최초 1회 OpenDART 에서 받아 data/dart_corpcodes.json 에 캐시.
 * 회사명이 매칭될 때만 주입되므로(자기제한), 비기업 주제에는 자연히 비활성.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { unzip } from '../util/unzip';
import { registerConnector } from './registry';

const KEY = 'DART_API_KEY';
function isDartEnabled(): boolean { return !!getSecret(KEY); }

let _corp: Map<string, string> | null = null; // 회사명 → corp_code(8자리)
const corpFile = (): string => path.join(CONFIG.dataDir, 'dart_corpcodes.json');
const _groundCache = new Map<string, string>();

async function ensureCorpCodes(signal?: AbortSignal): Promise<Map<string, string>> {
  if (_corp) return _corp;
  // 디스크 캐시 우선
  try {
    const j = JSON.parse(fs.readFileSync(corpFile(), 'utf-8')) as Record<string, string>;
    _corp = new Map(Object.entries(j));
    return _corp;
  } catch { /* 없으면 다운로드 */ }
  const key = getSecret(KEY);
  if (!key) { _corp = new Map(); return _corp; }
  try {
    const r = await fetchTimeout(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`, {}, signal, Math.max(CONFIG.groundingTimeoutMs, 30_000));
    const buf = Buffer.from(await r.arrayBuffer());
    const files = unzip(buf);
    let xml = '';
    for (const [name, b] of files) if (/CORPCODE\.xml$/i.test(name) || /\.xml$/i.test(name)) { xml = b.toString('utf-8'); break; }
    const map = new Map<string, string>();
    const re = /<corp_code>(\d{8})<\/corp_code>\s*<corp_name>([^<]+)<\/corp_name>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const nm = (m[2] ?? '').trim();
      if (nm.length >= 3) map.set(nm, m[1]!); // 너무 짧은 이름은 오매칭 방지로 제외
    }
    _corp = map;
    try { fs.writeFileSync(corpFile(), JSON.stringify(Object.fromEntries(map))); } catch { /* 캐시 실패 무해 */ }
    return map;
  } catch { _corp = new Map(); return _corp; }
}

async function dartGround(query: string, signal?: AbortSignal): Promise<string> {
  if (!isDartEnabled() || !query.trim()) return '';
  const ck = query.trim().slice(0, 80);
  const hit = _groundCache.get(ck);
  if (hit !== undefined) return hit;
  const key = getSecret(KEY)!;
  let text = '';
  try {
    const map = await ensureCorpCodes(signal);
    if (map.size) {
      // 주제에 등장하는 회사명(긴 이름=구체적 우선, 최대 2개)
      const names = [...map.keys()].filter((n) => query.includes(n)).sort((a, b) => b.length - a.length).slice(0, 2);
      const parts: string[] = [];
      for (const n of names) {
        try {
          const r = await fetchTimeout(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${encodeURIComponent(key)}&corp_code=${map.get(n)}`, {}, signal);
          const j = await r.json() as Record<string, string>;
          if (j.status === '000') {
            parts.push(`· ${j.corp_name}${j.stock_code ? `(상장 ${j.stock_code})` : '(비상장)'} 대표:${j.ceo_nm || '-'} 업종코드:${j.induty_code || '-'} 설립:${j.est_dt || '-'} 결산:${j.acc_mt || '-'}월 주소:${(j.adres || '').slice(0, 30)}`);
          }
        } catch { /* 개별 실패 무시 */ }
      }
      text = parts.join('\n').slice(0, 800);
    }
  } catch { text = ''; }
  _groundCache.set(ck, text);
  return text;
}

registerConnector({
  id: 'dart',
  keyDef: {
    key: KEY,
    label: 'DART (전자공시)',
    icon: '📊',
    desc: 'OpenDART 기업 공시·개황 조회. 설정 시 주제에 등장하는 기업의 공시정보 자동 주입',
    placeholder: 'OpenDART 인증키(crtfc_key)',
  },
  blockLabel: '[기업 공시(DART)]',
  scope: 'global', // 회사명이 매칭될 때만 주입돼 자기제한됨(비기업 주제엔 비활성)
  enabled: isDartEnabled,
  ground: dartGround,
});
