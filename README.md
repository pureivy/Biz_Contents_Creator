# AI 콘텐츠 스튜디오 (biz_contents_creator)

> **Claude Code CLI(구독 인증)를 백엔드로 쓰는 단일 Node/TS 런타임의 멀티에이전트 AI 콘텐츠 스튜디오.** 편집장 + 전문가 팀이 주제를 분해·토론·집필해 **네이버 블로그 → 카드뉴스 → 숏폼(MP4)** 세트를 만들고, 그 지식을 마크다운 위키로 컴파일·유지한다. 브랜드(고객사)별 자료·발행 계정을 격리하며, 유휴 시간에는 스스로 리서치·제작을 이어간다.

---

## 1. 배경

로컬 LLM(Ollama) 우선으로 출발했으나, 콘텐츠 스튜디오 피벗과 함께 **Claude 단일 백엔드**로 확정하고 Ollama 경로를 완전히 제거했다(2026-07). 현재 설계의 핵심:

- **Claude Code CLI 경유 호출** — `claude -p --output-format stream-json` 서브프로세스 spawn. **구독(정액) 인증**이라 API 크레딧 과금이 없다(`src/llm/claudeCli.ts`). 대가로 호출당 CLI 부팅 오버헤드(~1.5s)와 구독 rate limit을 감수한다.
- **구독 강제** — 호출 시 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 등을 env에서 제거해, 키가 있어도 크레딧 과금 경로로 회귀하지 않는다.
- **역할 tier 라우팅** — 편집장·통합(heavy)=`claude-opus-4-8`, 전문가/팀원 본작업(standard)=`claude-sonnet-5`, 분해·배정·수렴판정·분류 같은 구조적 단발 호출(micro)=`claude-haiku-4-5`.
- **마이크로 단발 호출** — 분해/배정/판정/분류는 풀 에이전틱 루프 없이 `microJSON` 1회로 처리.
- 직원(역할) 시스템 프롬프트·절차·판단기준은 `assets/company/`(시드, **커밋 대상**) → `data/company.yaml`(런타임 사본, gitignore). 런타임 사본이 없으면 부팅 시 시드에서 복사되므로(`company-loader.ts`), 역할·프롬프트를 영구히 바꾸려면 시드를 고쳐야 한다.

> 정액 구독이지만 무비용 보험으로 월별 사용량 원장(`data/llm_usage.json`)과 예산 캡(`MONTHLY_BUDGET_USD`, 0=무제한)을 유지한다(`src/llm/cost.ts`).

---

## 2. 핵심 아키텍처

```
브라우저 (React 프론트 /  ·  경량 자체 UI /lite)
        │  HTTP + SSE (무접두 /runs… 계약 + /api/* 별칭)
        ▼
Hono 서버 (src/server/main.ts) ── 단일 Node/TS 런타임
        │
   ┌────┼────────────────┬─────────────────┬──────────────┐
   ▼    ▼                ▼                 ▼              ▼
오케스트레이터     콘텐츠 파이프라인      LLM Wiki        거버넌스·자율
(org/debate/     블로그→카드뉴스→숏폼   (data/wiki)     (승인·브랜드·
 directed)        (org·cardnews·                       스케줄러)
   │              shorts.ts)               │
   ▼                    │                  ▼
LLM 코어 (src/llm)      ▼             마크다운 지식베이스
 claudeCli.ts     OpenAI(이미지·TTS)   그라운딩 커넥터
 models/setting   네이버 발행(임시저장)  (naver·dart·law·youtube)
        │
        ▼
   Claude Code CLI (구독 인증, claude -p / stream-json)
```

### (a) LLM 코어 — `src/llm/`
- `claudeCli.ts` — Claude Code CLI를 `claude -p --output-format stream-json`로 spawn하고 stdout을 줄단위 파싱(`content_block_delta`→누적, `result`에서 usage 수확). 격리 cwd(`os.tmpdir()`)로 프로젝트 `CLAUDE.md` 오염 차단, 동시성 `Semaphore(ANTHROPIC_CONCURRENCY)`.
- `client.ts` — 파사드 `llm.chat()`(단일 진입점). `models.ts`/`setting.ts` — tier(`micro`/`standard`/`heavy`) → 실제 모델 id 매핑(`CONFIG.cloudTierModels`). `cost.ts` — 사용량 원장·예산 캡.
- Ollama 코드(`ollama.ts` 등)는 삭제됐고, 백엔드는 `{ backend: 'claude' }`로 고정(토글 폐지).

