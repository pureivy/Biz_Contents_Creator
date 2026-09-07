/**
 * 사용자 첨부 실사진의 씬 배정(2026-09-04).
 *
 * 이 채널의 오랜 약점은 화면이 전부 생성 이미지라는 것이었다. 8월에 "실사진이 지금 당장 없다"고
 * 해서 I2V·필름룩으로 우회했지만, 실제로 찍은 사진 한 장이 그 모든 우회보다 낫다.
 *
 * 두 갈래로 쓴다.
 *  (가) 배경으로 직접 — 배정된 씬은 생성하지 않고 그 사진을 쓴다. 생성비도 그만큼 준다.
 *  (나) 스타일 레퍼런스로 — 나머지 씬은 그 사진들의 색·빛·질감을 참고해 생성한다.
 *      한두 장만 올려도 전 씬의 톤이 그 사진에 맞춰진다.
 */

/** 씬 배정 결과 — index 는 씬 번호(0-base), null 은 생성으로 남김. */
export type AssetPlan = ReadonlyArray<string | null>;

/**
 * 사진을 씬에 배정한다(순수).
 *
 * 배정 규칙은 단순하게 둔다 — 사진이 어느 씬에 어울리는지는 비전이 판단할 일이고, 여기서는
 * '몇 장을 어디에 놓을까'만 정한다. 앞에서부터 채우되 훅(0)을 먼저 준다: 첫 프레임이 곧 커버라
 * 실사진이 커버가 되면 '생성 이미지 채널'이라는 인상이 가장 크게 깎인다.
 *
 * 전 씬을 실사진으로 덮지는 않는다 — 사진이 씬 내용과 안 맞으면 생성본만 못하다. 상한은 씬의
 * 절반(올림)이고, 그 이상 올려도 나머지는 스타일 레퍼런스로만 쓰인다.
 */
export function planAssetScenes(assets: readonly string[], sceneCount: number, order?: readonly number[]): AssetPlan {
  const out: Array<string | null> = Array.from({ length: Math.max(0, sceneCount) }, () => null);
  if (!assets.length || sceneCount <= 0) return out;
  const cap = Math.min(assets.length, Math.ceil(sceneCount / 2));
  // 배정 순서 — 지정이 없으면 훅부터 앞에서 차례로.
  const seq = (order?.length ? order : Array.from({ length: sceneCount }, (_, i) => i))
    .filter((i) => Number.isInteger(i) && i >= 0 && i < sceneCount);
  const seen = new Set<number>();
  let k = 0;
  for (const idx of seq) {
    if (k >= cap) break;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out[idx] = assets[k++]!;
  }
  return out;
}

/**
 * 내용 기준 배정을 planAssetScenes 가 받는 (사진 순서, 씬 순서) 쌍으로 편다(순수, 2026-09-04).
 *
 * planAssetScenes 는 "사진 목록을 씬 순서대로 하나씩 꽂는" 함수다. 그래서 "3번 사진은 2번 씬"
 * 같은 배정을 그대로 못 받는다. 여기서 두 배열의 순서를 맞춰 준다 — 배정된 사진을 앞으로 당기고,
 * 씬 순서도 같은 차례로 놓는다. 배정 없는 사진은 뒤에 붙고 종전 순서(훅부터)로 채워진다.
 */
export function orderAssetsByAssignment(
  assets: readonly string[], at: ReadonlyMap<string, number>, sceneCount: number,
): { assets: string[]; order: number[] } {
  const taken = new Set<number>();
  const head: Array<{ file: string; scene: number }> = [];
  for (const f of assets) {
    const i = at.get(f);
    if (!Number.isInteger(i) || i! < 0 || i! >= sceneCount || taken.has(i!)) continue;
    taken.add(i!);
    head.push({ file: f, scene: i! });
  }
  head.sort((a, b) => a.scene - b.scene);
  const rest = assets.filter((f) => !head.some((h) => h.file === f));
  const tail = Array.from({ length: sceneCount }, (_, i) => i).filter((i) => !taken.has(i));
  return { assets: [...head.map((h) => h.file), ...rest], order: [...head.map((h) => h.scene), ...tail] };
}

/** 배정되지 않은 사진 — 스타일 레퍼런스로 넘긴다(생성 API 의 refImages 상한 4장). */
export function styleRefs(assets: readonly string[], plan: AssetPlan, max = 4): string[] {
  const used = new Set(plan.filter((x): x is string => !!x));
  const rest = assets.filter((a) => !used.has(a));
  // 배정된 사진도 톤의 기준이므로, 남는 게 없으면 배정분에서 앞쪽 몇 장을 참조로 재사용한다.
  return (rest.length ? rest : assets.slice()).slice(0, max);
}

