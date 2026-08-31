# 사실 게이트 완화 · 수요 기각 기억 · 블로그 전면 수동 검토 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or a Workflow that runs the same implement→review→fix loop) to implement this plan task-by-task. Tasks are sequential (shared tsx-watch server, shared files).

**Goal:** 사용자 지시 3건(2026-08-27) — ① 사실 게이트는 수치·시기·약제·법령·가격·경험 주장만 보류하고 일반 상식 문장은 통과(참고 표시) ② 검색 수요 미달로 기각된 키워드를 틱 간 기억해 재제안·재조회 낭비 제거 ③ 네이버 블로그 글은 근거 유무와 무관하게 자동 임시저장을 하지 않고 전부 수동 검토 대기.

**Architecture:** ① `factGate.ts` 결과 조립에서 무근거 주장을 hard(보류)/soft(참고 `unverified`)로 나눈다 — 판정 프롬프트·추출은 그대로, 상태 계산만 바뀜. ② `topicDemand.ts` 에 브랜드별 기각 기억 파일 + 프롬프트 블록, `scheduler.ts`·`main.ts` 판정 지점에서 기억 우선 조회·기록. ③ `CONFIG.autoNaverDraft` 기본값 off + `maybeAutoNaverDraft` 를 "SEO 자동 리비전은 유지, 임시저장 호출만 차단"으로 분리.

**Tech Stack:** TypeScript, vitest, 기존 모듈(`src/content/factGate.ts`, `src/autonomy/contentNotify.ts`, `src/analytics/topicDemand.ts`, `src/autonomy/scheduler.ts`, `src/server/main.ts`, `src/config.ts`).

**Spec:** 이 문서(사용자 지시 + 선택 "수치 주장만 잡기 (Recommended)")가 스펙이다.

## Global Constraints

