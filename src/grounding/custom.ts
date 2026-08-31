/**
 * 선언형(설정 기반) 커넥터 엔진 — data/connectors.json 의 설정만으로 외부 REST API 를 그라운딩.
 * 코드 작성 없이 UI(또는 AI 자동설정)가 만든 설정을 그대로 실행한다. 안전: 코드 생성·실행 없음,
 * HTTP fetch + 선언적 추출(JSON 경로/정규식/텍스트)만 수행.
 *
 * 설정 1건 = 커넥터 1개. {key},{query} 플레이스홀더를 엔드포인트 URL 에 치환해 호출.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { getSecret } from '../secrets/store';
import { fetchTimeout } from '../util/fetch';
import { assertPublicHttpsUrl } from '../util/ssrf';
import { setCustomProvider, type GroundingConnector } from './registry';

export interface ExtractRule {
  /** 'json' = itemsPath 배열에서 fields 추출 · 'regex' = pattern 캡처 · 'text' = 원문 절단. */
  type: 'json' | 'regex' | 'text';
  itemsPath?: string;   // 예: 'response.body.items.item' (점 경로; 배열이면 순회)
  fields?: string[];    // 각 항목에서 뽑을 필드(점 경로)
  regex?: string;       // type=regex 일 때
  max?: number;         // 결과 총 길이 캡(기본 800)
  limit?: number;       // 항목 수 캡(기본 5)
}
export interface CustomConnectorCfg {
  id: string;           // kebab-case 영문
  keyName: string;      // 시크릿 키 이름(예: 'KOSIS_API')
  label: string; icon: string; desc: string;
  endpoint: string;     // {key},{query} 치환. 예: https://api...?key={key}&q={query}
  method?: 'GET';       // 현재 GET 만(안전)
  blockLabel: string;   // 프롬프트 주입 블록 머리말
  scope: 'global' | string[];
  extract: ExtractRule;
}
interface Store { connectors: CustomConnectorCfg[] }

const FILE = (): string => path.join(CONFIG.dataDir, 'connectors.json');
let _cache: Store | null = null;
function load(): Store {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as Store; if (!Array.isArray(_cache.connectors)) _cache = { connectors: [] }; }
  catch { _cache = { connectors: [] }; }
  return _cache;
}
function save(s: Store): void {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(s, null, 2), 'utf-8');
  _cache = s;
}
export function listCustomConfigs(): CustomConnectorCfg[] { return load().connectors; }
export function saveCustomConfig(cfg: CustomConnectorCfg): { ok: boolean; error?: string } {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(cfg.id || '')) return { ok: false, error: 'id 는 영소문자·숫자·하이픈(예: kosis-search).' };
  if (!cfg.keyName || !cfg.endpoint || !cfg.endpoint.includes('{query}')) return { ok: false, error: 'keyName·endpoint 필요(endpoint 에 {query} 포함).' };
  // extract.type 안전 보정(LLM·사용자가 미지원 타입을 넣어도 깨지지 않게).
  if (!cfg.extract || !['json', 'regex', 'text'].includes(cfg.extract.type)) cfg.extract = { ...(cfg.extract ?? {}), type: 'text' };
  const s = load();
  const i = s.connectors.findIndex((c) => c.id === cfg.id);
  if (i >= 0) s.connectors[i] = cfg; else s.connectors.push(cfg);
  save(s);
  return { ok: true };
}
export function deleteCustomConfig(id: string): { ok: boolean } {
  const s = load();
  s.connectors = s.connectors.filter((c) => c.id !== id);
  save(s);
  return { ok: true };
}

