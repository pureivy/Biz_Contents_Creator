#!/usr/bin/env python3
"""
블로그 이미지 생성 스킬 (gpt-image-2)

gepa 초안(draft.json = BlogDraft)의 imageSlots 또는 마크다운 본문의 `[IMAGE: 설명]`
마커를 기반으로 OpenAI 이미지 API(gpt-image-2)로 이미지를 생성하고, naver_publish.py 와
호환되는 매니페스트(`{"images": [{"file_path": ...}]}`)를 작성한다.

원본: naver-blog-agent-web/.claude/skills/image-generator (Gemini) → gpt-image-2 로 교체·단순화.

사용:
  python openai_image.py \
    --draft   <draft.json 경로>            # 또는 --content <마크다운 파일/텍스트>
    --output-dir <이미지 저장 디렉토리> \
    --manifest   <매니페스트 JSON 출력 경로> \
    --business-type "음식점" \
    --image-style   photorealistic \
    --topic "가게명/주제" \
    [--limit 4] [--size 1024x1024] [--model gpt-image-2] [--dry-run]

--dry-run: 실제 API 를 호출하지 않고(OPENAI_API_KEY 불필요) 매니페스트만 계획대로 기록.
"""
import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path

# 블로그 톤앤매너 스타일 프리셋(원본 image-generator STYLE_PRESETS 축약).
STYLE_PRESETS = {
    "photorealistic": "high-quality photorealistic photograph, bright and airy natural daylight, clean well-lit scene with soft highlights, warm and vivid true-to-life colors, authentic lifestyle aesthetic, avoid dark moody or muddy low-light, not stock-photo-like",
    "manhwa":         "Korean manhwa-style illustration, clean line art, soft cel shading",
    "watercolor":     "soft watercolor illustration, warm dreamy atmosphere, Korean art style",
    "ink_wash":       "East Asian ink wash painting style, minimal elegant composition, ink brushwork accents",
    "flat_design":    "modern flat design vector illustration, minimalist Korean design aesthetic, 2D style",
    "retro_poster":   "vintage retro Korean poster-style illustration, strong composition, nostalgic atmosphere",
    "handwritten_poster": "realistic outdoor photograph fused with large hand-drawn calligraphic HANGUL lettering embedded in the scene via depth and occlusion, indie-festival key-visual mood, boosted-natural saturation, soft sunlight, subtle film grain",
    # 쇼츠 상단 제목 오버레이 — 순수 검정 배경 위 붓펜 캘리(로컬 휘도 매트로 투명화 전제)
    "calligraphy":    "bold Korean brush-pen calligraphy lettering on a pure solid black background, crisp clean flat strokes, no glow, no halo, no gradient, no shadow, graphic sticker style",
}
DEFAULT_STYLE = "photorealistic"


def eprint(*a):
    print(*a, file=sys.stderr)


def read_maybe_file(value: str) -> str:
    """값이 존재하는 파일 경로면 내용을, 아니면 값 자체를 반환."""
    if not value:
        return ""
    try:
        p = Path(value)
        if p.exists() and p.is_file():
            return p.read_text(encoding="utf-8")
    except OSError:
        pass
    return value


def load_slots(draft: str, content: str, limit: int) -> list[dict]:
    """이미지 슬롯 목록을 만든다. 우선순위: draft.json(imageSlots) → 본문 [IMAGE:] 마커."""
    slots: list[dict] = []

    # 1) draft.json (BlogDraft) — {"imageSlots": [{"alt","prompt"}], "topic", "bodyMarkdown"}
    raw = read_maybe_file(draft) if draft else ""
    if raw:
        try:
            d = json.loads(raw)
            for s in d.get("imageSlots", []) or []:
                prompt = (s.get("prompt") or s.get("alt") or "").strip()
                if prompt:
                    slots.append({"prompt": prompt, "alt": (s.get("alt") or "").strip()})
            if not slots and d.get("bodyMarkdown"):
                content = content or d["bodyMarkdown"]
        except (json.JSONDecodeError, AttributeError):
            # draft 가 JSON 이 아니면 본문으로 취급
            content = content or raw

    # 2) 마크다운 본문의 [IMAGE: 설명] 마커
    if not slots and content:
        body = read_maybe_file(content)
        for m in re.findall(r"\[IMAGE:\s*([^\]]+)\]", body):
            desc = m.strip()
            if desc:
                slots.append({"prompt": desc, "alt": desc})

    return slots[: max(0, limit)] if limit else slots


