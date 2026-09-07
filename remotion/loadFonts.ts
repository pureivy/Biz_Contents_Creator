/**
 * 한글 폰트 확정 로딩 — Remotion 정석(delayRender 로 첫 프레임을 잡아두고, 로딩이 끝나면 놓아준다).
 *
 * 종전엔 fontFamily 에 '"Noto Sans KR", sans-serif' 라고 적어 놓기만 했다. 그런데 이 맥에는
 * Noto Sans KR 이 설치돼 있지 않다(확인: ~/Library/Fonts·/System/Library/Fonts 에 없음).
 * 즉 지금까지 나간 모든 영상은 선언한 폰트가 아니라 Chromium 이 고른 대체 폰트(Apple SD Gothic
 * Neo)로 렌더됐다. 눈에 띄는 사고는 없었지만 두 가지가 깨져 있었다.
 *   - 렌더 머신이 바뀌면 글자가 통째로 바뀐다(리눅스에 한글 폰트가 없으면 두부 ▯▯▯).
 *   - 자간·자폭이 달라지면 자막 줄바꿈과 제목 박스 높이가 같이 흔들린다.
 *
 * 그래서 폰트를 번들에 넣어 못박는다. Pretendard 를 고른 이유는 Apple SD Gothic Neo 를 대체할
 * 목적으로 만들어진 폰트라, 지금 사용자가 보고 있는 글자꼴을 거의 그대로 유지하기 때문이다
 * (fontPx 70·84, 테두리 8px, 제목 widthPct 74 는 전부 그 글자꼴 기준으로 손보정된 값이다).
 *
 * public/ 이 아니라 webpack import 로 넣는다 — 이 프로젝트의 publicDir 은 렌더마다 다른
 * 스테이징 디렉터리라(shortsRenderRemotion.ts), staticFile('fonts/…') 는 매 렌더 404 가 난다.
 */
import { continueRender, delayRender } from 'remotion';
import boldUrl from './fonts/Pretendard-Bold.woff2';
import extraBoldUrl from './fonts/Pretendard-ExtraBold.woff2';

/** 컴포넌트가 참조할 폰트 스택 — 로딩 실패 시에도 읽히도록 시스템 한글 폰트를 뒤에 남긴다. */
/** 측정용 단일 패밀리명 — layout-utils 는 스택이 아니라 이름 하나를 받는다. */
export const FONT_NAME = 'Pretendard';
export const FONT_FAMILY = 'Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

// 모듈 최상단 실행 — Remotion 은 동시 렌더 탭마다 이 모듈을 한 번씩 평가하고, 각 탭이 제 핸들을
// 잡는다. 프레임 0 이 폴백 폰트로 찍히는 사고(FOUT)를 막는 유일한 지점.
const handle = delayRender('한글 폰트(Pretendard) 로딩');
const faces: Array<[string, string]> = [[boldUrl, '700'], [extraBoldUrl, '800']];

Promise.all(
  faces.map(([url, weight]) =>
    new FontFace('Pretendard', `url(${url}) format('woff2')`, { weight, style: 'normal' })
      .load()
      .then((loaded) => { document.fonts.add(loaded); }),
  ),
)
  // 실패해도 렌더는 계속한다 — 폰트 하나 때문에 영상 생성이 통째로 죽는 쪽이 더 나쁘다.
  // 다만 조용히 넘어가지는 않는다: 폴백 결과가 이 맥에서는 멀쩡해 보여서, 로그가 없으면 이 커밋이
  // 없애려던 바로 그 사고(선언한 폰트가 아닌 채로 계속 나감)가 그대로 재현된다.
  // 브라우저 콘솔이라 renderMedia 의 onBrowserLog 를 켠 쪽에만 보인다(scripts/preview_shorts.ts).
  .catch((e: unknown) => { console.warn('[폰트] Pretendard 로딩 실패 — 시스템 폰트로 렌더된다:', e); })
  .then(() => { continueRender(handle); });
