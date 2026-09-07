import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAlias, labelQuestion, readVerdict, learnSpeciesLabel, ALIAS_STOPWORDS } from './speciesLearn';
import { SUBJECT_STOPWORDS_BASE } from './brand';
import { loadSpecies, appendSpeciesAlias, findSpecies, resetSpeciesCache } from './species';
import type { Species } from './species';

const sp = (name: string, latin: string, aliases?: string[]): Species =>
  ({ name, latin, ...(aliases ? { aliases } : {}) }) as Species;

/** 원예 브랜드가 설정으로 주던 업종 일반어 — 범용화 후에는 코드가 아니라 brand.yaml 이 준다. */
const HORT_STOPWORDS = ['나무', '묘목', '모종', '전정', '가지치기', '물주기', '거름', '분갈이', '화분'];

const LIST: Species[] = [
  sp('배롱나무', 'Lagerstroemia indica', ['백일홍나무', '흰배롱나무']),
  sp('배나무', 'Pyrus pyrifolia', ['신고배']),
  sp('밤나무', 'Castanea crenata'),
  sp('수국', 'Hydrangea macrophylla'),
  sp('참나무', 'Quercus'),
];

describe('checkAlias — 자동 별칭 거절 규칙(순수)', () => {
  it('운영자가 실제로 쓴 이름은 통과한다', () => {
    // 이 사건의 이름 — 이게 막히면 기능 자체가 무의미하다
    expect(checkAlias('백일홍', '배롱나무', LIST).ok).toBe(true);
    expect(checkAlias('목백일홍', '배롱나무', LIST).ok).toBe(true);
  });

  it('한 글자는 무조건 거절 — 아무 문장에나 걸린다', () => {
    // '배'가 들어가면 "배수·배치·배양토"가 전부 배나무가 된다.
    // '밤'이 들어가면 "한밤중 물주기"가 밤나무가 된다.
    for (const [a, t] of [['배', '배나무'], ['밤', '밤나무'], ['감', '배나무']] as const) {
      const v = checkAlias(a, t, LIST);
      expect(v.ok, `${a} 가 통과했다`).toBe(false);
      expect(v.reason).toContain('한 글자');
    }
  });

  it('업종 일반 표현은 거절 — 사전이 아니라 문장이다', () => {
    // 업종 낱말은 브랜드가 준다 — 원예 브랜드가 줄 목록을 명시해 기제 자체를 고정한다.
    for (const w of ['나무', '묘목', '전정', '화분']) {
      expect(checkAlias(w, '배롱나무', LIST, HORT_STOPWORDS).ok, `${w} 가 통과했다`).toBe(false);
    }
    expect(ALIAS_STOPWORDS).toBe(SUBJECT_STOPWORDS_BASE);
  });

  it('불용어는 넘긴 목록이 결정한다 — 브랜드 설정이 그대로 적용된다', () => {
    // 목록에 없으면 통과, 목록에 넣으면 거절 — 같은 낱말로 두 방향을 확인한다.
    expect(checkAlias('전정', '배롱나무', LIST, []).ok).toBe(true);
    const v = checkAlias('전정', '배롱나무', LIST, HORT_STOPWORDS);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('업종 일반 표현');
    // 미지정이면 브랜드 접근자(subjectStopwords) — 업종 중립 기본어는 어느 브랜드에서도 거절된다.
    for (const w of SUBJECT_STOPWORDS_BASE) expect(checkAlias(w, '배롱나무', LIST).ok, `${w} 가 통과했다`).toBe(false);
  });

  it('다른 소재 이름에 포함되면 거절 — 그 소재 문장을 가로챈다', () => {
    // '나무'는 배롱나무·밤나무·참나무 안에 다 들어 있다
    const v = checkAlias('나무', '수국', LIST);
    expect(v.ok).toBe(false);
  });

  it('다른 소재 이름을 품으면 거절 — 긴 이름이 이겨서 그쪽을 끌어간다', () => {
    // findSpecies 는 긴 키 우선이다. '수국묘목'을 배롱나무 별칭으로 넣으면
    // "수국묘목 심기"가 배롱나무가 된다.
    const v = checkAlias('수국묘목', '배롱나무', LIST);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('수국');
  });

  it('대상 소재가 이미 가진 이름과의 포함 관계는 문제가 아니다 — 같은 소재다', () => {
    // '백일홍'은 대상(배롱나무)의 기존 별칭 '백일홍나무'에 포함된다. 그래도 통과해야 한다.
    expect(checkAlias('백일홍', '배롱나무', LIST).ok).toBe(true);
  });

  it('이미 있는 별칭·표준명은 거절', () => {
    expect(checkAlias('흰배롱나무', '배롱나무', LIST).reason).toBe('이미 있음');
    expect(checkAlias('배롱나무', '배롱나무', LIST).reason).toBe('표준명과 같음');
  });

  it('사전에 없는 소재에는 못 붙인다 — LLM 이 지어낸 표준명 방어', () => {
    expect(checkAlias('무엇', '없는나무', LIST).ok).toBe(false);
  });

  it('빈 값은 거절', () => {
    expect(checkAlias('', '배롱나무', LIST).ok).toBe(false);
    expect(checkAlias('백일홍', '', LIST).ok).toBe(false);
  });
});

