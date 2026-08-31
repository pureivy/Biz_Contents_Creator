#!/usr/bin/env python3
"""카드뉴스 레퍼런스 검색 — DuckDuckGo 이미지 검색 + 다운로드(card-news-maker searcher.py 이식).

인기 카드뉴스 디자인 레퍼런스를 수집해 디자이너(LLM)가 트렌드를 분석할 수 있게 한다.
검색·다운로드·검증 실패는 전부 무해(fail-open) — 빈 매니페스트로 exit 0, 파이프라인은
레퍼런스 없이 기존 경로로 진행한다.

사용:
  python cardnews_search.py --query "국밥집 카드뉴스 인스타그램 디자인" \
    --num 5 --output-dir refs/ --manifest refs_manifest.json

매니페스트: {"images":[{"file_path","url","width","height"}], "count", "query"}
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlparse


def eprint(*a):
    print(*a, file=sys.stderr)


def search_image_urls(query: str, num: int) -> list[str]:
    """DuckDuckGo 이미지 URL 검색 — 실패 시 빈 목록(fail-open)."""
    try:
        from ddgs import DDGS
        with DDGS() as d:
            results = list(d.images(query, max_results=num * 2))  # 다운로드/검증 탈락 여유분
        return [r.get("image") for r in results if r.get("image")]
    except Exception as e:  # noqa: BLE001
        eprint(f"검색 실패(건너뜀): {e}")
        return []


def _ext_from_url(url: str) -> str:
    p = urlparse(url).path.lower()
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        if p.endswith(ext):
            return ext
    return ".jpg"


MAX_BYTES = 15 * 1024 * 1024  # 이미지 1장 하드캡 — 거대 응답으로 인한 메모리/디스크 폭주 방지


def _host_is_global(host: str | None) -> bool:
    """호스트가 공인(글로벌) IP 로만 해석되는지 — 루프백/사설/링크로컬 차단(SSRF 완화).

    검색결과 오염으로 내부망 주소가 섞여도 요청하지 않는다. 리다이렉트 종착지도 재검증하지만
    중간 hop 요청 자체는 막지 못하는 잔존 한계는 수용(데스크톱 앱·저심각도 완화 수준).
    """
    import ipaddress
    import socket
    if not host:
        return False
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(host, None)}
        return bool(addrs) and all(ipaddress.ip_address(a).is_global for a in addrs)
    except Exception:  # noqa: BLE001
        return False


def download(url: str, save_dir: Path) -> Path | None:
    """이미지 1장 다운로드 — 스킴/호스트 검증 + 스트리밍 사이즈 캡. 실패 시 None(fail-open)."""
    try:
        import httpx
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not _host_is_global(parsed.hostname):
            return None
        fp = save_dir / (hashlib.md5(url.encode()).hexdigest()[:16] + _ext_from_url(url))
        buf = bytearray()
        with httpx.Client(timeout=20.0, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as c:
            with c.stream("GET", url) as r:
                r.raise_for_status()
                if not _host_is_global(r.url.host):  # 리다이렉트 종착지 재검증
                    return None
                if int(r.headers.get("content-length") or 0) > MAX_BYTES:
                    return None
                for chunk in r.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_BYTES:  # Content-Length 없는 드립 응답도 캡
                        return None
        if len(buf) < 8_000:  # 아이콘/깨진 응답 컷
            return None
        fp.write_bytes(bytes(buf))
        return fp
    except Exception as e:  # noqa: BLE001
        eprint(f"다운로드 실패(건너뜀): {url[:80]} — {e}")
        return None


def validate(fp: Path) -> tuple[int, int] | None:
    """Pillow 로 열리는 실제 이미지인지 + 최소 크기(400px) 검증. 탈락 시 파일 제거."""
    try:
        from PIL import Image
        with Image.open(fp) as im:
            im.verify()
        with Image.open(fp) as im:  # verify 후 재오픈(치수 읽기)
            w, h = im.size
        if w < 400 or h < 400:
            fp.unlink(missing_ok=True)
            return None
        return (w, h)
    except Exception:  # noqa: BLE001
        fp.unlink(missing_ok=True)
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="카드뉴스 레퍼런스 이미지 검색·다운로드")
    ap.add_argument("--query", required=True)
    ap.add_argument("--num", type=int, default=5, help="목표 이미지 수(캡 8)")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--manifest", required=True)
    args = ap.parse_args()

    num = min(max(1, args.num), 8)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(args.manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    images = []
    for url in search_image_urls(args.query, num):
        if len(images) >= num:
            break
        fp = download(url, out_dir)
        if not fp:
            continue
        size = validate(fp)
        if not size:
            continue
        images.append({"file_path": str(fp.resolve()), "url": url, "width": size[0], "height": size[1]})

    manifest = {"images": images, "count": len(images), "query": args.query}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"레퍼런스 {len(images)}장 수집 — {manifest_path}")
    return 0  # 0장이어도 정상 종료(fail-open)


if __name__ == "__main__":
    sys.exit(main())
