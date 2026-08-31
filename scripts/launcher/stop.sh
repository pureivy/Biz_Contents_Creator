#!/bin/bash
# AI 콘텐츠 스튜디오 서버 종료 — 백엔드(8787 http / 8788 https) 프로세스 정리.
# 데스크탑의 "콘텐츠 서버 종료.app" 이 이 스크립트를 exec 한다.
# 프로젝트 경로 패턴으로만 pkill 하므로 같은 머신의 다른 프로젝트(gepa-ai-office 등)는 영향받지 않는다.

PROJ="/Users/sangbumnam/AI_Factory/AI_ContentsCreator"
PORTS="8787 8788"   # 8787=http, 8788=메타 OAuth https

notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1; }
alert()  { osascript -e "display dialog \"$1\" with title \"AI 콘텐츠 스튜디오\" buttons {\"확인\"} default button 1 with icon caution giving up after 60" >/dev/null 2>&1; }

echo "🛑 AI 콘텐츠 스튜디오 서버 종료 중…"

if ! lsof -ti tcp:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  • 실행 중인 서버가 없습니다."
  notify "AI 콘텐츠 스튜디오" "이미 종료되어 있습니다"
  exit 0
fi

# 프로젝트 경로가 포함된 tsx 실행 프로세스만 정리.
pkill -f "$PROJ/node_modules/.pnpm/tsx" 2>/dev/null && echo "  • 서버 프로세스 종료"

# 포트 리스너 정리 — 대상 PID 를 "한 번만" 수집한다. 2초 뒤 포트를 재조회해 kill -9 하면
# 그 사이 사용자가 다시 띄운 새 서버까지 죽는 경쟁 상태가 생긴다(실측: exit 137).
# -sTCP:LISTEN 필수 — 이게 없으면 그 포트에 접속한 브라우저 등 "클라이언트" PID 까지 잡혀
# 엉뚱한 앱(Chrome)이 종료된다(실측 확인).
targets=""
for port in $PORTS; do
  pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pids" ]; then echo "  • 포트 $port → 종료 ($pids)"; targets="$targets $pids"; fi
done
[ -n "$targets" ] && kill $targets 2>/dev/null

# 처음 잡은 PID 들이 사라질 때까지만 대기(최대 8초) → 남으면 그 PID 들만 강제 종료.
for _ in $(seq 1 8); do
  alive=""; for pid in $targets; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
  [ -z "$alive" ] && break
  sleep 1
done
if [ -n "$alive" ]; then kill -9 $alive 2>/dev/null; echo "  • 강제 종료 ($alive)"; sleep 1; fi

still=""
for pid in $targets; do kill -0 "$pid" 2>/dev/null && still="$still $pid"; done
if [ -z "$still" ]; then
  echo "✅ 종료 완료 — 8787/8788 모두 정리됨."
  notify "AI 콘텐츠 스튜디오" "서버 종료 완료"
else
  echo "⚠️ 아직 살아있는 프로세스:$still"
  alert "일부 프로세스가 아직 살아 있습니다:$still\n\n터미널에서 확인이 필요합니다."
  exit 1
fi