describe('readVerdict — LLM 응답 좁히기(순수)', () => {
  it('사전에 있는 소재를 지목한 alias 만 받는다', () => {
    expect(readVerdict({ kind: 'alias', of: '배롱나무' }, LIST)).toEqual({ kind: 'alias', of: '배롱나무' });
  });
  it('사전에 없는 표준명을 지목하면 unknown — 지어낸 이름에 별칭을 붙이면 안 된다', () => {
    expect(readVerdict({ kind: 'alias', of: '없는나무' }, LIST).kind).toBe('unknown');
  });
  it('학명 없는 new 는 unknown — 앵커 값이 없으면 넣을 이유가 없다', () => {
    expect(readVerdict({ kind: 'new', leaf: '어긋나기' }, LIST).kind).toBe('unknown');
  });
  it('학명이 있으면 형태와 함께 받는다', () => {
    const v = readVerdict({ kind: 'new', latin: 'Ficus carica', leaf: '어긋나기, 손바닥 모양' }, LIST);
    expect(v).toMatchObject({ kind: 'new', latin: 'Ficus carica', leaf: '어긋나기, 손바닥 모양' });
  });
  it('괄호 이명이 붙은 학명은 속명 종소명만 남긴다', () => {
    // 실측(2026-09-06): 자동 학습이 'Citrus japonica (Fortunella japonica)' 를 그대로 써서
    // 사전 무결성 테스트가 잡았다. 이 문자열이 이미지 프롬프트의 종 앵커로 그대로 들어간다.
    const v = readVerdict({ kind: 'new', latin: 'Citrus japonica (Fortunella japonica)' }, LIST);
    expect(v.latin).toBe('Citrus japonica');
  });
  it('학명 꼴이 아니면 unknown — 틀린 학명보다 없는 편이 낫다', () => {
    expect(readVerdict({ kind: 'new', latin: '금귤나무' }, LIST).kind).toBe('unknown');
    expect(readVerdict({ kind: 'new', latin: 'Citrus' }, LIST).kind).toBe('unknown');
  });
  it('쓰레기 입력은 unknown — 파싱 실패가 사전을 오염시키면 안 된다', () => {
    for (const bad of [null, undefined, {}, { kind: 'alias' }, 'nope', 42]) {
      expect(readVerdict(bad, LIST).kind).toBe('unknown');
    }
  });
});

describe('labelQuestion — 프롬프트(순수)', () => {
  it('사전이 아는 이름을 전부 보여 준다 — 그 안에서 고르게 한다', () => {
    const q = labelQuestion('백일홍', LIST);
    expect(q).toContain('배롱나무');
    expect(q).toContain('백일홍나무');
    expect(q).toContain('Lagerstroemia indica');
  });
  it('확신 없으면 unknown 이라고 못박는다 — 추측이 가장 나쁘다', () => {
    expect(labelQuestion('무엇', LIST)).toContain('추측하지 마라');
  });
  it('긍정문 원칙을 프롬프트에 넣는다 — 사전 서술 원칙과 같아야 한다', () => {
    expect(labelQuestion('무엇', LIST)).toContain('긍정문');
  });
});

