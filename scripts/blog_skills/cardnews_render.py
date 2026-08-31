#!/usr/bin/env python3
"""카드뉴스 텍스트 오버레이 렌더러 — 배경 PNG 위에 헤드라인/본문을 Pillow 로 합성.

card-news-maker(참고 프로젝트) renderer.py 의 검증된 오버레이 알고리즘 이식:
  - 줄바꿈은 글자수가 아니라 픽셀 측정(char 단위 getbbox) — 한글에 자연스러움
  - 텍스트 블록 전체 세로 중앙 정렬 + 블록 뒤 반투명 라운드 박스(전면 디밍 없음)
  - 헤드라인/본문 각각 오프셋 그림자로 가독성 확보
AI 이미지의 한글 오타 문제를 피하기 위해 텍스트는 전부 여기서 얹는다(배경은 텍스트 금지 생성).

입력:
  --plan        plan.json — {"title", "slides":[{"headline","body"?}]}
  --backgrounds openai_image.py 매니페스트 — {"images":[{"file_path", ...}]} (순서 = 슬라이드 순서)
  --output-dir  slide_NN.png 저장 디렉토리
  --manifest    렌더 결과 매니페스트(JSON) 출력 경로
  --size        정사각 한 변(기본 1024)

배경 누락/실패 슬라이드는 인덱스별 색상 그라데이션으로 폴백(전체 실패 방지).
exit 0=전부 성공, 2=일부/전체 실패(매니페스트 slides[].error 로 상세).
"""
import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 이모지·변형선택자 제거 — 카드 텍스트는 이모지 금지 정책이지만 LLM 출력 방어선.
_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"
    "☀-➿"
    "️‍"
    "]+",
    flags=re.UNICODE,
)

HOME = Path.home()
HEADLINE_FONTS = [
    HOME / "Library/Fonts/NanumGothic-ExtraBold.ttf",
    HOME / "Library/Fonts/Pretendard-ExtraBold.otf",
    HOME / "Library/Fonts/Pretendard-Black.otf",
]
BODY_FONTS = [
    HOME / "Library/Fonts/Pretendard-SemiBold.otf",
    HOME / "Library/Fonts/Pretendard-Medium.otf",
    HOME / "Library/Fonts/NanumGothic-Bold.ttf",
]
# 최후 폴백 — macOS 시스템 한글 폰트(.ttc 는 index 필요).
SYSTEM_TTC = Path("/System/Library/Fonts/AppleSDGothicNeo.ttc")

# 배경 폴백 그라데이션 팔레트(상단색, 하단색) — 인덱스 순환.
GRADIENTS = [
    ((36, 60, 92), (18, 30, 48)),     # 딥 네이비
    ((52, 84, 74), (24, 42, 38)),     # 딥 그린
    ((88, 58, 44), (44, 28, 24)),     # 웜 브라운
    ((64, 52, 88), (30, 24, 44)),     # 딥 퍼플
    ((40, 70, 88), (20, 34, 44)),     # 틸
]


def log(msg: str) -> None:
    print(msg, flush=True)


def clean(text: str) -> str:
    return _EMOJI_RE.sub("", text or "").strip()


def load_font(paths, size: int):
    for p in paths:
        try:
            if Path(p).exists():
                return ImageFont.truetype(str(p), size)
        except Exception:
            continue
    if SYSTEM_TTC.exists():
        for idx in (5, 2, 0):  # SemiBold 근처 → 폴백
            try:
                return ImageFont.truetype(str(SYSTEM_TTC), size, index=idx)
            except Exception:
                continue
    raise RuntimeError("한글 폰트를 찾을 수 없습니다 (NanumGothic/Pretendard/AppleSDGothicNeo)")


def wrap_text(text: str, font, max_width: int) -> list:
    """픽셀 측정 char 단위 줄바꿈 — 참고 renderer._wrap_text 이식."""
    lines = []
    for para in (text or "").split("\n"):
        para = para.strip()
        if not para:
            continue
        line = ""
        for ch in para:
            test = line + ch
            if font.getbbox(test)[2] > max_width and line:
                lines.append(line)
                line = ch.lstrip()
            else:
                line = test
        if line:
            lines.append(line)
    return lines


