// src/orchestrator/briefVerdict.test.ts
import { describe, it, expect } from 'vitest';
import { parseBriefVerdict, parseUnresolved, isBlocking, describeVerdict, VERDICT_FORMAT } from './briefVerdict';

// ── 고정 표본 ────────────────────────────────────────────────────────────────
// 지어낸 문자열이 아니라 실제 런(ba522a39fa7d, 2026-08-28 「정원 울타리 나무」)에서 팩트체커(정하람)가
// 낸 비평문 두 건의 실물 발췌다. 두 건 모두 판정은 REVISION_NEEDED 이지만 **표기 위치와 형식이 다르고**,
// 각각 오탐 함정을 품고 있다 — 파서가 실제로 상대할 입력이 이것이라서 표본으로 박아 둔다.

/** R2 — 머리글 3행에 정규 `판정:` 줄. 함정: 92행의 wiki 기록 메아리. */
const R2 = `# R2 검증 — 리서치·SEO팀 브리프 v2 「울타리 나무 6수종」

판정: **REVISION_NEEDED** (총점 43/70, 61%) — 총점과 무관하게 **무근거 기입 1건 확정**으로 자동 반려.

v1 지적(A-1~A-10, B-1·B-2)은 대체로 성실히 반영됐고, 특히 산술 검산 병기와 결손 선언(⚠️) 습관은 정착됐다.

---

## 1. 사실 스팟체크 (5건 역추적)

| # | 검증 대상 | 결과 |
|---|---|---|
| S-1 | 유튜브 5편 합계 163,027회 / 91.2% | **통과.** 75,526+36,339+28,404+11,386+11,372=163,027, ÷178,674=91.24% [근거: 브리프 §4-2 표 자체 검산] |

## 7. 채점표

| 기준 | 점수 | 근거 |
|---|---|---|
| ⑦서식·발행 준비도 | 6 | 분량·이미지·이모지 금지 규격은 명시됐으나 배분 합계 3,300자로 하한 턱걸이 + 블록 수 충돌 |
| **합계** | **43/70 (61%)** | 기준선 49점 미달 |

wiki 기록: \`R2/2026-08-28 울타리나무 브리프 v2 — REVISION_NEEDED(43/70), 무근거 기입 1건(손질강도), 산술 라벨 오류 1건(가성비 3편), 내부 모순 1건(Y5 3중 분류)\``;

/** R1 — 머리글에 판정 줄이 **없고** 문서 끝 채점표 합계 행에만 있다. 함정: 79행의 가정문. */
const R1 = `# 라운드 1 검토 — 정하람(팩트체커)

**전제 고지:** 이번 라운드에 실제로 제출된 산출물은 **리서치·SEO팀 브리프 1건뿐**입니다. 콘텐츠 제작팀 산출물이 없으므로 "팀 간 모순"은 현시점 **판정 불가**이며, 아래는 (A) 리서치·SEO팀 내부 모순·오류 (B) 제작팀에 넘어갈 때 터질 지뢰로 나눕니다.

---

## A. 리서치·SEO팀 — 산술·내부 모순 (심각도 순)

표의 6편 합계 178,674회는 검산 일치합니다(75,526+36,339+28,404+15,647+11,386+11,372=178,674).

### A-3. 보조 키워드 "합계 월 28,390회" 라벨-범위 불일치 (중대)
§1-2 표 6행 합계는 **44,620회**입니다(9,650+8,000+6,750+3,990+10,520+5,710). 28,390은 앞 4개 수종어만의 합입니다.

## B. 제작팀에 넘어갈 때 터질 지뢰

→ **조치:** ㉠ 붉은별무늬병 중간기주 관계와 이격 권장 조건을 **공식 기관 자료(농촌진흥청·산림청)로 1차 확인**하고 [근거] 병기, ㉡ 확인되면 향나무 블록에 "마당에 사과·배가 있다면" 조건 분기를 **필수 삽입**. 이 항목은 미해소 시 제 검토에서 **무근거·리스크 누락으로 REVISION_NEEDED 사유**가 됩니다.

## 채점표

| 기준 | 점수 | 근거 |
|---|---|---|
| **합계** | **44/70 (62.9%)** | **REVISION_NEEDED** — A-1·A-2·A-3 산술 오류와 B-1 리스크 누락은 총점과 무관하게 선행 해소 필요 |`;

