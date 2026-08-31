"""검은 단색 배경 위 밝은 캘리 → 투명 PNG(휘도 매트, 스크린 합성 역산).

사용: title_matte.py <in.png> <out.png>
쇼츠 상단 제목 오버레이용 — gpt-image 가 투명 배경을 지원하지 않아(gpt-image-2 실측 400),
순수 검은 배경에 그린 획을 알파로 역산한다. 획 내부는 불투명, 가장자리 반투명은
unpremultiply 로 색 복원(검정 프린지 방지). 여백은 트리밍(+8px 패딩).
"""
import sys

import numpy as np
from PIL import Image


def main() -> int:
    if len(sys.argv) != 3:
        print("사용법: title_matte.py <in.png> <out.png>", file=sys.stderr)
        return 2
    src = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(np.float32)
    mx = src.max(axis=2)
    alpha = np.clip(mx / 235.0, 0, 1)   # 235+ 는 완전 불투명
    alpha[alpha < 0.06] = 0             # 배경 노이즈 컷
    # 배경 순도 검증 — 모델이 '순수 검정'을 어기고 회색/무늬 배경을 그리면 커버리지가 치솟는다.
    # 그대로 진행하면 반투명 워시/회색 사각형이 영상 위에 얹히므로 실패 처리(호출부가 오버레이 생략).
    if float((alpha > 0.05).mean()) > 0.5:
        print("오류: 배경이 검정이 아님(알파 커버리지 과다) — 매트 불가", file=sys.stderr)
        return 1
    a3 = alpha[..., None]
    color = np.where(a3 > 0.01, np.clip(src / np.maximum(a3, 1e-6), 0, 255), 0)
    rgba = np.dstack([color.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    out = Image.fromarray(rgba)
    # 트리밍 기준은 '강한 획'만 — 떠도는 저알파 잡티 1픽셀이 크롭을 무력화하지 않게.
    bbox = Image.fromarray(((alpha > 0.3) * 255).astype(np.uint8)).getbbox()
    if bbox is None:
        print("오류: 획이 감지되지 않음(전부 배경)", file=sys.stderr)
        return 1
    pad = 8
    out = out.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                    min(out.width, bbox[2] + pad), min(out.height, bbox[3] + pad)))
    out.save(sys.argv[2])
    print(f"OK {out.width}x{out.height}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
