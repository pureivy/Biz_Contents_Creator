/**
 * 법제처(국가법령정보) MCP 클라이언트 — korean-law-mcp 원격 HTTP 서버 연결.
 * API 키 패널의 LAW_API_KEY(=법제처 OC)가 설정되면 활성화되어, 모든 직원의 작업 그라운딩에
 * 관련 법령을 자동 주입한다(wiki·web 과 동일 패턴). 키가 없으면 비활성(graceful, 런 무중단).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getSecret } from '../secrets/store';
import { CONFIG } from '../config';

const ENDPOINT = 'https://korean-law-mcp.fly.dev/mcp';

let _client: Client | null = null;
let _connectedOc = '';
let _tools: string[] = [];
const _groundCache = new Map<string, string>(); // 주제 → 검색결과(런 내 재호출 방지)

/** LAW_API_KEY(법제처 OC)가 설정돼 있으면 서비스 활성. */
export function isLawEnabled(): boolean {
  return !!getSecret('LAW_API_KEY');
}

async function getClient(): Promise<Client | null> {
  const oc = getSecret('LAW_API_KEY') ?? '';
  if (!oc) return null;
  if (_client && _connectedOc === oc) return _client;
  if (_client) { try { await _client.close(); } catch { /* */ } _client = null; }
  try {
    const client = new Client({ name: 'ai-contents-studio', version: '1.0.0' }, { capabilities: {} });
    // 연결에도 타임아웃 — 원격 MCP 서버 무응답 시 connect 가 무한 대기하지 않게(타임아웃 시 미연결로 폴백).
    const connect = client.connect(new StreamableHTTPClientTransport(new URL(`${ENDPOINT}?oc=${encodeURIComponent(oc)}`)));
    const timer = new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error('MCP 연결 타임아웃')), CONFIG.groundingTimeoutMs);
      if (typeof t.unref === 'function') t.unref();
    });
    await Promise.race([connect, timer]);
    connect.catch(() => { /* 타임아웃 후 늦게 끝나는 연결의 unhandled rejection 방지 */ });
    _client = client;
    _connectedOc = oc;
    _groundCache.clear(); // OC 변경 시 캐시 무효
    try { const t = await client.listTools(); _tools = t.tools.map((x) => x.name); } catch { /* */ }
    return _client;
  } catch { _client = null; return null; }
}

/** 서비스 카드용 도구명 목록(빈 배열=미연결/미설정). */
export async function lawTools(): Promise<string[]> {
  if (!isLawEnabled()) return [];
  if (_tools.length) return _tools;
  await getClient();
  return _tools;
}

/** 주제 → 관련 법령 검색 결과(그라운딩 주입용). 주제별 캐시. 미설정·실패 시 ''(런 무중단). */
export async function lawGround(topic: string, signal?: AbortSignal): Promise<string> {
  if (!isLawEnabled() || !topic.trim()) return '';
  const key = topic.trim().slice(0, 80);
  const hit = _groundCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const client = await getClient();
    if (!client) return '';
    const r = await client.callTool(
      { name: 'search_law', arguments: { query: topic.slice(0, 60) } },
      undefined,
      { timeout: CONFIG.groundingTimeoutMs, ...(signal ? { signal } : {}) }, // 무응답 MCP 무한 대기 방지
    ) as { content?: Array<{ text?: string }> };
    const text = (r.content ?? []).map((c) => c.text ?? '').join('').slice(0, 800).trim();
    _groundCache.set(key, text);
    return text;
  } catch { return ''; }
}
