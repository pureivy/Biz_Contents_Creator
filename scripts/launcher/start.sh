#!/bin/bash
# AI 콘텐츠 스튜디오 서버 시작 — 백엔드(8787 http / 8788 https) 기동 후 브라우저 오픈.
# 데스크탑의 "콘텐츠 서버 실행.app" 이 이 스크립트를 exec 한다. 터미널에서 직접 실행해도 동일하게 동작한다.
# 서버는 detached(nohup)로 띄우므로 런처가 끝나도 계속 실행된다.

PROJ="/Users/sangbumnam/AI_Factory/AI_ContentsCreator"
LOG="$PROJ/.launcher-logs"

# LaunchServices(더블클릭) 경유 시 PATH 가 /usr/bin:/bin:/usr/sbin:/sbin 로 축소되므로 pnpm/node 위치를 보강.
# ~/.local/bin·~/.claude/local 도 필수 — claude CLI 가 여기 산다. 빠지면 서버는 정상 기동하지만
# 모든 LLM 호출이 "spawn claude ENOENT" 로 죽어 오토런이 조용히 아무 일도 안 한다(실사고 2026-08-31).
export PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
alert()  { osascript -e "display dialog \"$1\" with title \"AI 콘텐츠 스튜디오\" buttons {\"확인\"} default button 1 with icon caution giving up after 60" >/dev/null 2>&1; }

mkdir -p "$LOG"
cd "$PROJ" || { alert "프로젝트 폴더를 찾을 수 없습니다:\n$PROJ"; exit 1; }

if ! command -v pnpm >/dev/null 2>&1; then
  alert "pnpm 을 찾을 수 없습니다.\n\nPATH: $PATH"; exit 1
fi

# claude CLI 는 모든 콘텐츠 생성의 백엔드 — 없으면 서버는 떠도 오토런·런이 전부 조용히 실패한다.
if ! command -v claude >/dev/null 2>&1; then
  alert "claude CLI 를 찾을 수 없습니다.\n\n서버는 뜨지만 글·오토런이 동작하지 않습니다.\n\nPATH: $PATH"; exit 1
fi

echo "🎬 AI 콘텐츠 스튜디오 서버 시작…"

if lsof -ti tcp:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  • 이미 실행 중 (8787) — 새로 띄우지 않습니다."
  already=1
else
  # 로그는 덮어쓰지 않고 이어 쓴다(2026-08-31) — 종전 '>' 는 재기동마다 server.log 를 비워, 방금 끝난
  # 작업의 실패 사유가 통째로 사라졌다(실측: 임시저장이 왜 죽었는지 파일 mtime 으로 역추적해야 했다).
  # 무한 증식은 20MB 넘을 때 최근 2000줄만 남기는 제자리 회전으로 막는다 — 별도 파일을 만들지 않으므로
  # 회전 중 서버가 떠도 꼬이지 않는다(기동 전에만 수행).
  if [ -f "$LOG/server.log" ] && [ "$(stat -f %z "$LOG/server.log" 2>/dev/null || echo 0)" -gt 20971520 ]; then
    KEEP=$(tail -n 2000 "$LOG/server.log")
    printf '%s\n' "$KEEP" > "$LOG/server.log"
    echo "  • 로그 회전 — 최근 2000줄만 남김"
  fi
  { echo; echo "═══ 기동 $(date '+%Y-%m-%d %H:%M:%S') ═══"; } >> "$LOG/server.log"
  ( nohup pnpm start >> "$LOG/server.log" 2>&1 < /dev/null & )
  echo "  • 서버 기동 → $LOG/server.log (이어쓰기)"
  already=0
fi

# 준비 대기(최대 ~40s): /healthz
printf "  • 준비 대기"
for _ in $(seq 1 40); do
  curl -s http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  printf "."; sleep 1
done
echo

if curl -s http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
  echo "✅ 준비 완료 — http://127.0.0.1:8787/"

  # 다른 기기(맥북·아이폰)용 tailnet 주소 — tailscale serve 설정에서 유도(하드코딩 없음).
  # 서버는 127.0.0.1 에만 바인딩되고 Tailscale 이 tailnet 안에서만 프록시하므로 LAN 노출은 없다.
  TS_URL=$(tailscale serve status 2>/dev/null | awk '/^https:\/\// {u=$1} /proxy http:\/\/127\.0\.0\.1:8787/ {print u; exit}')
  [ -n "$TS_URL" ] && echo "   • 다른 기기: $TS_URL"

  if [ "$already" = "1" ]; then
    notify "AI 콘텐츠 스튜디오" "이미 실행 중입니다 — 8787"
  else
    notify "AI 콘텐츠 스튜디오" "서버 실행됨${TS_URL:+ · $TS_URL}"
  fi
  open "http://127.0.0.1:8787/"
else
  echo "⚠️ 시작 지연/실패 — $LOG/server.log 확인"
  alert "서버가 40초 안에 응답하지 않았습니다.\n\n로그: $LOG/server.log"
  open -a Console "$LOG/server.log" 2>/dev/null
  exit 1
fi
