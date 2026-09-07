# 번들 폰트

`Pretendard-Bold.woff2` / `Pretendard-ExtraBold.woff2` — Pretendard v1.3.9,
SIL Open Font License 1.1 (`OFL.txt` 참조). https://github.com/orioncactus/pretendard

`remotion/loadFonts.ts` 가 webpack import 로 번들에 싣고 delayRender 로 첫 프레임을 잡아둔다.
public/ 이 아닌 이유: 이 프로젝트의 publicDir 은 렌더마다 다른 스테이징 디렉터리라
`staticFile('fonts/…')` 가 매번 404 가 난다(src/tools/shortsRenderRemotion.ts).

굵기는 700·800 둘만 싣는다 — 컴포넌트가 쓰는 fontWeight 가 600~900 인데, 그 범위는 이 둘로
합성된다. 굵기를 추가하면 렌더 번들이 굵기당 ~780KB 씩 커진다.
