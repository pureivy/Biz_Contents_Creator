import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractVerifiedClaims, rejectVerifiedLine, acceptVerifiedSource } from './workspace';

describe('extractVerifiedClaims (검증 지식 Self-RAG)', () => {
  it('[근거: 출처] 태그가 붙은 주장만 추출한다', () => {
    const t = '경북 수출이 전년 대비 증가했다 [근거: 통계청 2024]. 이건 추측이라 태그가 없다.';
    const r = extractVerifiedClaims(t);
    expect(r.length).toBe(1);
    expect(r[0]!.source).toBe('통계청 2024');
    expect(r[0]!.claim).toContain('수출');
  });

  it('태그가 없으면 빈 배열', () => {
    expect(extractVerifiedClaims('근거 표시가 전혀 없는 일반 문장이다.')).toEqual([]);
  });

  it('여러 주장 + 전각 콜론(：) 변형을 처리한다', () => {
    const t = '민간 투자가 확대되었다 [근거: 진흥원 보고서]\n고용지표가 개선되었다 [근거：고용노동부]';
    const r = extractVerifiedClaims(t);
    expect(r.length).toBe(2);
    expect(r.map((x) => x.source)).toEqual(['진흥원 보고서', '고용노동부']);
    expect(r[0]!.claim).toContain('투자');
    expect(r[1]!.claim).toContain('고용');
  });

  it('너무 짧은 주장(8자 미만)이나 빈 출처는 버린다', () => {
    expect(extractVerifiedClaims('짧다 [근거: x]')).toEqual([]);
    expect(extractVerifiedClaims('충분히 긴 사실 주장이다 [근거: ]')).toEqual([]);
  });

  it('빈 입력은 빈 배열', () => {
    expect(extractVerifiedClaims('')).toEqual([]);
  });
});

describe('appendMemory — 명시 brand 귀속(오귀속 회귀)', () => {
  const tmp = path.join(os.tmpdir(), `workspace-brand-attr-test-${process.pid}`);
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무해 */ }
    delete process.env.GEPA_DATA_DIR;
    vi.resetModules();
  });
  it('활성 브랜드(범용)와 무관하게 명시 브랜드 파일에 기록되고, 활성 파일로 새지 않는다', async () => {
    fs.mkdirSync(tmp, { recursive: true });
    process.env.GEPA_DATA_DIR = tmp;
    vi.resetModules();
    const ws = await import('./workspace');
    ws.appendMemory('tester', '명시 귀속 교훈', '브랜드a');
    const brandFile = path.join(tmp, 'agents', 'tester', 'memory-브랜드a.md');
    expect(fs.existsSync(brandFile)).toBe(true);
    expect(fs.readFileSync(brandFile, 'utf-8')).toContain('명시 귀속 교훈');
    // 활성 브랜드(신선한 tmp = 범용)의 memory.md 로 새지 않음 — 오귀속 회귀 가드
    expect(fs.existsSync(path.join(tmp, 'agents', 'tester', 'memory.md'))).toBe(false);
  });
});

describe('verified 승격 정직화(스펙 §5)', () => {
  const E = (label: string, kind: 'connector' | 'web' | 'wiki-raw' | 'wiki-derived') => ({ label, kind });
  it('거절 규칙 — 동일·위키 종합/비평·성과·사내·확립된·미실측·⚠️·표 조각', () => {
    expect(rejectVerifiedLine('9월 시비', '동일')).toBeTruthy();
    expect(rejectVerifiedLine('9월 시비', '위키 「유실수 가을 시비 (종합)」')).toBeTruthy();
    expect(rejectVerifiedLine('9월 시비', '성과 페이지')).toBeTruthy();
    expect(rejectVerifiedLine('9월 시비', '검증된 지식(사내)')).toBeTruthy();
    expect(rejectVerifiedLine('9월 시비', '확립된 원예학 지식')).toBeTruthy();
    expect(rejectVerifiedLine('⚠️ 미실측 — 데이터랩 지수 100', '검색어트렌드(데이터랩)')).toBeTruthy();
    expect(rejectVerifiedLine('| 보조3 | 올리브나무 키우기 |', '검색광고 실검색량')).toBeTruthy();
    expect(rejectVerifiedLine('4월 하순부터 약충이 깨어난다', '농사로 https://www.nongsaro.go.kr/x')).toBeNull();
    expect(rejectVerifiedLine('9월 시비', '근거 표기된 지식(verified)')).toBeTruthy();
    expect(rejectVerifiedLine('⚠ 미확인 — 데이터랩 지수', '검색어트렌드(데이터랩)')).toBeTruthy();
  });
  it('가정·미확인 토큰 좁힘 — 가정용/가정정원 등 생활어와 역참조 미확인을 정상 근거로 오탈락시키지 않는다', () => {
    expect(rejectVerifiedLine('실내·가정 맥락을 제목에 명시', '네이버 블로그 SERP "올리브나무 물주기"')).toBeNull();
    expect(rejectVerifiedLine('김도현 미확인 항목 ①의 실측 결과: 3건', '네이버 블로그 SERP "무화과나무 가지치기"')).toBeNull();
    expect(rejectVerifiedLine('수확량 20% 증가를 가정하면', '네이버 블로그 SERP')).toBeTruthy();
    expect(rejectVerifiedLine('⚠ 미확인 — 데이터랩', '검색어트렌드(데이터랩)')).toBeTruthy();
    expect(rejectVerifiedLine('| 미확인 |', '검색광고 실검색량')).toBeTruthy();
  });
  it('수락 — 커넥터 라벨 포함·웹 URL 일치·raw 위키 제목; 파생 위키·원장 불일치는 거절', () => {
    const entries = [E('검색광고 실검색량', 'connector'), E('https://www.nongsaro.go.kr/x', 'web'), E('블루베리 재배 원문', 'wiki-raw'), E('블루베리나무', 'wiki-derived')];
    expect(acceptVerifiedSource('실볼륨 680회', '검색광고 실검색량 — 시드 "올리브나무 물주기"', entries)).toBe(true);
    expect(acceptVerifiedSource('4월 하순 부화', '농사로 https://www.nongsaro.go.kr/x', entries)).toBe(true);
    expect(acceptVerifiedSource('산성 토양', '위키 「블루베리 재배 원문」', entries)).toBe(true);
    expect(acceptVerifiedSource('산성 토양', '위키 - 블루베리나무', entries)).toBe(false);
    expect(acceptVerifiedSource('산성 토양', '농촌진흥청', entries)).toBe(false);
    expect(acceptVerifiedSource('산성 토양', '동일', entries)).toBe(false);
  });
});
