import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LlmWiki, slugify, buildLinkResolver, provenanceLabel } from './llmwiki';

// compileDebateOverview 테스트용 LLM 목킹 — 다른 테스트는 llm 을 호출하지 않아 무해.
vi.mock('../llm/client', () => ({
  llm: { chat: vi.fn(async () => ({ text: '합의: [[장마철 배수]]가 우선 대응이다. 반박·기각: 절대 검색량 단정. 열린 질문: 지역별 편차.' })) },
}));
// 브랜드 소재 게이트만 대체(나머지는 실제 구현 유지) — maintain 의 금지소재 차단 검증용.
vi.mock('../content/brand', async (orig) => ({
  ...(await orig<typeof import('../content/brand')>()),
  offBrandTerm: (text: string) => (/다육|상추/.test(text) ? '다육' : null),
}));

const sha1 = (s: string) => createHash('sha1').update(s.trim()).digest('hex');

let dir: string;
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-')), 'wiki');
});

describe('slugify', () => {
  it('공백·특수문자 정리, 한글 보존', () => {
    expect(slugify('Local LLM!')).toBe('local-llm');
    expect(slugify('제2의 두뇌')).toBe('제2의-두뇌');
  });
});

// macOS/iCloud 가 한글 장슬러그 파일명을 NFD ~255바이트에서 잘라 'x 2.md' 중복까지 만든 회귀(2026-07-13).
describe('buildLinkResolver — 슬러그·별칭 해석(순수)', () => {
  const P = (slug: string, aliases: string[] = []) => ({ slug, aliases });
  it('실 슬러그는 자기 자신, 고유 별칭은 소유 페이지로', () => {
    const r = buildLinkResolver([P('고온-스트레스', ['고온스트레스']), P('잎-손상-진단')]);
    expect(r.get('고온-스트레스')).toBe('고온-스트레스');
    expect(r.get('고온스트레스')).toBe('고온-스트레스');
    expect(r.get('잎-손상-진단')).toBe('잎-손상-진단');
  });
  it('두 페이지 이상이 주장하는 별칭은 모호 → 제외(결정적, readdir 순서 무관)', () => {
    // 실측: 'debate' 는 37개 토론 페이지가 공유 — 아무 데나 붙으면 안 된다.
    const r = buildLinkResolver([P('a', ['debate']), P('b', ['debate']), P('c', ['고유'])]);
    expect(r.has('debate')).toBe(false);
    expect(r.get('고유')).toBe('c');
    // 입력 순서를 뒤집어도 동일 결과
    const r2 = buildLinkResolver([P('b', ['debate']), P('a', ['debate']), P('c', ['고유'])]);
    expect(r2.has('debate')).toBe(false);
  });
  it('별칭이 실 페이지 슬러그와 충돌하면 실 페이지가 이긴다', () => {
    const r = buildLinkResolver([P('모종'), P('다른-페이지', ['모종'])]);
    expect(r.get('모종')).toBe('모종');
  });
  it('기록형(performance 등)은 별칭으로 개념 정체성을 주장 못 한다 — 성과 스냅샷이 키워드를 선점하던 사고', () => {
    // analytics/*Perf 가 성과 페이지에 aliases:[타겟키워드] 를 심는다 — 개념 링크가 조회수 기록으로
    // 해석되면 진짜 지식 갭이 은폐된다(2026-07-31 리뷰 실측: '여름 거름 주기').
    const r = buildLinkResolver([
      { slug: '성과-여름-거름-주기-abc', aliases: ['여름 거름 주기'], type: 'performance' },
      { slug: '거름-과다증', aliases: [], type: 'concept' },
    ]);
    expect(r.has('여름-거름-주기')).toBe(false); // 갭은 갭으로 남아야 maintain 이 개념을 만든다
    expect(r.get('거름-과다증')).toBe('거름-과다증');
    // 지식 타입이면 정상 주장
    const r2 = buildLinkResolver([{ slug: '고온-스트레스', aliases: ['고온스트레스'], type: 'concept' }]);
    expect(r2.get('고온스트레스')).toBe('고온-스트레스');
  });
  it('문자·숫자 없는 별칭은 버린다 — slugify 의 page 폴백이 [[page]] 를 오해석하지 않게', () => {
    const r = buildLinkResolver([P('a', ['', '  ', '!!!'])]);
    expect(r.size).toBe(1);        // 실 슬러그 a 만
    expect(r.has('page')).toBe(false);
    expect(r.has('없는것')).toBe(false);
  });
});

