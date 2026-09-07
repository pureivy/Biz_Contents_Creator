/**
 * 편집 기법 뽑기(2026-09-04) — 편마다 '쓰는 기술 자체'가 달라지게.
 *
 * 종전엔 파라미터만 갈렸다. 실측: 8편을 돌려 보면 '사용된 기술 목록'이 2가지 조합뿐이었고,
 * 매 편 같은 9종(필름룩·자막모션·켄번즈·드리프트·컷빛샘·진행바·캘리·스포트라이트·파티클)을 썼다.
 * 색과 리듬이 달라도 '무엇을 쓰는가'가 같으면 편집 방식이 하나로 읽힌다.
 *
 * 그래서 선택 기법 풀을 두고 편마다 2가지를 뽑는다. 조합만 10가지이고, 각 기법 안에서 또
 * 파라미터가 갈린다.
 *
 * 풀에 넣는 기준은 두 가지다.
 *  · 씬 길이를 안 바꾼다 — 낭독이 길이를 지배한다는 불변식은 절대 못 건드린다.
 *  · 화면의 '어디'를 알 필요가 없다 — 가리키기 도해를 철회했던 이유다(작가는 이미지를 못 본다).
 *    레터박스·듀오톤처럼 화면 전체에 거는 것만 넣는다.
 */
import { random } from 'remotion';

export type EditTechnique = '레터박스' | '흑백 인서트' | '정지 강조' | '테두리 프레임' | '비네트 호흡';
export const EDIT_TECHNIQUES: readonly EditTechnique[] = [
  '레터박스', '흑백 인서트', '정지 강조', '테두리 프레임', '비네트 호흡',
];
/** 한 편이 뽑는 기법 수 — 2개. 하나면 티가 안 나고, 셋이면 서로 싸운다. */
export const TECHNIQUES_PER_VIDEO = 2;

/**
 * 편 시드 → 뽑힌 기법 집합(순수·결정적·중복 없음).
 * 같은 편은 재렌더해도 같은 기법을 받는다.
 */
export function pickTechniques(seed: string, count = TECHNIQUES_PER_VIDEO): EditTechnique[] {
  const pool = [...EDIT_TECHNIQUES];
  const out: EditTechnique[] = [];
  // 상한을 루프 밖에서 고정한다 — 안에서 pool.length 를 다시 읽으면 splice 로 줄어든 길이가
  // 상한까지 끌어내려 요청한 개수보다 적게 뽑힌다(테스트가 5개 요청에 3개를 잡아냈다).
  const want = Math.min(count, pool.length);
  for (let i = 0; i < want; i++) {
    const k = Math.floor(random(`${seed}:tech:${i}`) * pool.length) % pool.length;
    out.push(pool.splice(k, 1)[0]!);
  }
  return out;
}

/**
 * 실촬영 화면에 걸면 안 되는 기법(2026-09-04 실측).
 *
 * 사장님이 찍어 올린 사계장미 영상이 하필 '흑백 인서트'가 걸린 씬에 들어가 흑백으로 나갔다.
 * 실촬영을 쓰는 값어치는 화면이 진짜로 보이는 데 있는데 색을 빼면 그게 사라진다. '정지 강조'도
 * 같은 이유로 뺀다 — 실제로 찍은 화면을 세워 두면 영상을 쓴 이유 자체가 없어진다.
 * 나머지(레터박스·테두리·비네트)는 화면 위에 얹히기만 하므로 실촬영에도 무해하다.
 */
export const TECHNIQUES_UNSAFE_ON_REAL: readonly EditTechnique[] = ['흑백 인서트', '정지 강조'];

/**
 * 기법이 걸릴 씬 번호(순수) — 씬마다 다 걸면 기법이 아니라 필터가 된다.
 * 훅(0)은 뺀다: 첫 프레임이 곧 커버라 여기를 건드리면 커버가 바뀐다(2026-09-03 실사고).
 *
 * realScenes 는 실촬영 화면이 들어간 씬 번호다. 파괴적인 기법은 그 씬을 피해서 고르고,
 * 피할 자리가 없으면 아예 안 건다(-1) — 억지로 거느니 안 거는 편이 낫다.
 */
export function techniqueScene(
  seed: string, tech: EditTechnique, sceneCount: number, realScenes: ReadonlySet<number> = new Set(),
): number {
  if (sceneCount <= 2) return -1; // 본문이 없으면 걸 자리도 없다
  const body: number[] = [];
  const avoid = TECHNIQUES_UNSAFE_ON_REAL.includes(tech);
  for (let i = 1; i < sceneCount - 1; i++) if (!(avoid && realScenes.has(i))) body.push(i); // 훅·CTA 제외
  if (!body.length) return -1;
  return body[Math.floor(random(`${seed}:techscene:${tech}`) * body.length) % body.length]!;
}
