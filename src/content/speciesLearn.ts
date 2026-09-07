/**
 * 보관소 딱지로 수종 사전을 배운다(2026-09-05) — 사장님이 소재에 적어 둔 이름이 곧 근거다.
 *
 * 왜 필요한가. 사장님이 '백일홍' 딱지로 올린 영상이 '배롱나무 묘목' 편에서 배제됐다. 같은
 * 나무인데 사전의 별칭 표에 그 이름이 없었다. 사람이 매번 사전을 고치게 두면 같은 일이
 * 반복된다 — 소재를 올리는 순간이 그 이름을 배울 가장 좋은 시점이다.
 *
 * 왜 '새 수종 추가'로는 안 되는가(중요). appendSpecies 는 학명이 겹치면 건너뛴다. 백일홍의
 * 학명은 Lagerstroemia indica 로 배롱나무와 같으므로, 새 수종으로 넣으려 하면 조용히
 * 아무 일도 안 하고 끝난다. 이번 사고를 만든 그 경로다. 그래서 배워야 할 것은 '별칭'이다.
 *
 * 세 갈래로 나뉜다:
 *   1. 사전이 이미 아는 이름 → 할 일 없음
 *   2. 아는 수종의 다른 이름  → 그 수종의 aliases 에 덧붙인다  ← 이번 사고가 여기였다
 *   3. 정말 처음 보는 식물   → 새 항목으로 넣는다(auto·verified:false)
 *
 * 2와 3을 가르는 데는 지식이 필요해서 LLM 이 판정한다. 실패는 전부 삼킨다 — 사전을 못
 * 배웠다고 업로드가 실패하면 안 된다.
 */
import type { Species } from './species';
import { normalizeLatinName } from './species';

/**
 * 별칭으로 써도 되는 이름인가(순수) — 이 파일에서 가장 중요한 함수다.
 *
 * findSpecies 는 `text.includes(key)` 다. 짧은 별칭 하나가 사전 전체를 망가뜨린다:
 * '배'를 넣으면 "배수·배치·배양토"가 전부 배나무가 되고, '밤'을 넣으면 "한밤중 물주기"가
 * 밤나무가 된다. 그러면 주제→수종 판정이 프로젝트 전체에서 틀어진다 — 소재 매칭만의
 * 문제가 아니다.
 *
 * 사람이 커밋하는 별칭은 테스트가 지킨다(species.test.ts 의 충돌 검사). 그러나 여기서
 * 자동으로 쓰는 별칭은 그 테스트를 거치지 않는다. 그래서 검사를 런타임으로 가져온다.
 * 애매하면 거절한다 — 별칭 하나를 놓치는 비용보다 사전이 오염되는 비용이 훨씬 크다.
 */
export const ALIAS_MIN_LENGTH = 2;

/** 원예 문장에 흔히 나오는 말 — 수종 이름으로 오면 사전을 오염시킨다. */
export const ALIAS_STOPWORDS: readonly string[] = [
  '나무', '묘목', '모종', '식물', '수목', '조경수', '정원수', '유실수', '관목', '교목',
  '열매', '과일', '꽃', '잎', '가지', '뿌리', '줄기', '수피', '씨앗', '종자',
  '심기', '전정', '가지치기', '관리', '물주기', '거름', '비료', '분갈이', '화분',
  '봄', '여름', '가을', '겨울', '정원', '텃밭', '화단', '울타리', '생울타리',
];

export interface AliasVerdict { ok: boolean; reason?: string }

/**
 * @param alias  붙이려는 별칭(사장님이 소재에 적은 이름)
 * @param target 이 별칭을 붙일 수종의 표준명
 * @param list   현재 사전 전체
 */
