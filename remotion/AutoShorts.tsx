import React from 'react';
import { z } from 'zod';
import { AbsoluteFill, Series, Audio, staticFile, OffthreadVideo, useCurrentFrame } from 'remotion';
import { sceneEnterFade } from './anim';
import { KenBurnsImage } from './KenBurnsImage';
import { KineticCaption } from './KineticCaption';
import { ProgressBar } from './ProgressBar';
import { StatCountUp } from './StatCountUp';
import { ListReveal } from './ListReveal';
import { QuoteCard } from './QuoteCard';
import { TitleOverlay } from './TitleOverlay';
import { SpotlightMask } from './SpotlightMask';
import { ParticleDrift } from './ParticleDrift';
import { BarChartGrow } from './BarChartGrow';
import { TakeawayCard } from './TakeawayCard';

export const autoShortsSchema = z.object({
  scenes: z.array(z.object({
    imageSrc: z.string().nullable(),
    audioSrc: z.string().nullable(),
    screenText: z.string(),
    durationInFrames: z.number(),
    videoSrc: z.string().nullable().optional(),
    clipFrames: z.number().optional(), // 실제 클립 길이(30fps 기준 프레임) — 감속 재생 배율 산정용. 없으면 CLIP_FRAMES 폴백.
    kind: z.enum(['hook', 'stat', 'list', 'quote', 'chart', 'cta']).optional(),
    stat: z.object({ value: z.number(), unit: z.string().optional(), label: z.string().optional() }).optional(),
    items: z.array(z.string()).max(4).optional(),
    /** CTA 결론(2026-08-28) — "조건 → 답" 쌍을 화면에 띄운다. 무음 시청·되감기 없음 대응. */
    takeaways: z.array(z.object({ when: z.string(), then: z.string() })).max(3).optional(),
    quote: z.object({ text: z.string(), source: z.string().optional() }).optional(),
    chart: z.object({
      series: z.array(z.object({ label: z.string(), value: z.number() })).max(5),
      unit: z.string().optional(), highlight: z.number().optional(),
    }).optional(),
    /** 씬 연출(결정적 kind 기본값, 서버가 산정) — 미지정=종전 동작(fade 엔터 + index parity 켄번즈). */
    fx: z.object({
      enter: z.enum(['none', 'fade', 'slide-up', 'wipe', 'scale']).optional(),
      move: z.enum(['zoom-in', 'zoom-out', 'push', 'none']).optional(),
      intensity: z.enum(['subtle', 'normal', 'strong']).optional(),
      accent: z.enum(['spotlight', 'particles-leaves', 'particles-petals', 'particles-snow']).optional(),
    }).optional(),
  })),
  totalFrames: z.number(),
  /** 자막 옵션 — 위치(하단 여백 %)·키워드 강조색·테두리·글자 크기. 미지정=컴포넌트 기본값. */
  caption: z.object({ bottomPct: z.number().optional(), keyword: z.string().optional(), outline: z.boolean().optional(), fontPx: z.number().optional(), hookFontPx: z.number().optional() }).optional(),
  /** 상단 고정 제목(별도 생성한 투명 캘리 PNG) — 전 씬 지속 오버레이. 미지정=없음(종전). */
  title: z.object({ imageSrc: z.string(), topPct: z.number().optional(), widthPct: z.number().optional() }).optional(),
});
export type AutoShortsProps = z.infer<typeof autoShortsSchema>;
export const defaultProps: AutoShortsProps = {
  scenes: [{ imageSrc: null, audioSrc: null, screenText: '샘플 자막 한 줄', durationInFrames: 90 }],
  totalFrames: 90,
};

const CLIP_FRAMES = 180; // 6초 클립 × 30fps 컴포지션 — clipFrames 미지정 시 감속 배율 산정 폴백

