import { useEffect, useRef, useState } from "react";
import { ttsFetch } from "../api";
import { useStore } from "../store";

/** TTS 재생 — /voice/tts → Blob → decodeAudioData → AudioBufferSourceNode + AnalyserNode(아바타 파형).
 *
 *  iOS Safari 무음 수정(데스크톱은 기존도 정상이었음):
 *   - 구 구현은 speak() 마다 `new Audio()` + `createMediaElementSource` 후 `el.play()` 했다. iOS 는
 *     (1) 오디오 언락이 'HTMLMediaElement 인스턴스 단위'라 제스처에서 재생된 적 없는 새 엘리먼트는 차단되고,
 *     (2) 서버 왕복(STT+LLM+TTS, 수 초)을 await 한 뒤의 play() 는 user-activation 윈도우가 만료돼
 *     NotAllowedError → `.catch(()=>stop())` 가 삼켜 무음. 동시에 analyser 도 안 붙어 아바타 입도 멈췄다.
 *   - 수정: BufferSource 방식. 사용자 제스처(convo 토글/마이크 탭)에서 prime() 이 AudioContext 를 한 번
 *     resume + 1-sample 무음 재생으로 '래치'하면, 이후 비제스처 async 에서도 decodeAudioData →
 *     AudioBufferSourceNode.start() 가 차단 없이 재생된다(per-context 언락, 만료 없음·엘리먼트 무관).
 *     analyser 는 그래프에 그대로 붙어 JarvisAvatar 가 음성에 반응한다. 데스크톱은 동일하게 정상.
 *   - 참고: WebAudio 출력은 iOS 무음(링거) 스위치의 영향을 받는다 — 스위치가 무음이면 입은 움직여도
 *     소리가 안 날 수 있다(사용자 점검 안내). */
export function useTts() {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [speakingSeq, setLocalSeq] = useState<number | null>(null);
  const setSpeaking = useStore((s) => s.setSpeaking);
  const acRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const anRef = useRef<AnalyserNode | null>(null);
  const genRef = useRef(0); // speak 세대 — 늦게 끝난 decode 가 더 새 재생을 덮지 않게 가드

  // AudioContext 언마운트 시 닫기(per-origin 한도 누수 방지)
  useEffect(() => () => { acRef.current?.close().catch(() => {}); }, []);

  function ensureCtx(): AudioContext {
    const ctx = acRef.current ?? new AudioContext();
    acRef.current = ctx;
    return ctx;
  }

  function teardown(): void {
    try { srcRef.current?.stop(); } catch { /* 이미 정지 */ }
    srcRef.current?.disconnect();
    anRef.current?.disconnect();
    srcRef.current = null;
    anRef.current = null;
  }

  function stop(): void {
    genRef.current++; // 진행 중 speak 무효화
    teardown();
    setLocalSeq(null); setSpeaking(null); setAnalyser(null);
  }

  /** 사용자 제스처(convo 토글/마이크 탭)에서 호출 — iOS 오디오 언락 + running 래치. */
  async function prime(): Promise<void> {
    const ctx = ensureCtx();
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    // 1-sample 무음 버퍼를 '제스처 안'에서 재생 → iOS 가 ctx 를 running 으로 고정(이후 async 유지).
    if (ctx.state === "running") {
      try {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start();
      } catch { /* noop */ }
    }
  }

  async function speak(text: string, seq?: number): Promise<void> {
    stop();                       // 이전 재생 정리 + 세대 증가
    const gen = genRef.current;
    const ctx = ensureCtx();
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const blob = await ttsFetch(text);
    if (!blob || gen !== genRef.current) return;
    let buf: AudioBuffer;
    try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); }
    catch { return; }
    if (gen !== genRef.current) return; // 그 사이 stop()/새 speak() → 폐기

    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(an);
    an.connect(ctx.destination);
    srcRef.current = src;
    anRef.current = an;
    setAnalyser(an);
    const id = seq ?? null;
    setLocalSeq(id); setSpeaking(id);
    src.onended = () => { if (gen === genRef.current) stop(); };
    try { src.start(); } catch { stop(); }
  }

  return { speak, stop, prime, speakingSeq, analyser };
}