export function checkAlias(alias: string, target: string, list: readonly Species[]): AliasVerdict {
  const a = String(alias ?? '').trim();
  const t = String(target ?? '').trim();
  if (!a) return { ok: false, reason: '빈 이름' };
  if (!t) return { ok: false, reason: '붙일 수종이 없음' };
  if (a === t) return { ok: false, reason: '표준명과 같음' };
  if (a.length < ALIAS_MIN_LENGTH) {
    return { ok: false, reason: `${ALIAS_MIN_LENGTH}자 미만 — 한 글자는 아무 문장에나 걸린다` };
  }
  if (ALIAS_STOPWORDS.includes(a)) return { ok: false, reason: '원예 일반 표현' };

  // 대상 수종이 사전에 있어야 별칭을 붙일 수 있다
  const targetSp = list.find((s) => s.name === t);
  if (!targetSp) return { ok: false, reason: `사전에 없는 수종(${t})` };

  // 대상 수종이 이미 가진 이름들 — 이 이름들과의 포함 관계는 문제가 아니다(같은 나무니까)
  const own = new Set<string>([targetSp.name, ...(targetSp.aliases ?? [])]);
  if (own.has(a)) return { ok: false, reason: '이미 있음' };

  for (const sp of list) {
    for (const key of [sp.name, ...(sp.aliases ?? [])]) {
      if (!key || own.has(key)) continue;
      // 별칭이 '다른 수종 이름의 일부'면, 그 수종 문장이 이 별칭에 걸린다.
      // 예: '나무'는 배롱나무·밤나무 안에 다 들어 있다.
      if (key.includes(a)) return { ok: false, reason: `다른 수종 이름에 포함됨(${key})` };
      // 별칭이 '다른 수종 이름을 품고' 있으면, 더 긴 이름이 이겨서 그 수종을 가로챈다.
      // 예: '수국비료'를 다른 종 별칭으로 넣으면 수국 이야기가 그쪽으로 끌려간다.
      if (a.includes(key)) return { ok: false, reason: `다른 수종 이름을 품음(${key})` };
    }
  }
  return { ok: true };
}

/** LLM 판정 결과 — 보관소 딱지 하나를 어떻게 처리할지. */
export interface LabelVerdict {
  kind: 'alias' | 'new' | 'unknown';
  /** kind==='alias' 일 때 어느 수종의 다른 이름인지(표준명). */
  of?: string;
  latin?: string;
  type?: string;
  leaf?: string;
  form?: string;
  flower?: string;
  fruit?: string;
}

/** LLM 에게 물을 문장(순수) — 사전이 아는 이름을 전부 보여 주고 그 안에서 고르게 한다. */
export function labelQuestion(label: string, list: readonly Species[]): string {
  const known = list.map((s) => {
    const al = (s.aliases ?? []).length ? `(${(s.aliases ?? []).join(', ')})` : '';
    return `- ${s.name} ${al} = ${s.latin}`;
  }).join('\n');
  return [
    `운영자가 브랜드 소재 보관소의 사진·영상에 "${label}" 이라는 이름을 직접 적어 올렸다.`,
    '이 이름이 아래 사전에 있는 소재(수종·품종 등)의 다른 이름인지, 아니면 사전에 없는 새 소재인지 판정하라.',
    '',
    '[사전에 있는 소재]',
    known,
    '',
    '판정 기준',
    `- "${label}" 이 위 목록에 있는 소재를 부르는 다른 이름(이명·상품명·지역명)이면 kind="alias", of=그 소재의 표준명.`,
    '- 위 목록에 없는 별개의 소재면 kind="new" 로 하고 학명(식물이 아니면 영문 표준명)과 형태를 적어라.',
    '- 무엇인지 확신이 없으면 kind="unknown". 추측하지 마라.',
    '',
    '형태를 적을 때는 긍정문만 써라. "손바닥 모양이 아니다" 같은 부정문은 쓰지 마라 —',
    '이미지 모델이 부정을 못 다뤄 오히려 그 형태를 그린다. 무엇인지만 적어라.',
    '',
    'JSON 으로만 답하라:',
    '{"kind":"alias|new|unknown","of":"표준명","latin":"속명 종소명",',
    ' "type":"활엽 교목 등","leaf":"잎차례와 모양","form":"수형","flower":"시기·색·꽃차례","fruit":"시기·색·모양"}',
  ].join('\n');
}

