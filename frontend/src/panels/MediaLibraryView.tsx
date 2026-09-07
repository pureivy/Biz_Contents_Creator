import { useEffect, useRef, useState } from "react";
import Ico from "./Ico";

/**
 * 사진·영상 보관소 — 한 번 올려 두고 여러 콘텐츠가 꺼내 쓴다.
 *
 * 컴포저 첨부는 '이 런에만' 쓰인다. 그래서 같은 소재 사진을 소재 편마다 다시 올려야 했다.
 * 여기에 소재 이름(품종·제품·메뉴 등, 소재 사전의 키)을 붙여 두면, 그 소재 콘텐츠가 만들어질 때 자동으로 화면에 들어간다.
 */
interface MediaItem {
  id: string; kind: "image" | "video"; name: string; bytes: number;
  seconds?: number; species?: string; tags?: string[]; note?: string; createdTs: string;
}

const fmtSize = (b: number): string => (b > 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);

export default function MediaLibraryView() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [species, setSpecies] = useState("");
  const [tags, setTags] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const r = await fetch("/media");
      const j = (await r.json()) as { media?: MediaItem[] };
      setItems(j.media ?? []);
    } catch { /* 목록 실패는 빈 화면으로 — 업로드는 계속 가능 */ }
  };
  useEffect(() => { void load(); }, []);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f);
      // 올릴 때 소재 이름을 붙이는 게 핵심 — 안 붙이면 범용 소재라 아무 편에나 쓰인다.
      if (species.trim()) fd.append("species", species.trim());
      if (tags.trim()) fd.append("tags", tags.trim());
      const r = await fetch("/media", { method: "POST", body: fd });
      const j = (await r.json()) as { error?: string; skipped?: Array<{ file: string; reason: string }> };
      if (j.error) window.alert(j.error);
      else if (j.skipped?.length) window.alert(`일부 제외:\n${j.skipped.map((s) => `· ${s.file} — ${s.reason}`).join("\n")}`);
      await load();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    await fetch(`/media/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await load();
  };
  const remove = async (m: MediaItem) => {
    if (!window.confirm(`"${m.name}" 을(를) 보관소에서 지울까요? 파일도 함께 삭제됩니다.`)) return;
    await fetch(`/media/${m.id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div className="media-lib">
      <div className="media-head">
        <div>
          <h2>사진·영상 보관소</h2>
          <p>올릴 때 소재 이름(품종·제품·메뉴 등)을 붙여 두면, 그 소재의 콘텐츠를 만들 때 자동으로 화면에 들어갑니다. 비우면 어떤 주제에나 쓰이는 범용 소재가 되고, 처음 보는 이름은 소재 사전이 배웁니다.</p>
        </div>
        <div className="media-upload">
          <input value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="소재 이름 (품종·제품명)" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="태그 쉼표로 (가을, 열매)" />
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Ico name="plus" size={12} /> {busy ? "올리는 중…" : "사진·영상 올리기"}
          </button>
          <input ref={fileRef} type="file" multiple hidden
            accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm"
            onChange={(e) => void upload(e.target.files)} />
        </div>
      </div>

      {items.length === 0 ? (
        <p className="media-empty">아직 보관된 소재가 없습니다. 직접 찍은 사진·영상을 올려 두면 생성 이미지 대신 화면에 씁니다.</p>
      ) : (
        <div className="media-grid">
          {items.map((m) => (
            <div key={m.id} className="media-card">
              <div className="media-thumb">
                {m.kind === "image"
                  ? <img src={`/media/file/${m.id}`} alt={m.name} loading="lazy" />
                  : <video src={`/media/file/${m.id}`} muted preload="metadata" />}
                <span className="media-kind">{m.kind === "video" ? `영상 ${m.seconds ? `${m.seconds.toFixed(1)}초` : ""}` : "사진"}</span>
              </div>
              <div className="media-meta">
                <span className="media-name" title={m.name}>{m.name}</span>
                <span className="media-sub">{fmtSize(m.bytes)}</span>
                <input className="media-species" defaultValue={m.species ?? ""} placeholder="소재 이름"
                  onBlur={(e) => { if (e.target.value !== (m.species ?? "")) void patch(m.id, { species: e.target.value }); }} />
                <input className="media-tags" defaultValue={(m.tags ?? []).join(", ")} placeholder="태그"
                  onBlur={(e) => {
                    const next = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
                    if (next.join(",") !== (m.tags ?? []).join(",")) void patch(m.id, { tags: next });
                  }} />
                <button type="button" className="media-del" onClick={() => void remove(m)}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
