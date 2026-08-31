#!/usr/bin/env python3
"""유튜브 쇼츠 커버(썸네일) 지정 — Playwright 지속 세션.

Data API(thumbnails.set)가 쇼츠 세로 피드 커버를 못 바꾸는 한계를, 유튜브 스튜디오 웹 UI
자동화로 우회한다. 네이버 발행(naver_publish.py)의 지속 프로필 패턴을 그대로 재사용:
1회 로그인 → 전용 프로필에 세션 지속 → 이후 헤드리스 무인 반복.

사용:
  1회 로그인(헤드풀, 사용자가 직접 구글 로그인):
      python youtube_cover.py --login [--slug bionditree]
  UI 실물 확인(읽기 전용 — 커버 편집 UI가 있는지/셀렉터 파악):
      python youtube_cover.py --video-id <ID> --inspect [--slug ..] [--headless]
  커버 지정(0초=디자인 썸네일 업로드):
      python youtube_cover.py --video-id <ID> --thumbnail <path> [--slug ..] [--headless]

주의: 구글 비밀번호/2단계/캡차는 자동화하지 않는다(사용자 1회 수동 로그인). 로그인은 반드시 --login 으로.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path


def log(m: str) -> None:
    print(m, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    """구조화 결과를 stdout 로(서버가 파싱). 로그는 stderr 로 분리."""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def profile_path(slug: str) -> Path:
    # 인스턴스별 프로필 분리(멀티 브랜드) — YOUTUBE_PROFILE_DIR 지정 시 그 경로, 아니면 slug 별 홈 경로.
    if os.environ.get("YOUTUBE_PROFILE_DIR"):
        p = Path(os.environ["YOUTUBE_PROFILE_DIR"])
    else:
        p = Path.home() / ".youtube-studio-profiles" / (slug or "default")
    p.mkdir(parents=True, exist_ok=True)
    return p


def make_context(pw, profile_dir: Path, headless: bool):
    # 네이버와 동일한 자동화 탐지 회피 + 지속 프로필(캡차/재로그인 회피).
    ctx = pw.chromium.launch_persistent_context(
        str(profile_dir),
        channel="chrome",
        headless=headless,
        slow_mo=80,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--disable-extensions",
        ],
        ignore_default_args=["--enable-automation"],
        viewport={"width": 1360, "height": 960},
    )
    ctx.add_init_script(
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        "window.chrome={runtime:{}};"
    )
    return ctx


def _logged_in(page) -> bool:
    # 스튜디오 대시보드/채널 페이지면 로그인된 것. 로그인 화면(accounts.google.com)이면 아님.
    try:
        return "studio.youtube.com" in page.url and "accounts.google" not in page.url
    except Exception:
        return False


def do_login(slug: str) -> None:
    from playwright.sync_api import sync_playwright

    profile_dir = profile_path(slug)
    with sync_playwright() as pw:
        ctx = make_context(pw, profile_dir, headless=False)  # 로그인은 반드시 헤드풀
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto("https://studio.youtube.com", wait_until="domcontentloaded", timeout=30000)
        log("")
        log("=" * 60)
        log("브라우저 창이 열렸습니다. 그 창에서 유튜브(구글) 로그인을 완료하세요.")
        log("커버를 지정할 채널로 전환까지 해 두면 됩니다.")
        log("로그인이 감지되면 자동으로 세션을 저장하고 창을 닫습니다(Enter 불필요).")
        log("최대 6분 대기합니다...")
        log("=" * 60)
        # TTY 없이도 되도록 input() 대신 로그인 완료를 폴링 감지 + 실패 원인 진단.
        deadline = time.time() + 360
        ok = False
        blocked = None
        shot = str(profile_dir / "login-current.png")  # 진단용 현재 화면(로컬 전용)
        block_msgs = [
            "안전하지 않을 수 있", "browser or app may not be secure",
            "Couldn't sign you in", "로그인할 수 없", "확인할 수 없는 브라우저",
            "This browser or app may not be secure",
        ]
        tick = 0
        while time.time() < deadline:
            time.sleep(3)
            tick += 1
            if _logged_in(page):
                # 대시보드 진입 확인 후 채널 전환 여유 10초.
                log("[로그인] 감지됨 — 10초 후 세션 저장")
                time.sleep(10)
                ok = _logged_in(page)
                break
            if tick % 5 == 0:  # ~15초마다 진단 스냅샷 + 구글 차단 문구 감지
                try:
                    page.screenshot(path=shot)
                except Exception:
                    pass
                try:
                    txt = page.evaluate("() => document.body ? document.body.innerText.slice(0,3000) : ''")
                    hit = next((m for m in block_msgs if m in txt), None)
                    if hit:
                        blocked = hit
                        log(f"[차단감지] 구글이 자동화 브라우저 로그인을 거부하는 문구 발견: '{hit}'")
                        try:
                            page.screenshot(path=shot)
                        except Exception:
                            pass
                        break
                except Exception:
                    pass
        try:
            ctx.storage_state(path=str(profile_dir / "yt_storage.json"))
        except Exception as e:
            log(f"[세션] storage_state 저장 실패(무해, 프로필로도 지속): {str(e)[:80]}")
        last_url = ""
        try:
            last_url = page.url
        except Exception:
            pass
        ctx.close()
        note = "로그인 확인됨" if ok else (
            f"구글 자동화 차단 감지: '{blocked}' — Playwright 로그인 불가, 확장/쿠키이관 대안 필요" if blocked
            else "로그인 미확인(6분 초과) — 다시 --login 실행")
        emit({"ok": ok, "mode": "login", "profile": str(profile_dir),
              "blocked": blocked, "last_url": last_url, "screenshot": shot, "note": note})


def _goto_edit(page, video_id: str) -> None:
    url = f"https://studio.youtube.com/video/{video_id}/edit"
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    time.sleep(4)  # 스튜디오 SPA 렌더 대기


def do_inspect(slug: str, video_id: str, headless: bool) -> None:
    """읽기 전용 — 편집 페이지에서 썸네일/커버 관련 UI 존재 여부와 후보 셀렉터를 덤프."""
    from playwright.sync_api import sync_playwright

    profile_dir = profile_path(slug)
    shot = str(profile_dir / f"inspect-{video_id}.png")
    with sync_playwright() as pw:
        ctx = make_context(pw, profile_dir, headless=headless)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        _goto_edit(page, video_id)
        if not _logged_in(page):
            emit({"ok": False, "mode": "inspect", "error": "not_logged_in",
                  "url": page.url, "hint": "먼저 --login 실행"})
            ctx.close()
            return
        try:
            page.screenshot(path=shot, full_page=True)
        except Exception:
            shot = None
        # 썸네일/커버 관련 텍스트·요소 탐색(한/영). 실물 UI 파악용.
        probe = page.evaluate(
            """() => {
              const kw = ['썸네일','미리보기 이미지','미리보기','커버','동영상 프레임','thumbnail','cover','frame','자동 생성','맞춤 미리보기'];
              const out = [];
              const nodes = document.querySelectorAll('*');
              for (const el of nodes) {
                const t = (el.getAttribute && (el.getAttribute('aria-label')||'')) + ' ' + (el.textContent||'').slice(0,80);
                const tag = el.tagName ? el.tagName.toLowerCase() : '';
                if (kw.some(k => t.includes(k))) {
                  // 리프에 가까운 것만(자식 많은 컨테이너 제외)
                  if (el.children.length <= 3) {
                    out.push({tag, id: el.id||'', cls: (el.className&&el.className.toString?el.className.toString():'').slice(0,60),
                              aria: (el.getAttribute && el.getAttribute('aria-label'))||'', text: (el.textContent||'').trim().slice(0,60)});
                  }
                }
                if (out.length > 40) break;
              }
              const fileInputs = [...document.querySelectorAll('input[type=file]')].map(i => ({
                accept: i.accept||'', id: i.id||'', name: i.name||'', hidden: i.offsetParent===null}));
              return {matches: out, fileInputs, title: document.title, url: location.href};
            }"""
        )
        ctx.close()
        emit({"ok": True, "mode": "inspect", "video_id": video_id,
              "screenshot": shot, "probe": probe})


def do_set_cover(slug: str, video_id: str, thumbnail: str, headless: bool) -> None:
    """커버 지정 — inspect 로 실물 UI 확인 후 셀렉터를 확정해 구현 예정.
    현재는 안전상 미구현(플레이스홀더): 잘못된 셀렉터로 엉뚱한 저장을 하지 않도록 막는다."""
    emit({"ok": False, "mode": "set_cover", "error": "not_implemented",
          "note": "먼저 --inspect 로 실물 커버 UI를 확인한 뒤 셀렉터를 확정해 구현합니다."})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", default=os.environ.get("YOUTUBE_SLUG", "bionditree"))
    ap.add_argument("--video-id")
    ap.add_argument("--thumbnail")
    ap.add_argument("--login", action="store_true")
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        emit({"ok": False, "error": "playwright 패키지 필요 — pip install playwright && playwright install chrome"})
        sys.exit(1)

    if args.login:
        do_login(args.slug)
    elif args.inspect:
        if not args.video_id:
            emit({"ok": False, "error": "--video-id 필요"})
            sys.exit(1)
        do_inspect(args.slug, args.video_id, args.headless)
    elif args.video_id and args.thumbnail:
        do_set_cover(args.slug, args.video_id, args.thumbnail, args.headless)
    else:
        emit({"ok": False, "error": "사용법: --login | --video-id <ID> --inspect | --video-id <ID> --thumbnail <path>"})
        sys.exit(1)


if __name__ == "__main__":
    main()
