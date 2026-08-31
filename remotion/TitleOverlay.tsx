import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';

/** 영상 상단 고정 제목 — 별도 생성한 투명 캘리 PNG(shortsTitleArt)를 전 씬 지속 오버레이.
 *  텍스트 재조판이 아니라 이미지 합성 방식(사용자 확정 2026-07-30 — 썸네일과 같은 손글씨 무드). */
export const TitleOverlay: React.FC<{
  /** public/ 스테이징된 투명 캘리 파일명(staticFile 참조). */
  imageSrc: string;
  /** 상단 오프셋(% of 높이) — 기본 5(플랫폼 상단 UI ~8% 회피와 낙서 잘림 방지의 절충). */
  topPct?: number;
  /** 폭(% of 화면 폭) — 기본 74(1080px 중 ~800px). 2줄 위계(키워드 라벨+훅) 기준 재보정(2026-07-31) — 90은 1줄 시절 값. */
  widthPct?: number;
}> = ({ imageSrc, topPct = 5, widthPct = 74 }) => (
  <AbsoluteFill>
    {/* 높이 상한 박스(26%) — 크롭 종횡비가 예측 불가(낙서 위치 가변)라, 세로로 긴 크롭이
        화면 중앙의 stat/list/quote 카드까지 침범하지 않게 contain 으로 가둔다. */}
    <div style={{
      position: 'absolute', top: `${topPct}%`, left: '50%', transform: 'translateX(-50%)',
      width: `${widthPct}%`, height: '26%',
    }}>
      <Img
        src={staticFile(imageSrc)}
        style={{
          width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'top center',
          // 부드러운 검은 그림자 — 밝은 배경 시인성(알파 윤곽을 따라감)
          filter: 'drop-shadow(0 5px 7px rgba(0,0,0,0.8))',
        }}
      />
    </div>
  </AbsoluteFill>
);