const Scene: React.FC<{ s: AutoShortsProps['scenes'][number]; index: number; caption?: AutoShortsProps['caption'] }> = ({ s, index, caption }) => {
  const f = useCurrentFrame();
  // 씬 엔터 이펙트 — 종전 '6프레임 페이드인(첫 씬 제외)'을 일반화. 씬 길이 불변이라 TTS 싱크 무손상.
  // TransitionSeries(씬 오버랩=전체 길이 단축)는 '오디오가 길이를 지배' 불변식·SRT 누적 시계와 충돌해 채택하지 않는다.
  const enter = s.fx?.enter ?? (index > 0 ? 'fade' : 'none');
  const p = enter === 'none' ? 1 : sceneEnterFade(f, 6);
  const wrap: React.CSSProperties = { opacity: p };
  if (enter === 'slide-up') wrap.transform = `translateY(${(1 - p) * 24}px)`;
  else if (enter === 'scale') wrap.transform = `scale(${0.96 + 0.04 * p})`;
  else if (enter === 'wipe') { wrap.opacity = 1; wrap.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; }
  return (
    <AbsoluteFill style={wrap}>
      {s.videoSrc ? (
        // 루프 금지 — 씬이 클립(≈6초)보다 길면 재생 속도를 낮춰 클립 한 번이 씬 전체를 덮는다.
        // 종전 <Loop>는 씬 중간에 클립이 처음으로 되감겨 '튕김'이 보였고(실측: 씬 6.6~8.0s vs 클립 6.04s
        // 로 거의 매 씬 발생), 감속 재생은 튕김 제거에 더해 I2V 잔결함(형태 흔들림)도 시각적으로 완화한다.
        <OffthreadVideo
          src={staticFile(s.videoSrc)}
          muted
          playbackRate={Math.min(1, (s.clipFrames ?? CLIP_FRAMES) / Math.max(1, s.durationInFrames))}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <KenBurnsImage src={s.imageSrc} total={s.durationInFrames} index={index} move={s.fx?.move} intensity={s.fx?.intensity} />
      )}
      {/* 액센트 — 배경 위·자막/오버레이 아래(텍스트는 어두워지거나 가려지지 않게) */}
      {s.fx?.accent === 'spotlight' ? <SpotlightMask /> : null}
      {s.fx?.accent?.startsWith('particles-') ? (
        <ParticleDrift kind={s.fx.accent.slice('particles-'.length) as 'leaves' | 'petals' | 'snow'} sceneIndex={index} />
      ) : null}
      {s.kind === 'stat' && s.stat ? <StatCountUp stat={s.stat} total={s.durationInFrames} /> : null}
      {s.kind === 'list' && s.items?.length ? <ListReveal items={s.items} total={s.durationInFrames} /> : null}
      {s.kind === 'quote' && s.quote ? <QuoteCard quote={s.quote} total={s.durationInFrames} /> : null}
      {s.kind === 'chart' && s.chart ? <BarChartGrow chart={s.chart} total={s.durationInFrames} /> : null}
      {s.kind === 'cta' && s.takeaways?.length ? <TakeawayCard takeaways={s.takeaways} total={s.durationInFrames} /> : null}
      <KineticCaption text={s.screenText} variant={s.kind === 'hook' || s.kind === 'cta' ? s.kind : undefined} bottomPct={caption?.bottomPct} keyword={caption?.keyword} outline={caption?.outline} fontPx={caption?.fontPx} hookFontPx={caption?.hookFontPx} />
      {s.audioSrc ? <Audio src={staticFile(s.audioSrc)} /> : null}
    </AbsoluteFill>
  );
};

export const AutoShorts: React.FC<AutoShortsProps> = ({ scenes, caption, title }) => (
  <AbsoluteFill style={{ background: '#000', fontFamily: '"Noto Sans KR", sans-serif' }}>
    <Series>
      {scenes.map((s, i) => (
        <Series.Sequence key={i} durationInFrames={Math.max(1, s.durationInFrames)}>
          <Scene s={s} index={i} caption={caption} />
        </Series.Sequence>
      ))}
    </Series>
    {title?.imageSrc ? <TitleOverlay imageSrc={title.imageSrc} topPct={title.topPct} widthPct={title.widthPct} /> : null}
    <ProgressBar />
  </AbsoluteFill>
);