/** 씬 길이 대비 영상이 이만큼은 되어야 배정한다. 이보다 짧으면 감속 배율이 0.5 밑으로 떨어져
 *  실촬영 영상이 '고장 난 슬로모션'으로 보인다(렌더러는 클립 한 번으로 씬을 덮으려 속도를 낮춘다). */
export const MIN_CLIP_COVERAGE = 0.5;

/** 씬 하나에 넣을 영상 구간 — 원본 경로와 그 안에서 잘라 쓸 위치. */
export interface VideoSegment {
  readonly path: string;
  /** 원본에서 이 구간이 시작하는 지점(초). */
  readonly startSec: number;
  /** 이 구간의 길이(초). */
  readonly seconds: number;
}

/**
 * 첨부 영상을 씬에 배정한다(순수).
 *
 * 규칙은 하나다 — **영상 하나는 씬 하나**(사용자 확정 2026-09-04).
 *
 * 한때 한 영상을 여러 구간으로 쪼개 여러 씬에 넣어 봤다. 23초짜리가 6초 씬 하나만 덮고 나머지가
 * 버려지는 게 아까웠기 때문이다. 실측 결과가 분명했다: 넓게 찍은 하우스 밭 영상 하나가 5씬 중
 * 3씬을 먹으니 가운데 11초가 한 장면처럼 이어졌고, 그중 둘은 클로즈업을 설명하는 대목이라
 * 화면과 말이 겉돌았다. 단조로움을 지우려고 시작한 일인데 단조로움을 만들었다. 아까운 것보다
 * 어긋나는 것이 나쁘다.
 *
 * 지키는 것:
 *  · 훅(0)은 비운다 — 영상 첫 프레임은 대개 정지 상태라 커버로 약하다.
 *  · 씬 길이의 MIN_CLIP_COVERAGE 에 못 미치는 영상은 안 쓴다 — 과한 감속은 결함으로 보인다.
 *  · prefer(감독이 내용을 보고 고른 자리)가 길이보다 우선한다. 배정을 못 받은 영상만 길이로 채운다.
 *
 * 구간은 언제나 영상 앞에서 뗀다. 어디를 쓸지는 사람이 올릴 때 이미 정한 것이고, 코드가 중간
 * 어딘가를 골라야 할 근거가 없다.
 */
export function planVideoSegments(
  videos: ReadonlyArray<{ path: string; seconds: number }>,
  sceneSeconds: readonly number[],
  prefer: ReadonlyMap<string, number> = new Map(),
): ReadonlyArray<VideoSegment | null> {
  const out: Array<VideoSegment | null> = sceneSeconds.map(() => null);
  if (!videos.length || !sceneSeconds.length) return out;
  const pool = videos.filter((v) => v.path && v.seconds > 0);
  if (!pool.length) return out;
  const claimed = new Set<number>();
  const used = new Set<string>();
  const fits = (v: { seconds: number }, sec: number): boolean => v.seconds >= sec * MIN_CLIP_COVERAGE;
  const place = (v: { path: string; seconds: number }, i: number): void => {
    out[i] = { path: v.path, startSec: 0, seconds: Math.min(sceneSeconds[i]!, v.seconds) };
    claimed.add(i);
    used.add(v.path);
  };

  // 0) 내용으로 정해진 자리 먼저 — 감독이 대본과 소재 설명을 나란히 놓고 고른 것.
  for (const [file, at] of prefer) {
    const v = pool.find((x) => x.path === file);
    if (!v || used.has(file)) continue;
    if (!Number.isInteger(at) || at <= 0 || at >= sceneSeconds.length || claimed.has(at)) continue;
    if (!fits(v, sceneSeconds[at]!)) continue;
    place(v, at);
  }

  // 1) 배정을 못 받은 영상만 길이로 채운다 — 내용을 본 판단이 있는데 길이가 덮어쓰면 안 된다.
  //    긴 씬부터(채울 영상을 고르기 어려운 쪽부터), 감속이 가장 작은 영상을 고른다.
  const rest = pool.filter((v) => !prefer.has(v.path) && !used.has(v.path));
  if (rest.length) {
    const order = sceneSeconds
      .map((sec, i) => ({ i, sec }))
      .filter((x) => x.i > 0 && !claimed.has(x.i))
      .sort((a, b) => b.sec - a.sec);
    for (const { i, sec } of order) {
      const avail = rest.filter((v) => !used.has(v.path) && fits(v, sec));
      if (!avail.length) break;
      // 씬을 통째로 덮는 것 중 가장 짧은 것(여유가 큰 영상은 더 긴 씬에 남긴다),
      // 없으면 하한을 넘는 것 중 가장 긴 것(감속 폭이 가장 작다).
      const exact = avail.filter((v) => v.seconds >= sec).sort((a, b) => a.seconds - b.seconds)[0];
      place(exact ?? avail.sort((a, b) => b.seconds - a.seconds)[0]!, i);
    }
  }
  return out;
}
