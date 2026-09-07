import React from 'react';
import { z } from 'zod';
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig, random } from 'remotion';
import { TransitionSeries } from '@remotion/transitions';
import { Video } from '@remotion/media';
import { CutFlash } from './CutFlash';
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
import { CompareCard } from './CompareCard';
import { FONT_FAMILY } from './loadFonts';
import { pickFilmLook, filmLookEffects, type FilmLook } from './filmLook';
import { pickCaptionMotion, type CaptionMotionName } from './captionMotion';
import { pickTechniques, techniqueScene, type EditTechnique } from './editTechniques';
import { TechniqueLayer } from './TechniqueLayer';
import { saturation } from '@remotion/effects/saturation';
import { contrast } from '@remotion/effects/contrast';

export const autoShortsSchema = z.object({
  scenes: z.array(z.object({
    imageSrc: z.string().nullable(),
    audioSrc: z.string().nullable(),
    screenText: z.string(),
    durationInFrames: z.number(),
    videoSrc: z.string().nullable().optional(),
    clipFrames: z.number().optional(), // 실제 클립 길이(컴포지션 fps 기준 프레임) — 감속 재생 배율 산정용. 없으면 CLIP_SECONDS 폴백.
    /** 사용자가 찍어 올린 실촬영 화면인가(2026-09-04) — 파괴적 편집 기법이 이 씬을 피한다. */
    realFootage: z.boolean().optional(),
    kind: z.enum(['hook', 'stat', 'list', 'quote', 'chart', 'cta', 'compare']).optional(),
    stat: z.object({ value: z.number(), unit: z.string().optional(), label: z.string().optional() }).optional(),
    items: z.array(z.string()).max(4).optional(),
    /** CTA 결론(2026-08-28) — "조건 → 답" 쌍을 화면에 띄운다. 무음 시청·되감기 없음 대응. */
    takeaways: z.array(z.object({ when: z.string(), then: z.string() })).max(3).optional(),
    /** 대비 씬(2026-09-03) — "이것 말고 이것". 위치 추측이 필요 없는 연출(화살표 도해 대체). */
    compare: z.object({
      bad: z.object({ label: z.string(), note: z.string().optional() }),
      good: z.object({ label: z.string(), note: z.string().optional() }),
    }).optional(),
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
  /** 카메라 드리프트 시드(2026-09-03) — 편·씬마다 다른 손 흔들림. 미지정=흔들림 없음(종전 궤도). */
  driftSeed: z.string().optional(),
  /** 룩 자리 이동(2026-09-04) — 형제편(같은 대본·이미지)이 원편과 다른 색을 받게. 원편 0, 형제 1. */
  lookOffset: z.number().optional(),
  totalFrames: z.number(),
  /** 자막 옵션 — 위치(하단 여백 %)·키워드 강조색·테두리·글자 크기. 미지정=컴포넌트 기본값. */
  caption: z.object({ bottomPct: z.number().optional(), keyword: z.string().optional(), outline: z.boolean().optional(), fontPx: z.number().optional(), hookFontPx: z.number().optional() }).optional(),
  /** 상단 고정 제목(별도 생성한 투명 캘리 PNG) — 전 씬 지속 오버레이. 미지정=없음(종전). */
  title: z.object({ imageSrc: z.string(), topPct: z.number().optional(), widthPct: z.number().optional() }).optional(),
});
export type AutoShortsProps = z.infer<typeof autoShortsSchema>;

const CLIP_SECONDS = 6; // clipFrames 미지정 시 감속 배율 산정 폴백 — 프레임 수는 fps 에서 유도

const Scene: React.FC<{ s: AutoShortsProps['scenes'][number]; index: number; caption?: AutoShortsProps['caption']; driftSeed?: string; look?: FilmLook; capMotion?: CaptionMotionName;
  /** 이 씬에 걸린 선택 기법(없으면 undefined). */
  tech?: EditTechnique; techSeed?: string }> = ({ s, index, caption, driftSeed, look, capMotion, tech, techSeed }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  // 필름 룩 — 배경(이미지·클립)에만 건다. 자막·카드는 별도 레이어라 영향이 없다(글자는 보정 대상이 아니다).
  const baseEffects = look ? filmLookEffects(look) : undefined;
  // 흑백 인서트 — 이 씬만 색을 뺀다. '잠깐 다른 결로 넘어갔다 돌아오는' 편집 장치다.
  //
  // 처음엔 duotone 을 썼는데 실렌더에서 원본 사진이 두 색으로 뭉개져 알아볼 수 없었다.
  // duotone 은 세기 파라미터가 없어(darkColor·lightColor·threshold 뿐) 약하게 걸 방법이 없다 —
  // 사진 기반 채널에는 맞지 않는 도구였다. 채도만 빼면 사진은 그대로 읽히면서 결만 바뀐다.
  const effects = tech === '흑백 인서트' && baseEffects
    ? [...baseEffects, saturation({ amount: 0.12 }), contrast({ amount: 1.06 })]
    : baseEffects;
  // 정지 강조 — 이 씬의 배경 모션만 멈춘다(자막·카드는 그대로 움직인다). 씬 길이는 안 건드린다.
  const frozen = tech === '정지 강조';
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
        // @remotion/media 의 <Video>(4.0.520) — OffthreadVideo 와 달리 effects 프롭을 받는다.
        // 그래서 클립 씬도 스틸 씬과 같은 필름 룩을 받는다(색이 튀면 보정 안 한 것만 못하다).
        <Video
          src={staticFile(s.videoSrc)}
          muted
          playbackRate={Math.min(1, (s.clipFrames ?? CLIP_SECONDS * fps) / Math.max(1, s.durationInFrames))}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          {...(effects ? { effects } : {})}
        />
      ) : (
        <KenBurnsImage src={s.imageSrc} total={s.durationInFrames} index={index} move={frozen ? 'none' : s.fx?.move} intensity={s.fx?.intensity} driftSeed={driftSeed ? `${driftSeed}:${index}` : undefined} {...(effects ? { effects } : {})} />
      )}
      {/* 액센트 — 배경 위·자막/오버레이 아래(텍스트는 어두워지거나 가려지지 않게) */}
      {s.fx?.accent === 'spotlight' ? <SpotlightMask /> : null}
      {s.fx?.accent?.startsWith('particles-') ? (
        <ParticleDrift kind={s.fx.accent.slice('particles-'.length) as 'leaves' | 'petals' | 'snow'} sceneIndex={index} />
      ) : null}
      {/* 선택 기법 층 — 배경 위·자막 아래. 자막을 덮으면 읽기가 죽는다. */}
      {tech && techSeed ? <TechniqueLayer tech={tech} seed={techSeed} total={s.durationInFrames} /> : null}
      {s.kind === 'stat' && s.stat ? <StatCountUp stat={s.stat} total={s.durationInFrames} {...(driftSeed ? { seed: `${driftSeed}:${index}` } : {})} /> : null}
      {s.kind === 'list' && s.items?.length ? <ListReveal items={s.items} total={s.durationInFrames} /> : null}
      {s.kind === 'quote' && s.quote ? <QuoteCard quote={s.quote} total={s.durationInFrames} /> : null}
      {s.kind === 'chart' && s.chart ? <BarChartGrow chart={s.chart} total={s.durationInFrames} /> : null}
      {s.kind === 'cta' && s.takeaways?.length ? <TakeawayCard takeaways={s.takeaways} total={s.durationInFrames} /> : null}
      {s.kind === 'compare' && s.compare ? <CompareCard compare={s.compare} /> : null}
      <KineticCaption text={s.screenText} variant={s.kind === 'hook' || s.kind === 'cta' ? s.kind : undefined} bottomPct={caption?.bottomPct} keyword={caption?.keyword} outline={caption?.outline} fontPx={caption?.fontPx} hookFontPx={caption?.hookFontPx} {...(capMotion ? { motion: capMotion } : {})} />
      {s.audioSrc ? <Audio src={staticFile(s.audioSrc)} /> : null}
    </AbsoluteFill>
  );
};