describe('parseBriefVerdict — 실측 비평문 고정 표본', () => {
  it('R2: 머리글 판정 줄에서 반려·총점을 읽는다', () => {
    const p = parseBriefVerdict(R2);
    expect(p.verdict).toBe('revision_needed');
    expect(p.score).toBe(43);
    expect(p.maxScore).toBe(70);
    expect(p.source).toBe('head');
  });

  it('R1: 머리글에 판정 줄이 없으면 채점표 합계 행에서 읽는다', () => {
    const p = parseBriefVerdict(R1);
    expect(p.verdict).toBe('revision_needed');
    expect(p.score).toBe(44);
    expect(p.maxScore).toBe(70);
    expect(p.source).toBe('total-row');
  });

  it('R1 의 가정문(“…REVISION_NEEDED 사유가 됩니다”)만으로는 판정이 잡히지 않는다', () => {
    // 채점표를 떼면 남는 건 가정문 하나뿐 — 여기서 반려가 나오면 앵커가 무너진 것이다.
    const onlyHypothetical = R1.split('## 채점표')[0]!;
    expect(parseBriefVerdict(onlyHypothetical).verdict).toBe('unparsed');
  });

  it('R2 의 wiki 기록 메아리만으로는 판정이 잡히지 않는다', () => {
    const onlyEcho = R2.split('\n').filter((l) => l.startsWith('wiki 기록:')).join('\n');
    expect(parseBriefVerdict(onlyEcho).verdict).toBe('unparsed');
  });

  it('합계 행에 판정 토큰이 없으면(R2 채점표) 그 행으로는 판정하지 않는다', () => {
    const row = '| **합계** | **43/70 (61%)** | 기준선 49점 미달 |';
    expect(parseBriefVerdict(row).verdict).toBe('unparsed');
  });
});

describe('parseBriefVerdict — 정규 표기·경계', () => {
  it('페르소나 정규 표기(차단 건수 포함)를 읽는다', () => {
    const p = parseBriefVerdict('# 검증\n\n판정: REVISION_NEEDED · 총점 43/70 · 차단 3건\n\n본문…');
    expect(p).toMatchObject({ verdict: 'revision_needed', score: 43, maxScore: 70, blockers: 3, source: 'head' });
  });

  it('APPROVED 를 통과로 읽는다', () => {
    const p = parseBriefVerdict('판정: APPROVED · 총점 58/70 · 차단 0건');
    expect(p.verdict).toBe('approved');
    expect(p.blockers).toBe(0);
    expect(isBlocking(p)).toBe(false);
  });

  it('빈 비평문·판정 없는 산문은 unparsed 이고, unparsed 는 통과가 아니다', () => {
    for (const t of ['', '   ', '전반적으로 좋습니다. 발행해도 되겠습니다.']) {
      const p = parseBriefVerdict(t);
      expect(p.verdict).toBe('unparsed');
      expect(isBlocking(p)).toBe(true); // 미파싱을 통과로 흘리면 게이트가 조용히 무력화된다
    }
  });

  it('기준 인용문에 섞인 판정 토큰은 앵커 밖이라 무시한다', () => {
    const quoting = '# 검토\n\n제 기준은 이렇습니다. 무근거 주장이 1건이라도 있으면 REVISION_NEEDED 입니다.\n\n이번 브리프는 문제 없었습니다.';
    expect(parseBriefVerdict(quoting).verdict).toBe('unparsed');
  });

  it('단위가 낀 슬래시(163,027회 / 91.2%)는 점수로 읽지 않는다', () => {
    const p = parseBriefVerdict('판정: REVISION_NEEDED — 유튜브 합계 163,027회 / 91.2%');
    expect(p.verdict).toBe('revision_needed');
    expect(p.score).toBeNull(); // 판정은 살고 점수만 비는 게 맞다
  });

  it('만점이 터무니없으면 점수를 버린다(판정은 유지)', () => {
    const p = parseBriefVerdict('판정: APPROVED (2026/8)');
    expect(p.verdict).toBe('approved');
    expect(p.score).toBeNull();
  });

  it('REVISION NEEDED / revision-needed 변형도 받는다', () => {
    expect(parseBriefVerdict('판정: REVISION NEEDED').verdict).toBe('revision_needed');
    expect(parseBriefVerdict('판정: **revision-needed**').verdict).toBe('revision_needed');
  });

  it('머리글 범위를 넘어선 판정 줄은 머리글 앵커로 잡지 않는다', () => {
    const late = `${Array.from({ length: 20 }, (_, i) => `문단 ${i + 1}`).join('\n\n')}\n\n판정: APPROVED · 총점 60/70`;
    expect(parseBriefVerdict(late).verdict).toBe('unparsed');
  });

  it('페르소나 채점 기준의 자기 인용(산문)은 판정으로 읽지 않는다', () => {
    // 팩트체커 시스템 프롬프트가 담은 문장 그대로 — 합계·점수·판정 토큰이 한 줄에 다 모여 있다.
    // 표 행 제한이 없으면 이 줄이 APPROVED 로 오독된다(개발 중 실제로 걸린 오탐).
    const selfQuote = '# 검토\n\n## 기준\n\n제 기준: 사실 스팟체크 통과를 전제로 총점 49/70 이상이면 APPROVED, 미만이면 REVISION_NEEDED 입니다.\n\n본문 검토는 아래에 이어집니다.';
    expect(parseBriefVerdict(selfQuote).verdict).toBe('unparsed');
  });
});

