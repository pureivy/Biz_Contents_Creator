#!/usr/bin/env python3
"""숏폼 씬 프레임 합성 — 배경 이미지를 세로(기본 1620×2880)로 커버핏하고 화면 텍스트를 굽는다.

홈브류 ffmpeg 가 drawtext(freetype) 없이 빌드돼 있어(실측), 자막은 Pillow 로 프레임에
미리 굽고 ffmpeg 는 줌·오디오 조립만 담당한다. cardnews_render.py 의 검증된 요소
(폰트 폴백 체인·반투명 라운드 박스·그림자·그라데이션 폴백)를 세로형으로 이식.

렌더 해상도를 최종(1080×1920)의 1.5배로 잡는 이유: ffmpeg zoompan 이 다운스케일하며
텍스트가 선명해진다(업스케일 소프트닝 회피).
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HOME = Path.home()
FONTS = [
    HOME / "Library/Fonts/Pretendard-Bold.otf",
    HOME / "Library/Fonts/Pretendard-SemiBold.otf",
    HOME / "Library/Fonts/NanumGothic-ExtraBold.ttf",
]
SYSTEM_TTC = Path("/System/Library/Fonts/AppleSDGothicNeo.ttc")
# 딥컬러 세로 그라데이션 팔레트(상단, 하단) — 씬 인덱스 순환(배경 이미지 누락 폴백).
GRADIENTS = [
    ((36, 60, 92), (14, 24, 40)),
    ((52, 84, 74), (20, 34, 30)),
    ((88, 58, 44), (36, 24, 20)),
    ((64, 52, 88), (26, 20, 38)),
    ((40, 70, 88), (16, 28, 38)),
]


def load_font(size: int):
    for p in FONTS:
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except Exception:
                continue
    if SYSTEM_TTC.exists():
        for idx in (5, 2, 0):
            try:
                return ImageFont.truetype(str(SYSTEM_TTC), size, index=idx)
            except Exception:
                continue
    raise RuntimeError("한글 폰트 없음")


def cover_fit(img: Image.Image, w: int, h: int) -> Image.Image:
    sw, sh = img.size
    scale = max(w / sw, h / sh)
    nw, nh = int(sw * scale + 0.5), int(sh * scale + 0.5)
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - w) // 2, (nh - h) // 2
    return img.crop((left, top, left + w, top + h))


def gradient_bg(w: int, h: int, idx: int) -> Image.Image:
    top, bottom = GRADIENTS[idx % len(GRADIENTS)]
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        rgb = tuple(int(top[c] + (bottom[c] - top[c]) * t) for c in range(3))
        for x in range(w):
            px[x, y] = rgb
    return img


def wrap_px(text: str, font, max_w: int) -> list:
    lines, line = [], ""
    for ch in text:
        test = line + ch
        if font.getbbox(test)[2] > max_w and line:
            lines.append(line)
            line = ch.lstrip()
        else:
            line = test
    if line:
        lines.append(line)
    return lines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="", help="배경 이미지(없으면 그라데이션 폴백)")
    ap.add_argument("--text", default="", help="화면 텍스트(비면 배경만)")
    ap.add_argument("--index", type=int, default=0, help="씬 인덱스(폴백 색 순환)")
    ap.add_argument("--output", required=True)
    ap.add_argument("--width", type=int, default=1620)
    ap.add_argument("--height", type=int, default=2880)
    a = ap.parse_args()

    w, h = a.width, a.height
    if a.image and Path(a.image).exists():
        base = cover_fit(Image.open(a.image).convert("RGB"), w, h)
    else:
        base = gradient_bg(w, h, a.index)

    text = (a.text or "").strip()
    if text:
        img = base.convert("RGBA")
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        font = load_font(w // 14)  # 1620px 기준 ≈115px — 세로 화면에서 크게
        lines = wrap_px(text, font, int(w * 0.86))
        lh = int(font.size * 1.35)
        block_h = lh * len(lines)
        # 하단 20% 지점 — 블록 세로 중심 y≈80%. 배경 박스 없음(사용자 지정) — 가독성은 그림자 담당.
        y0 = int(h * 0.80) - block_h // 2
        y = y0
        for line in lines:
            lw = font.getbbox(line)[2]
            x = (w - lw) / 2
            draw.text((x + 3, y + 3), line, font=font, fill=(0, 0, 0, 170))
            draw.text((x, y), line, font=font, fill=(255, 255, 255, 255))
            y += lh
        base = Image.alpha_composite(img, layer).convert("RGB")

    Path(a.output).parent.mkdir(parents=True, exist_ok=True)
    base.save(a.output, "PNG")
    print(json.dumps({"ok": True, "output": a.output}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
