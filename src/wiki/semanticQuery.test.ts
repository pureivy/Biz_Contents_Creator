/**
 * semanticQuery 통합 — Ollama 임베딩 rerank 제거(2026-07-06) 후 휴리스틱 단일 경로 검증.
 *  (1) 휴리스틱 query() 와 동일 순위(회귀 0).
 *  (2) limit 준수 + 컨텍스트 발췌 생성.
 *  (3) 인사·직무 의도 질의의 앵커 set-pull(업무분장표 보충)이 계속 동작.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmWiki } from './llmwiki';

let dir: string;
let w: LlmWiki;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-')), 'wiki');
  w = new LlmWiki(dir);
  // 후보가 limit 보다 많도록 12개 — 공통 토큰 '데이터'로 휴리스틱 recall 되게.
  for (let i = 0; i < 12; i++) {
    w.upsertPage({ title: `데이터 페이지 ${i}`, type: 'concept', body: `데이터 분석 항목 ${i} 로컬 속도 위키`, summary: `요약 ${i}` });
  }
});

describe('semanticQuery', () => {
  it('휴리스틱 query() 와 동일 순위(임베딩 경로 제거 후 단일 경로)', async () => {
    const heur = w.query('데이터 분석', 4);
    const sem = await w.semanticQuery('데이터 분석', 4);
    expect(sem.hits.map((p) => p.slug)).toEqual(heur.hits.map((p) => p.slug));
  });

  it('limit 을 준수하고 히트별 발췌 컨텍스트를 만든다', async () => {
    const sem = await w.semanticQuery('데이터 분석', 4);
    expect(sem.hits.length).toBeLessThanOrEqual(4);
    expect(sem.hits.length).toBeGreaterThan(0);
    for (const p of sem.hits) expect(sem.context).toContain(`### ${p.title}`);
  });

  it('인사·직무 의도 질의는 앵커(업무분장) 동형 자료를 limit 밖에서 보충한다', async () => {
    for (let i = 0; i < 8; i++) {
      w.upsertPage({ title: `${i}팀 업무분장표`, type: 'source', body: `업무분장 담당업무 팀원 명단 ${i}`, summary: `${i}팀 담당` });
    }
    const sem = await w.semanticQuery('전직원 담당업무 알려줘', 4);
    const anchored = sem.hits.filter((p) => p.title.includes('업무분장')).length;
    expect(anchored).toBeGreaterThan(4 - 1); // set-pull 로 limit(4)를 넘어 8팀 문서가 보충된다
  });
});