describe('slugify — 장슬러그 NFD 바이트 캡(+해시)', () => {
  const longTitle = '8월 휴가철·하반기 성수기 대비 경북 숙박·관광·식음료 중소·소상공인의 자금 확보·마케팅 고민 분석 (요약)';
  const nfdBytes = (s: string) => Buffer.byteLength(s.normalize('NFD'), 'utf-8');

  it('NFD 180바이트 초과 시 접두사+해시8로 캡, 결정적', () => {
    const s = slugify(longTitle);
    expect(nfdBytes(`${s}.md`)).toBeLessThanOrEqual(200); // 파일명 전체가 255바이트 한계 안쪽
    expect(s).toMatch(/-[0-9a-f]{8}$/);
    expect(slugify(longTitle)).toBe(s); // 같은 제목 → 같은 슬러그([[링크]] 해석 일치)
  });

  it('긴 공통 접두사를 가진 다른 제목은 다른 슬러그(절단 충돌 방지)', () => {
    const a = slugify(longTitle);
    const b = slugify(longTitle.replace('(요약)', '· 비평 (b0ff1796)'));
    expect(a).not.toBe(b);
  });

  it('짧은 슬러그는 기존 동작 불변', () => {
    expect(slugify('제2의 두뇌')).toBe('제2의-두뇌');
    expect(slugify('Local LLM!')).toBe('local-llm');
  });

  it('장제목 페이지 저장·조회 라운드트립 — 파일명=슬러그', () => {
    const w = new LlmWiki(dir);
    const p = w.upsertPage({ title: longTitle, type: 'concept', body: '본문' });
    expect(fs.existsSync(path.join(dir, `${p.slug}.md`))).toBe(true);
    expect(w.getPage(slugify(longTitle))?.title).toBe(longTitle);
  });

  it('생성자 수선 — 잘린 파일명(basename≠slug) 레거시 파일을 캡 슬러그로 복구', () => {
    new LlmWiki(dir); // 레이아웃 생성
    const fullSlug = '박'.repeat(60); // 캡 도입 전 80자 캡만 통과한 장슬러그(NFD 360바이트)
    const legacy = [
      '---', 'title: 긴 제목', `slug: ${fullSlug}`, 'type: concept',
      'aliases: []', 'sources: []', 'contributors: []',
      'updated: 2026-07-01', 'summary: s', '---', '', '본문', '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, `${'박'.repeat(20)} 2.md`), legacy, 'utf-8'); // iCloud 절단+중복 재현
    const w = new LlmWiki(dir);
    const canonical = slugify(fullSlug); // 캡 적용 결과(슬러그 재정규화와 동일)
    expect(fs.existsSync(path.join(dir, `${'박'.repeat(20)} 2.md`))).toBe(false); // 잔재 제거
    expect(fs.existsSync(path.join(dir, `${canonical}.md`))).toBe(true);
    expect(w.getPage(canonical)?.title).toBe('긴 제목');
  });
});

describe('LlmWiki', () => {
  it('스키마 문서를 초기화한다', () => {
    new LlmWiki(dir);
    expect(fs.existsSync(path.join(dir, 'WIKI_SCHEMA.md'))).toBe(true);
  });

  it('페이지 생성·프런트매터 라운드트립·[[링크]] 파싱', () => {
    const w = new LlmWiki(dir);
    const p = w.upsertPage({ title: 'Ollama', type: 'entity', body: '로컬 추론 서버. [[Local LLM]]을 실행한다.', summary: '로컬 LLM 서버' });
    expect(p.slug).toBe('ollama');
    const re = w.getPage('ollama');
    expect(re?.title).toBe('Ollama');
    expect(re?.type).toBe('entity');
    expect(re?.summary).toBe('로컬 LLM 서버');
    expect(re?.links).toContain('local-llm'); // [[Local LLM]] → slug
  });

  it('같은 제목 재적재 시 갱신 섹션 추가(중복 페이지 X)', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '제2의 두뇌', type: 'concept', body: '초안' });
    w.upsertPage({ title: '제2의 두뇌', type: 'concept', body: '추가 정보' });
    expect(w.list().filter((p) => p.slug === '제2의-두뇌')).toHaveLength(1);
    expect(w.getPage('제2의-두뇌')?.body).toContain('## 갱신');
    expect(w.getPage('제2의-두뇌')?.body).toContain('추가 정보');
  });

  it('query — 인덱스 우선 관련 페이지 본문 반환', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: 'Ollama 튜닝', type: 'concept', body: '컨텍스트 길이를 16384로 설정한다.' });
    w.upsertPage({ title: '무관한 글', type: 'concept', body: '딴 얘기.' });
    const { hits, context } = w.query('ollama 튜닝 컨텍스트');
    expect(hits[0]?.title).toBe('Ollama 튜닝');
    expect(context).toContain('16384');
  });

  it('graph — [[링크]] → 노드/엣지', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: 'A', type: 'entity', body: '[[B]] 참조' });
    w.upsertPage({ title: 'B', type: 'entity', body: '내용' });
    const g = w.graph();
    expect(g.nodes.length).toBe(2);
    expect(g.links.length).toBe(1); // A→B
  });

  it('recordDebate — 토론을 1급 노드 + 반박(rebuts) 엣지로 영속화', async () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '전기요금', type: 'concept', body: '산업용 전기요금 체계.' }); // 산출 개념(relates 대상)
    const created = await w.recordDebate({
      topic: '전기료 지원', runId: 'abcd1234ef',
      critique: { name: '비평가', text: '근거가 약하다.' },
      positions: [
        { name: '기획팀', text: '바우처 도입을 제안한다.' },
        { name: '법무팀', text: '법령 개정이 필요하다.' },
      ],
      relatesTo: ['전기요금'],
    });
    expect(created.length).toBe(3); // 입장 2 + 비평 1
    const critSlug = created.find((s) => s.includes('비평'))!;
    expect(w.getPage(critSlug)?.type).toBe('debate');
    expect(w.getPage(critSlug)?.rebuts.length).toBe(2); // 비평 → 두 입장
    const g = w.graph();
    const rebuts = (g.links as Array<{ kind: string; target: string }>).filter((l) => l.kind === 'rebuts');
    expect(rebuts.length).toBe(2); // 비평 → 두 입장(빨강 반박 엣지 2개)
    // 두 입장 노드가 산출 개념([[전기요금]])으로 relates 연결돼 지식 그래프에 합류
    const relSrc = (g.links as Array<{ kind: string; target: string; source: string }>)
      .filter((l) => l.kind === 'relates' && l.target === '전기요금').map((l) => l.source);
    expect(relSrc).toContain(created[0]); // 기획팀 입장
    expect(relSrc).toContain(created[1]); // 법무팀 입장
  });

  it('recordDebate — rebuts 가 프런트매터 라운드트립으로 보존', async () => {
    await new LlmWiki(dir).recordDebate({
      topic: 'T', runId: 'r1',
      critique: { name: 'C', text: '비평' }, positions: [{ name: 'P', text: '입장' }],
    });
    const crit = new LlmWiki(dir).list('debate').find((p) => p.title.includes('비평'))!; // 디스크 재로드
    expect(crit.rebuts.length).toBe(1);
  });

  it('recordDebate — prune 그룹 무결성·현재 run 보호(dangling rebuts 0)', async () => {
    const w = new LlmWiki(dir);
    let lastRun = '';
    for (let i = 0; i < 35; i++) { // keepRuns(30) 초과로 prune 유발
      lastRun = `run${i}`;
      await w.recordDebate({ topic: `토픽${i}`, runId: lastRun, critique: { name: 'C', text: '비평' }, positions: [{ name: 'P', text: '입장' }] });
    }
    expect(w.list('debate').length).toBeLessThanOrEqual(30 * 2); // 캡 적용 — 무한 증식 X
    const survived = w.list('debate').filter((p) => p.aliases.includes(`run:${lastRun}`));
    expect(survived.length).toBe(2); // 현재(마지막) run 의 입장+비평 보호 — 방금 만든 토론이 안 지워짐
    // 그룹 무결성 — 비평의 rebuts 가 살아있는 입장만 가리킴(dangling 빨강 엣지/유령 stub 0)
    const g = w.graph();
    const real = new Set((g.nodes as Array<{ id: string; category?: string }>).filter((n) => n.category !== 'stub').map((n) => n.id));
    const dangling = (g.links as Array<{ kind: string; target: string }>).filter((l) => l.kind === 'rebuts' && !real.has(l.target));
    expect(dangling.length).toBe(0);
  });

  it('lint — 고아·끊긴 링크 탐지', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: 'A', type: 'entity', body: '[[없는페이지]] 참조' });
    const r = w.lint();
    expect(r.danglingLinks.some((d) => d.to === '없는페이지')).toBe(true);
  });

  it('별칭 링크는 끊긴 링크·고아가 아니다 — maintain 중복 페이지 생성 차단(2026-07-31)', () => {
    const w = new LlmWiki(dir);
    // '고온 스트레스' 페이지가 '고온스트레스' 를 별칭으로 선언 → 다른 페이지가 별칭으로 링크.
    w.upsertPage({ title: '고온 스트레스', type: 'concept', body: '정의', aliases: ['고온스트레스'] });
    w.upsertPage({ title: '잎 손상 진단', type: 'concept', body: '[[고온스트레스]] 가 원인일 수 있다' });
    const r = w.lint();
    expect(r.danglingLinks.some((d) => d.to === '고온스트레스')).toBe(false); // 종전엔 true(가짜 갭)
    expect(r.orphans).not.toContain('고온 스트레스');                          // 별칭 인바운드도 인정
  });

  it('지식 페이지가 성과(기록) 페이지로 흡수되지 않는다 — 성과 요약이 백과사전 정의로 덮이던 사고', () => {
    const w = new LlmWiki(dir);
    // 성과 스냅샷(측정 기록) — 타겟 키워드를 별칭으로 가진다(analytics/*Perf 실제 동작).
    const perf = w.upsertPage({
      title: '릴스 성과 · 블루베리', type: 'performance', body: '도달 135 · 조회 142 · 성과신호 0.21',
      summary: '도달 135 · 조회 142', aliases: ['블루베리나무'],
    });
    // maintain 이 갭을 메우려 만든 지식 페이지 — 종전엔 compactKey 별칭 일치로 성과 페이지에 흡수됐다.
    const made = w.upsertPage({ title: '블루베리나무', type: 'entity', body: '진달래과 낙엽관목', summary: '진달래과 낙엽관목' });
    expect(made.slug).not.toBe(perf.slug);                       // 별도 페이지로 생성
    expect(w.getPage(perf.slug)?.summary).toBe('도달 135 · 조회 142'); // 성과 요약 보존
    expect(w.getPage(perf.slug)?.body).not.toContain('진달래과');      // 갱신 섹션 오염 없음
  });

  it('maintain — 브랜드 금지 소재 갭은 페이지를 만들지 않는다(두뇌 재파종 차단)', async () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '허용 개념', type: 'concept', body: '[[다육식물]] 과 [[장마철 배수]] 참조' });
    const r = await w.maintain('m', { maxFill: 4 });
    expect(r.filled).not.toContain('다육식물');   // 금지 소재 — 생성 차단
    expect(r.filled).toContain('장마철 배수');     // 정상 갭은 그대로 보충
    expect(w.lint().danglingLinks.some((d) => d.to === '다육식물')).toBe(true); // 보고는 유지
  });

  describe('fillDanglingFromSource — maxFill·금지소재 게이트(스펙 §4)', () => {
    it('원문 언급이 있는 대상만, 상한만큼, 금지소재 제외', async () => {
      const w = new LlmWiki(dir);
      w.upsertPage({ title: '원문A', type: 'source', body: '사과나무 전정과 배롱나무 전정과 다육 관리와 블루베리 시비를 다룬다', sources: ['run:r'] });
      w.upsertPage({ title: '허브', type: 'concept', body: '[[사과나무 전정]] [[배롱나무 전정]] [[다육 관리]] [[블루베리 시비]] [[없는 개념]]', sources: ['run:r'] });
      const r = await w.fillDanglingFromSource('m', { maxFill: 2 });
      expect(r.filled).toBe(2);
      const made = w.allPages().filter((p) => p.sources.includes('stub:source')).map((p) => p.title);
      expect(made).toHaveLength(2);
      expect(made).not.toContain('다육 관리');
      expect(w.allPages().some((p) => p.title === '없는 개념')).toBe(false);
    });
  });

  it('graph — 별칭 링크가 유령 stub 이 아니라 실 노드를 가리킨다', () => {
    const w = new LlmWiki(dir);
    const target = w.upsertPage({ title: '고온 스트레스', type: 'concept', body: '정의', aliases: ['고온스트레스'] });
    w.upsertPage({ title: '잎 손상 진단', type: 'concept', body: '[[고온스트레스]] 참조' });
    const g = w.graph();
    const nodes = g.nodes as Array<{ id: string; category?: string }>;
    expect(nodes.some((n) => n.category === 'stub' && n.id === '고온스트레스')).toBe(false);
    const links = g.links as Array<{ target: string; kind: string }>;
    expect(links.some((l) => l.kind === 'relates' && l.target === target.slug)).toBe(true);
  });

  it('summary 가 대괄호로 시작/끝나도 배열로 오파싱 안 됨(라운드트립)', () => {
    const w = new LlmWiki(dir);
    const p = w.upsertPage({ title: '대괄호', type: 'concept', body: 'x', summary: '[중요] 요약 [a,b]' });
    expect(w.getPage(p.slug)?.summary).toBe('[중요] 요약 [a,b]');
  });

  it('배열 메타(aliases) 값의 쉼표가 항목을 쪼개지 않음', () => {
    const w = new LlmWiki(dir);
    const p = w.upsertPage({ title: '쉼표', type: 'concept', body: 'x', aliases: ['두뇌, 제2의', 'LLM'] });
    expect(w.getPage(p.slug)?.aliases).toEqual(['두뇌, 제2의', 'LLM']);
  });

  it('getPage — 경로 탈출 거부', () => {
    const w = new LlmWiki(dir);
    expect(w.getPage('../../../etc/passwd')).toBeUndefined();
    expect(w.getPage('a/b')).toBeUndefined();
  });

  it('lint — danglingLinks.to 는 슬러그가 아닌 원제목', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: 'A', type: 'entity', body: '[[Local LLM]] 참조' });
    expect(w.lint().danglingLinks.some((d) => d.to === 'Local LLM')).toBe(true);
  });

  it('upsertPage — source → entity 승격(강등은 막음)', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: 'X', type: 'source', body: '원본' });
    w.upsertPage({ title: 'X', type: 'entity', body: '추출' });
    expect(w.getPage('x')?.type).toBe('entity');
    w.upsertPage({ title: 'X', type: 'source', body: '다시 소스' });
    expect(w.getPage('x')?.type).toBe('entity'); // 강등 안 됨
  });

  it('rebuildIndex — index.md 생성', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '엔티티1', type: 'entity', body: 'x', summary: '요약1' });
    w.rebuildIndex();
    const idx = fs.readFileSync(path.join(dir, 'index.md'), 'utf-8');
    expect(idx).toContain('[[엔티티1]]');
    expect(idx).toContain('🔑 엔티티');
  });
});

