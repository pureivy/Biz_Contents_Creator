/**
 * 필름 룩(2026-09-04) — 생성 이미지에 '촬영하고 보정한 사진'의 흔적을 입힌다.
 *
 * 유튜브 노출이 끊긴 뒤로 '대량 자동생산처럼 보이는 것'을 지우는 게 과제였다. 앞서 연출·카메라·
 * 촬영지시·자막 배치를 편마다 갈랐는데, 정작 화면 자체는 gpt-image 출력물 그대로였다. 생성
 * 이미지가 티 나는 지점은 잡티가 없고, 색이 중립이고, 렌즈 결함이 없다는 것이다 — 실제 사진에는
 * 전부 있는 것들이다.
 *
 * @remotion/effects(셰이더 기반)로 그 셋을 되돌린다. 무작위 효과 뒤범벅이 아니라 '룩' 단위로 묶는다:
 * 무작위로 thermal-vision 이나 pixelate 를 걸면 실사처럼 보이는 게 아니라 더 기계처럼 보인다.
 * 목표는 다양함 자체가 아니라 '사람이 보정한 것처럼 보이는 다양함'이다.
 *
 * 편 단위로 하나의 룩을 고정한다 — 실제 촬영본은 한 편 안에서 색이 튀지 않는다. 편이 달라지면
 * 룩이 갈린다.
 */
import { brightness } from '@remotion/effects/brightness';
import { chromaticAberration } from '@remotion/effects/chromatic-aberration';
import { contrast } from '@remotion/effects/contrast';
import { saturation } from '@remotion/effects/saturation';
import { vibrance } from '@remotion/effects/vibrance';
import { vignette } from '@remotion/effects/vignette';
import { whiteBalance } from '@remotion/effects/white-balance';
import { random, type EffectsProp } from 'remotion';

/** 룩 한 벌 — 값은 전부 '있는 듯 없는 듯'한 범위다. 세게 걸면 보정이 아니라 필터가 된다. */
export interface FilmLook {
  readonly name: string;
  /** 색온도(-1 파랑 ~ +1 호박) */
  readonly temperature: number;
  /** 색조(-1 초록 ~ +1 자홍) */
  readonly tint: number;
  /** 대비 배율(1 = 원본) */
  readonly contrast: number;
  /** 채도 배율(1 = 원본) */
  readonly saturation: number;
  /** 선명도 보정(-1 ~ 1) — 이미 진한 색은 덜 건드리고 흐린 색을 올린다 */
  readonly vibrance: number;
  /** 밝기(-1 ~ 1) */
  readonly brightness: number;
  /** 비네트 강도(0 ~ 1) — 가장자리 어둡게 */
  readonly vignette: number;
  /** 색수차 강도 — 렌즈 가장자리 색 번짐. 0 이면 안 건다 */
  readonly aberration: number;
}

/**
 * 룩 목록 — 이름을 붙인 이유는 "무엇을 흉내내는가"가 값보다 오래 남기 때문이다.
 * 값은 실제 사진 보정에서 쓰는 폭을 넘지 않는다(대비 ±10%, 채도 ±10%, 색온도 ±0.15).
 */