def build_prompt(slot: dict, style: str, business_type: str, topic: str, allow_text: bool = False) -> str:
    style_desc = STYLE_PRESETS.get(style, STYLE_PRESETS[DEFAULT_STYLE])
    parts = [slot["prompt"]]
    if business_type:
        parts.append(f"업종: {business_type}")
    if topic:
        parts.append(f"주제/가게: {topic}")
    parts.append(style_desc)
    if allow_text:
        # 카드뉴스 완성 카드 — 슬롯 프롬프트에 명시된 한국어 문구는 렌더링, 그 외 잡글자는 차단.
        parts.append("프롬프트에 명시된 한국어 문구만 정확히 그 표기 그대로 렌더링, 그 외 글자·워터마크·로고 금지")
    else:
        parts.append("no text, no watermark, no logo")  # 블로그 이미지엔 글자 없이
    return ", ".join(parts)


def _normalize_ref(path: Path, work_dir: Path):
    """참조 이미지를 gpt-image-2 지원 포맷(PNG·RGB)으로 정규화 — 애니메이션(GIF 등)은 첫 프레임.
    Pillow 로 못 열면 None(스킵). GIF/webp·CMYK·확장자↔내용 불일치를 흡수해 invalid_image_file 을 방지한다
    (실측 2026-07-24: .jpg 로 저장된 네이버 카페 GIF 가 카드뉴스 배경 7/7 실패시킴)."""
    try:
        from PIL import Image  # 지연 임포트 — Pillow 없어도 일반 생성 경로는 동작
        with Image.open(path) as im:
            try:
                im.seek(0)  # 애니메이션이면 첫 프레임
            except Exception:  # noqa: BLE001
                pass
            out = work_dir / f"norm-{path.stem}.png"
            im.convert("RGB").save(out, format="PNG")
            return out
    except Exception:  # noqa: BLE001
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="블로그 이미지 생성(gpt-image-2)")
    ap.add_argument("--draft", default="", help="draft.json(BlogDraft) 경로 또는 JSON 문자열")
    ap.add_argument("--content", default="", help="마크다운 본문 파일/문자열([IMAGE:] 마커 파싱)")
    ap.add_argument("--output-dir", required=True, help="이미지 저장 디렉토리")
    ap.add_argument("--manifest", required=True, help="매니페스트 JSON 출력 경로")
    ap.add_argument("--business-type", default="")
    ap.add_argument("--image-style", default=DEFAULT_STYLE)
    ap.add_argument("--topic", default="")
    ap.add_argument("--limit", type=int, default=4, help="최대 이미지 수(폭주/과금 방지)")
    ap.add_argument("--size", default="1024x1024", help="1024x1024 | 1536x1024 | 1024x1536")
    ap.add_argument("--model", default=os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2"))
    ap.add_argument("--ref-images", nargs="*", default=[],
                    help="참조 이미지 경로들 — 있으면 images.edit 로 참조 스타일 기반 생성(최대 4장 사용)")
    ap.add_argument("--allow-text", action="store_true",
                    help="프롬프트에 명시된 문구의 이미지 내 렌더링 허용(카드뉴스 완성 카드) — 기본은 no-text")
    ap.add_argument("--dry-run", action="store_true", help="API 미호출(키 불필요) — 매니페스트만 계획대로 기록")
    args = ap.parse_args()

    # 참조 이미지 검증 — 존재하는 파일만, 캡 4장(요청 크기 폭주 방지). 전부 무효면 일반 생성으로 폴백.
    ref_paths = [Path(p) for p in args.ref_images if p and Path(p).is_file()][:4]

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # 참조 정규화 — gpt-image-2 미지원 포맷(GIF 등)·확장자 불일치를 PNG·RGB 로 변환(못 열면 스킵)해
    # images.edit 의 invalid_image_file 을 막는다. 전부 무효면 일반 생성으로 폴백(아래 ref_paths 빈 분기).
    if ref_paths:
        _nd = out_dir / "_refnorm"
        _nd.mkdir(parents=True, exist_ok=True)
        ref_paths = [q for q in (_normalize_ref(p, _nd) for p in ref_paths) if q is not None]
    manifest_path = Path(args.manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    slots = load_slots(args.draft, args.content, args.limit)
    if not slots:
        # 슬롯이 없으면 빈 매니페스트를 남기고 정상 종료(파이프라인 차단 방지).
        manifest = {"images": [], "count": 0, "model": args.model, "dry_run": args.dry_run,
                    "note": "이미지 슬롯 없음(draft.imageSlots·[IMAGE:] 마커 모두 비어 있음)"}
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"이미지 슬롯 없음 — 빈 매니페스트 기록: {manifest_path}")
        return 0

    client = None
    if not args.dry_run:
        if not os.environ.get("OPENAI_API_KEY"):
            eprint("오류: OPENAI_API_KEY 미설정(--dry-run 으로 테스트하거나 키를 설정하세요)")
            return 2
        try:
            from openai import OpenAI  # 지연 임포트 — dry-run 은 openai 없이도 동작
            client = OpenAI()
        except Exception as e:  # noqa: BLE001
            eprint(f"오류: OpenAI 클라이언트 초기화 실패: {e}")
            return 2

    images = []
    for i, slot in enumerate(slots):
        prompt = build_prompt(slot, args.image_style, args.business_type, args.topic, args.allow_text)
        filename = f"blog-image-{i + 1:02d}.png"
        file_path = out_dir / filename
        entry = {
            "index": i,
            "filename": filename,
            "file_path": str(file_path.resolve()),
            "alt": slot.get("alt", ""),
            "prompt": prompt,
            "style": args.image_style,
        }
        if args.dry_run:
            entry["dry_run"] = True
        else:
            try:
                if ref_paths:
                    # 참조 스타일 생성 — 레퍼런스의 팔레트·무드·질감을 따르되 프롬프트 장면을 새로 그림.
                    from contextlib import ExitStack
                    edit_prompt = (
                        f"{prompt}. Follow the color palette, mood, lighting and overall design style "
                        f"of the reference images, but create a completely new scene as described."
                    )
                    with ExitStack() as stack:
                        refs = [stack.enter_context(open(p, "rb")) for p in ref_paths]
                        resp = client.images.edit(model=args.model, image=refs, prompt=edit_prompt, size=args.size, n=1)
                    entry["ref_count"] = len(ref_paths)
                else:
                    resp = client.images.generate(model=args.model, prompt=prompt, size=args.size, n=1)
                b64 = resp.data[0].b64_json  # gpt-image-* 는 항상 base64 반환
                file_path.write_bytes(base64.b64decode(b64))
            except Exception as e:  # noqa: BLE001
                eprint(f"이미지 {i + 1} 생성 실패: {e}")
                entry["error"] = str(e)
        images.append(entry)

    ok = sum(1 for e in images if "error" not in e and (args.dry_run or Path(e["file_path"]).exists()))
    manifest = {"images": images, "count": len(images), "ok": ok,
                "model": args.model, "style": args.image_style, "dry_run": args.dry_run}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    mode = "DRY-RUN(계획)" if args.dry_run else "생성"
    print(f"이미지 {mode}: {ok}/{len(images)}장 · 모델 {args.model} · 매니페스트 {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