### (b) 3가지 런 모드 — `src/orchestrator/`
디스패처 `index.ts`가 옵션에 따라 분기한다.

| 모드 | 트리거 | 동작 | 파일 |
|---|---|---|---|
| **directed** | `agent` 지정 | 직원 1명 단독 응답(가장 빠름) | `directed.ts` |
| **org**(위계, 기본) | `path='team'`/`'full'` 또는 `RUN_MODE=org` | CEO 라우팅 → 리서치팀(병렬) → 토론·비평 → 작가 단독 집필 → 포장·finalize | `org.ts` + `prepare.ts`/`finalize.ts` |
| **debate**(평면) | `RUN_MODE=debate` | 전문가 평면 작업 → 비평/반박 라운드 → 수렴판정 → 종합 | `run.ts` + `debate.ts` |

공통: 작업 전 위키 그라운딩(관련 지식 자동 주입), 종료 후 산출물 위키 ingest + 자가수선. `revise.ts`는 검토 피드백으로 초안을 개정(v+1).

### (c) 콘텐츠 파이프라인 — 블로그 → 카드뉴스 → 숏폼
- **블로그**(`org.ts`) — org 런이 본문을 집필·포장해 `draft.json/md/html`을 `data/sessions/<runId>/`에 쓰고 콘텐츠 **piece**로 승격한다.
- **카드뉴스**(`orchestrator/cardnews.ts`, standby 팀) — 기획→디자인→`gpt-image-2`가 **한글 텍스트 포함 카드를 직접 렌더**→비전 QA(오타 검수, 문제 장만 재생성).
- **숏폼**(`orchestrator/shorts.ts`, standby 팀) — 기획(훅·씬·내레이션)→씬 이미지(무텍스트)→렌더러가 자막 프레임 + **OpenAI TTS 내레이션** + ffmpeg로 **1080×1920 MP4 + srt** 조립.
- 카드뉴스·숏폼은 블로그 org 런과 **별도 파이프라인**이다. 블로그 초안 완료 후 자동 파생되거나(`AUTO_CARDNEWS`/`AUTO_SHORTS`), 독립 주제로도 만들 수 있다. 자세한 흐름은 8절.

### (d) Karpathy "LLM Wiki" — `src/wiki/llmwiki.ts`
RAG가 아니라 에이전트가 직접 유지하는 **마크다운 지식베이스**. 지식을 1회 컴파일하고 계속 갱신(compounding)한다. 자세한 워크플로우는 6절.

### (e) 거버넌스·브랜드·자율 — `src/approvals/`, `src/content/brand.ts`, `src/autonomy/`
- 발행 휴먼 게이트(블로킹 + 타임아웃 fail-open), 자율 레벨(0=off,1=read,2=draft승인,3=auto).
- **브랜드(고객사)별 격리** — 자료·위키·발행 계정을 브랜드 슬러그로 분리(7절).
- **유휴/정기 자율 사이클** — 사용자 런이 없을 때만 제작·리서치를 이어가고, 사용자 런 도착 시 양보(6-1절).

### (f) 그라운딩 커넥터 — `src/grounding/`
네이버(검색·데이터랩·검색광고·자동완성)·DART(전자공시)·국가법령·유튜브 Data API·커스텀 소스. 리서치 팀이 실측 데이터로 근거를 확보한다.

### (g) 프론트 — `frontend/`(React/Vite) + `public/index.html`(경량 SPA)
- React 프론트는 오피스 연출·타임라인·위키 그래프·성과 뷰·실시간 SSE 스트리밍. `/`에서 `frontend/dist`를 서빙.
- 빌드 불필요한 경량 단일 페이지 UI는 `/lite`.

### (h) 내보내기 — `src/export/hwpx.ts` + `src/util/zip.ts`
순수 Node(외부 의존성 無)로 마크다운 산출물을 한글 **HWPX**(OWPML section + 최소 ZIP 라이터)로 변환.

---

## 3. 빠른 시작

### 전제조건
- **Node.js >= 20.6** (ESM)
- **Claude Code CLI** — 설치 후 구독 계정으로 로그인돼 있어야 한다(`claude` 실행 파일이 PATH에, 또는 `CLAUDE_CLI_PATH`로 지정). LLM 호출 전부가 이 CLI를 경유한다.
- 패키지 매니저 **pnpm**(npm도 가능)
- (선택) **OpenAI API 키** — 이미지 생성(`gpt-image-2`)·음성 TTS(`gpt-4o-mini-tts`)에 필요. 없으면 이미지는 dry-run, TTS는 macOS `say` 폴백.
- (선택) **블로그 스킬 Python venv** — 네이버 임시저장·OpenAI 이미지 스크립트(`scripts/blog_skills/`). `BLOG_PYTHON`으로 venv python 경로 지정. 네이버 발행은 Playwright 사용.
- (선택) **ffmpeg**(`brew install ffmpeg`) — 숏폼 렌더·음성 변환.
- (선택) **mlx-whisper**(`pip install mlx-whisper`) — 음성 입력(STT).