export const FILM_LOOKS: readonly FilmLook[] = [
  // 맑은 날 야외에서 찍어 살짝 따뜻하게 만진 느낌
  { name: '따뜻한 오후', temperature: 0.22, tint: 0.03, contrast: 1.14, saturation: 1.12, vibrance: 0.12, brightness: 0.01, vignette: 0.2, aberration: 0 },
  // 흐린 날·그늘. 채도를 낮추고 대비를 살짝 눌러 다큐멘터리 톤
  { name: '흐린 날 다큐', temperature: -0.16, tint: -0.04, contrast: 0.92, saturation: 0.78, vibrance: 0.1, brightness: 0.03, vignette: 0.14, aberration: 0.06 },
  // 필름 스캔 느낌 — 그레인을 조금 더 주고 대비를 낮춰 바랜 톤
  { name: '바랜 필름', temperature: 0.12, tint: 0.08, contrast: 0.86, saturation: 0.8, vibrance: 0.16, brightness: 0.05, vignette: 0.34, aberration: 0.12 },
  // 최근 폰 카메라 결과물 — 대비·채도를 올리되 그레인은 최소
  { name: '선명한 디지털', temperature: 0.02, tint: 0, contrast: 1.22, saturation: 1.18, vibrance: 0.08, brightness: -0.01, vignette: 0.06, aberration: 0 },
  // 아침·이슬. 차갑고 부드럽게
  { name: '이른 아침', temperature: -0.24, tint: 0.05, contrast: 0.96, saturation: 0.92, vibrance: 0.14, brightness: 0.07, vignette: 0.12, aberration: 0.06 },
  // 해질녘. 가장 따뜻하고 비네트가 깊다
  { name: '해질녘', temperature: 0.28, tint: 0.09, contrast: 1.08, saturation: 1.06, vibrance: 0.1, brightness: -0.05, vignette: 0.32, aberration: 0.08 },
];

/**
 * 시드 문자열 → 룩(순수·결정적). 같은 편은 언제 다시 렌더해도 같은 룩을 받는다.
 * remotion 의 random() 을 쓴다 — 서버 쪽 해시(fxSeed)를 끌어오면 node 모듈이 브라우저 번들에
 * 딸려 들어간다. random() 은 코어 API 라 번들 안에서 안전하고 결정적이다.
 */
export function pickFilmLook(seed: string, offset = 0): FilmLook {
  const base = Math.floor(random(`${seed}:look`) * FILM_LOOKS.length);
  return FILM_LOOKS[(base + offset) % FILM_LOOKS.length]!;
}

/**
 * 룩 → effects 배열(순수). 색을 먼저 잡고(화이트밸런스 → 대비 → 채도 → 선명도 → 밝기)
 * 렌즈가 만드는 것(색수차 → 비네트)을 얹는다. 실제 촬영·현상 순서와 같다.
 *
 * ## 필름 그레인은 뺐다 (2026-09-04 실측)
 *
 * 처음엔 프레임마다 시드를 바꾸는 그레인을 넣었다. 생성 이미지가 티 나는 이유 중 하나가
 * '잡티가 없다'는 것이니 되돌려 주자는 생각이었다. 그런데 재 보니 값이 안 맞았다.
 *
 *     그레이딩+비네트만   35초  42MB     ← 효과 전(37초·45MB)보다 오히려 싸다
 *     + 그레인 절반·3프레임 42초  50MB
 *     + 그레인 최대·매프레임 48초  84MB
 *
 * 그런데 세 결과를 균일면에서 1:1 로 확대해 비교하면 구분이 안 된다 — h264 인코더가 그레인을
 * 먼저 지운다. 유튜브가 재인코딩하면 한 번 더 지워진다. 즉 렌더 시간과 파일만 늘고 화면에는
 * 남지 않는다. 남는 것만 남긴다: 그레이딩·비네트·색수차는 구조적 변화라 인코딩을 견딘다.
 */
export function filmLookEffects(look: FilmLook): EffectsProp {
  const out = [
    whiteBalance({ temperature: look.temperature, tint: look.tint }),
    contrast({ amount: look.contrast }),
    saturation({ amount: look.saturation }),
    vibrance({ amount: look.vibrance }),
    brightness({ amount: look.brightness }),
  ];
  if (look.aberration > 0) out.push(chromaticAberration({ amount: look.aberration }));
  out.push(vignette({ amount: look.vignette }));
  return out;
}

/**
 * 클립(I2V)도 같은 룩을 받는다 — @remotion/media 의 <Video> 는 effects 프롭을 받는다(4.0.520 확인).
 * 종전 OffthreadVideo 는 안 받아서 클립 씬만 보정이 빠졌을 것이다. 한 편 안에서 색이 튀면
 * 보정을 안 한 것만 못하다.
 */
