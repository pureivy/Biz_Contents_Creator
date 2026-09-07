/**
 * 형제편 자산 승계(2026-09-03) — 같은 원고에서 채널별 편을 만들 때 비싼 상단을 공유한다.
 *
 * 종전엔 채널마다 완전히 독립된 런을 돌렸다. 대본(LLM)·씬 이미지(gpt-image)·I2V 클립(fal)·
 * 상단 캘리·썸네일이 전부 두 벌이었다. 편당 비용은 이미지가 지배한다 — 씬 5장이 $0.20~0.95,
 * 대본 LLM 이 $0.05, 낭독이 $0.07 수준이다. 즉 두 벌로 만들며 늘어난 돈의 대부분이 이미지다.
 *
 * 분리의 원래 근거는 "중복 콘텐츠로 찍히는 걸 피한다"였는데, 유튜브는 인스타 릴스를 볼 수 없다.
 * 플랫폼끼리 콘텐츠 지문을 공유하지 않으므로 그 근거는 성립하지 않았다. 실제로 문제였던 건
 * 채널 '안쪽'의 판박이였고, 그건 연출·촬영지시·제목 변주로 따로 고쳤다(한 벌을 만들든 두 벌을
 * 만들든 똑같이 유효하다).
 *
 * 낭독은 승계하지 않는다 — 편마다 작가가 다르고 작가마다 목소리가 다르다(사용자 확정 2026-09-03).
 * 낭독은 이미지의 1/3~1/10 값이라, 이걸 지키려고 승계를 포기할 이유가 없다.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 씬→이미지 매핑 파일 이름. 원편이 남기고 형제편이 읽는다.
 *
 * 왜 파일이 필요한가(2026-09-04 실사고). 종전엔 scenes/ 안의 파일을 이름순으로 정렬해 앞에서부터
 * 씬에 꽂았다. 전 씬을 생성하던 시절엔 그게 맞았다 — 파일 순서가 곧 씬 순서였다. 실촬영 씬은
 * 이미지를 아예 안 만들게 되면서 그 전제가 깨졌다: 5씬 중 3번이 실촬영이면 생성 파일은 네 개
 * (blog-image-01..04)이고, 이름순으로 꽂으면 3번 씬이 4번 씬 그림을 받고 마지막 씬은 빈다.
 * 실측에서 인스타편의 4·5번 씬 그림이 밀리고 마지막 씬이 그라데이션으로 나갔다.
 *
 * 파일 이름에 씬 번호를 새기는 방법도 있었지만, 이미지 생성 스크립트·씬 QA 재생성·수정요청
 * 재생성이 저마다 이름을 짓는다. 그 셋을 다 건드리는 것보다 매핑을 한 곳에 적어 두는 편이 좁다.
 */
export const SCENE_IMAGE_MAP = 'scene-images.json';

/** 승계 대상 — 파일 단위. 낭독(remotion/narr_*.mp3)은 일부러 제외한다(작가별 목소리 유지). */
export const INHERITED_FILES = ['plan.json', 'title-art.png', 'title-copy.json', 'thumbnail.jpg', 'thumb-qa-failed.json', SCENE_IMAGE_MAP] as const;
/** 승계 대상 — 디렉터리 단위. */
// scenes-retry·revise-imgs 도 옮긴다(2026-09-04) — 씬 QA 재생성본과 수정요청 재생성본이 여기 산다.
// 이걸 빼면 매핑이 가리키는 파일이 형제편에 없어 그 씬만 빈다.
export const INHERITED_DIRS = ['scenes', 'scenes-retry', 'revise-imgs', 'clips'] as const;

export interface InheritResult {
  /** 실제로 복사된 항목(로그·검증용). */
  copied: string[];
  /** 대본을 못 가져왔으면 승계 실패 — 호출부가 일반 생성으로 되돌아가야 한다. */
  ok: boolean;
}

/**
 * 원편 디렉터리의 자산을 형제편 디렉터리로 복사한다.
 *
 * 참조가 아니라 복사인 이유: 레코드가 자족적이어야 원편을 지워도 형제편이 살아남는다(테스트 쇼츠가
 * 수시로 정리되는 환경이다). 편당 ~14MB 는 이미지 재생성 비용보다 훨씬 싸다.
 *
 * thumb-qa-failed.json 도 함께 옮긴다 — 오타 미해결 썸네일을 물려받았으면 발행 게이트도 물려받아야
 * 한다. 이게 빠지면 형제편 경로로 검증 안 된 썸네일이 그대로 나간다.
 */