### 설치
```bash
git clone https://github.com/pureivy/Biz_Contents_Creator.git
cd Biz_Contents_Creator
pnpm install
# (선택) React 프론트 빌드 — 안 하면 /lite 사용
cd frontend && pnpm install && pnpm build && cd ..
```

### 개발 서버 실행
```bash
pnpm dev          # TZ=Asia/Seoul tsx watch src/server/main.ts (핫리로드)
# 또는 비-watch
pnpm start        # TZ=Asia/Seoul tsx src/server/main.ts
```
브라우저에서 **http://127.0.0.1:8790** 접속 — 이 저장소의 `.env` 가 `PORT=8790` 이다(코드 기본값은 8787, `src/config.ts`). 같은 머신에서 다른 인스턴스와 나란히 띄우려고 옮겨 둔 값이므로, 단독으로 쓸 거면 `.env` 의 `PORT` 를 지우면 8787 로 돌아간다.
- `/` — React 프론트(빌드돼 있으면)
- `/lite` — 빌드 불필요 경량 UI

주제를 입력하면 실시간으로 에이전트 스트리밍, 속도 메트릭, 위키 자동 적재, 오피스 연출이 보인다. **"리서치" 토글이 켜져 있으면 블로그·카드뉴스·숏폼을 만들지 않고 조사·위키 적재만 하는 리서치 런으로 실행된다**(8절 참조).

> API 키(OpenAI·네이버 계정)는 파일이 아니라 UI의 **API 키 탭** 또는 `data/secrets.json`(gitignore)에서 관리한다.

---

## 4. 주요 API

서버는 React 프론트용 **무접두 계약**(`/runs…`)과 자체 UI용 **`/api/*` 별칭**을 대부분 동일 핸들러로 이중 등록한다. 아래는 무접두 기준의 대표 라우트(전체는 `src/server/main.ts`).

### 런·콘텐츠 piece
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/runs` | 런 시작. body `{ topic, agent?, path?, mission?, persona?, images?, docs? }`. `mission:'research'`=리서치 런 |
| POST | `/runs/attachments` | 런 첨부(이미지≤8·문서≤8) 업로드·검증 |
| GET | `/runs/:id/events` | **SSE** 이벤트 스트림(`Last-Event-ID` 재연결) |
| POST | `/runs/:id/cancel` · `/promote` · `/revise` | 취소 · piece 승격 · 수정요청(v+1) |
| GET · POST · DELETE | `/pieces …` | 콘텐츠 타임라인(캘린더). `/pieces/:id/draft`·`/run`·`/naver-draft`·`/metrics` |

### 카드뉴스·숏폼·성과
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/cardnews` · `/pieces/:id/cardnews` | 카드뉴스 생성(독립 주제 / 초안 파생) |
| GET | `/cardnews/:id` · `/cardnews/:id/slides/:name` · `/cardnews/:id/zip` | 상태 · 슬라이드 이미지 · 전체 zip |
| POST | `/shorts` · `/pieces/:id/shorts` | 숏폼 생성(독립 주제 / 초안 파생) |
| GET | `/shorts/:id/video` · `/shorts/:id/zip` | MP4 다운로드 · 자산 zip |
| GET · POST | `/performance` · `/pieces/:id/collect-metrics` | 발행 후 성과 수집·분석 |

### 브랜드·위키·승인·자료
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET · POST · DELETE | `/brands` · `/brands/activate` · `/brands/:slug` | 브랜드 목록·전환·삭제 |
| GET · PUT | `/brand` | 활성 브랜드 프로필 조회·수정 |
| GET | `/wiki/graph` · `/wiki/pages` · `/wiki/page/:id` · `/wiki/stats` · `/wiki/lint` | 지식 그래프·페이지·갭 점검 |
| POST | `/wiki/maintain` · `/wiki/audit` · `/wiki/inject` · `/wiki/reingest` | 자가수선 · 모순감사 · 지식주입 · 재적재 |
| GET · POST | `/approvals` · `/approvals/:id/decide` | 대기 승인 목록 · 승인/반려 |
| POST · GET | `/sources` | 자료(.md/.txt/.csv/.json 등) 업로드 → 위키 소스화 |

