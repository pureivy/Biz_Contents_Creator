"""
네이버 블로그 '본인' 포스트 성과 수집기 — 조회수 + 검색 유입 키워드(+체류).

전략(리서치 보고서 기반, 캡처-우선):
- 포스트별 조회수/검색 유입은 크리에이터 어드바이저(creator-advisor.naver.com) 인증 뒤에 있고
  정확한 엔드포인트는 버전마다 달라 하드코딩이 취약하다. 그래서 **네트워크 캡처**가 주 전략이다:
  로그인된 영속 프로필로 어드바이저를 열고, 페이지가 스스로 호출하는 api JSON 응답을 리스너로
  가로채 원본 형태 그대로 <run-dir>/naver_stats_capture.json 에 덤프한다. 그 위에서 휴리스틱
  추출(조회수·유입 키워드)을 시도한다. 실패해도 덤프가 남아 다음 실행의 추출기를 정밀화할 수 있다.
- 폴백: 블로그 통계 페이지 DOM. 그래도 없으면 빈 샘플(fail-open) — 호출자는 수동 입력으로 되돌린다.

계약: 마지막 줄에 `RESULT_JSON: {...}` 를 출력한다(TS 가 이 줄을 파싱).
  {views:int, dwellSec:int|None, searchInflow:[{keyword,count,rank?}], source:str, note:str, captured:int}
자격증명은 절대 출력하지 않는다. 로그인 벽이면 note 로 안내하고 빈 샘플로 종료(exit 0, fail-open).
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]


def load_env(project_root: str) -> None:
    env_path = os.path.join(project_root, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())


def log(msg: str):
    print(msg, flush=True)


def emit(sample: dict):
    """결과 계약 — 마지막 줄에 RESULT_JSON 프리픽스로 출력."""
    print("RESULT_JSON: " + json.dumps(sample, ensure_ascii=False), flush=True)


# ── URL 파싱 ────────────────────────────────────────────────────────────────
def parse_blog_url(url: str) -> tuple:
    """publishedUrl → (blogId, logNo). 형태: /blogId/logNo, PostView.naver?blogId=&logNo=, m.blog…"""
    blog_id = ""
    log_no = ""
    m = re.search(r"[?&]blogId=([^&]+)", url)
    if m:
        blog_id = m.group(1)
    m = re.search(r"[?&]logNo=(\d+)", url)
    if m:
        log_no = m.group(1)
    if not blog_id or not log_no:
        # /blogId/logNo 형태
        m = re.search(r"blog\.naver\.com/([^/?#]+)/(\d+)", url)
        if m:
            blog_id = blog_id or m.group(1)
            log_no = log_no or m.group(2)
    return blog_id, log_no


# ── 캡처된 JSON 에서 휴리스틱 추출 ─────────────────────────────────────────────
VIEW_KEYS = ("cnt", "count", "pv", "readcnt", "readcount", "viewcount", "hit", "hits", "pageview")
KW_KEYS = ("keyword", "query", "searchkeyword", "keywordname", "refererkeyword")
# 유입 횟수 필드 — 우선순위 순. 'ratio'(백분율)는 횟수가 아니라 제외.
# metricValue: 어드바이저가 검색어별 유입 수치를 담는 실제 필드(대소문자 무시 매칭 → 소문자로 등록).
CNT_KEYS = ("cnt", "count", "pv", "hit", "searchcnt", "searchcount", "inflow", "value", "metricvalue")

# 검색 유입 키워드는 '유입-검색' 전용 엔드포인트에서만 신뢰한다. 채널 대시보드(realtime-summary·
# soaring-contents·yesterday-summary·popular-*-keyword 등 /home/*)의 키워드는 '이 글'의 검색 유입이
# 아니라 채널 전체 실시간/인기 키워드라, 글별 성과에 붙이면 무관 키워드가 섞인다(오귀속 차단).
_INFLOW_HINTS = ("inflow-search", "search-keyword", "inflow-analysis", "rank/inflow")


def _is_search_inflow_endpoint(path: str, url: str = "") -> bool:
    """이 캡처가 '이 글의 검색 유입 키워드'를 담는 전용 엔드포인트인가. /home/* 채널 대시보드는 제외."""
    s = (str(path) + " " + str(url)).lower()
    if "/home/" in s:
        return False
    return any(h in s for h in _INFLOW_HINTS)


def _num(v):
    try:
        n = int(float(v))
        return n if n >= 0 else 0
    except Exception:
        return 0


def blog_stat_cumulative_cv(context, log_no: str):
    """네이버 블로그 통계(blog.stat.naver.com)에서 이 글(log_no)의 '누적 조회수'를 집계(2026-07-20 역추적).
    통계 '게시물 조회수'의 실제 소스 — rank/cvContentPc(주별 글별 cv) 합 + 이번 주 daily/rankCv(일별)로
    보강(주별 롤업 지연분). referer 헤더 필수(없으면 채널 API 처럼 400/403). 실패·미발견은 None(폴백)."""
    if not log_no:
        return None
    hdr = {"referer": "https://m.blog.naver.com/", "accept": "application/json"}
    base = "https://blog.stat.naver.com/api/blog"

    def _rows(url):
        try:
            r = context.request.get(url, headers=hdr, timeout=15000)
            if r.status == 200 and "json" in r.headers.get("content-type", ""):
                return r.json().get("result", {}).get("statDataList", [{}])[0].get("data", {}).get("rows", {})
        except Exception:
            pass
        return {}

    def _sum(rows):
        s = 0
        for u, cv in zip(rows.get("uri", []), rows.get("cv", [])):
            if log_no in str(u):
                s += _num(cv)
        return s

    today = date.today()
    this_mon = today - timedelta(days=today.weekday())
    total = 0
    found = False
    # 완료된 주(최근 16주 캡) — 주별 글별 cv 합
    w = this_mon - timedelta(weeks=16)
    while w < this_mon:
        rows = _rows(f"{base}/rank/cvContentPc?timeDimension=WEEK&startDate={w.isoformat()}")
        if rows.get("uri"):
            v = _sum(rows)
            if v:
                total += v; found = True
        w += timedelta(weeks=1)
    # 이번 주(월~오늘) — 주별 롤업 전이라 일별로 보강
    d = this_mon
    while d <= today:
        rows = _rows(f"{base}/daily/rankCv?timeDimension=DATE&startDate={d.isoformat()}&exclude=dashboard,weekAndMonthAnalysis")
        if rows.get("uri"):
            v = _sum(rows)
            if v:
                total += v; found = True
        d += timedelta(days=1)
    return total if found else None


def extract_advisor_metrics(captures: list, log_no: str = "") -> dict:
    """크리에이터 어드바이저에서 '이 글(log_no)' 지표를 정밀 추출.
    - 조회수(cv): 채널 순위 리스트(realtime-summary·soaring-contents 의 metricRanks[].rank[])에서
      contentId 가 이 글인 항목의 metricValue 만 취한다. 종전엔 yesterday-summary(블로그 전체 일별 합)+
      realtime 채널 총계를 그 글에 붙여 '블로그 전체 조회수'를 글 조회수로 오귀속했다(2026-07-20 실측
      수정). 어드바이저는 채널 중심이라 글별 '누적' 조회수는 없다 — 여기 값은 최근(당일) 글별 cv 이며,
      네이버 통계의 누적 게시물 조회수와 다를 수 있어 정확값은 수동 입력이 권장된다.
    - 검색 유입 키워드: 유입-검색 전용 엔드포인트의 keyword+수치만(채널 대시보드 키워드는 제외).
    log_no 미지정이면 글별 cv 를 특정할 수 없어 0(블로그 전체 오귀속 방지)."""
    post_cv = None  # 글별 cv(찾으면 값, 없으면 None → 0)
    inflow = {}

    def _post_cv_from_ranks(data) -> "int|None":
        # metricRanks[].rank[] 중 metricType=cv 이고 contentId(글 URL)에 이 log_no 가 있는 항목.
        best = None
        for mr in (data.get("metricRanks") or []) if isinstance(data, dict) else []:
            if not isinstance(mr, dict) or mr.get("metricType") != "cv":
                continue
            for it in (mr.get("rank") or []):
                if isinstance(it, dict) and log_no and log_no in str(it.get("contentId", "")):
                    best = max(best or 0, _num(it.get("metricValue")))
        # soaring-contents 등 data 가 곧 리스트인 경우도 지원
        if isinstance(data, list):
            for it in data:
                if isinstance(it, dict) and log_no and log_no in str(it.get("contentId", "")):
                    best = max(best or 0, _num(it.get("cv") or it.get("metricValue") or it.get("count")))
        return best

    for cap in captures:
        body = cap.get("body")
        if not isinstance(body, dict):
            continue
        path = str(body.get("path", ""))
        data = body.get("data")
        if data in (None, [], {}):
            continue
        if path.endswith("/realtime-summary") or path.endswith("/soaring-contents"):
            cv = _post_cv_from_ranks(data)
            if cv is not None:
                post_cv = max(post_cv or 0, cv)
        elif _is_search_inflow_endpoint(path, cap.get("url", "")):
            # 아이템 후보: data 리스트 · data.rank/list/searchKeyword · data.metricRanks[].rank[].
            if isinstance(data, list):
                items = data
            else:
                items = data.get("rank") or data.get("list") or data.get("searchKeyword") or []
                if not items and isinstance(data.get("metricRanks"), list):
                    items = [r for mr in data["metricRanks"]
                             if isinstance(mr, dict) and isinstance(mr.get("rank"), list)
                             for r in mr["rank"]]
            if isinstance(items, list):
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    kw = it.get("keyword") or it.get("query") or it.get("searchKeyword")
                    if not kw or str(kw).strip().lower() in ("null", "none", "기타", "직접유입"):
                        continue
                    cnt = _num(it.get("cv") or it.get("count") or it.get("cnt")
                               or it.get("inflow") or it.get("value") or it.get("metricValue"))
                    inflow[str(kw).strip()] = max(inflow.get(str(kw).strip(), 0), cnt)
    ranked = sorted(inflow.items(), key=lambda kv: kv[1], reverse=True)[:12]
    search_inflow = [{"keyword": k, "count": c, "rank": i + 1} for i, (k, c) in enumerate(ranked)]
    return {"views": post_cv or 0, "dwellSec": None, "searchInflow": search_inflow}


def _walk(obj, fn):
    fn(obj)
    if isinstance(obj, dict):
        for v in obj.values():
            _walk(v, fn)
    elif isinstance(obj, list):
        for v in obj:
            _walk(v, fn)


DWELL_KEYS = ("avgreadtime", "readtime", "dwelltime", "usetime", "avgusetime")
# logNo 무관 조회수 폴백에 허용할 '강한' 조회수 키(일반적인 count/cnt 는 유입수와 혼동돼 제외).
STRONG_VIEW_KEYS = ("readcnt", "readcount", "viewcount", "pageview", "pv")


def extract_metrics(captures: list, log_no: str) -> dict:
    """캡처된 api 응답 목록에서 조회수·유입 키워드를 최선 추출(휴리스틱). 확신 없으면 0/[]."""
    views = 0
    dwell = None        # logNo 무관 폴백
    dwell_logno = None  # logNo 포함 노드에서 얻은 값(우선)
    inflow = {}         # keyword -> count
    allow_kw = False    # 현재 cap 이 유입-검색 엔드포인트일 때만 키워드 수집(루프에서 cap 별로 갱신)

    def visit(node):
        nonlocal views, dwell, dwell_logno
        if not isinstance(node, dict):
            return
        lower = {str(k).lower(): k for k in node.keys()}
        # 이 노드가 logNo 를 '직접 값'으로 가지면 포스트별 레코드로 간주(엔벌로프 총계 과대추출 방지).
        has_logno = bool(log_no) and any(
            str(v) == log_no for v in node.values() if isinstance(v, (str, int)))
        # 조회수 — logNo 노드는 모든 view 키 허용, 아니면 강한 키 + views 미확정일 때만(유입수 오인 방지).
        for vk in VIEW_KEYS:
            if vk in lower:
                cand = _num(node[lower[vk]])
                if has_logno:
                    views = max(views, cand)
                elif views == 0 and vk in STRONG_VIEW_KEYS and cand < 10_000_000:
                    views = max(views, cand)
        # 체류 — logNo 노드 우선, 아니면 첫 값만(마지막이 이기지 않게).
        for dk in DWELL_KEYS:
            if dk in lower:
                d = _num(node[lower[dk]])
                if d:
                    if has_logno:
                        dwell_logno = d
                    elif dwell is None:
                        dwell = d
        # 유입 키워드 — 유입-검색 전용 엔드포인트(allow_kw)에서만. 채널 대시보드(realtime/soaring/
        # popular)의 키워드는 '이 글' 유입이 아니라 채널 전체 키워드라 오귀속 방지 차원에서 건너뛴다.
        # 필드는 KW_KEYS/CNT_KEYS '우선순위'로 선택(키 삽입 순서 비의존).
        if allow_kw:
            kw_field = next((lower[k] for k in KW_KEYS if k in lower), None)
            if kw_field:
                kw = str(node.get(kw_field, "")).strip()
                if kw and kw.lower() not in ("null", "none", "직접유입", "기타"):
                    cnt_field = next((lower[k] for k in CNT_KEYS if k in lower), None)
                    cnt = _num(node.get(cnt_field)) if cnt_field else 0
                    inflow[kw] = max(inflow.get(kw, 0), cnt)

    for cap in captures:
        body = cap.get("body")
        path = str(body.get("path", "")) if isinstance(body, dict) else ""
        allow_kw = _is_search_inflow_endpoint(path, cap.get("url", ""))
        try:
            _walk(body, visit)
        except Exception:
            continue
    if dwell_logno is not None:
        dwell = dwell_logno

    ranked = sorted(inflow.items(), key=lambda kv: kv[1], reverse=True)[:12]
    search_inflow = [{"keyword": k, "count": c, "rank": i + 1} for i, (k, c) in enumerate(ranked)]
    return {"views": views, "dwellSec": dwell, "searchInflow": search_inflow}


# ── 메인 ──────────────────────────────────────────────────────────────────
def main():
    load_env(str(PROJECT_ROOT))
    parser = argparse.ArgumentParser(description="네이버 블로그 성과 수집")
    parser.add_argument("--url", required=True, help="발행된 글 URL")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    os.makedirs(args.run_dir, exist_ok=True)
    blog_id, log_no = parse_blog_url(args.url)

    if args.dry_run:
        # 브라우저 없이 대표 샘플 — 파이프라인(수집→ingest→강화) 검증용.
        emit({
            "views": 137, "dwellSec": 52,
            "searchInflow": [
                {"keyword": "장마철 실내 습도", "count": 18, "rank": 1},
                {"keyword": "제습기 없이 습도", "count": 7, "rank": 2},
            ],
            "source": "scrape:dry-run", "note": "dry-run 대표 샘플", "captured": 0,
        })
        return

    if not blog_id or not log_no:
        emit({"views": 0, "dwellSec": None, "searchInflow": [],
              "source": "scrape:naver_advisor", "note": f"URL 파싱 실패(blogId/logNo): {args.url[:80]}", "captured": 0})
        return

    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        emit({"views": 0, "dwellSec": None, "searchInflow": [],
              "source": "scrape:naver_advisor", "note": "playwright 미설치", "captured": 0})
        return

    # 인스턴스별 프로필 분리(멀티 기업) — NAVER_PROFILE_DIR 지정 시 그 경로, 아니면 종전 홈 전역 경로.
    profile_dir = Path(os.environ["NAVER_PROFILE_DIR"]) if os.environ.get("NAVER_PROFILE_DIR") else (Path.home() / ".naver-blog-profiles" / "cli")
    profile_dir.mkdir(parents=True, exist_ok=True)
    captures = []
    stat_cv = None  # 블로그 통계 누적 조회수(있으면 어드바이저보다 우선) — 브라우저 블록에서 채움

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            str(profile_dir), channel="chrome", headless=args.headless, slow_mo=40,
            args=["--disable-blink-features=AutomationControlled", "--disable-infobars", "--disable-extensions"],
            ignore_default_args=["--enable-automation"],
            viewport={"width": 1280, "height": 900},
        )
        context.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); window.chrome={runtime:{}};"
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.on("dialog", lambda d: d.accept())

        def on_response(resp):
            try:
                url = resp.url
                if "creator-advisor.naver.com" in url and "api" in url:
                    ct = resp.headers.get("content-type", "")
                    if "json" in ct:
                        captures.append({"url": url, "body": resp.json()})
            except Exception:
                pass

        page.on("response", on_response)

        # ── 로그인 — 발행 스크립트(naver_publish)와 동일 플로우 재사용. 영속 프로필에 세션 쿠키가
        #    남지 않으면(로그인 상태 유지 미체크) 매 실행 로그인해야 한다. creator-advisor 는 blog.naver.com
        #    로그인(nid 쿠키, .naver.com 도메인)으로 함께 인증되므로 blog 로그인만 확립하면 된다.
        naver_id = os.environ.get("NAVER_ID", "")
        naver_pw = os.environ.get("NAVER_PW", "")
        # 저장된 쿠키 복원 — 발행 스크립트와 같은 프로필·쿠키 파일 공유(같은 환경 재로그인 방지).
        cookies_file = profile_dir / "naver_cookies.json"
        if cookies_file.exists():
            try:
                with open(cookies_file, encoding="utf-8") as f:
                    context.add_cookies(json.load(f))
            except Exception:
                pass
        # 인증 확인 + 누적 조회수 — blog.stat(context.request, 쿠키 인증)로 판정. DOM 로그인 링크 체크가
        # 헤드리스에서 헛발질(로그인돼 있어도 링크 존재로 오판→10분 로그인 루프 stuck)하는 문제를 우회한다.
        # blog.stat 이 200 JSON 을 주면 인증된 것 — 그 세션으로 게시물 누적 조회수까지 바로 얻는다.
        authed = False
        try:
            _ai = context.request.get("https://blog.stat.naver.com/api/blog/user-info",
                                      headers={"referer": "https://m.blog.naver.com/", "accept": "application/json"}, timeout=15000)
            authed = (_ai.status == 200 and "json" in _ai.headers.get("content-type", ""))
        except Exception:
            authed = False
        if authed:
            try:
                stat_cv = blog_stat_cumulative_cv(context, log_no)
            except Exception:
                stat_cv = None

        page.goto("https://blog.naver.com", wait_until="domcontentloaded", timeout=15000)
        time.sleep(1.5)
        # API 인증(authed) 우선 — 성공이면 DOM 체크 무시(헤드리스 오판 회피). 실패 시에만 DOM 폴백.
        logged_in = authed or page.locator("a[href*='nidlogin'], .link_login").count() == 0
        if not logged_in and args.headless:
            # 헤드리스에선 자동 로그인 시도 금지 — 캡차·기기확인이 뜨면 사람이 처리할 수 없어 멈춘다.
            # 즉시 명확 실패(수집 게이트가 오늘 재시도를 막고, 다음 헤드풀 실행에서 세션이 복구되면 자동 정상화).
            context.close()
            emit({"views": 0, "dwellSec": None, "searchInflow": [],
                  "source": "scrape:naver_advisor",
                  "note": "로그인 세션 만료 — 헤드리스 수집 불가. 발행 등 헤드풀 실행에서 재로그인되면 자동 복구.",
                  "captured": 0})
            return
        if not logged_in:
            try:
                from naver_publish import full_auto_login, save_cookies  # 같은 디렉토리 스크립트
                full_auto_login(page, naver_id, naver_pw)
                try:
                    save_cookies(context, cookies_file)  # 로그인 세션 저장(다음 실행 복원)
                except Exception:
                    pass
            except SystemExit:
                context.close()
                emit({"views": 0, "dwellSec": None, "searchInflow": [],
                      "source": "scrape:naver_advisor",
                      "note": "네이버 로그인 실패(시간 초과) — 열린 브라우저에서 직접 로그인 후 다시 시도하세요.",
                      "captured": 0})
                return
            except Exception as e:
                context.close()
                emit({"views": 0, "dwellSec": None, "searchInflow": [],
                      "source": "scrape:naver_advisor", "note": f"로그인 오류: {str(e)[:80]}", "captured": 0})
                return

        # 로그인 세션으로 크리에이터 어드바이저 진입 — SPA 가 홈 통계 api 를 호출(캡처됨).
        page.goto("https://creator-advisor.naver.com/", wait_until="networkidle", timeout=20000)
        time.sleep(2.5)
        # 유입분석 화면도 열어 검색 유입 api 유도.
        for u in ("https://creator-advisor.naver.com/naver_blog/inflow",
                  "https://creator-advisor.naver.com/naver_blog/inflowSearch"):
            try:
                page.goto(u, wait_until="networkidle", timeout=15000)
                time.sleep(2)
            except Exception:
                time.sleep(1)

        # 로그인 쿠키를 상속한 api 직접 호출 — SPA 라우트에 의존하지 않고 실측 엔드포인트를 확실히 캡처한다.
        # (조회수=cv, 검색 유입 키워드) 채널 단위. channelId 는 blog_id 와 동일.
        cid = blog_id
        today = date.today().isoformat()
        yday = (date.today() - timedelta(days=1)).isoformat()
        base = "https://creator-advisor.naver.com/api/v6"
        api_urls = [
            f"{base}/home/yesterday-summary?channelId={cid}&date={today}&service=naver_blog",
            f"{base}/home/realtime-summary?channelId={cid}&date={today}&service=naver_blog",
            # 검색 유입 키워드 — 정확 경로는 버전별 상이, 여러 후보 시도(404 는 무시). 응답 오면 추출기가 파싱.
            f"{base}/inflow-analysis/inflow-search?channelId={cid}&date={yday}&interval=day&service=naver_blog",
            f"{base}/inflow-analysis/search-keyword?channelId={cid}&date={yday}&interval=day&service=naver_blog",
            f"{base}/rank/inflow-search?channelId={cid}&date={yday}&interval=day&service=naver_blog",
            f"{base}/inflow-search/detail?channelId={cid}&date={yday}&interval=day&service=naver_blog",
        ]
        for u in api_urls:
            try:
                resp = context.request.get(u, timeout=15000)
                if resp.ok:
                    captures.append({"url": u, "body": resp.json()})
            except Exception:
                continue

        # 글별 '누적' 조회수 — 위 authed 경로에서 못 구했으면(로그인 후 등) 여기서 1회 시도.
        if stat_cv is None:
            try:
                stat_cv = blog_stat_cumulative_cv(context, log_no)
            except Exception:
                stat_cv = None

        context.close()

    # 캡처 덤프(추출기 정밀화용) — 자격증명 없음.
    try:
        with open(os.path.join(args.run_dir, "naver_stats_capture.json"), "w", encoding="utf-8") as f:
            json.dump(captures, f, ensure_ascii=False, indent=1)
    except Exception:
        pass

    # 어드바이저에 로그인 세션이 적용됐는지 — 캡처에 Unauthorized 가 남아 있으면 세션 미확립.
    def _unauth(cap):
        b = cap.get("body")
        return isinstance(b, dict) and "unauthorized" in str(b.get("message", "")).lower()
    all_unauth = bool(captures) and all(_unauth(c) for c in captures)

    # 어드바이저 실측 엔드포인트 정밀 추출을 우선, 부족분은 범용 휴리스틱으로 보강.
    adv = extract_advisor_metrics(captures, log_no)
    gen = extract_metrics(captures, log_no)
    # 조회수 우선순위: blog.stat 누적(게시물 조회수 실소스) > 어드바이저 글별 당일 > 휴리스틱.
    views = stat_cv if stat_cv is not None else (adv["views"] or gen["views"])
    metrics = {
        "views": views,
        "dwellSec": adv["dwellSec"] or gen["dwellSec"],
        "searchInflow": adv["searchInflow"] or gen["searchInflow"],
    }
    # 로그인은 됐지만(권한 응답 수신) 수치가 0 = 발행 직후 미집계일 가능성.
    logged = any(isinstance(c.get("body"), dict) and c["body"].get("data") not in (None,) for c in captures)
    if stat_cv is not None:
        note = ("네이버 통계 게시물 누적 조회수입니다."
                + ("" if metrics["searchInflow"] else " (검색 유입 키워드는 별도 수집.)"))
    elif metrics["views"]:
        note = ("어드바이저 글별 당일 조회수 — 누적(통계 게시물 조회수)과 다를 수 있어 정확값은 수동 입력 권장."
                + ("" if metrics["searchInflow"] else " (검색 유입은 글 단위 데이터가 없어 비웠습니다.)"))
    elif metrics["searchInflow"]:
        note = ""
    elif all_unauth or not captures:
        note = ("어드바이저 로그인 세션 미확립 — 브라우저에서 네이버에 로그인(로그인 상태 유지 체크) 후 "
                "다시 시도하세요. 계속 실패하면 수동 입력으로 대체할 수 있습니다.")
    elif logged:
        note = ("로그인·수집 정상인데 이 글의 어드바이저 조회수가 0입니다 — 조회가 적은 글은 채널 순위 "
                "리스트에 안 잡히거나 당일 조회가 0일 수 있습니다. 누적 게시물 조회수는 네이버 통계에서 "
                "확인해 수동 입력을 권장합니다(발행 당일은 지연 집계로 0일 수 있음).")
    else:
        note = "자동 추출 실패 — 캡처 덤프(naver_stats_capture.json) 확인 후 추출기 정밀화 필요. 수동 입력으로 대체 가능."
    emit({**metrics, "source": "scrape:naver_advisor", "note": note, "captured": len(captures)})


if __name__ == "__main__":
    main()