export function inheritShortsAssets(fromDir: string, toDir: string): InheritResult {
  const copied: string[] = [];
  if (!fs.existsSync(path.join(fromDir, 'plan.json'))) return { copied, ok: false };
  fs.mkdirSync(toDir, { recursive: true });
  for (const f of INHERITED_FILES) {
    const src = path.join(fromDir, f);
    try {
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(toDir, f));
      copied.push(f);
    } catch { /* 개별 실패는 건너뛴다 — plan.json 만 있으면 렌더는 된다 */ }
  }
  for (const d of INHERITED_DIRS) {
    const src = path.join(fromDir, d);
    try {
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(toDir, d), { recursive: true });
      copied.push(`${d}/`);
    } catch { /* 무해 — 이미지 없으면 렌더러가 그라데이션 폴백 */ }
  }
  return { copied, ok: true };
}


/**
 * 원편이 씬→이미지 매핑을 남긴다(편 폴더 기준 상대경로). 실패는 무해 — 위치 폴백.
 *
 * 파일명만 적었다가 실사고를 냈다(2026-09-04). 씬 이미지는 한 곳에만 있지 않다 —
 * 처음 생성분은 scenes/, 씬 QA 재생성분은 scenes-retry/, 수정요청 재생성분은 revise-imgs/ 에
 * 들어가고, 세 곳의 파일명이 똑같이 blog-image-01.png 로 겹친다. 실측: 씬3 이 QA 로 재생성돼
 * scenes-retry/blog-image-01.png 를 가리키는데 매핑엔 "blog-image-01.png" 만 남아, 읽는 쪽이
 * scenes/blog-image-01.png(=씬1 그림)를 집었다. 상대경로로 적어 그 충돌을 없앤다.
 */
export function writeSceneImageMap(dir: string, images: ReadonlyArray<string | null>): void {
  try {
    const rel = images.map((p) => {
      if (!p) return null;
      const r = path.relative(dir, p);
      // 편 폴더 밖(사용자 첨부 사진 등)은 매핑에 못 담는다 — 형제편에 그 파일이 없다.
      return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null;
    });
    fs.writeFileSync(path.join(dir, SCENE_IMAGE_MAP), JSON.stringify(rel), 'utf-8');
  } catch { /* 무해 — 없으면 위치 기준으로 읽는다 */ }
}

/**
 * 승계 디렉터리에서 씬 이미지 경로를 씬 순서대로 읽는다(없는 자리는 null).
 * 매핑 파일이 있으면 그걸 따르고, 없으면(2026-09-04 이전 편) 종전대로 이름순 위치로 읽는다.
 */
export function inheritedSceneImages(dir: string, sceneCount: number): Array<string | null> {
  const at = (f: string | null | undefined): string | null => {
    if (!f) return null;
    // 상대경로(신규) 우선, 파일명만 있는 옛 매핑은 scenes/ 밑으로 본다.
    // '..' 이 섞인 값은 무시한다 — 매핑 파일이 편 폴더 밖을 가리킬 이유가 없다.
    if (f.includes('..')) return null;
    const candidates = f.includes('/') ? [path.join(dir, f)] : [path.join(dir, 'scenes', f)];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch { /* 다음 후보 */ }
    }
    return null;
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, SCENE_IMAGE_MAP), 'utf-8')) as unknown;
    if (Array.isArray(raw)) {
      return Array.from({ length: sceneCount }, (_, i) => at(typeof raw[i] === 'string' ? raw[i] as string : null));
    }
  } catch { /* 매핑 없음 — 아래 위치 폴백 */ }
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(dir, 'scenes')).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  } catch { /* scenes 없음 */ }
  return Array.from({ length: sceneCount }, (_, i) => at(files[i]));
}

/**
 * 승계 디렉터리에서 클립 경로를 씬 순서대로 읽는다.
 *
 * 실촬영(user_NN.mp4)이 생성 클립(clip_NN.mp4)을 이긴다 — 원편이 사용자 화면을 어느 씬에 놓았는지
 * 그대로 물려받는다(2026-09-04). 형제편이 같은 대본을 쓰는데 실촬영만 다른 자리에 가면, 같은
 * 화면을 두 번 다르게 배치한 꼴이 된다. 원편의 판단이 곧 이 편의 판단이다.
 */
export function inheritedClips(dir: string, sceneCount: number): Array<string | null> {
  return Array.from({ length: sceneCount }, (_, i) => {
    const nn = String(i + 1).padStart(2, '0');
    for (const name of [`user_${nn}.mp4`, `clip_${nn}.mp4`]) {
      const p = path.join(dir, 'clips', name);
      try { if (fs.existsSync(p)) return p; } catch { /* 다음 후보 */ }
    }
    return null;
  });
}
