import { useRef, useState } from "react";

/** 홀드 녹음(push-to-talk). getUserMedia→MediaRecorder + AnalyserNode(스트립 구동). */
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const mr = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const ac = useRef<AudioContext | null>(null);

  async function start(): Promise<void> {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const ctx = new AudioContext();
      ac.current = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(an);
      setAnalyser(an);
      chunks.current = [];
      const rec = new MediaRecorder(s);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      mr.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "마이크 사용 불가");
    }
  }

  function cleanup() {
    stream.current?.getTracks().forEach((t) => t.stop());
    ac.current?.close().catch(() => {});
    stream.current = null; ac.current = null; setAnalyser(null);
  }

  function stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const rec = mr.current;
      if (!rec || rec.state === "inactive") { setRecording(false); cleanup(); return resolve(null); }
      rec.onstop = () => {
        const blob = chunks.current.length ? new Blob(chunks.current, { type: rec.mimeType || "audio/webm" }) : null;
        setRecording(false); cleanup(); resolve(blob);
      };
      rec.stop();
    });
  }

  return { recording, start, stop, analyser, error };
}