// 자료 업로드 내용 중복 판정 — /sources 가 '동일 내용'만 건너뛰도록 원문(raw) 해시를 쓴다.
// 과거엔 페이지 본문(누적·청크) 해시로 비교해 청크/갱신된 문서의 재업로드를 놓쳤다.
describe('referencedRawHashes — 업로드 원문(raw) 기준 내용 중복 판정', () => {
  it('청크 분할 문서도 원문 해시로 재업로드를 잡는다(본문 해시 방식이 깨지는 경우)', () => {
    const w = new LlmWiki(dir);
    const big = Array.from({ length: 300 }, (_, i) => `행 ${i}: 데이터 값 항목 ${i} 내용 텍스트 라인`).join('\n');
    const ref = w.saveRaw('큰문서.txt', big);
    w.addSourceDoc({ title: '큰문서', body: big, sources: [ref] });
    expect(w.list('source').length).toBeGreaterThan(1);             // 실제로 청크 분할됨(본문≠원문)
    expect(w.referencedRawHashes().has(sha1(big))).toBe(true);      // 같은 파일 재업로드 → 건너뜀
  });

  it('같은 제목 다른 내용으로 갱신(append)된 뒤에도 원래 원문 재업로드를 잡는다', () => {
    const w = new LlmWiki(dir);
    const v1 = '버전1 본문 내용', v2 = '버전2 다른 본문 내용';
    w.addSourceDoc({ title: '리포트', body: v1, sources: [w.saveRaw('리포트.txt', v1)] });
    w.addSourceDoc({ title: '리포트', body: v2, sources: [w.saveRaw('리포트.txt', v2)] }); // 같은 slug → 갱신
    const seen = w.referencedRawHashes();
    expect(seen.has(sha1(v1))).toBe(true);   // v1 재업로드 → 건너뜀
    expect(seen.has(sha1(v2))).toBe(true);   // v2 재업로드 → 건너뜀
  });

  it('삭제된 자료의 고아 raw 는 제외 — 삭제 후 같은 파일 재업로드 가능', () => {
    const w = new LlmWiki(dir);
    const body = '삭제 테스트 본문';
    const p = w.addSourceDoc({ title: '지울자료', body, sources: [w.saveRaw('지울자료.txt', body)] });
    expect(w.referencedRawHashes().has(sha1(body))).toBe(true);
    w.deletePage(p.slug);
    expect(w.referencedRawHashes().has(sha1(body))).toBe(false); // 참조 끊김 → 재업로드 허용
  });
});