/** 점 경로로 중첩값 탐색(배열이면 그대로 반환). */
function dig(obj: unknown, p?: string): unknown {
  if (!p) return obj;
  return p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function asText(v: unknown): string { return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }

/** 정규식 소스 안전성 휴리스틱(순수) — 과장 길이·중첩 수량자(치명적 백트래킹) 거부. ReDoS 완화. */
export function isSafeRegexSource(src: string): boolean {
  if (typeof src !== 'string' || src.length > 200) return false;
  // (…+)+ / (…*)* / (…+)* 류 중첩 수량자 — 지수 백트래킹의 전형.
  if (/\([^)]*[+*][^)]*\)[+*]/.test(src)) return false;
  return true;
}

/** 설정대로 응답에서 텍스트 추출. */
function applyExtract(raw: string, ex: ExtractRule): string {
  const max = ex.max ?? 800, limit = ex.limit ?? 5;
  if (ex.type === 'regex' && ex.regex) {
    // ReDoS 완화 — 위험 패턴(중첩 수량자)·과장 소스는 거부하고, 입력을 8KB 로 캡, 매칭 진행 실패 시 강제 전진.
    if (!isSafeRegexSource(ex.regex)) return '';
    try {
      const re = new RegExp(ex.regex, 'g'); const out: string[] = []; let m: RegExpExecArray | null;
      const input = raw.slice(0, 8000);
      let guard = 0;
      while ((m = re.exec(input)) !== null && out.length < limit && guard++ < 1000) {
        out.push((m[1] ?? m[0]).trim());
        if (m.index === re.lastIndex) re.lastIndex++; // 영길이 매칭 무한루프 방지
      }
      return out.join('\n').slice(0, max);
    } catch { return ''; }
  }
  if (ex.type === 'json') {
    try {
      const json = JSON.parse(raw);
      let items = dig(json, ex.itemsPath);
      if (!Array.isArray(items)) items = items != null ? [items] : [];
      const arr = (items as unknown[]).slice(0, limit);
      const lines = arr.map((it) => (ex.fields?.length ? ex.fields.map((f) => `${f.split('.').pop()}:${asText(dig(it, f))}`).join(' · ') : asText(it)));
      return lines.join('\n').slice(0, max);
    } catch { return raw.slice(0, max); }
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, max);
}

const _groundCache = new Map<string, string>();
/** 설정 1건 실행 — 키·쿼리 치환 → fetch → 추출. 미설정·실패 시 ''. */
export async function runCustomConnector(cfg: CustomConnectorCfg, query: string, signal?: AbortSignal): Promise<string> {
  const key = getSecret(cfg.keyName);
  if (!key || !query.trim()) return '';
  const ck = `${cfg.id}:${query.trim().slice(0, 80)}`;
  const hit = _groundCache.get(ck);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    const url = cfg.endpoint
      .replace(/\{key\}/g, encodeURIComponent(key))
      .replace(/\{query\}/g, encodeURIComponent(query.slice(0, 60)));
    // SSRF·시크릿 유출 가드 — {key}(시크릿)가 URL 에 실리므로, https 공개 호스트가 아니면 fetch 자체를 막는다.
    const safe = await assertPublicHttpsUrl(url);
    if (!safe.ok) { _groundCache.set(ck, ''); return ''; }
    const r = await fetchTimeout(url, { method: 'GET' }, signal);
    const raw = (await r.text()).slice(0, 20000);
    text = applyExtract(raw, cfg.extract);
  } catch { text = ''; }
  _groundCache.set(ck, text);
  return text;
}

function cfgToConnector(cfg: CustomConnectorCfg): GroundingConnector {
  return {
    id: cfg.id,
    keyDef: { key: cfg.keyName, label: cfg.label || cfg.id, icon: cfg.icon || '🔌', desc: cfg.desc || '사용자 연동(AI 자동설정)', placeholder: 'API 키' },
    blockLabel: cfg.blockLabel || `[${cfg.label || cfg.id}]`,
    scope: cfg.scope || 'global',
    enabled: () => !!getSecret(cfg.keyName),
    ground: (q, s) => runCustomConnector(cfg, q, s),
  };
}

