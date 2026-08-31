import { describe, it, expect, vi, beforeEach } from 'vitest';
// microJSON 만 가짜로 — scoreSeo 가 같은 모듈의 findTemplateNumbers 를 쓰므로 부분 목이어야 한다.
vi.mock('../orchestrator/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orchestrator/agent')>()),
  microJSON: vi.fn(),
}));
import { microJSON } from '../orchestrator/agent';
import { stripTrailingTagDump, stripInternalMarkers, packageNaverBlog } from './naverBlog';
import { CONFIG } from '../config';

const mocked = microJSON as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => mocked.mockReset());

// 실측(2026-08-10 사용자 지적): 작가 모델이 가끔 본문 끝에 맨 키워드를 나열한다("포도나무수확시기
// 포도수확시기 … 비온디트리" — 태그 접두 없음). 발행 레이어의 #태그 칩과 중복이고 본문 키워드
// 덤프는 스팸 신호가 된다. 종전 정규식은 "태그: #…" 접두 줄만 지워 맨 나열이 통과했다.
describe('stripTrailingTagDump — 본문 끝 태그·키워드 나열 제거(순수)', () => {
  it('"태그: #…" 줄을 제거한다(종전 동작 유지)', () => {
    expect(stripTrailingTagDump('본문입니다.\n\n태그: #사과 #배')).toBe('본문입니다.');
    expect(stripTrailingTagDump('본문입니다.\n\n**태그**: #사과 #배')).toBe('본문입니다.');
  });
  it('맨 키워드 나열(4개 이상 토큰·구두점 없음)을 제거한다', () => {
    const body = '나무가 자리 잡는 과정을 기록하고 있습니다.\n\n포도나무수확시기 포도수확시기 캠벨포도수확시기 화분포도 비온디트리';
    expect(stripTrailingTagDump(body)).toBe('나무가 자리 잡는 과정을 기록하고 있습니다.');
  });
  it('마침표로 끝나는 정상 마무리 문단은 남긴다', () => {
    const body = '첫 문단.\n\n계절마다 어떤 신호를 내는지 계속 기록합니다.';
    expect(stripTrailingTagDump(body)).toBe(body);
  });
  it('구두점이 있는 나열 문장은 남긴다', () => {
    const body = '본문.\n\n사과, 배, 감, 포도를 함께 심었습니다';
    expect(stripTrailingTagDump(body)).toBe(body);
  });
  it('토큰 3개 이하 짧은 줄은 남긴다(과제거 방지)', () => {
    const body = '본문.\n\n감사합니다 여러분 안녕히';
    expect(stripTrailingTagDump(body)).toBe(body);
  });
});