export const AutoShorts: React.FC<AutoShortsProps> = ({ scenes, caption, title, driftSeed, lookOffset }) => {
  // 룩은 편 단위로 하나 — 실제 촬영본은 한 편 안에서 색이 튀지 않는다. driftSeed(=쇼츠 id)가 없으면
  // 보정 없음(구 props 폴백).
  const look = driftSeed ? pickFilmLook(driftSeed, lookOffset ?? 0) : undefined;
  // 컷 빛샘 — 상시로 바꿨다(2026-09-04). 종전엔 3편 중 2편에만 걸었는데, 사용자가 "뭐가 바뀐지
  // 모르겠다"고 한 편이 하필 안 걸린 편이었다. 장치를 껐다 켜는 것보다 '같은 장치를 매번 다르게'가
  // 판박이를 더 잘 지운다 — 길이·세기·색을 편마다 가른다.
  const flashFrames = driftSeed ? 9 + Math.floor(random(`${driftSeed}:flashLen`) * 8) : 0; // 9~16프레임(0.3~0.53초)
  const flashStrength = driftSeed ? 0.18 + random(`${driftSeed}:flashAmp`) * 0.16 : 0;      // 0.18~0.34
  // 빛샘 색 — 실제 필름 라이트리크는 호박~주황 범위다. 청록으로 돌리면 필름이 아니라 글리치로 보인다.
  // 자막 모션 — 편마다 하나. 영상에서 가장 오래 보이는 요소라 여기가 갈려야 체감이 크다.
  const capMotion = driftSeed ? pickCaptionMotion(random(`${driftSeed}:capmotion`)) : undefined;
  // 선택 편집 기법 — 편마다 2가지. 파라미터만 갈리던 종전엔 8편이 사실상 2조합뿐이었다(실측).
  const techs = driftSeed ? pickTechniques(driftSeed) : [];
  const techAt = new Map<number, EditTechnique>();
  // 실촬영 씬 — 흑백·정지처럼 화면을 지우는 기법은 여기를 피한다(사장님 영상이 흑백으로 나갔다).
  const realScenes = new Set(scenes.flatMap((s, i) => (s.realFootage ? [i] : [])));
  for (const t of techs) {
    const at = techniqueScene(driftSeed ?? '', t, scenes.length, realScenes);
    if (at >= 0 && !techAt.has(at)) techAt.set(at, t); // 한 씬에 둘씩 겹치지 않게
  }
  const flashHue = Math.round((look && look.temperature < 0 ? 30 : 8) + (driftSeed ? random(`${driftSeed}:flashHue`) * 22 : 0));
  return (
  <AbsoluteFill style={{ background: '#000', fontFamily: FONT_FAMILY }}>
    {/*
      Series → TransitionSeries 로 옮긴 이유는 Overlay 하나 때문이다. Overlay 는 컷 위에 얹히기만
      하고 앞뒤 씬 길이를 건드리지 않는다 — 종전에 전환을 통째로 닫아 뒀던 이유("씬이 겹쳐 전체
      길이가 줄어 오디오 싱크가 깨진다")가 Overlay 에는 적용되지 않는다. Transition 은 여전히
      안 쓴다(그건 실제로 길이를 줄인다).
    */}
    <TransitionSeries>
      {scenes.flatMap((s, i) => {
        // name 은 Studio 타임라인 라벨 전용 — 렌더 결과에는 영향이 없다.
        const seq = (
          <TransitionSeries.Sequence key={`s${i}`} durationInFrames={Math.max(1, s.durationInFrames)} name={`씬${i + 1} · ${s.kind ?? '무연출'}`}>
            <Scene s={s} index={i} caption={caption} driftSeed={driftSeed} look={look} capMotion={capMotion} {...(techAt.get(i) ? { tech: techAt.get(i), techSeed: `${driftSeed}:${i}` } : {})} />
          </TransitionSeries.Sequence>
        );
        // 컷 위 빛샘 — 씬과 씬 사이에만(첫 씬 앞·마지막 씬 뒤에는 컷이 없다).
        // 커버가 되는 첫 프레임을 건드리지 않으려면 i>0 조건이 필수다.
        if (i === 0 || !driftSeed || !flashFrames) return [seq];
        return [
          <TransitionSeries.Overlay key={`o${i}`} durationInFrames={flashFrames}>
            <CutFlash cutIndex={i} seed={driftSeed} hueShift={flashHue} strength={flashStrength} />
          </TransitionSeries.Overlay>,
          seq,
        ];
      })}
    </TransitionSeries>
    {title?.imageSrc ? <TitleOverlay imageSrc={title.imageSrc} topPct={title.topPct} widthPct={title.widthPct} /> : null}
    <ProgressBar />
  </AbsoluteFill>
  );
};
