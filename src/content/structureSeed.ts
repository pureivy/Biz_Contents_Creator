/**
 * 런별 구조 시드(2026-08-27 권고 4 — 골격 다양화).
 *
 * 문제: 작가·기획 프롬프트가 골격을 **자리까지 고정**해 놨다(중심 명제 인용은 "도입 훅 직후", 프레임
 * 체크리스트는 "글당 1곳"). 문구를 아무리 다양화해도 글의 뼈대가 매편 같은 자리에 같은 순서로 서서
 * "같은 사람이 같은 틀로 찍어낸 글" 인상이 남았다(말투 감사 §3).
 *
 * 해법: 런마다 골격을 한 벌 뽑아(시드) 프롬프트에 [이번 글 구조] 로 주입한다. 시드 한 벌은 블로그(도입 유형·
 * 중심 명제 인용 위치·표/체크리스트/예고 온오프)와 파생물(카드 본문 줄 수·해시태그 수·쇼츠 씬 수) 값을
 * 모두 담지만, **한 세트가 같은 시드를 공유하지는 않는다** — 카드·쇼츠 잡은 각자 currentStructureSeed() 로
 * 새로 뽑아 자기 필드만 읽는다. 그래서 블로그 런이 남긴 cardLines·hashtags·shortsScenes 는 읽히지 않는다.
 *
 * 불변식:
 *  - 선택 블록(표·체크리스트·예고)은 **정확히 2개만** true — 셋 다 켜면 지금과 같은 만능 골격이 되고,
 *    하나만 켜면 글이 앙상해진다.
 *  - 예고는 "결론을 다음 편으로 미루기"가 아니다(결론 의무는 보호 자산). 켜져도 '마무리를 완결한 뒤
 *    맨 끝 한 줄' 까지만 허용한다. 이 한 줄과 genreGuide 의 '예고로 닫지 마라' 는 같은 프롬프트에 함께
 *    들어가면 정면 충돌하므로, 예고가 켜진 런에서는 buildGenreGuide(axes, teaser) 가 그 문장을 뺀다
 *    (org.ts — Fix round 2026-08-27). 결론을 미루지 말라는 제약은 위 괄호 문구가 계속 건다.
 *  - 킬스위치 STRUCTURE_VARIETY=off → 새로 '뽑는' 자리(currentStructureSeed/resolveStructureSeed)만
 *    FIXED_STRUCTURE_SEED 고정(종전 동작). 이미 기록된 시드를 '읽는' 승계는 킬스위치와 무관하다.
 */
import { CONFIG } from '../config';
import { readStructureSeed, writeStructureSeed } from '../sessions/digest';

/** 중심 명제 인용(">> " 따옴표)을 놓을 자리. 'none' 이면 이번 글엔 쓰지 않는다. */
export type ThesisQuotePos = 'none' | 'after-hook' | 'mid' | 'before-close';
/** 도입 훅의 유형 — 장면/질문/주장/대비. */
export type OpenerKind = 'scene' | 'question' | 'claim' | 'contrast';

export interface StructureSeed {
  thesisQuote: ThesisQuotePos;
  /** 마크다운 비교표를 쓸지. */
  table: boolean;
  /** ">>> " 프레임(마무리 요약·행동 체크리스트 박스)을 쓸지. */
  checklist: boolean;
  /** 마무리 뒤 다음 편 예고 한 줄을 붙일지. */
  teaser: boolean;
  openers: OpenerKind;
  /** 카드뉴스 본문 장 body 줄 수. */
  cardLines: 2 | 3 | 4 | 5;
  /** 카드뉴스 해시태그 개수(10~15). */
  hashtags: number;
  /** 쇼츠 씬 수(4~6). */
  shortsScenes: 4 | 5 | 6;
}

const THESIS: readonly ThesisQuotePos[] = ['none', 'after-hook', 'mid', 'before-close'];
const OPENERS: readonly OpenerKind[] = ['scene', 'question', 'claim', 'contrast'];

/**
 * 킬스위치 off 시의 고정 시드 = 2026-08-27 이전 동작.
 *  - thesisQuote 'after-hook' : 구 문구 "도입 훅 직후가 최적"
 *  - table+checklist true, teaser false : 구 문구는 표·프레임을 권하고 예고는 금지했다("이 글 안에서 완결")
 *  - openers 'question' : 구 문구의 도입 처방("독자의 상황·질문으로 바로 시작한다" — 지금은 이 블록에 위임)
 *  - cardLines 4 / hashtags 12 : 카드 프롬프트에 수치 지시가 없던 자리의 기본값(계획서 지정값)
 *  - shortsScenes 5 : 40초 상한에서 구 계산(min(6, 8, floor(40/8))) 이 내던 실제 값
 */