def gradient_bg(size: int, idx: int) -> Image.Image:
    top, bottom = GRADIENTS[idx % len(GRADIENTS)]
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def draw_lines(draw, lines, font, start_y, size, fill, shadow_offset, shadow_fill, line_h):
    y = start_y
    for line in lines:
        w = font.getbbox(line)[2]
        x = (size - w) / 2
        draw.text((x + shadow_offset, y + shadow_offset), line, font=font, fill=shadow_fill)
        draw.text((x, y), line, font=font, fill=fill)
        y += line_h
    return y


def overlay(bg: Image.Image, headline: str, body: str, size: int, slide_no: int, total: int) -> Image.Image:
    img = bg.convert("RGBA").resize((size, size))
    is_cover = slide_no == 1
    # 표지는 헤드라인만 크게, 본문 슬라이드는 참고 프로젝트 비율(//13, //26).
    h_font = load_font(HEADLINE_FONTS, size // (10 if is_cover and not body else 13))
    b_font = load_font(BODY_FONTS, size // 26)

    h_lines = wrap_text(headline, h_font, int(size * 0.85))
    b_lines = wrap_text(body, b_font, int(size * 0.80)) if body else []

    h_lh = int(h_font.size * 1.4)
    b_lh = int(b_font.size * 1.5)
    gap = int(size * 0.06) if h_lines and b_lines else 0
    total_h = len(h_lines) * h_lh + gap + len(b_lines) * b_lh
    start_y = (size - total_h) / 2

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # 텍스트 블록 뒤 반투명 라운드 박스 — 배경과 무관하게 가독성 보장.
    if h_lines or b_lines:
        widths = [h_font.getbbox(l)[2] for l in h_lines] + [b_font.getbbox(l)[2] for l in b_lines]
        block_w = max(widths)
        pad_x, pad_y = int(size * 0.06), int(size * 0.04)
        box = (
            (size - block_w) / 2 - pad_x, start_y - pad_y,
            (size + block_w) / 2 + pad_x, start_y + total_h + pad_y,
        )
        draw.rounded_rectangle(box, radius=int(size * 0.025), fill=(0, 0, 0, 130))

    y = draw_lines(draw, h_lines, h_font, start_y, size, (255, 255, 255, 255), 2, (0, 0, 0, 160), h_lh)
    if b_lines:
        draw_lines(draw, b_lines, b_font, y + gap, size, (240, 240, 240, 255), 1, (0, 0, 0, 120), b_lh)

    # 슬라이드 번호(표지 제외) — 우하단.
    if not is_cover and total > 1:
        n_font = load_font(BODY_FONTS, size // 34)
        label = f"{slide_no} / {total}"
        w = n_font.getbbox(label)[2]
        draw.text((size - w - int(size * 0.045), size - int(size * 0.075)), label,
                  font=n_font, fill=(255, 255, 255, 200))

    return Image.alpha_composite(img, layer).convert("RGB")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--backgrounds", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--size", type=int, default=1024)
    a = ap.parse_args()

    plan = json.loads(Path(a.plan).read_text(encoding="utf-8"))
    try:
        bgs = json.loads(Path(a.backgrounds).read_text(encoding="utf-8")).get("images", [])
    except Exception:
        bgs = []
    out_dir = Path(a.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    slides = plan.get("slides", [])
    total = len(slides)
    results = []
    ok = 0
    for i, slide in enumerate(slides):
        no = i + 1
        entry = {"index": no, "filename": f"slide_{no:02d}.png"}
        try:
            bg_path = (bgs[i] or {}).get("file_path") if i < len(bgs) else None
            if bg_path and Path(bg_path).exists():
                bg = Image.open(bg_path)
            else:
                bg = gradient_bg(a.size, i)
                entry["bg_fallback"] = True
            img = overlay(bg, clean(slide.get("headline", "")), clean(slide.get("body", "")), a.size, no, total)
            fp = out_dir / entry["filename"]
            img.save(fp, "PNG", quality=95)
            entry["file_path"] = str(fp)
            ok += 1
            log(f"렌더 {no}/{total}: {entry['filename']}" + (" (배경 폴백)" if entry.get("bg_fallback") else ""))
        except Exception as e:  # 슬라이드 단위 부분 실패 허용
            entry["error"] = str(e)[:200]
            log(f"렌더 {no}/{total} 실패: {entry['error']}")
        results.append(entry)

    manifest = {"ok": ok, "count": total, "slides": results}
    Path(a.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"카드 렌더: {ok}/{total}장 · 매니페스트 {a.manifest}")
    return 0 if ok == total and total > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