### 음성·자비스·시스템
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/voice/stt` · `/voice/tts` · `/voice/settings` · GET `/voice/voices` | STT·TTS·설정·음색 목록 |
| POST | `/jarvis/chat` | 자비스(비서) 대화 |
| GET | `/company` · `/personas` · `/api-keys` · `/connectors` · `/autonomy/status` | 로스터·페르소나·키·커넥터·자율 상태 |
| GET | `/healthz` · `/api/health` · `/llm` · `/runsettings` | 헬스체크 · LLM 상태 · 런타임 설정 |

---

## 5. 설정 (환경변수)

모두 선택값이며, 비우면 기본값이 적용된다(`src/config.ts`). 인스턴스 분리는 `GEPA_ENV_FILE`로 로드할 `.env` 경로를 지정한다(이름은 레거시).

### 서버 · LLM(Claude 단일)
| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 서버 바인딩. 메타 OAuth 콜백 전용 HTTPS 는 `PORT+1`(`META_HTTPS_PORT` 로 개별 지정 가능). **이 저장소의 `.env` 는 `PORT=8790`** |
| `CLOUD_MICRO_MODEL` | `claude-haiku-4-5` | micro tier(구조적 단발) 모델 |
| `CLOUD_STANDARD_MODEL` | `claude-sonnet-5` | standard tier(본문 집필) 모델 |
| `CLOUD_HEAVY_MODEL` | `claude-opus-4-8` | heavy tier(통합·편집) 모델 |
| `CLAUDE_CLI_PATH` | `claude` | Claude Code CLI 실행 파일 경로 |
| `ANTHROPIC_CONCURRENCY` | `6` | Claude CLI 동시 spawn 상한 |
| `AGENT_THINKING` | `false` | 생성 단계 모델 추론(thinking) 활성 |
| `REQUEST_TIMEOUT_MS` | `600000` | LLM 요청 타임아웃(ms) |
| `MAX_OUTPUT_TOKENS` | `8192` | 일반 호출 출력 상한(1~32768 클램프) |
| `INTEGRATION_MAX_OUTPUT_TOKENS` | `24000` | 통합(종합) 단계 출력 상한 |
| `MONTHLY_BUDGET_USD` | `0` | 월 예산 캡($, 0=무제한, 무비용 보험) |

### 조직 · 동시성 · 연출
| 변수 | 기본값 | 설명 |
|---|---|---|
| `RUN_MODE` | `org` | `org`(위계) 또는 `debate`(평면) |
| `CONCURRENCY` / `TEAM_PARALLEL` | `4` / `4` | 동시 LLM 세션 / 팀 병렬도 |
| `MAX_TURNS_PER_AGENT` | `20` | 에이전트당 최대 턴 |
| `MIN_SPECIALISTS` / `MAX_SPECIALISTS` | `2` / `2` | 전문가 수 범위 |
| `DEBATE_ROUNDS` / `DEBATE_ROUNDS_CAP` | `2` / `3` | debate 라운드 / 상한 |
| `ORG_DEBATE_ROUNDS` | `1` | org 비평→반박 라운드(0~3) |
| `TERMINATION` | `adaptive` | 수렴 종료 방식 |
| `CHOREO_PAUSE_MS` / `TOKEN_COALESCE_MS` / `SSE_PING_SECONDS` | `300` / `80` / `15` | 연출·토큰병합·SSE ping |

### 저장 · 승인 · 그라운딩
| 변수 | 기본값 | 설명 |
|---|---|---|
| `GEPA_DATA_DIR` | `./data` | 데이터 루트(wiki/sessions/agents/approvals 파생) — 이름은 레거시 |
| `DEFAULT_AUTONOMY` | `2` | 기본 자율 레벨(2=draft 승인) |
| `REQUIRE_APPROVAL` / `APPROVAL_TIMEOUT_S` | `false` / `600` | 쓰기 승인 게이트 |
| `WRITE_SESSION_DIGEST` / `EVOLVE_EMPLOYEES` | `true` / `true` | 세션 다이제스트 / 직원 자가학습 |
| `WEB_SEARCH` | `true` | 인-프로세스 웹검색 |
| `GROUNDING_TIMEOUT_MS` | `15000` | 외부 커넥터 fetch 타임아웃(3000~120000) |

### 콘텐츠 제작 — OpenAI 이미지 · 네이버 발행
| 변수 | 기본값 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | `''` | OpenAI 키(이미지·TTS) — 서브프로세스 env로만 전달 |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | 이미지 생성 모델 |
| `BLOG_PYTHON` / `BLOG_SCRIPTS_DIR` | `''` / `scripts/blog_skills` | 블로그 스킬 venv python / 스크립트 디렉토리 |
| `NAVER_SESSION_FILE` | `<data>/.naver_session.json` | 네이버 Playwright 세션(storage_state) 경로 |
| `BLOG_AUTO_IMAGE` | `false` | finalize 후 블로그 이미지 자동 생성 옵트인 |
| `AUTO_NAVER_DRAFT` / `NAVER_DRAFT_SEO_MIN` | `true` / `80` | ready 도달 시 자동 임시저장 / 최소 SEO 점수 |
| `AUTO_CARDNEWS` / `AUTO_SHORTS` | `true` / `true` | 임시저장 성공 시 카드뉴스·숏폼 자동 파생 |

> 브랜드별 네이버 계정은 `data/secrets.json`의 `NAVER_ACCOUNTS`(JSON `{"<slug>":{blogId,loginId,loginPw}}`)로 관리한다. 폴백이 없어(미설정 브랜드=발행 에러) 계정 섞임을 원천 차단한다. `ANTHROPIC_API_KEY`는 정의만 있고 **사용하지 않는다**(Claude는 구독 인증).

### 음성 입출력
| 변수 | 기본값 | 설명 |
|---|---|---|
| `TTS_PROVIDER` | `openai` | TTS 제공자(`openai`\|`say`) — 키 없으면 `say` 폴백 |
| `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | `gpt-4o-mini-tts` / `nova` | OpenAI TTS 모델·음색 |
| `VOICE_TTS_VOICE` | `Yuna` | macOS `say` 폴백 음색 |
| `VOICE_STT_MODEL` | `mlx-community/whisper-large-v3-turbo` | STT(음성인식) 모델 |