describe('stripInternalMarkers — URL 없는 [근거:]·데이터 없음 표식 제거(스펙 §6c)', () => {
  it('URL 없는 [근거:] 는 지우고, URL 있는 것은 (출처: URL) 로 바꾼다', () => {
    expect(stripInternalMarkers('4월 하순에 깨어납니다 [근거: 농사로].')).toBe('4월 하순에 깨어납니다.');
    expect(stripInternalMarkers('기준입니다 [근거: 확립된 원예학 지식] 그래서')).toBe('기준입니다 그래서');
    expect(stripInternalMarkers('심습니다 [근거: 산림청 https://www.forest.go.kr/x]')).toBe('심습니다 (출처: https://www.forest.go.kr/x)');
  });
  it('"⚠️ 데이터 없음:" 줄과 인라인 표식을 제거한다', () => {
    expect(stripInternalMarkers('앞\n- ⚠️ 데이터 없음: 발아율 (필요 자료: 실측)\n뒤')).toBe('앞\n뒤');
    expect(stripInternalMarkers('발아율은 ⚠️ 데이터 없음: 발아율 (필요 자료: 실측) 수준입니다.')).toBe('발아율은 수준입니다.');
  });
  // 백트래킹 폭발 가드(2026-08-26 최종 리뷰 F5a) — 종전 `(?:⚠️?)?\s*` 는 앞뒤 `\s*` 사이에 선택 그룹이
  // 끼어 "긴 공백 + 매칭 실패"에서 지수 백트래킹을 일으켰다. `(?:⚠️\s*)?` 로 공백을 그룹 안에 넣어 봉합.
  // stripEmoji 는 ⚠(Extended_Pictographic)와 VS16 을 함께 지우므로 맨 ⚠ 만 남는 경우는 없다(실측 확인).
  it('긴 공백 뒤 비매칭 텍스트에서 즉시 반환한다(백트래킹 폭발 없음)', () => {
    const input = `${' '.repeat(3000)}데이터`;
    const t0 = Date.now();
    expect(stripInternalMarkers(input)).toBe(input);
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it('괄호 없는 인라인 표식은 문장 경계에서 멈춰 뒤 문장을 보존한다', () => {
    const out = stripInternalMarkers('발아율은 ⚠️ 데이터 없음: 매우 낮은 수준입니다. 다음 문단도 있습니다.');
    expect(out).toContain('다음 문단도 있습니다.');
    expect(out).not.toContain('데이터 없음');
  });
});

// 요약·설명 메타투 재시도(2026-08-27 권고 2) — 검색 스니펫(meta)이 "…를 정리했습니다"로 끝나면
// 프롬프트가 샌 것이다. 같은 콜을 1회만 다시 부르고, 재시도가 깨끗할 때만 meta 를 갈아끼운다:
// 제목 후보·태그는 자기 제약(15~40자·키워드 4/5 포함)이 따로 있어 meta 표적 재생성이 덮으면 안 된다.
describe('packageNaverBlog — meta 요약투 린트 + 1회 재시도(권고 2)', () => {
  const pack = (meta: string, titles: string[]) => ({
    primaryKeyword: '가을 묘목', titles, meta, tags: ['가을묘목', '묘목심기'], images: [{ alt: '뿌리', prompt: '뿌리 사진' }],
  });
  const input = { topic: '가을 묘목 심는 법', body: '뿌리부터 봅니다. 잎은 나중입니다.', model: 'micro' };
  const CLEAN = '잎이 상한 나무는 9월에 비료를 줘도 소용없습니다. 갈변이 어디서 시작됐는지부터 보세요.';

  it('meta 가 깨끗하면 재시도하지 않는다', async () => {
    mocked.mockResolvedValueOnce(pack(CLEAN, ['가을 묘목 고르는 기준 한 가지']));
    const b = await packageNaverBlog(input);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(b.draft.metaDescription).toBe(CLEAN);
  });

  it('요약투면 1회 재시도하고, 깨끗해진 meta 만 갈아끼운다(제목 후보는 1차 유지)', async () => {
    mocked
      .mockResolvedValueOnce(pack('가을 묘목 심는 법을 정리했습니다.', ['1차 제목 후보입니다']))
      .mockResolvedValueOnce(pack(CLEAN, ['재시도 제목 후보입니다']));
    const b = await packageNaverBlog(input);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(b.draft.metaDescription).toBe(CLEAN);
    expect(b.draft.titleCandidates).toEqual(['1차 제목 후보입니다']);
    expect(String(mocked.mock.calls[1]?.[2])).toContain('결론 한 줄 + 조건 한 줄');
  });

  it('재시도 후에도 잔존하면 1차 meta 를 유지하고 로그만 남긴다(콜 2회 초과 금지·발행 차단 없음)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocked
      .mockResolvedValueOnce(pack('가을 묘목 심는 법을 정리했습니다.', ['1차 제목 후보입니다']))
      .mockResolvedValueOnce(pack('묘목 고르는 법을 알아봅니다.', ['재시도 제목 후보입니다']));
    const b = await packageNaverBlog(input);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(b.draft.metaDescription).toBe('가을 묘목 심는 법을 정리했습니다.');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[메타] 요약투 잔존'))).toBe(true);
    spy.mockRestore();
  });

  it('재시도 콜이 던져도 1차 결과로 계속 간다(fail-open)', async () => {
    mocked
      .mockResolvedValueOnce(pack('핵심만 담았어요.', ['1차 제목 후보입니다']))
      .mockRejectedValueOnce(new Error('boom'));
    const b = await packageNaverBlog(input);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(b.draft.metaDescription).toBe('핵심만 담았어요.');
  });

  // Fix wave(2026-08-27, 소견 4) — 권고 2 가 만든 이 두 번째 콜만 킬스위치가 없었다(계획서 Global
  // Constraints: 모든 새 동작에 킬스위치). off 면 검사 자체를 건너뛰어 콜이 1회로 돌아간다.
  it('META_SUMMARY_LINT=off 면 검사·재시도를 건너뛴다(콜 1회, 1차 meta 유지)', async () => {
    const cfg = CONFIG as unknown as { metaSummaryLint: boolean };
    const orig = cfg.metaSummaryLint;
    cfg.metaSummaryLint = false;
    try {
      mocked.mockResolvedValueOnce(pack('가을 묘목 심는 법을 정리했습니다.', ['1차 제목 후보입니다']));
      const b = await packageNaverBlog(input);
      expect(mocked).toHaveBeenCalledTimes(1);
      expect(b.draft.metaDescription).toBe('가을 묘목 심는 법을 정리했습니다.');
    } finally { cfg.metaSummaryLint = orig; }
  });
});