export const FIXED_STRUCTURE_SEED: StructureSeed = {
  thesisQuote: 'after-hook',
  table: true,
  checklist: true,
  teaser: false,
  openers: 'question',
  cardLines: 4,
  hashtags: 12,
  shortsScenes: 5,
};

/** rand() 가 1 을 돌려줘도 인덱스가 넘치지 않게 클램프(테스트 경계값). */
const pick = <T>(arr: readonly T[], r: number): T => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))]!;
const int = (lo: number, hi: number, r: number): number => Math.min(hi, lo + Math.floor(r * (hi - lo + 1)));

/** 시드 한 벌을 뽑는다(순수 — rand 주입으로 테스트 가능). */
/**
 * 전방 갭(Fix wave 2026-08-27 소견 7, 기록용) — teaser 가 켜지는 런은 2/3(off 가 균등 3택이라)인데,
 * **블로그 예고는 예고 이행 루프가 잡지 않는다**: promiseStore().create 호출부는 cardnews·shorts(그리고
 * 수동 등록)뿐이고 블로그 경로에는 next 수집이 없다. 즉 그 한 줄은 약속으로 기록되지도, 시즌 창에
 * 이행되지도 않는다. 회귀는 아니다 — 금지 지시가 있던 때에도 실측 10/10편이 예고로 닫혔고, 이번 시드는
 * 그 비율을 2/3 로 낮추면서 '결론을 예고로 미루지 마라' 제약을 새로 붙였다.
 * 닫으려면 (a) 블로그 포장 단계에서 마무리 예고 문장을 뽑아 promiseStore().create({sourceKind:'blog'}) 로
 * 등록하거나 (b) 이행 배선이 생길 때까지 teaser 를 상수 false 로 고정한다(선택 블록은 표·체크리스트 2택).
 * (b)는 '선택 블록 중 정확히 2개만 true' 불변식을 다시 써야 하므로 배선(a) 쪽이 자연스럽다.
 */
export function pickStructureSeed(rand: () => number): StructureSeed {
  const thesisQuote = pick(THESIS, rand());
  const openers = pick(OPENERS, rand());
  // 선택 블록은 '끌 하나'를 뽑는 방식 — 정확히 2개 true 가 구조적으로 보장된다.
  const off = int(0, 2, rand());
  return {
    thesisQuote,
    table: off !== 0,
    checklist: off !== 1,
    teaser: off !== 2,
    openers,
    cardLines: int(2, 5, rand()) as StructureSeed['cardLines'],
    hashtags: int(10, 15, rand()),
    shortsScenes: int(4, 6, rand()) as StructureSeed['shortsScenes'],
  };
}

/** 킬스위치를 본 시드 — off 면 고정 시드 사본(호출부가 변형해도 상수가 오염되지 않게 복사). */
export function currentStructureSeed(rand: () => number = Math.random): StructureSeed {
  return CONFIG.structureVariety ? pickStructureSeed(rand) : { ...FIXED_STRUCTURE_SEED };
}

/**
 * 새 집필 런의 시드 확정 — 뽑아서 sessions/<runId>/structure.json 에 남긴다(리비전이 승계).
 * 영속화 실패는 fail-open(부가 기록 실패로 런이 죽으면 안 된다, 스펙 §8).
 */
export function resolveStructureSeed(runId: string): StructureSeed {
  const seed = currentStructureSeed();
  try { writeStructureSeed(runId, seed); } catch { /* fail-open */ }
  return seed;
}