### 자율 사이클 · 능동 에이전트
| 변수 | 기본값 | 설명 |
|---|---|---|
| `AUTO_CYCLE_MINUTES` | `0` | 유휴 자율 사이클 주기(분, 0=off) |
| `RESEARCH_CYCLE_HOURS` | `24` | 지식 리서치 런 주기(시간, 0=off) |
| `CONTENT_CADENCE_PER_WEEK` / `CONTENT_READY_CAP` | `3` / `5` | 주당 목표 편수 / 미발행 백로그 캡 |
| `DAILY_BRIEFING_TIME` / `PERFORMANCE_SYNC_TIME` | `''` / `''` | 일일 브리핑 / 성과 동기화 시각("HH:MM") |
| `PERFORMANCE_WINDOW_DAYS` | `14` | 발행 후 성과 측정 대기일 |
| `NOTIFY_AUTO_CYCLE` | `true` | 자율 사이클 완료 알림 |
| `AGENT_TOOL_LOOP` / `AGENT_MAX_TOOL_CALLS` | `false` / `4` | 능동 다단계 tool-loop / 턴당 호출 캡(1~12) |
| `ENFORCE_AUTONOMY` | `true` | 자율 레벨 강제 게이팅 |
| `AGENT_SHELL` / `AGENT_SHELL_ALLOW` / `AGENT_SHELL_TIMEOUT_MS` | `false` / (읽기명령) / `60000` | 셸 실행 도구 + allowlist + 타임아웃 |
| `INJECTED_KNOWLEDGE_CAP` | `10000` | 주입 지식 반영 한도(자 수) |

> 하위호환 폴백으로 `LOCAL_LLM_TIMEOUT_MS` / `LOCAL_LLM_MAX_OUTPUT_TOKENS` / `LOCAL_LLM_INTEGRATION_MAX_OUTPUT_TOKENS` 세 개의 구 env 이름을 아직 읽는다(신규 이름의 폴백). `OLLAMA_*`·`EMBED_MODEL`·`USE_EMBEDDINGS`는 더 이상 유효하지 않다.

---

## 6. 위키 워크플로우 (Karpathy LLM Wiki)

`data/wiki/`(브랜드별 `data/wiki-<slug>/`) 아래에 LLM이 직접 유지하는 마크다운 지식베이스. RAG가 아니라 지식을 1회 컴파일해 계속 갱신(compounding)한다. 구조:

```
data/
├── raw/ · raw-<브랜드>/    # 업로드 원본(불변, 브랜드 격리)
└── wiki/ · wiki-<브랜드>/
    ├── index.md            # 카탈로그(카테고리별 1줄 요약) — 인덱스 우선 탐색 진입점
    ├── log.md              # append-only 타임라인
    ├── WIKI_SCHEMA.md      # 유지 규칙(스키마)
    └── pages/*.md          # 엔티티/개념/소스 페이지(YAML 프런트매터 + [[위키링크]])
```

| 워크플로우 | 코드 | 설명 |
|---|---|---|
| **ingest** | `ingest()` | 산출물/소스 → 엔티티·개념 추출 → 페이지 생성·갱신([[링크]]) → index 재생성 → log 기록. 재적재 시 '갱신' 섹션 머지(compounding). |
| **query** | `query()` / `semanticQuery()` | 휴리스틱 인덱스 탐색으로 관련 지식을 작업 전 주입(그라운딩). |
| **lint** | `lint()` | 고아 페이지·끊긴 링크(지식 갭) 탐지 → `GET /wiki/lint`. |
| **maintain** | `maintain()` | 자가수선: 끊긴 링크를 LLM으로 보충. `POST /wiki/maintain` + 런 종료 시 자동. |
| **audit** | `findContradictions()` | 토픽 겹치는 페이지 쌍을 비교 → 상충 주장 탐지. `POST /wiki/audit?resolve=1`이면 해소 노트 기록. |

흐름 예: 런이 끝나면 산출물이 `ingest`로 페이지가 되고, 끊긴 링크는 자동 `maintain`이 보충하며, 다음 런은 그 지식을 `query`로 자동 그라운딩한다 — 쓸수록 똑똑해지는 "제2의 두뇌".

---

## 6-1. 능동 실행 · 거버넌스 · 자율 (옵트인)

기본 런은 "분해→작업→집필"의 단발 경로다. 그 위에 **능동 에이전트**를 opt-in으로 얹었다 — 대부분 기본 off라 켜기 전까지 기본 동작은 동일하다.

| 기능 | 켜기 | 동작 |
|---|---|---|
| **능동 tool-loop** | `AGENT_TOOL_LOOP=1` | `work` 단계 에이전트가 `<tool name="wiki_query">…</tool>` 태그로 자료를 스스로 더 캐고 재호출(`AGENT_MAX_TOOL_CALLS` 캡) |
| **거버넌스 enforcement** | `ENFORCE_AUTONOMY=1`(기본) | 자율레벨로 도구 게이팅 — `0`=없음, `1`=읽기만, `2`=쓰기는 **승인 게이트**, `3`=자동 |
| **셸 실행** | `AGENT_SHELL=1`(+autonomy≥2) | `<tool name="run_command">…</tool>` → 샌드박스 단일 명령. **다층 방어**(아래) |
| **유휴 자율 사이클** | `AUTO_CYCLE_MINUTES=N` | N분마다 **사용자 런이 없을 때만** '가장 가치있는 단일 작업'을 제안→실행. 사용자 런 도착 시 진행 중 자율런을 **양보(abort)** |
| **지식 리서치 사이클** | `RESEARCH_CYCLE_HOURS=24` | 주기적으로 리서치 런(조사→토론→위키 적재→직원 학습)을 돌려 두뇌를 컴파운딩. 블로그·카드뉴스·숏폼은 만들지 않아 캘린더를 오염시키지 않는다 |
| **정기 운영** | `DAILY_BRIEFING_TIME` / `PERFORMANCE_SYNC_TIME` | 일일 브리핑 / 발행 성과 동기화(`PERFORMANCE_WINDOW_DAYS` 경과분) |

> 설계 원칙: 단일 슬롯 속도 철학을 깨지 않도록 전부 보수적 기본값(off)·유계(캡)·양보(yield). 능동 실행이 열리면 거버넌스가 필요해지므로 함께 설계됐다.

**셸 실행(`run_command`) 보안 모델 — 양성 컨테인먼트.** 적대적 보안리뷰가 '경로 블랙리스트'를 글로브·틸드·중괄호로 전부 우회함을 입증해, **블랙리스트를 폐기하고 컨테인먼트로 재설계**했다:
- `spawn(shell:false)` — 셸 미경유라 글로브·치환·리다이렉트·체이닝이 원천 차단(인자 전부 리터럴).
- **경로 컨테인먼트** — 인자가 절대경로(`/`)·홈(`~`)·상위(`..`)를 못 써 샌드박스 `data/agents/<id>/workspace/` 하위로만 해석.
- argv[0] **allowlist**(읽기명령) + 특수문자 거부 + 타임아웃 SIGKILL + 출력 하드캡. 셸 게이트는 `ENFORCE_AUTONOMY=false`라도 항상 적용.