/** LLM 응답(파싱된 객체)을 안전한 판정으로 좁힌다(순수). 사전에 없는 of 는 unknown 으로 떨어뜨린다. */
export function readVerdict(raw: unknown, list: readonly Species[]): LabelVerdict {
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = String(o[k] ?? '').trim();
    return v ? v.slice(0, 200) : undefined;
  };
  const kind = String(o['kind'] ?? '').trim();
  if (kind === 'alias') {
    const of = str('of');
    // 사전에 실제로 있는 수종이어야 한다 — LLM 이 지어낸 표준명에 별칭을 붙이면 안 된다
    if (of && list.some((s) => s.name === of)) return { kind: 'alias', of };
    return { kind: 'unknown' };
  }
  if (kind === 'new') {
    // LLM 은 "Citrus japonica (Fortunella japonica)" 처럼 이명을 괄호로 덧붙인다(실측 2026-09-06).
    // 이 값이 그대로 이미지 프롬프트의 종 앵커가 되므로 여기서 '속명 종소명'으로 좁힌다.
    const latin = normalizeLatinName(str('latin') ?? '');
    if (!latin) return { kind: 'unknown' }; // 학명 없이는 앵커 값이 없다
    return {
      kind: 'new', latin,
      ...(str('type') ? { type: str('type') } : {}),
      ...(str('leaf') ? { leaf: str('leaf') } : {}),
      ...(str('form') ? { form: str('form') } : {}),
      ...(str('flower') ? { flower: str('flower') } : {}),
      ...(str('fruit') ? { fruit: str('fruit') } : {}),
    };
  }
  return { kind: 'unknown' };
}

/**
 * 보관소 딱지 하나로 사전을 배운다(부수효과 — 파일을 고치고 LLM 을 부른다).
 *
 * 순수부(checkAlias·readVerdict)와 나눈 이유는 이 파일의 나머지와 같다: 판정은 테스트로
 * 고정하고, 여기서는 물어보고 쓰기만 한다.
 *
 * 실패는 전부 삼킨다. 사전을 못 배웠다고 업로드가 실패하면 안 된다 — 소재는 이미 저장됐고,
 * 사전은 없어도 매칭이 돌아간다(주제 문장 폴백). 여기는 '더 좋아지는' 경로지 필수 경로가 아니다.
 *
 * @returns 사람에게 보여 줄 한 줄. 아무 일도 안 했으면 undefined.
 */
export async function learnSpeciesLabel(
  label: string,
  deps: {
    list: () => readonly Species[];
    ask: (question: string) => Promise<unknown>;
    known: (name: string) => boolean;
    addAlias: (name: string, alias: string) => boolean;
    addSpecies: (e: { name: string; latin: string; type?: string; leaf?: string; form?: string; flower?: string; fruit?: string }) => boolean;
    log?: (msg: string) => void;
  },
): Promise<string | undefined> {
  const name = String(label ?? '').trim();
  if (!name) return undefined;
  try {
    if (deps.known(name)) return undefined; // 사전이 이미 아는 이름 — 할 일 없음
    const list = deps.list();
    const v = readVerdict(await deps.ask(labelQuestion(name, list)), list);

    if (v.kind === 'alias' && v.of) {
      const gate = checkAlias(name, v.of, list);
      if (!gate.ok) {
        const msg = `수종 별칭 보류 — '${name}' → ${v.of} (${gate.reason})`;
        deps.log?.(msg);
        return msg;
      }
      if (deps.addAlias(v.of, name)) return `수종 별칭 학습 — '${name}' 은 ${v.of} 의 다른 이름`;
      return undefined;
    }

    if (v.kind === 'new' && v.latin) {
      if (deps.addSpecies({ name, latin: v.latin, ...(v.type ? { type: v.type } : {}), ...(v.leaf ? { leaf: v.leaf } : {}), ...(v.form ? { form: v.form } : {}), ...(v.flower ? { flower: v.flower } : {}), ...(v.fruit ? { fruit: v.fruit } : {}) })) {
        return `수종 사전 추가 — ${name} (${v.latin}) · 형태 미검토`;
      }
      return undefined;
    }

    const msg = `소재 판정 보류 — '${name}' 이 무엇인지 확실치 않다`;
    deps.log?.(msg);
    return msg;
  } catch { return undefined; } // fail-open — 사전 학습 실패가 업로드를 막지 않는다
}