describe('llmWikiFor — 명시 브랜드 디렉터리 귀속(오귀속 회귀)', () => {
  const tmp = path.join(os.tmpdir(), `llmwiki-brand-attr-test-${process.pid}`);
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무해 */ }
    delete process.env.GEPA_DATA_DIR;
    vi.resetModules();
  });
  it('활성 브랜드(범용)와 무관하게 명시 브랜드 위키 디렉터리에 기록', async () => {
    fs.mkdirSync(tmp, { recursive: true });
    process.env.GEPA_DATA_DIR = tmp;
    vi.resetModules();
    const w = await import('./llmwiki');
    w.llmWikiFor('브랜드x').upsertPage({
      title: '귀속 테스트', type: 'performance',
      body: '본문', summary: '요약', sources: ['perf:test'], aliases: [],
    });
    expect(fs.existsSync(path.join(tmp, 'wiki-브랜드x'))).toBe(true);   // 명시 브랜드 디렉터리
    expect(fs.existsSync(path.join(tmp, 'wiki'))).toBe(false);          // 활성(범용) 디렉터리로 새지 않음
  });
});

// 80자 문자 절단 충돌(2026-07-15 실측): 같은 80자 접두의 장제목 입장·비평이 같은 슬러그로 붕괴해
// 서로를 덮어쓰고(본문 소실) 자기반박 루프까지 만들었다 — 절단 시 원문 해시8로 구분한다.
describe('slugify — 80자 절단 충돌 방지(원문 해시8)', () => {
  it('같은 80자 접두의 서로 다른 장제목 → 서로 다른 슬러그(결정적)', () => {
    const prefix = '가'.repeat(40) + ' ' + 'b'.repeat(45); // 정규화 후 86자 > 80
    const a = `${prefix} 리서치SEO팀 입장`;
    const b = `${prefix} 비평`;
    expect(slugify(a)).not.toBe(slugify(b));
    expect(slugify(a)).toBe(slugify(a)); // 결정적
  });
  it('80자 이하 제목은 종전과 동일(해시 없음)', () => {
    expect(slugify('제2의 두뇌')).toBe('제2의-두뇌');
  });
});