---

## 7. 브랜드(고객사) 격리

여러 고객사의 콘텐츠를 한 스튜디오에서 다루되, **자료·지식·발행 계정을 브랜드별로 분리**한다.

- **레지스트리** — `data/brands/<slug>.yaml`(이름·업종·타겟·톤·채널 등), 활성 브랜드는 `data/brand.yaml`. `activateBrand`로 전환.
- **주입 방식** — 프롬프트를 고치지 않고 런타임 컨텍스트(`brandContext`)로 브랜드 정보를 주입하고, 생성물에 `piece.brand`/`cardnews.brand`/`shorts.brand`를 태깅한다.
- **파일 격리** — 원본(`raw-<slug>/`)·위키(`wiki-<slug>/`)·공유 상태(decisions 등)를 브랜드 접미사로 분리. 슬러그는 경로 탈출 방어(`isSafeBrandSlug`)로 검증.
- **발행 계정 격리** — 네이버 계정을 `NAVER_ACCOUNTS`에 브랜드별로 저장하고, 세션 파일·프로필도 브랜드별로 분리. **폴백이 없어** 미설정 브랜드는 발행 에러로 명확히 막는다(계정 섞임 방지).

---

## 8. 콘텐츠 파이프라인 상세

한 편의 콘텐츠는 **piece**로 관리되며 스테이지를 따라 이동한다:

```
idea → research → draft → ready → published → measured → reflected   (실패 시 error)
```

- **블로그 런(org)** — CEO 라우팅 → 리서치팀 조사·토론 → 작가가 브리프·검수·네이버 SERP 실측을 반영해 본문 1편 집필 → 포장(제목·태그·SEO·이미지 슬롯) → `finalizeRun`이 `draft.json/md/html` 저장 + 위키 적재. 초안이 생기면 piece가 `draft`로 승격된다.
- **리서치 런(`mission='research'`)** — UI "리서치" 토글로 실행. **집필·포장을 통째로 생략**해 `draft.json`을 만들지 않는다(→ piece 승격·자동 발행·파생이 자연 차단). 조사→토론→**위키 적재**→직원 학습만 남긴다. 캘린더를 오염시키지 않고 두뇌만 컴파운딩하는 용도다.
- **네이버 발행** — 실제로는 SmartEditor **임시저장만** 한다(발행 버튼은 사람이 네이버에서 직접 누른다). 자동 임시저장은 `AUTO_NAVER_DRAFT` + SEO ≥ `NAVER_DRAFT_SEO_MIN`(기본 80)일 때만, 미달이면 자동 리비전 1회 후 수동 검토로 넘긴다.
- **이미지 생성** — `gpt-image-2`(`openai_image.py` 서브프로세스). 블로그는 이미지 슬롯 확정 시 최대 3장, 카드뉴스는 한글 텍스트 포함 카드를 직접 렌더. OpenAI 키가 없으면 dry-run(계획만)으로 파이프라인을 막지 않는다. 모델이 직접 부르는 `image_generate`는 과금이라 승인 게이트.
- **카드뉴스·숏폼 파생** — 블로그 초안이 완료·임시저장되면 서버가 같은 주제로 카드뉴스·숏폼 런을 자동 파생한다(`AUTO_CARDNEWS`/`AUTO_SHORTS`). 검토 화면이나 제작실에서 초안 기준으로 "만들기"를 눌러 수동 파생도 가능하다. **리서치 런에는 초안이 없으므로 파생도 일어나지 않는다.**

---

## 9. 음성 입출력 (Voice I/O)

좌하단 🎙 버튼을 누르고 말하면 한국어가 입력창에 채워지고, 런 종료 시 최종 결과를 음성으로 읽어준다.

- **STT** — `mlx-whisper`(모델 `mlx-community/whisper-large-v3-turbo`, 첫 사용 시 자동 다운로드 ~1.5GB). 변환에 `ffmpeg` 필요.
- **TTS** — 기본 **OpenAI `gpt-4o-mini-tts`**(음색 `nova`). 키가 없거나 실패하면 macOS `say`(음색 `Yuna`) + ffmpeg로 폴백. `src/voice/tts.ts`가 OpenAI HTTPS를 직접 호출(ffmpeg 불필요).
- 미설치 시 음성 버튼은 비활성화되고 나머지 기능은 정상 동작한다. 설정은 `data/voice.json`.