describe('parseUnresolved — 미해소 절', () => {
  const withSection = `판정: REVISION_NEEDED · 총점 43/70 · 차단 3건

## 1. 사실 스팟체크
- S-1 통과
- S-2 통과

## 미해소
- 향나무 붉은별무늬병 중간기주 관계를 공식 기관 자료로 확인하고 [근거] 병기
- "손질강도" 수치는 브리프 어디에도 근거가 없다 — 삭제하거나 출처를 달아라
- Y5 수종이 '중'과 '고'로 이중 분류돼 있다`;

  it('미해소 항목을 뽑는다', () => {
    expect(parseUnresolved(withSection)).toEqual([
      '향나무 붉은별무늬병 중간기주 관계를 공식 기관 자료로 확인하고 [근거] 병기',
      '"손질강도" 수치는 브리프 어디에도 근거가 없다 — 삭제하거나 출처를 달아라',
      "Y5 수종이 '중'과 '고'로 이중 분류돼 있다",
    ]);
  });

  it('미해소 절 앞의 다른 목록은 섞이지 않는다', () => {
    expect(parseUnresolved(withSection)).not.toContain('S-1 통과');
  });

  it('"없음"은 항목으로 세지 않는다 — 통과한 런이 1건으로 보이면 안 된다', () => {
    expect(parseUnresolved('판정: APPROVED\n\n## 미해소\n- 없음')).toEqual([]);
  });

  it('절이 없으면 빈 배열(구 런·자유 서술)', () => {
    expect(parseUnresolved(R1)).toEqual([]);
    expect(parseUnresolved('')).toEqual([]);
  });

  it('다음 머리글에서 멈춘다', () => {
    const t = '## 미해소\n- 첫 항목\n\n## 참고\n- 이건 미해소가 아니다';
    expect(parseUnresolved(t)).toEqual(['첫 항목']);
  });

  it('번호·원문자 목록도 받고, 상한을 넘기지 않는다', () => {
    expect(parseUnresolved('## 미해소\n1. 하나\n② 둘')).toEqual(['하나', '둘']);
    expect(parseUnresolved(`## 미해소\n${Array.from({ length: 30 }, (_, i) => `- 항목 ${i}`).join('\n')}`)).toHaveLength(10);
  });
});

describe('VERDICT_FORMAT — 프롬프트와 파서의 맞물림', () => {
  it('프롬프트가 요구하는 표기를 파서가 실제로 읽는다', () => {
    // 프롬프트와 파서가 조용히 어긋나는 것이 이 게이트의 유일한 무력화 경로다. 형식 문자열이 지시하는
    // 그대로 쓴 비평문을 왕복시켜 둘이 붙어 있는지 확인한다.
    expect(VERDICT_FORMAT).toContain('판정: REVISION_NEEDED');
    expect(VERDICT_FORMAT).toContain('## 미해소');
    const asInstructed = '판정: REVISION_NEEDED · 총점 43/70 · 차단 2건\n\n본문 검토…\n\n## 미해소\n- 무근거 수치 삭제\n- 중간기주 확인';
    const p = parseBriefVerdict(asInstructed);
    expect(p).toMatchObject({ verdict: 'revision_needed', score: 43, maxScore: 70, blockers: 2 });
    expect(parseUnresolved(asInstructed)).toHaveLength(2);
    expect(p.blockers).toBe(parseUnresolved(asInstructed).length); // 차단 건수 ↔ 항목 수 일치 지시
  });
});

describe('describeVerdict', () => {
  it('사람이 읽는 한 줄로 요약한다', () => {
    expect(describeVerdict(parseBriefVerdict(R2))).toBe('반려 · 43/70(머리글)');
    expect(describeVerdict(parseBriefVerdict(R1))).toBe('반려 · 44/70(채점표)');
    expect(describeVerdict(parseBriefVerdict(''))).toBe('판정 미파싱(앵커 없음)');
    expect(describeVerdict(parseBriefVerdict('판정: APPROVED · 총점 58/70 · 차단 0건'))).toBe('통과 · 58/70 · 차단 0건(머리글)');
  });
});