describe('rebuildIndex — PageType 전 타입 등재(debate 포함)', () => {
  it('8타입 각 1페이지 → index.md 에 전부 등재·헤더 수 일치', () => {
    const w = new LlmWiki(dir);
    const types = ['entity', 'concept', 'source', 'overview', 'answer', 'lesson', 'debate', 'performance'] as const;
    for (const t of types) w.upsertPage({ title: `${t} 페이지`, type: t, body: `${t} 본문` });
    w.rebuildIndex();
    const idx = fs.readFileSync(path.join(dir, 'index.md'), 'utf-8');
    expect(idx).toContain('페이지 8개');
    for (const t of types) expect(idx).toContain(`[[${t} 페이지]]`);
  });
});

// 슬러그 알고리즘 변천(절단→캡→절단해시)의 1회 수선 — 파일 rename 만 하고 참조(rebuts)를 안 고치면
// 토론 그래프 빨강 엣지가 유령을 가리킨다(2026-07-15 감사: 10/30 끊김).
describe('생성자 1회 수선 — 레거시 슬러그 rename + rebuts 재매핑', () => {
  it('구절단(80자) 슬러그 페이지가 새 슬러그로 개명되고, rebuts 참조도 따라온다', () => {
    fs.mkdirSync(dir, { recursive: true });
    const longTitle = 'a'.repeat(100);
    const legacySlug = 'a'.repeat(80); // 구 알고리즘: slice(0,80), 캡 비적용(ASCII 는 NFD 180B 이내)
    fs.writeFileSync(path.join(dir, `${legacySlug}.md`),
      `---\ntitle: ${longTitle}\nslug: ${legacySlug}\ntype: debate\naliases: []\nsources: []\ncontributors: []\nupdated: 2026-07-10\nsummary: s\n---\n본문\n`, 'utf-8');
    fs.writeFileSync(path.join(dir, '비평.md'),
      `---\ntitle: 비평\nslug: 비평\ntype: debate\naliases: []\nsources: []\ncontributors: []\nrebuts: ["${legacySlug}"]\nupdated: 2026-07-10\nsummary: s\n---\n비평 본문\n`, 'utf-8');
    const w = new LlmWiki(dir);
    const target = slugify(longTitle);
    expect(target).not.toBe(legacySlug);
    expect(fs.existsSync(path.join(dir, `${target}.md`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${legacySlug}.md`))).toBe(false);
    expect(w.getPage('비평')!.rebuts).toEqual([target]);
  });
  it('캡 이전 원 슬러그를 가리키는 rebuts 는 캡 슬러그로 재매핑, 자기반박은 제거', () => {
    fs.mkdirSync(dir, { recursive: true });
    const hangul = '위'.repeat(79); // NFD 180B 초과 → 캡 대상(문자수 80 이하 → 절단 없음)
    const capped = slugify(hangul);
    expect(capped).not.toBe(hangul.toLowerCase());
    fs.writeFileSync(path.join(dir, `${capped}.md`),
      `---\ntitle: ${hangul}\nslug: ${capped}\ntype: debate\naliases: []\nsources: []\ncontributors: []\nupdated: 2026-07-10\nsummary: s\n---\n입장\n`, 'utf-8');
    fs.writeFileSync(path.join(dir, '자기비평.md'),
      `---\ntitle: 자기비평\nslug: 자기비평\ntype: debate\naliases: []\nsources: []\ncontributors: []\nrebuts: ["${hangul.toLowerCase()}", "자기비평"]\nupdated: 2026-07-10\nsummary: s\n---\n비평\n`, 'utf-8');
    const w = new LlmWiki(dir);
    expect(w.getPage('자기비평')!.rebuts).toEqual([capped]); // 원슬러그→캡 재매핑 + 자기참조 제거
  });
});

describe('ensureSchema — 스키마 문서를 엔진 현행판으로 동기화', () => {
  it('낡은 WIKI_SCHEMA.md(pages/ 표기·5타입)는 현행판으로 덮어써진다', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'WIKI_SCHEMA.md'), '# 구버전\n- pages/*.md\n', 'utf-8');
    void new LlmWiki(dir);
    const doc = fs.readFileSync(path.join(dir, 'WIKI_SCHEMA.md'), 'utf-8');
    expect(doc).toContain('debate');
    expect(doc).not.toContain('pages/*.md');
  });
});

// 교훈·성과 페이지가 작성자·태그로만 연결된 '위성 섬'이 되던 문제(2026-07-16 그래프 검토) —
// 생성부가 이 헬퍼로 지식 본체와 [[링크]]를 만든다. always=무조건(스텁=생성 후보 신호), ifExists=실재 시만.
describe('relatedLine — 그래프 연결용 관련 링크 줄', () => {
  it('always 는 무조건, ifExists 는 실재 페이지만, 없으면 빈 문자열', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '여름 화분 (요약)', type: 'source', body: 'b' });
    expect(w.relatedLine(['여름화분'], ['여름 화분 (요약)', '없는 페이지']))
      .toBe('\n\n관련: [[여름화분]] · [[여름 화분 (요약)]]');
    expect(w.relatedLine([], ['없는 페이지'])).toBe('');
    expect(w.relatedLine([undefined, '여름화분', '여름화분'], [])).toBe('\n\n관련: [[여름화분]]'); // 빈값·중복 정리
  });
});

// 토론(입장·비평)이 상한 프루닝으로 증발하기 전 '<topic> (종합)' overview 로 응축(2026-07-16 설계).
// 같은 topic 재컴파일은 같은 페이지에 갱신 섹션 누적 = 컴파일 1회 + 지속 갱신(카파시).
describe('compileDebateOverview — 토론→종합 증분 컴파일', () => {
  it('overview 페이지 생성(+요약 링크·LLM 본문 [[링크]]) 및 재컴파일 머지(갱신 누적)', async () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '장마철 관리 (요약)', type: 'source', body: 'b' });
    const slug = await w.compileDebateOverview({
      topic: '장마철 관리', model: 'micro',
      positions: [{ name: '갑', text: '배수 우선 입장' }], critique: { name: '을', text: '검색량 단정 비평' },
    });
    expect(slug).toBe(slugify('장마철 관리 (종합)'));
    const p = w.getPage(slug!)!;
    expect(p.type).toBe('overview');
    expect(p.body).toContain('[[장마철 관리 (요약)]]');
    expect(p.links).toContain(slugify('장마철 배수'));
    const again = await w.compileDebateOverview({ topic: '장마철 관리', model: 'micro', positions: [{ name: '갑', text: '2차 입장' }] });
    expect(again).toBe(slug);
    expect(w.getPage(slug!)!.body).toContain('## 갱신');
    const idx = fs.readFileSync(path.join(dir, 'index.md'), 'utf-8');
    expect(idx).toContain('[[장마철 관리 (종합)]]'); // 인덱스 즉시 반영(🧭 종합 섹션)
  });
  it('입장이 비면 컴파일 생략(null)', async () => {
    const w = new LlmWiki(dir);
    expect(await w.compileDebateOverview({ topic: 't', model: 'm', positions: [] })).toBeNull();
  });
});

// 근사중복 병합(2026-07-16, 감사 잔여 ①) — 표기 변형은 결정적 흡수, 의미 중복은 mergePages 로 병합.
describe('upsertPage — 표기 변형(공백·특수문자) 근사중복 흡수', () => {
  it("'가을 등산'이 이미 있으면 '가을등산' upsert 는 새 페이지 대신 기존에 머지", () => {
    const w = new LlmWiki(dir);
    const a = w.upsertPage({ title: '가을 등산', type: 'concept', body: '원본' });
    const b = w.upsertPage({ title: '가을등산', type: 'concept', body: '변형 표기 본문' });
    expect(b.slug).toBe(a.slug); // 새 파일 없음
    const p = w.getPage(a.slug)!;
    expect(p.body).toContain('## 갱신');
    expect(p.aliases).toContain('가을등산'); // 흡수된 표기는 별칭으로
    expect(w.allPages().filter((x) => x.type === 'concept')).toHaveLength(1);
  });
  it('별칭(alias)과의 표기 일치도 흡수한다', () => {
    const w = new LlmWiki(dir);
    const a = w.upsertPage({ title: 'SERP 경쟁', type: 'concept', body: 'b', aliases: ['검색결과 경쟁'] });
    const b = w.upsertPage({ title: '검색결과경쟁', type: 'concept', body: 'b2' });
    expect(b.slug).toBe(a.slug);
  });
});

describe('mergePages — 의미 중복 병합(메타 합집합·참조 재지정·흡수 삭제)', () => {
  it('본문 병합 섹션·aliases/sources 합집합·타 페이지 [[링크]]·rebuts 재지정·loser 삭제·index 반영', async () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '심사 프로세스', type: 'concept', body: '5단계 절차', sources: ['run:a'] });
    w.upsertPage({ title: '심사절차', type: 'concept', body: '4단계 요약', sources: ['run:b'], aliases: ['심사 단계'] });
    w.upsertPage({ title: '지정 신청', type: 'concept', body: '신청 후 [[심사절차]]를 거친다. 상세는 [[심사절차|절차 문서]] 참고.' });
    const critique = w.upsertPage({ title: '비평 노드', type: 'debate', body: 'x', rebuts: [slugify('심사절차')] });
    const ok = await w.mergePages(slugify('심사 프로세스'), slugify('심사절차'));
    expect(ok).toBe(true);
    expect(w.getPage(slugify('심사절차'))).toBeUndefined(); // loser 삭제
    const win = w.getPage(slugify('심사 프로세스'))!;
    expect(win.body).toContain('## 병합');
    expect(win.body).toContain('4단계 요약');
    expect(win.aliases).toEqual(expect.arrayContaining(['심사절차', '심사 단계']));
    expect(win.sources).toEqual(expect.arrayContaining(['run:a', 'run:b']));
    const ref = w.getPage(slugify('지정 신청'))!;
    expect(ref.body).toContain('[[심사 프로세스]]');
    expect(ref.body).toContain('[[심사 프로세스|절차 문서]]'); // 파이프 표시명 보존
    expect(ref.body).not.toContain('[[심사절차');
    expect(w.getPage(critique.slug)!.rebuts).toEqual([slugify('심사 프로세스')]);
    expect(fs.readFileSync(path.join(dir, 'index.md'), 'utf-8')).not.toContain('[[심사절차]]');
  });
  it('없는 슬러그·자기 병합은 false', async () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: 'x', type: 'concept', body: 'b' });
    expect(await w.mergePages(slugify('x'), slugify('x'))).toBe(false);
    expect(await w.mergePages(slugify('x'), '없는것')).toBe(false);
  });
});

describe('provenanceLabel — 그라운딩 출처 라벨(스펙 §4)', () => {
  const P = (type: string, sources: string[]) => ({ type: type as never, sources });
  it('raw > performance > maintain:auto > stub:source > 토론·종합 > run: > 미상', () => {
    expect(provenanceLabel(P('concept', ['raw/a.md']))).toBe('원문(raw)');
    expect(provenanceLabel(P('performance', ['perf:url']))).toBe('실측 성과');
    expect(provenanceLabel(P('entity', ['maintain:auto']))).toBe('LLM 생성 스텁');
    expect(provenanceLabel(P('entity', ['stub:source']))).toBe('원문 발췌 스텁');
    expect(provenanceLabel(P('overview', []))).toBe('토론·종합(출처 없음)');
    expect(provenanceLabel(P('concept', ['run:abc']))).toBe('런 산출 요약');
    expect(provenanceLabel(P('concept', []))).toBe('출처 미상');
  });
});

describe('query — forFacts 필터·스텁 감가·라벨 머리말', () => {
  it('forFacts 면 performance·debate·overview·lesson 을 제외하고 maintain:auto 는 감가한다', () => {
    const w = new LlmWiki(dir);
    w.upsertPage({ title: '감나무 깍지벌레', type: 'entity', body: '감나무 깍지벌레 방제 요약', sources: ['maintain:auto'] });
    w.upsertPage({ title: '감나무 깍지벌레 방제', type: 'concept', body: '감나무 깍지벌레 방제는 4월 하순 약충기', sources: ['run:r1'] });
    w.upsertPage({ title: '감나무 깍지벌레 성과', type: 'performance', body: '감나무 깍지벌레 조회 120', sources: ['perf:u'] });
    const all = w.query('감나무 깍지벌레', 5);
    expect(all.hits.some((p) => p.type === 'performance')).toBe(true);
    const facts = w.query('감나무 깍지벌레', 5, { forFacts: true });
    expect(facts.hits.some((p) => p.type === 'performance')).toBe(false);
    expect(facts.hits.map((p) => p.title).sort()).toEqual(['감나무 깍지벌레', '감나무 깍지벌레 방제']);
    expect(facts.context).toContain('### 감나무 깍지벌레 방제 [런 산출 요약]');
    expect(facts.context).toContain('### 감나무 깍지벌레 [LLM 생성 스텁]');
  });
  it('maintain:auto·stub:source 는 같은 점수의 sources:[] 페이지보다 낮게 감가된다', () => {
    // 제목 토큰 2개 일치(+16)·본문 존재(+2) 동일 → run: ×0.5 = 9 vs maintain:auto ×0.5 = 9 (동점) — 감가 자체를 확인하려면 스텁만 있는 경우와 비교
    const only = new LlmWiki(path.join(dir, '..', 'w2'));
    only.upsertPage({ title: '배롱나무 전정', type: 'entity', body: '배롱나무 전정 개요', sources: ['maintain:auto'] });
    only.upsertPage({ title: '배롱나무 전정 참고', type: 'entity', body: '배롱나무 전정 개요', sources: [] });
    const hits = only.query('배롱나무 전정', 2).hits.map((p) => p.title);
    expect(hits[0]).toBe('배롱나무 전정 참고'); // 출처 미상(감가 없음)이 스텁(×0.5)보다 앞

    const stubOnly = new LlmWiki(path.join(dir, '..', 'w3'));
    stubOnly.upsertPage({ title: '배롱나무 전정', type: 'entity', body: '배롱나무 전정 개요', sources: ['stub:source'] });
    stubOnly.upsertPage({ title: '배롱나무 전정 참고', type: 'entity', body: '배롱나무 전정 개요', sources: [] });
    const stubHits = stubOnly.query('배롱나무 전정', 2).hits.map((p) => p.title);
    expect(stubHits[0]).toBe('배롱나무 전정 참고'); // 원문 발췌 스텁(×0.5)도 출처 미상(감가 없음)보다 뒤
  });
});