describe('appendSpeciesAlias — 기존 블록 안을 고친다', () => {
  const withFile = (body: string, run: (f: string) => void): void => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
    const f = path.join(d, 'species.yaml');
    fs.writeFileSync(f, body, 'utf-8');
    resetSpeciesCache();
    try { run(f); } finally { resetSpeciesCache(); fs.rmSync(d, { recursive: true, force: true }); }
  };

  const YAML = `species:
  배롱나무:
    latin: Lagerstroemia indica
    aliases: [백일홍나무, 흰배롱나무]
    type: 활엽 교목
  밤나무:
    latin: Castanea crenata
    type: 활엽 교목
`;

  it('aliases 줄이 있으면 목록 끝에 끼워 넣는다', () => {
    withFile(YAML, (f) => {
      expect(appendSpeciesAlias('배롱나무', '백일홍', f)).toBe(true);
      const out = fs.readFileSync(f, 'utf-8');
      expect(out).toContain('aliases: [백일홍나무, 흰배롱나무, 백일홍]');
      resetSpeciesCache();
      expect(findSpecies('백일홍', loadSpecies(f))?.name).toBe('배롱나무');
    });
  });

  it('aliases 줄이 없으면 latin 다음에 만든다', () => {
    withFile(YAML, (f) => {
      expect(appendSpeciesAlias('밤나무', '알밤나무', f)).toBe(true);
      const out = fs.readFileSync(f, 'utf-8');
      expect(out).toContain('    latin: Castanea crenata\n    aliases: [알밤나무]');
      // 옆 블록을 건드리지 않았다
      expect(out).toContain('aliases: [백일홍나무, 흰배롱나무]');
    });
  });

  it('다른 소재 블록을 건드리지 않는다', () => {
    withFile(YAML, (f) => {
      appendSpeciesAlias('배롱나무', '백일홍', f);
      const list = loadSpecies(f);
      expect(list.find((s) => s.name === '밤나무')?.aliases ?? []).toEqual([]);
    });
  });

  it('이미 있으면 아무것도 안 한다', () => {
    withFile(YAML, (f) => {
      const before = fs.readFileSync(f, 'utf-8');
      expect(appendSpeciesAlias('배롱나무', '흰배롱나무', f)).toBe(false);
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  it('없는 소재·빈 값은 false — 파일을 건드리지 않는다', () => {
    withFile(YAML, (f) => {
      const before = fs.readFileSync(f, 'utf-8');
      expect(appendSpeciesAlias('없는나무', '무엇', f)).toBe(false);
      expect(appendSpeciesAlias('', '무엇', f)).toBe(false);
      expect(appendSpeciesAlias('배롱나무', '', f)).toBe(false);
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });

  it('자동으로 붙은 별칭에 표시를 남긴다 — LLM 은 틀릴 수 있다', () => {
    // 실측: haiku 가 '도장나무'(회양목의 이명)를 참나무라고 답했다. 표시가 없으면
    // 사람이 무엇을 검토해야 할지 알 수 없다.
    withFile(YAML, (f) => {
      appendSpeciesAlias('배롱나무', '백일홍', f);
      const line = fs.readFileSync(f, 'utf-8').split('\n').find((l) => l.includes('# auto'))!;
      expect(line).toContain('# auto(사람 검토 전): 백일홍');
    });
  });

  it('두 번째 자동 별칭은 표시에 이어 붙는다 — 주석이 겹치지 않는다', () => {
    withFile(YAML, (f) => {
      appendSpeciesAlias('배롱나무', '백일홍', f);
      appendSpeciesAlias('배롱나무', '목백일홍', f);
      const out = fs.readFileSync(f, 'utf-8');
      const line = out.split('\n').find((l) => l.includes('aliases:') && l.includes('목백일홍'))!;
      expect(line).toContain('# auto(사람 검토 전): 백일홍, 목백일홍');
      expect((line.match(/# auto/g) ?? []).length).toBe(1); // 주석이 두 번 붙으면 안 된다
      resetSpeciesCache();
      // 주석이 붙어도 YAML 이 읽힌다
      const sp2 = loadSpecies(f).find((x) => x.name === '배롱나무')!;
      expect(sp2.aliases).toEqual(['백일홍나무', '흰배롱나무', '백일홍', '목백일홍']);
    });
  });

  it('덧붙인 뒤에도 YAML 이 멀쩡하다 — 다른 항목이 안 깨진다', () => {
    withFile(YAML, (f) => {
      appendSpeciesAlias('배롱나무', '백일홍', f);
      appendSpeciesAlias('밤나무', '알밤나무', f);
      resetSpeciesCache();
      const list = loadSpecies(f);
      expect(list.map((s) => s.name).sort()).toEqual(['밤나무', '배롱나무']);
      expect(list.find((s) => s.name === '배롱나무')?.latin).toBe('Lagerstroemia indica');
      expect(list.find((s) => s.name === '밤나무')?.type).toBe('활엽 교목');
    });
  });
});

describe('실제 사전으로 — 이 사건이 다시 나면 막힌다', () => {
  it('보관소 딱지로 들어올 법한 이름들이 규칙을 통과·거절한다', () => {
    resetSpeciesCache();
    // 실제 사전은 브랜드 런타임 데이터(git 비추적) — 같은 서식의 픽스처로 사건을 재현한다.
    const real = loadSpecies(fileURLToPath(new URL('./__fixtures__/species.yaml', import.meta.url)));
    resetSpeciesCache();
    // 통과해야 하는 것 — 사람이 실제로 적는 이명
    expect(checkAlias('목백일홍', '배롱나무', real).ok || findSpecies('목백일홍', real)?.name === '배롱나무').toBe(true);
    // 거절해야 하는 것 — 사전을 오염시킬 이름
    expect(checkAlias('배', '배나무', real).ok).toBe(false);
    expect(checkAlias('밤', '밤나무', real).ok).toBe(false);
    expect(checkAlias('묘목', '배나무', real, HORT_STOPWORDS).ok).toBe(false);
  });
});

describe('learnSpeciesLabel — 세 갈래 처리(주입 의존)', () => {
  const base = (over: Partial<Parameters<typeof learnSpeciesLabel>[1]> = {}) => {
    const calls = { alias: [] as string[][], species: [] as string[] };
    const deps = {
      list: () => LIST,
      known: (n: string) => LIST.some((s) => s.name === n || (s.aliases ?? []).includes(n)),
      ask: async () => ({ kind: 'unknown' }),
      addAlias: (n: string, a: string) => { calls.alias.push([n, a]); return true; },
      addSpecies: (e: { name: string }) => { calls.species.push(e.name); return true; },
      ...over,
    };
    return { deps, calls };
  };

  it('사전이 아는 이름이면 LLM 을 아예 안 부른다', async () => {
    let asked = 0;
    const { deps } = base({ ask: async () => { asked++; return {}; } });
    expect(await learnSpeciesLabel('배롱나무', deps)).toBeUndefined();
    expect(await learnSpeciesLabel('흰배롱나무', deps)).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('별칭으로 판정되면 그 소재에 붙인다 — 이 사건의 경로', async () => {
    const { deps, calls } = base({ ask: async () => ({ kind: 'alias', of: '배롱나무' }) });
    const msg = await learnSpeciesLabel('백일홍', deps);
    expect(calls.alias).toEqual([['배롱나무', '백일홍']]);
    expect(calls.species).toEqual([]);
    expect(msg).toContain('배롱나무');
  });

  it('위험한 별칭은 LLM 이 시켜도 거절한다 — 거절 규칙이 최종 관문', async () => {
    const { deps, calls } = base({ ask: async () => ({ kind: 'alias', of: '배나무' }) });
    const msg = await learnSpeciesLabel('배', deps);
    expect(calls.alias).toEqual([]);
    expect(msg).toContain('보류');
  });

  it('처음 보는 식물은 새 항목으로 넣는다', async () => {
    const { deps, calls } = base({ ask: async () => ({ kind: 'new', latin: 'Ficus carica', leaf: '어긋나기' }) });
    await learnSpeciesLabel('무화과', deps);
    expect(calls.species).toEqual(['무화과']);
    expect(calls.alias).toEqual([]);
  });

  it('확신 없으면 아무것도 안 쓴다 — 추측이 사전에 남으면 계속 틀린다', async () => {
    const { deps, calls } = base({ ask: async () => ({ kind: 'unknown' }) });
    const msg = await learnSpeciesLabel('무엇인가', deps);
    expect(calls.alias).toEqual([]); expect(calls.species).toEqual([]);
    expect(msg).toContain('보류');
  });

  it('LLM 이 터져도 조용히 끝난다 — 업로드가 실패하면 안 된다', async () => {
    const { deps, calls } = base({ ask: async () => { throw new Error('boom'); } });
    expect(await learnSpeciesLabel('백일홍', deps)).toBeUndefined();
    expect(calls.alias).toEqual([]); expect(calls.species).toEqual([]);
  });

  it('빈 딱지는 아무 일도 안 한다', async () => {
    let asked = 0;
    const { deps } = base({ ask: async () => { asked++; return {}; } });
    expect(await learnSpeciesLabel('   ', deps)).toBeUndefined();
    expect(asked).toBe(0);
  });
});
