import { describe, it, expect } from 'vitest';
import { buildMotionPrompt, extractVideoUrl, buildI2vBody } from './shortsSceneClips';

describe('buildMotionPrompt — 원본 + 모션 접미(순수)', () => {
  it('원본 포함 + 시네마틱 모션·무텍스트 문구', () => {
    const p = buildMotionPrompt('a plant by the window');
    expect(p).toContain('a plant by the window');
    expect(p).toContain('cinematic motion');
    expect(p).toContain('no text');
  });
});
describe('extractVideoUrl — 정상/결측/이형 방어(순수)', () => {
  it('video.url 이 http 문자열일 때만 통과, 그 외 null', () => {
    expect(extractVideoUrl({ video: { url: 'https://x/y.mp4' } })).toBe('https://x/y.mp4');
    expect(extractVideoUrl({ video: {} })).toBeNull();
    expect(extractVideoUrl({})).toBeNull();
    expect(extractVideoUrl(null)).toBeNull();
    expect(extractVideoUrl({ video: { url: 42 } })).toBeNull();
    expect(extractVideoUrl({ video: { url: 'ftp://x' } })).toBeNull();
    expect(extractVideoUrl({ video: { url: 'httpx://a' } })).toBeNull();
  });
});
describe('buildI2vBody — 모델별 스키마 분기(순수)', () => {
  it('wan 계열: 세로 9:16 고정 + 145프레임@24fps(≈6초) + 붕괴 억제 negative_prompt', () => {
    const b = buildI2vBody('fal-ai/wan/v2.2-5b/image-to-video', 'p', 'data:x');
    // toEqual 유지 — 예기치 않은 필드 추가(fal 은 비호환 필드에 422 무음 실패)를 잡는 가드.
    expect(b).toEqual({
      prompt: 'p', image_url: 'data:x', num_frames: 145, frames_per_second: 24, resolution: '720p', aspect_ratio: '9:16',
      negative_prompt: 'distortion, morphing, warping, melting, deformed face, deformed hands, extra limbs, mutated fingers, objects appearing or disappearing, text, letters, watermark, flickering',
    });
  });
  it('ltx 계열: duration·1080p·무오디오', () => {
    const b = buildI2vBody('fal-ai/ltx-2/image-to-video/fast', 'p', 'data:x');
    expect(b).toEqual({ prompt: 'p', image_url: 'data:x', duration: 6, resolution: '1080p', fps: 25, generate_audio: false });
  });
  it('wan + subjectHold: 피사체 동작 금지 negative 보강(사람·손·도구 카메라 전용 강제, 2026-07-31)', () => {
    const b = buildI2vBody('fal-ai/wan/v2.2-5b/image-to-video', 'p', 'data:x', true);
    const neg = String(b.negative_prompt);
    expect(neg).toContain('deformed hands');       // 기존 붕괴 억제 유지
    expect(neg).toContain('hands moving');
    expect(neg).toContain('cutting motion');
    expect(neg).toContain('tool moving');
    // subjectHold=false 는 기존과 바이트 동일(스키마 가드)
    expect(buildI2vBody('fal-ai/wan/v2.2-5b/image-to-video', 'p', 'data:x', false))
      .toEqual(buildI2vBody('fal-ai/wan/v2.2-5b/image-to-video', 'p', 'data:x'));
  });
});
