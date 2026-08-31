#!/bin/zsh
# Ollama 튜닝 런처 — 로컬 멀티에이전트 속도의 Tier-1(무위험) 개선.
#
# 왜 서버 env 인가: keep_alive 와 컨텍스트 길이를 '요청 단위'로 넘기면
#   - keep_alive: 요청마다 서버 기본값(5m)으로 되돌아가 런 사이 콜드 로드
#   - num_ctx:    옵션이 다른 요청마다 모델 통째 리로드(스래시)
# 되므로, 서버 환경변수가 유일하게 안전한 정식 경로다. (원본 GEPA 실측 교훈 계승)
#
# ⚠️ 메뉴바 Ollama.app 이 11434 를 선점하면 이 서버가 못 뜬다 → 먼저 종료할 것.
#   확인:  curl -s localhost:11434/api/ps   (expires_at 이 ~30분 뒤, context_length 16384)
#
# 사용:  ./scripts/serve_ollama_tuned.sh
#   값 덮어쓰기:  OLLAMA_CONTEXT_LENGTH=32768 ./scripts/serve_ollama_tuned.sh

export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
# 컨텍스트 길이 — 기본 8192(앱)/4096(구버전)은 멀티에이전트 그라운딩에 부족해 앞부분
# 잘림(조용한 품질저하)을 유발. 16384 가 KV 메모리와 균형. 큰 머신은 32768.
export OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-16384}"
# flash attention — Metal 포함 지원 GPU 에서 프리필 속도/메모리 개선.
export OLLAMA_FLASH_ATTENTION="${OLLAMA_FLASH_ATTENTION:-1}"
# KV 캐시 양자화 — 메모리 절감으로 더 큰 ctx 를 같은 RAM 에. (q8_0 권장, 문제 시 주석)
export OLLAMA_KV_CACHE_TYPE="${OLLAMA_KV_CACHE_TYPE:-q8_0}"
# 단일 슬롯 — 동시 요청을 여러 슬롯으로 쪼개면 KV 캐시 경쟁으로 재프리필 폭증.
# 본 구현은 로컬에서 concurrency=1 직렬화하므로 슬롯도 1이 정합.
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"

echo "[serve_ollama_tuned] KEEP_ALIVE=$OLLAMA_KEEP_ALIVE CONTEXT_LENGTH=$OLLAMA_CONTEXT_LENGTH FLASH_ATTENTION=$OLLAMA_FLASH_ATTENTION KV_CACHE_TYPE=$OLLAMA_KV_CACHE_TYPE NUM_PARALLEL=$OLLAMA_NUM_PARALLEL"
if curl -s --max-time 1 localhost:11434/api/version >/dev/null 2>&1; then
  echo "[serve_ollama_tuned] ⚠️  11434 포트에 이미 Ollama 가 떠 있습니다(메뉴바 앱 등)."
  echo "    먼저 종료하세요 — env 는 서버 시작 시에만 적용됩니다."
  exit 1
fi
exec ollama serve
