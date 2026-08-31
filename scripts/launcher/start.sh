#!/bin/bash
# AI 콘텐츠 스튜디오 서버 시작 — 백엔드(8787 http / 8788 https) 기동 후 브라우저 오픈.
# 데스크탑의 "콘텐츠 서버 실행.app" 이 이 스크립트를 exec 한다. 터미널에서 직접 실행해도 동일하게 동작한다.
# 서버는 detached(nohup)로 띄우므로 런처가 끝나도 계속 실행된다.

PROJ="/Users/sangbumnam/AI_Factory/AI_ContentsCreator"
LOG="$PROJ/.launcher-logs"

# LaunchServices(더블클릭) 경유 시 PATH 가 /usr/bin:/bin:/usr/sbin:/sbin 로 축소되므로 pnpm/node 위치를 보강.
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
alert()  { osascript -e "display dialog \"$1\" with title \"AI 콘텐츠 스튜디오\" buttons {\"확인\"} default button 1 with icon caution giving up after 60" >/dev/null 2>&1; }

mkdir -p "$LOG"
cd "$PROJ" || { alert "프로젝트 폴더를 찾을 수 없습니다:\n$PROJ"; exit 1; }

if ! command -v pnpm >/dev/null 2>&1; then
  alert "pnpm 을 찾을 수 없습니다.\n\nPATH: $PATH"; exit 1
fi

echo "🎬 AI 콘텐츠 스튜디오 서버 시작…"

if lsof -ti tcp:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  • 이미 실행 중 (8787) — 새로 띄우지 않습니다."
  already=1
else
  ( nohup pnpm start > "$LOG/server.log" 2>&1 < /dev/null & )
  echo "  • 서버 기동 → $LOG/server.log"
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