// 동적 커넥터 제공 — connectors() 호출 때마다 설정을 live 로 반영(저장 즉시 적용, 재시작 불필요).
setCustomProvider(() => listCustomConfigs().map(cfgToConnector));

// ---- AI 자동설정 ----
import { llm } from '../llm/client';
import { resolveAssignment } from '../llm/setting';

/** 텍스트에서 첫 JSON 객체를 관대하게 파싱(format:json 응답용 — 순환 import 회피로 자체 구현). */
function parseFirstJson<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { /* 펜스/머리말 제거 시도 */ }
  const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)) as T; } catch { return null; } }
  return null;
}

/** HTML/텍스트 문서를 거칠게 평문화(태그·스크립트 제거). */
function htmlToText(s: string): string {
  return s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * AI 자동설정 — API 이름(+선택 문서 URL)으로 Claude(heavy)가 선언형 설정을 제안.
 * 코드를 생성·실행하지 않고 '설정(JSON)'만 만든다. 저장 전 반드시 테스트로 검증할 것.
 */
export async function autoConfigConnector(
  input: { keyName: string; apiName: string; docsUrl?: string; signal?: AbortSignal },
): Promise<CustomConnectorCfg | null> {
  let docs = '';
  if (input.docsUrl) {
    try {
      const safe = await assertPublicHttpsUrl(input.docsUrl); // SSRF 가드 — 내부망·평문 문서 URL 차단
      if (safe.ok) {
        const r = await fetchTimeout(input.docsUrl, {}, input.signal);
        docs = htmlToText(await r.text()).slice(0, 5000);
      }
    } catch { /* 문서 없이도 진행 */ }
  }
  const heavy = resolveAssignment().heavy;
  const sys =
    '너는 외부 REST API 연동 설정 생성기다. 주어진 API 를 "검색어로 호출해 결과를 받는" 선언형 설정(JSON)을 만든다. ' +
    '엔드포인트 URL 에서 인증키 자리는 {key}, 검색어 자리는 {query} 로 표기한다. 실제 동작하는 정확한 경로·파라미터명을 써라.';
  const user =
    `API 이름: ${input.apiName}\n키 파라미터(시크릿): ${input.keyName}\n` +
    (docs ? `\n[API 문서 발췌]\n${docs}\n` : '') +
    '\nJSON 만 출력:\n' +
    '{"id":"kebab-id","label":"한글 이름","icon":"📈","desc":"한 줄 설명","endpoint":"https://.../api?serviceKey={key}&numOfRows=5&keyword={query}","blockLabel":"[표시 머리말]","scope":"global","extract":{"type":"json","itemsPath":"response.body.items.item","fields":["title","pblancNm"]}}\n' +
    'extract.type 은 반드시 "json"|"regex"|"text" 중 하나(다른 값 금지). 응답이 JSON 이면 "json"(itemsPath=결과배열 점경로, fields=뽑을 필드들), XML/텍스트면 "regex"(regex=한 항목을 잡는 정규식, 캡처그룹 1개), 불확실하면 "text". 정확한 실제 엔드포인트·파라미터명을 쓰고, 추측이면 "text"로 안전하게.';
  try {
    const res = await llm.chat({
      model: heavy,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      maxOutputTokens: 800, temperature: 0.2, format: 'json', signal: input.signal,
    });
    const cfg = parseFirstJson<CustomConnectorCfg>(res.text);
    if (!cfg || !cfg.endpoint || !cfg.endpoint.includes('{query}')) return null;
    // keyName 강제(사용자 입력 우선) + 기본값 보정.
    cfg.keyName = input.keyName;
    cfg.id = (cfg.id || input.keyName.toLowerCase().replace(/_/g, '-')).replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'custom-api';
    cfg.method = 'GET';
    cfg.scope = cfg.scope || 'global';
    cfg.blockLabel = cfg.blockLabel || `[${cfg.label || cfg.id}]`;
    cfg.extract = cfg.extract || { type: 'text' };
    return cfg;
  } catch { return null; }
}