- 서버는 launchd `pnpm dev`(tsx watch): `src/` 저장 = 재시작 = 진행 중 런 사망. 자율 사이클은 컨트롤러가 꺼 둠. 매 저장·테스트 전 유휴 확인 `curl -s http://127.0.0.1:8787/runs | grep -c '"status":"running"'` → 0 AND `pgrep -f naver_publish.py` 비어 있음. `pnpm dev` 금지, 서버 POST 금지.
- `pnpm typecheck` + `pnpm test` green. `git add` 는 바꾼 파일만(`git add -A` 금지 — 병렬 세션이 data/ 를 커밋함). `rm` 대신 `trash`.
- 커밋 트레일러 2줄 필수: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01HUSNN1pJkNxMnbvjqRHdmN`.
- 브랜드 격리: 새 파일은 `<name>-<brandSlug>.json`. 킬스위치 off 면 외부 호출·파일 쓰기 0.
- 기존 하드 게이트(재탕·브랜드 소재·함정어·리서치 폐기·계열 하드·수종 앵커)와 수요 게이트 채택 순서는 그대로.

---

### Task 1: 사실 게이트 — 수치 주장만 보류(hard/soft 분리)

**Files:**
- Modify: `src/content/factGate.ts` (상태 계산 `:150-165`, `FactGateInfo`/`FactGateResult`, `factGateBlog` 결과 조립 `:279-310`)
- Modify: `src/autonomy/contentNotify.ts:100` `factGateLines`
- Modify: `src/orchestrator/org.ts` `[사실게이트]` 콘솔 미러 로그(주장 N건 줄에 `참고 M` 추가), `writeFactGate` 산출물에 `unverified` 포함
- Modify: `src/config.ts` + `.env.example` — `factGateStrict: envBool('FACT_GATE_STRICT', false)`
- Test: `src/content/factGate.test.ts`, `src/autonomy/contentNotify.test.ts`(있으면)

**Requirements (exact):**
- `export const HARD_CLAIM_KINDS: ReadonlySet<ClaimKind> = new Set(['number','time','treatment','law','price','stat','experience'])`.
- `export function isHardClaim(c: { text: string; kind: ClaimKind }): boolean` = `HARD_CLAIM_KINDS.has(c.kind) || HARD_FACT_RE.test(c.text) || /\d/.test(c.text) || /(?:[일이삼사오육칠팔구십백천]+\s*(?:배|회|번|일|주|개월|년|도|cm|m|kg|g|ml|리터|원|%))/.test(c.text)`.
- 결과 조립: `unsupported` = status 'unsupported' 이고 `isHardClaim` 참 / 새 필드 `unverified: string[]` = status 'unsupported' 이고 `isHardClaim` 거짓. `contradicted` 는 그대로(항상 hard). `status = (unsupported.length + contradicted.length > 0) ? 'hold' : 'pass'`.
- `CONFIG.factGateStrict === true` 면 예전 동작(모든 무근거 → `unsupported`, `unverified` 빈 배열).
- `FactGateInfo` 에 `unverified?: string[]` 추가(구 데이터 호환 — 없으면 []). `fact_gate.json` 에 `unverified` 기록. `piece.factGate` 로 전파(`advancePieceReady` 는 info 를 통째로 저장하므로 타입만 맞추면 됨 — 확인).
- 표적 수정·작가 재작성은 기존대로 `unsupported`(=hard) + `contradicted` 만 대상 — 코드 변경 없이 좁아지는지 확인하고 테스트로 고정(soft 만 있는 런은 pass 이므로 수정 라운드 0).
- `factGateLines`: pass 이고 `unverified.length > 0` 이면 `✅ 사실 게이트 통과 · 근거 미확인(참고) N건` + 최대 `maxItems` 줄 `· 문장` 앞에 `참고:` 접두. hold 는 기존 형식 유지하되 끝에 `(참고 M건)` 을 M>0 일 때만 덧붙임.
- 콘솔 미러: `[사실게이트] 사실 게이트 — 주장 N건 · 무근거 H · 참고 S · 모순 C · …`.
- 테스트(최소): (a) kind general + 수치 없음 → unverified·pass (b) kind general + "3배" → unsupported·hold (c) kind time → hold (d) kind experience → hold (e) strict on → 전부 unsupported (f) factGateLines pass+참고 렌더 (g) hold+참고 M 표기.

**Commit:** `feat(fact-gate): 수치·시기·약제·법령·가격·경험 주장만 보류 — 일반 상식 무근거는 참고(unverified)로 통과(FACT_GATE_STRICT 복귀 스위치)`

---

### Task 2: 수요 미달 기각 기억(틱 간) + 제안 금지 블록

**Files:**
- Modify: `src/analytics/topicDemand.ts`
- Modify: `src/autonomy/scheduler.ts`(후보 루프 수요 결정 지점·`demandTargets` 필터·프롬프트 블록)
- Modify: `src/server/main.ts` `demandCheckFor`(예고·클러스터 경로)
- Test: `src/analytics/topicDemand.test.ts`, `src/autonomy/scheduler.test.ts`

**Requirements (exact):**
- `export const DEMAND_REJECT_TTL_DAYS = 30`. 파일 `data/analytics/demand-rejects-<slug>.json` 형식 `{ [normKw]: { keyword: string; line: string; ts: string } }`. 쓰기는 `${f}.${process.pid}.tmp` → rename.
- `export function rememberDemandReject(slug: string, keyword: string, line: string, now?: Date): void` — 만료 항목 정리 후 upsert. `CONFIG.topicDemandGate` off 면 no-op.
- `export function demandRejectFor(slug: string, keyword: string | undefined, now?: Date): { keyword: string; line: string; ts: string } | null` — `normKw` 대조, 만료면 null. off 면 null.
- `export function demandRejectBlock(slug: string, now?: Date): string` — 항목 없으면 `''`; 있으면 `[검색 수요 미달로 기각된 키워드 — 30일간 제안 금지]` 헤더 + 최근순 최대 15줄 `- "keyword" (line)` + 지침 1줄 `이 키워드와 띄어쓰기만 다른 변형도 같은 키워드다. 대신 검색량이 있는 상위 카테고리어로 주제를 세워라.`
- 스케줄러: (a) `demandTargets` 에서 기억된 키워드 제외(조회 비용 0) (b) 수요 결정 지점에서 `demandRejectFor` 가 있으면 API 행 대신 그 line 으로 `reject`(마지막 라운드는 기존 relax 규칙 그대로 demote rank 1) — 로그 `[auto-cycle] 아이디어 기각(검색 수요 미달·기억) — "title" (line)` (c) API 판정이 `reject` 이면 `rememberDemandReject` (d) 프롬프트: `demandSignalBlock` 직후에 `demandRejectBlock(slug)` 삽입, `[신호 우선순위]` 줄은 변경 없음(금지 블록은 이미 "금지가 항상 이긴다" 규칙 적용).
- `main.ts demandCheckFor`: 호출 전에 `demandRejectFor` 확인 → 있으면 API 없이 reject; API reject 면 `rememberDemandReject`.
- 순수 판정 로직은 `demandGateDecision` 에 `opts.remembered?: { line: string }` 로 넣어 테스트 가능하게(remembered 가 있으면 rows 무시하고 reject/relaxed demote).
- 테스트(최소): TTL 만료 무시 / 정규화 대조("가을거름"↔"가을 거름") / off 시 no-op·파일 미생성 / 블록 15줄 상한·빈 문자열 / `demandGateDecision` remembered → reject, relax → demote+relaxed.

**Commit:** `feat(topic): 수요 미달 기각 키워드 30일 기억 — 재조회 0·재제안 금지 블록·예고/클러스터 경로 공유`

---

### Task 3: 블로그 자동 임시저장 전면 중단(수동 검토 대기) — SEO 자동 리비전은 유지

**Files:**
- Modify: `src/config.ts:293` 기본값 `envBool('AUTO_NAVER_DRAFT', false)`; `.env.example` 설명 갱신
- Modify: `src/server/main.ts:2170-2195` `maybeAutoNaverDraft`
- Modify: `src/autonomy/contentNotify.ts`(검토 메시지에 수동 검토 줄) — 실제 메시지 조립 위치를 grep 해서 찾을 것
- Test: 기존 main 엔드포인트 테스트 또는 `contentNotify.test.ts`

**Requirements (exact):**
- `maybeAutoNaverDraft` 분리: SEO 점수 확인·자동 리비전 런 발사(`revisionLaunched`)는 `CONFIG.autoNaverDraft` 와 무관하게 기존대로 동작. **임시저장 호출만** `CONFIG.autoNaverDraft` 가 true 일 때 실행. off 이면 조각당 1회 로그 `[발행담당] <제목> — 자동 임시저장 꺼짐 → 수동 검토 대기(텔레그램·검토 탭 버튼)`.
- 사실 게이트 hold 차단(`autoDraftBlockedByFactGate`)은 auto-draft 가 on 일 때만 의미 — 순서: autoNaverDraft off → 로그·return(리비전 로직은 그 앞에서 처리). 기존 hold 로그는 on 일 때만.
- 텔레그램 검토 메시지: auto-draft off 이면 사실 게이트 줄 아래에 `✋ 수동 검토 대기 — 아래 "네이버 임시저장" 버튼으로 저장` 1줄(on 이면 기존 문구). 버튼·수동 API(`POST /pieces/:id/naver-draft`)·검토 탭 UI 는 변경 없음.
- `.env` 에 `AUTO_NAVER_DRAFT` 항목이 없음(확인됨) → 코드 기본값만으로 off 가 된다. `.env.example` 에 `AUTO_NAVER_DRAFT=false # 기본 off(2026-08-27 사용자 확정): 모든 블로그 글은 수동 검토 후 버튼으로 임시저장. true 로 켜면 SEO 하한·사실 게이트 통과 시 자동 저장`.
- 테스트(최소): autoNaverDraft off → 임시저장 미호출·리비전 판단은 수행 / on → 기존 동작 / 메시지에 수동 검토 줄.

**Commit:** `feat(publish): 블로그 자동 임시저장 기본 off — 전부 수동 검토 대기, SEO 자동 리비전은 유지`