/**
 * 리비전 런의 시드 — **승계 전용**이다. 물려받을 시드가 없으면(이 기능 이전 런·기록 손상) null 을 돌려준다:
 * 초안에 없는 골격을 새로 뽑아 "유지하라"고 말하면 그건 유지가 아니라 재구성 지시다. 호출부는 null 일 때
 * STRUCTURE_KEEP_BLOCK(있는 그대로 두라)을 넣는다.
 * 승계분은 자기 런에도 남긴다 — 연쇄 리비전이 같은 골격을 물려받는다(브리프·사실 카드와 같은 패턴).
 * 킬스위치는 보지 않는다(Fix round 2026-08-27): STRUCTURE_VARIETY 는 시드를 '뽑는' 동작만 지배한다.
 * off 로 되돌린 뒤 다양화 시드로 쓰인 초안을 개정할 때 고정 시드를 끼워 넣으면, 초안에 없는 표·프레임을
 * "유지하라"고 말하는 셈이라 작가가 없던 구조를 새로 만든다. 기록이 있으면 승계, 없으면 null 이 양쪽 다 옳다.
 */
export function inheritStructureSeed(runId: string, baseRunId?: string): StructureSeed | null {
  const inherited = baseRunId ? readStructureSeed(baseRunId) : null;
  if (!inherited) return null;
  try { writeStructureSeed(runId, inherited); } catch { /* fail-open */ }
  return inherited;
}

/**
 * 골격 '유지' 블록 — 시드를 모르는 자리에 쓴다(승계 실패한 리비전, 지적만 고치는 수정 라운드).
 * BLOG_BODY_GUIDE 가 인용구·프레임·표를 [이번 글 구조] 에 위임하므로, 블록이 아예 없으면 작가는
 * "안 켜졌다"로 읽어 멀쩡한 프레임·표를 걷어낸다 — 그 공백을 이 문장이 막는다.
 */
export const STRUCTURE_KEEP_BLOCK =
  '[이번 글 구조] 이 글의 기존 골격을 그대로 유지한다 — 중심 명제 인용(">> ")·프레임 박스(">>> ")·표는 지금 초안에 있는 대로 두고, 이번 수정에서 새로 넣거나 빼지 마라.';

const OPENER_TEXT: Record<OpenerKind, string> = {
  scene: '장면 — 현장에서 눈에 보이는 한 장면(무엇이 어떻게 보이는지)으로 연다',
  question: '질문 — 독자가 실제로 던지는 질문 한 줄로 연다',
  claim: '주장 — 결론을 먼저 단정해 놓고 그 근거로 들어간다',
  contrast: '대비 — 흔한 통념을 먼저 놓고 어긋나는 지점을 짚으며 연다',
};

const THESIS_TEXT: Record<ThesisQuotePos, string> = {
  none: '쓰지 마라(이번 글은 0곳 — 중심 명제는 본문 문장으로 녹인다)',
  'after-hook': '도입 훅 직후에 1곳',
  mid: '본문 중간(가운데 소제목 근처)에 1곳',
  'before-close': '마무리 직전에 1곳',
};

/**
 * 작가 프롬프트에 넣을 [이번 글 구조] 블록. revise 모드는 '이렇게 써라'가 아니라 '이 골격을 유지하라'로
 * 말한다 — 리비전은 잘 쓰인 구조를 보존하는 것이 목적이라, 구성 지시문을 그대로 넣으면 재구성을 부른다.
 */
export function structureBlock(seed: StructureSeed, opts: { revise?: boolean } = {}): string {
  const head = opts.revise
    ? '[이번 글 구조] 이 글의 골격은 아래와 같다 — 개정하면서 이 골격을 유지하고, 요청과 무관한 구조 변경은 하지 마라.'
    : '[이번 글 구조] 이번 글에만 적용되는 골격이다 — 아래대로 쓰고, 꺼진 요소는 넣지 마라(매 글 같은 배치를 피하려는 지시다).';
  return [
    head,
    `- 도입 유형: ${OPENER_TEXT[seed.openers]}`,
    `- 중심 명제 인용(">> " 따옴표): ${THESIS_TEXT[seed.thesisQuote]}`,
    `- 표: ${seed.table ? '넣는다 — 비교·정리·수치 한 곳을 마크다운 표로' : '넣지 마라 — 비교·정리는 문장과 목록으로 푼다'}`,
    `- 체크리스트(">>> " 프레임): ${seed.checklist ? '넣는다 — 마무리 요약·행동 체크리스트 박스 1곳' : '넣지 마라 — 마무리는 문단으로 맺는다'}`,
    `- 예고: ${seed.teaser
      ? '마무리를 완결한 뒤, 맨 끝에 다음 편에서 이어 다룰 것 한 줄만(이 글의 결론을 예고로 미루지 마라)'
      : '넣지 마라 — 이 글 안에서 완결한다'}`,
  ].join('\n');
}
