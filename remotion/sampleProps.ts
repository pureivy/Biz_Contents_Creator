/**
 * Studio 미리보기용 표본 props — `pnpm studio` 로 열었을 때 빈 화면 대신 실제 쇼츠 모양이 뜨게.
 * 연출(kind) 전종을 한 편에 담아, 카드 컴포넌트를 렌더 없이 눈으로 고칠 수 있게 한다.
 * 이미지·오디오는 null — 에셋 스테이징 없이도 열리도록(배경은 KenBurnsImage 의 그라디언트 폴백).
 */
import type { AutoShortsProps } from './AutoShorts';

const FPS = 30;
const sec = (s: number): number => Math.round(s * FPS);

type Scene = AutoShortsProps['scenes'][number];

const scenes: Scene[] = [
  {
    imageSrc: null, audioSrc: null, durationInFrames: sec(4.5), kind: 'hook',
    screenText: '수국이 9월에 시드는 진짜 이유',
    fx: { enter: 'none', move: 'push', intensity: 'strong', accent: 'spotlight' },
  },
  {
    imageSrc: null, audioSrc: null, durationInFrames: sec(6), kind: 'stat',
    screenText: '뿌리 한 포기에 배양토 47리터',
    stat: { value: 47, unit: 'L', label: '배양토 몫' },
    fx: { enter: 'fade', intensity: 'subtle' },
  },
  {
    imageSrc: null, audioSrc: null, durationInFrames: sec(6.5), kind: 'compare',
    screenText: '꽃대만 자르고 큰 손질은 미루세요',
    compare: {
      bad: { label: '가지째 자르기', note: '내년 꽃눈까지 날아감' },
      good: { label: '꽃대만 짧게', note: '눈은 남기고 정리' },
    },
    fx: { enter: 'fade', intensity: 'subtle' },
  },
  {
    imageSrc: null, audioSrc: null, durationInFrames: sec(6), kind: 'list',
    screenText: '9월에 챙길 세 가지',
    items: ['물주기 격일로', '웃거름 중단', '반그늘 이동'],
    fx: { enter: 'wipe', intensity: 'subtle' },
  },
  {
    imageSrc: null, audioSrc: null, durationInFrames: sec(6), kind: 'chart',
    screenText: '달마다 물 주는 횟수',
    chart: { series: [{ label: '7월', value: 12 }, { label: '8월', value: 10 }, { label: '9월', value: 6 }], unit: '회', highlight: 2 },
    fx: { enter: 'slide-up', intensity: 'subtle' },
  },
  {
    imageSrc: null, audioSrc: null, durationInFrames: sec(5), kind: 'cta',
    screenText: '가을 준비 더 보기',
    takeaways: [
      { when: '잎이 처지면', then: '물 부족' },
      { when: '잎끝이 마르면', then: '비료 과다' },
    ],
    fx: { enter: 'fade', move: 'zoom-out', intensity: 'normal', accent: 'particles-leaves' },
  },
];

export const sampleProps: AutoShortsProps = {
  scenes,
  totalFrames: scenes.reduce((a, s) => a + s.durationInFrames, 0),
  driftSeed: 'sample',
  caption: { bottomPct: 22, keyword: '수국 꽃대', outline: true },
};
