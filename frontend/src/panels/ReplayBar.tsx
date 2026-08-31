import { useEffect, useState } from "react";
import { useStore } from "../store";

const SPEEDS = [1, 2, 4, 8];

// Transport-agnostic replay: drives the SAME fold reducer as live, so the
// renderer can't tell live from replay. Scrubbing re-folds from the start.
export default function ReplayBar() {
  const pos = useStore((s) => s.replayPos);
  const total = useStore((s) => s.replayBuffer.length);
  const seek = useStore((s) => s.seek);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);

  useEffect(() => {
    if (!playing) return;
    if (pos >= total) {
      setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => seek(pos + 1), 150 / speed);
    return () => clearTimeout(id);
  }, [playing, pos, total, speed, seek]);

  const atEnd = pos >= total;

  return (
    <div className="replay-bar">
      <span className="replay-tag">리플레이</span>
      <button
        className="replay-btn"
        onClick={() => {
          if (atEnd) seek(0);
          setPlaying((p) => !p);
        }}
        title={playing ? "일시정지" : "재생"}
      >
        {playing ? "⏸" : atEnd ? "↻" : "▶"}
      </button>
      <button className="replay-btn" onClick={() => { setPlaying(false); seek(0); }} title="처음으로">⏮</button>
      <input
        className="replay-scrub"
        type="range"
        min={0}
        max={total}
        value={pos}
        onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }}
      />
      <span className="replay-pos">{pos} / {total}</span>
      <select className="replay-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
        {SPEEDS.map((s) => (
          <option key={s} value={s}>{s}×</option>
        ))}
      </select>
    </div>
  );
}