**자비스 대화형** — 좌하단 "🗣️ 자비스" 토글을 켜면 마이크로 비서와 대화한다. 인사·간단 질의는 즉답하고, 업무 지시는 office에 위임해 결과를 음성으로 보고한다(`src/jarvis/`, `POST /jarvis/chat`).

---

## 10. 프로젝트 구조

```
biz_contents_creator/
├── package.json              # Node≥20.6·ESM·Hono·tsx·vitest
├── scripts/blog_skills/      # 네이버 발행·OpenAI 이미지 Python 스크립트(venv)
├── public/index.html         # 경량 자체 SPA(/lite, 빌드 불필요)
├── frontend/                 # React/Vite 프론트(/ 에서 dist 서빙)
├── assets/                   # company 시드·HWPX 템플릿
├── data/                     # 런타임 데이터(GEPA_DATA_DIR) — wiki(두뇌)·agents(직원 학습)·brands·
│                             #   sessions·cardnews·shorts. **예외 없이 전부 gitignore** — 클론하면
│                             #   비어 있고, 부팅 시 assets/company 시드에서 조직이 생성된다
└── src/
    ├── config.ts             # 전역 설정(env)
    ├── server/main.ts        # Hono HTTP + SSE 서버(전 엔드포인트)
    ├── llm/                  # Claude CLI 클라이언트·tier 라우팅·비용 (claudeCli·client·models·setting·cost)
    ├── orchestrator/         # 런 엔진(org·debate·directed)·집필·finalize·카드뉴스·숏폼·에이전트·툴·셸
    ├── content/              # 브랜드·페르소나·piece·카드뉴스·숏폼 모델
    ├── output/               # 렌더·SEO·네이버 블로그/스마트에디터 포맷·이미지 계획
    ├── agents/               # 회사·역할 정의 + 직원 워크스페이스(자가진화)
    ├── grounding/            # 커넥터: naver·dart·law·youtube·custom
    ├── wiki/                 # Karpathy LLM Wiki(ingest/query/lint/maintain/audit)
    ├── voice/                # STT·TTS·오디오·설정·엔드포인트
    ├── jarvis/               # 자비스 대화형 어시스턴트
    ├── autonomy/             # 자율 스케줄러·정기 브리핑·알림
    ├── analytics/            # 성과 수집·분석·전략 강화
    ├── approvals/            # 승인 라이프사이클(거버넌스)
    ├── secrets/              # 비밀값(네이버 계정 등) 저장소
    ├── research/             # 자율 리서치 주제 발굴
    ├── sessions/             # 세션 다이제스트(_brief/_report/<agent>.md)
    ├── mcp/                  # 법제처 법령 MCP 클라이언트
    ├── events/               # 이벤트 버스 + 프론트 공유 와이어 타입
    ├── export/               # markdown → HWPX(OWPML)
    ├── tools/                # 웹검색·추출·분류·블로그 스킬·숏폼 렌더
    └── util/                 # 세마포어·zip·fetch·abort·시간·문자열·id
```

---

## 11. 테스트

```bash
pnpm test          # vitest run (1회)
pnpm test:watch    # 워치 모드
pnpm typecheck     # tsc --noEmit
```

현재 **테스트 40개 파일 · 301개 통과**, `tsc --noEmit` 클린. 헤드리스 벤치(단계별 토큰·tok/s·벽시계)는 `tsx src/bench/bench.ts`.

---

## 부록: 설계 메모

- **구독 인증 고정** — LLM 호출은 전부 `claude -p`(Claude Code 구독). 호출 시 `ANTHROPIC_API_KEY`류를 env에서 제거해 크레딧 과금 회귀를 막는다. 대가로 호출당 CLI 부팅(~1.5s)·구독 rate limit을 감수한다.
- **tier 라우팅** — 정액 구독이라 "품질 우선": 구조적 단발만 haiku(micro), 본문은 sonnet(standard), 통합·편집은 opus(heavy).
- **마이크로 단발** — 분해/배정/수렴/분류는 풀 에이전틱 루프 대신 `microJSON` 1회로 비용·지연을 억제한다.
- **비용 보험** — 정액이라도 `data/llm_usage.json` 원장 + `MONTHLY_BUDGET_USD` 캡으로 폭주를 방어한다.
- **자율은 양보 우선** — 유휴/정기 사이클은 사용자 런이 없을 때만 돌고, 사용자 런 도착 시 즉시 abort로 양보한다.
- **네이버는 임시저장까지만** — 발행(공개)은 항상 사람이 최종 확인한다. 자동화는 임시저장·SEO 게이트에서 멈춘다.
