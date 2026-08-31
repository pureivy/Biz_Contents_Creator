# 사실 기반 게이트 설계 — 콘텐츠 날조·거짓 차단 (2026-08-26)

## 0. 배경과 목표

사용자 절대 규칙(2026-08-26): **"컨텐츠 내용은 사실에 기반해서 작성해야 해. 지어내거나 거짓을 이야기하면 절대 안됨."**

감사(워크플로 wf_ff159c34, 26 에이전트, 읽기 전용) 실측:

- 표본 6편(블로그 4·카드 1·쇼츠 1)의 원예 사실 주장 85건 중 46건(54%)이 저장소 어디에도 근거가 없고, 5건은 자사 기존 글·위키와 모순된 채 발행됐다.
- 경험 날조(NO_FABRICATED_EXPERIENCE, 08-02)는 0건 — 그 가드는 작동한다. 그러나 **본문 생성 후 사실을 대조하는 게이트가 0개**다(구 데이터감사 패스가 8f16a8c 에서 제거된 뒤 대체물 없음, `org.ts:626`).
- 순환 세탁: 본문 → 위키 concept(출처 소실) / maintain 스텁(LLM 기억) / verified.md(태그 문자열만 검사, 토론 전 텍스트 승격) → 다음 런에 "우선 신뢰"로 재주입.
- 리비전 fast-path(발행글 73%)는 브리프·voiceGuide 없이 재작성해 새 수치가 끼어든다.

목표: 근거 없는 사실 주장이 **자동으로 발행 경로에 오르지 못하게** 하고, 근거 세탁 순환을 끊는다. 사람이 최종 판단하는 지점(텔레그램 버튼)은 유지하되, 판단에 필요한 정보(무근거 문장 목록)를 그 지점에 보여준다.

사용자 확정 판단(2026-08-26):
1. 보류는 **자동 임시저장·자동 파생 시작만 차단**한다. 사람의 수동 버튼은 유지(목록 동봉).
2. **유보어("대개/흔히/보통")가 붙은 원예 통설은 근거 없이 허용**한다(08-12 결론 의무 확정 유지). 수치·시기·약제·법령·가격·특정 개체 주장은 근거 필수. 모순 근거가 있으면 통설이라도 모순 처리.
3. 기존 `verified-<brand>.md` 를 **소급 정리**한다(아카이브 이동, git 추적이라 복구 가능).
4. 카드뉴스·쇼츠의 **원문 정합 판정**을 ①에 포함한다.

## 1. 범위

| # | 항목 | 성격 |
|---|---|---|
| ① | 본문 사실 게이트 + 보류 + 파생 정합 판정 + 프롬프트 정정 | 신규 서브시스템 |
| ② | 리비전 경로에 브리프·voiceGuide 재주입 | 바운디드 |
| ③ | 위키 그라운딩 출처 표기·인용 한정·스텁 격리 | 바운디드 |
| ④ | verified 승격 정직화 + 소급 정리 | 바운디드 |
| ⑤ | 파생·발행면 결정적 가드 3종 | 바운디드 |

범위 밖(후속 후보): URL 본문 fetch → `raw/` 저장 도구(감사 U14), 발행 후 정정 경로(U16), 검토 탭 UI 배지, 자비스 즉답 그라운딩(U30).

## 2. 사실 게이트(①)

### 2-1. 모듈 `src/content/factGate.ts`

순수 함수 + micro LLM 호출 2종. 모든 LLM 호출은 `microJSON`(기존)으로, 실패 시 예외를 삼키지 않고 `{ status: 'error' }` 를 돌려준다.

```ts
export type ClaimKind =
  | 'number' | 'time' | 'species' | 'pest' | 'treatment' | 'law' | 'price'
  | 'experience' | 'stat' | 'general';
export type ClaimStatus = 'supported' | 'hedged_general' | 'unsupported' | 'contradicted';
export interface FactClaim { text: string; kind: ClaimKind; status: ClaimStatus; evidence?: string }
export interface FactGateResult {
  status: 'pass' | 'hold' | 'error';
  claims: FactClaim[];
  unsupported: string[];   // 잔존 무근거 문장(원문 인용)
  contradicted: string[];  // 근거와 모순되는 문장(원문 인용 + 근거 발췌)
  repaired: boolean;       // 수정 라운드가 돌았는가
  error?: string;
  checkedTs: string;
}
```

- `numericClaimSentences(body): string[]` — 결정적 사전 추출. 숫자+단위(cm·mm·m·kg·g·L·℃·%·호·년생·주·일·개·회), 월(1~12월·시월·유월 등 고유어 포함), 24절기, 연도가 든 문장을 뽑는다. LLM 추출이 놓쳐도 이 문장들은 판정 대상에 강제 포함된다.
- `extractFactClaims(model, body)` — micro 1콜. 본문에서 검증 가능한 사실 주장을 최대 `FACT_GATE_MAX_CLAIMS`(기본 20)개 추출해 `{text, kind}` 로 돌려준다. 상식 수준의 뻔한 문장과 1인칭 판단·관점 문장("자리부터 정합니다")은 제외하라고 지시한다. `numericClaimSentences` 결과를 프롬프트에 "반드시 포함" 목록으로 넘긴다.
- `judgeClaims(model, claims, evidence)` — micro 1콜. 근거 말뭉치를 주고 각 주장에 status·evidence(근거 발췌 1줄)를 매긴다. 판정 규칙(프롬프트에 명시):
  - 의역·반올림("18~24cm" ↔ "20cm 안팎")·단위 환산(호↔cm 표: 6호=18cm, 8호=24cm, 10호=30cm, 12호=36cm, 15호=45cm)·한글 수사("스무")는 같은 값으로 본다 — 감사에서 반박된 오탐 사례를 그대로 예시로 넣는다.
  - `hedged_general`: "대개/흔히/보통/~인 경우가 많다/~일 수 있다" 유보어가 붙은 원예 일반 인과. 근거가 없어도 통과. 단 근거 말뭉치에 반대 진술이 있으면 `contradicted`.
  - 운영 수치(검색량·문서수·조회수)는 판정 대상에서 제외(`[운영 데이터 비공개]` 지침과 정합).
  - `experience` 종류는 근거 유무와 무관하게 `unsupported`(NO_FABRICATED_EXPERIENCE 와 이중 방어).
- `factGateBlog({ model, body, evidence })` → `FactGateResult`. `status = 'hold'` 조건: `unsupported.length + contradicted.length >= 1` 또는 LLM 실패.
- `buildEvidence({ brief, critiqueText, wikiGrounding, injected, verified })` — 근거 말뭉치 조립(순수). SERP 제목은 경쟁 블로그 주장이라 제외. 각 블록에 머리말을 붙여 판정기가 출처 종류를 알게 한다.

### 2-2. 실행 지점과 수정 라운드

`packageDesignFinalize`(org.ts) 진입 직후, `findTemplateNumbers` 옆:

1. `factGateBlog` 1차 판정.
2. 무근거·모순이 있으면 **1회 수정 라운드**: `writeBlogBody({ revise: { baseBody, feedback } })` 로 작가에게 돌려보낸다. feedback 은 "다음 문장은 브리프·근거 자료에 없다 — 삭제하거나, 유보어를 붙인 일반론 또는 근거 있는 판단 기준·관찰 방법으로 바꿔라. **새 사실·수치를 추가하지 마라.**" + 문장 목록. 이 리비전에도 ②의 브리프·voiceGuide 가 들어간다.
3. 수정본에 `factGateBlog` 2차 판정(추출·대조 재실행). 결과가 최종.
4. 결과를 `data/sessions/<runId>/fact_gate.json` 에 저장하고 `bus.emit('log')` 로 한 줄 남긴다(`사실 게이트 — 주장 N건 · 무근거 a · 모순 b · 수정 라운드 {예/아니오} · 판정 {pass|hold}`).
5. 이후 포장(formatter)·이미지·finalize 는 기존과 동일하게 진행한다 — 게이트는 런을 중단시키지 않는다.

리서치 런(`mission === 'research'`)은 본문이 없으므로 게이트를 건너뛴다.

작가 호출 비용: 1차 2콜 + (필요 시) 작가 1콜 + 2차 2콜 = 최대 5콜(micro 4 + 작가 1).

### 2-3. 조각(piece)·자동 발행 연동 (`src/server/main.ts`, `src/content/pieces.ts`)

- `Piece.factGate?: { status: 'pass' | 'hold' | 'error'; unsupported: string[]; contradicted: string[]; checkedTs: string }` 추가.
- `advancePieceReady` 가 `fact_gate.json` 을 읽어 piece 에 기록한다(파일 없음 = 게이트 미실행 = 필드 없음).
- `maybeAutoNaverDraft`: `piece.factGate?.status` 가 `hold` 또는 `error` 이면 자동 임시저장을 **건너뛰고** 로그를 남긴다(`[발행담당] … — 사실 게이트 보류 N건 → 자동 임시저장 건너뜀(수동 검토)`). SEO 미달 자동 리비전은 그대로 허용한다(리비전 결과는 다시 게이트를 거친다).
- 자동 파생(카드뉴스·쇼츠)은 네이버 임시저장 성공 훅에서 시작되므로, 자동 임시저장이 막히면 자동 파생도 자연히 막힌다. 사람이 수동 임시저장을 누르면 파생은 기존대로 시작된다.
- `contentNotify.blogReadyHtml`: `factGate` 가 hold/error 면 제목 아래에 `⚠ 사실 게이트 보류 N건` 과 무근거·모순 문장 최대 3개(각 80자 절단)를 넣는다. 버튼은 변경 없음.
- `GET /pieces` 응답은 piece 전체를 돌려주므로 `factGate` 가 자동 노출된다(UI 배지는 범위 밖).

### 2-4. 파생 정합 판정 (`src/orchestrator/standaloneQa.ts` 확장)

- `parityIssues(kindLabel, texts, sourceBody, signal): Promise<string[]>` — micro 1콜. 파생 문구(카드 장별 카피 / 씬 내레이션+screenText)를 원문 bodyMarkdown 과 대조해 (a) 원문에 없는 사실·수치·시기·약제 (b) 원문 결론의 반전(예: 원문 "잎 진 뒤로 미루라" ↔ 파생 "잎 멀쩡할 때만 주세요") 를 `"항목N: …"` 형식으로 보고한다. 반올림·의역·단위 환산 허용 규칙은 2-1과 동일하게 프롬프트에 넣는다.
- `planCards`·`planShorts` 의 기존 수정 라운드(standaloneIssues + styleLint)에 `parityIssues` 결과를 합류시킨다.
- 수정 라운드 뒤 `parityIssues` 를 1회 재실행해 잔존을 구하고, `CardNews.factGate` / `Shorts.factGate`(Piece 와 같은 형태)에 기록한다. 텔레그램 카드·쇼츠 캡션에 `⚠ 원문 정합 보류 N건` + 항목 최대 2개를 넣는다. 파생은 자동 발행이 없으므로 차단 대상은 없다(표시만).
- `standaloneIssues` 와 같은 품질 게이트: 판정 모델이 claude 계열이 아니면 빈 배열(오탐 재호출 방지).

### 2-5. 프롬프트 정정

- `data/company.yaml` 수석 작가(content_lead) system_prompt:
  - `[도입부] 3문장: 신뢰 근거(경험·데이터·출처)를 심는다` → `3문장: 신뢰 근거를 심는다 — 브리프에 있는 데이터·출처, 또는 우리가 무엇을 어떤 기준으로 보는지(판단 기준). 겪지 않은 경험을 만들어 넣지 않는다.`
  - `각 섹션 = 핵심 문장 → 설명 → 구체 예시·수치` → `각 섹션 = 핵심 문장 → 설명 → 구체 예시·수치(브리프에 근거가 있을 때만 — 없으면 수치 대신 판단 기준·관찰 방법으로 구체화한다)`.
  - `[제출 전 자기검증] ③모든 수치에 근거가 있는가(브리프 밖 수치 0건)` → `③모든 수치·시기·약제·품종 특성 주장에 브리프 근거가 있는가(브리프 밖 사실 0건 — 유보어 붙인 원예 통설만 예외)`.
- `BLOG_BODY_GUIDE`(org.ts): `사실·수치는 근거로 뒷받침([근거: 출처]). 없는 값은 지어내지 말고 생략한다.` 를 `사실·수치·시기·약제·품종 특성은 브리프·제공 자료에 있는 것만 쓴다. 없는 값은 지어내지 말고 생략하거나, 유보어("대개/흔히")를 붙인 일반론으로만 말한다. 본문에 [근거: …] 표기는 남기지 않는다.` 로 바꾼다(⑤(c)의 제거 규칙과 정합).
- 활성 `data/brands/bionditree.yaml` 은 손대지 않는다(프롬프트는 회사 로스터 소관).

### 2-6. 설정

- `FACT_GATE`(기본 on, `off` 면 게이트·파생 정합 전부 건너뜀 — 필드 미기록).
- `FACT_GATE_MAX_CLAIMS`(기본 20).

## 3. 리비전 경로(②)

- `runOrg` 가 `writeBlogBody` 호출 직전에 `brief` 를 `data/sessions/<runId>/research_brief.md` 로 저장한다(digest 의 `_brief.md` 는 주제·하위문제 요약이라 별개 파일).
- `LaunchOpts.revise` / `RunOptions.revise` 에 `baseRunId?: string` 추가. `maybeAutoNaverDraft`·검토 탭 수정요청·텔레그램 ✍수정요청이 리비전을 띄울 때 `piece.runId` 를 넣는다.
- `runOrgRevise`: `baseRunId` 의 `research_brief.md` 를 읽어 `brief` 로 넘기고, 자기 세션 디렉토리에도 같은 이름으로 복사한다(연쇄 리비전). 파일이 없으면 `brief: ''`(기존 동작)로 진행하고 로그를 남긴다.
- `writeBlogBody`: `voiceGuide` 의 `revise ? ''` 분기를 제거해 리비전에도 주입한다. 리비전 task 문장에 `기존 초안과 [리서치·SEO 브리프]에 없는 새 사실·수치·시기를 추가하지 마라` 를 덧붙인다. `reviseContext` 에 브리프 블록을 포함한다.
- 게이트(2-2)는 리비전 결과에도 동일하게 돈다.

## 4. 위키 그라운딩(③) — `src/wiki/llmwiki.ts`, `src/orchestrator/agent.ts`, `src/orchestrator/finalize.ts`

- `provenanceLabel(page): string` (순수) — `raw/` 출처 → `원문(raw)`; `type === 'performance'` → `실측 성과`; `sources` 에 `maintain:auto` → `LLM 생성 스텁`; `stub:source` → `원문 발췌 스텁`; `type ∈ {debate, overview, lesson}` → `토론·종합(출처 없음)`; `run:` → `런 산출 요약`; 그 외 → `출처 미상`.
- `query()`·`semanticQuery()` 컨텍스트 머리말을 `### 제목 [라벨]` 로 바꾼다.
- `query()` 점수: `maintain:auto` ×0.5 추가. `opts.forFacts === true` 면 `performance·debate·overview·lesson` 타입을 후보에서 제외한다. `runAgent` 에 `groundForFacts?: boolean` 을 추가하고 `writeBlogBody`(재집필 포함)에서 `true` 로 넘긴다. 리서치 팀(work 단계)은 기존대로.
- `groundDirective` 1)항: `아래 제공된 자료 중 [원문(raw)]·[실측 성과]·커넥터 블록의 실제 수치·명칭은 그대로 인용하라. [LLM 생성 스텁]·[토론·종합]·[런 산출 요약] 표기 자료는 방향 참고용이며, 그 수치·주장을 사실로 인용하지 마라.`
- `finalizeRun`: `maintain(model, {maxFill: 2})` 호출을 `fillDanglingFromSource(model, {maxFill: 2, signal})` 로 교체. `fillDanglingFromSource` 에 `maxFill` 옵션과 `offBrandTerm` 게이트를 추가한다(현재는 상한·게이트 없음). `maintain` 함수 자체는 남긴다(UI 수동 호출 경로 유지).
- `extract` 프롬프트: `links 는 비우지 마라 … (빈 배열 금지)` → `links 에는 본문에 실제로 언급된 개념만 넣는다. 관련 개념이 본문에 없으면 빈 배열을 허용한다`.
- 기존 `maintain:auto` 페이지 453장은 삭제하지 않는다(라벨·감가로 처리).

## 5. verified 정직화(④) — `src/orchestrator/groundingLedger.ts`(신규), `src/agents/workspace.ts`, `src/orchestrator/reflect.ts`, `src/orchestrator/finalize.ts`

- 원장: `noteGrounding(runId, entries: Array<{ label: string; kind: 'connector' | 'web' | 'wiki-raw' | 'wiki-derived' }>)`, `groundingEntries(runId)`, 런 종료 시 `clearGrounding(runId)`. 메모리 Map, 런 100개 상한(evict 오래된 것).
- `runAgent` 가 주입 시점에 기록한다: 위키 히트 → 제목(+`raw/` 출처면 `wiki-raw`, 아니면 `wiki-derived`); 커넥터 → `blockLabel`(대괄호 제거) + 그 연결자가 돌려준 컨텍스트 첫 줄의 질의어; 웹 검색 → 결과 URL 들.
- `acceptVerifiedSource(source, entries): boolean` (순수):
  - 거절: `/동일|위키\s*[「(]?.*(종합|비평)|성과|검증된 지식|사내|확립된|일반|상식|추정|추론/` 매치, 또는 주장 텍스트에 `/⚠️|미실측|미확인|데이터 없음|가정/`, 또는 주장이 표 조각(`|` 2개 이상 또는 `|` 로 시작).
  - 수락: `source` 가 URL 을 포함하고 그 URL 이 원장의 `web` 항목에 있음; 또는 원장의 `connector` 라벨 중 하나를 포함; 또는 `wiki-raw` 제목을 포함.
  - 그 외 거절. 거절 건수는 `검증 지식 — 승격 N건 · 거절 M건(원장 불일치)` 로 로그.
- 승격 입력: `finalizeRun` 에 `verifiedInputs?: Array<{ id: string; text: string }>` 을 추가하고 `runOrg` 가 **토론 후** `usableTeams` 의 `{ id: team.lead.id, text: t.deliverable }` 를 넘긴다. `reflectAndLearn` 은 이 입력이 있으면 그것으로만 승격하고, 없으면 기존 roster(파생·단독 경로 호환).
- `personaExtra` 라벨: `[검증된 지식(근거 확인됨 — 우선 신뢰)]` → `[근거 표기된 지식(출처 표기됨 — 실측·원문 출처만 사실로 인용, 방향 참고)]`.
- 소급 정리 스크립트 `scripts/verified_cleanup.ts`: 활성 브랜드의 `data/agents/*/verified-<brand>.md` 각 줄에 `acceptVerifiedSource` 의 **거절 규칙만**(원장은 없으므로 수락 규칙은 미적용) 적용해 거절 줄을 `verified_archive-<brand>.md` 로 옮기고 건수를 출력한다. `--dry-run` 지원. 1회 실행 후 결과를 커밋한다.

## 6. 파생·발행면 가드(⑤)

(a) 쇼츠 quote 출처 — `src/tools/shortsCommon.ts`, `src/orchestrator/shorts.ts`
- `normalizeSceneKind` 의 `source` 절단을 15자 **단어 경계**(마지막 공백 앞)로 바꾼다.
- `planShorts` 후처리: `quote.source` 가 `sourceBody` 에 (공백 제거 비교로) 포함되지 않으면 `source` 를 삭제한다(텍스트는 유지). `sourceBody` 가 없는 단독 생성은 `source` 를 항상 삭제한다.
- `ShortsRevision.scenes[]` 에 `quote?: { text?: unknown; source?: unknown }` 를 허용하고 `applyShortsRevision` 이 kind `quote` 씬에 한해 반영한다(text 40자·source 15자 상한 동일).

(b) 압축 유보어 보존 — `src/orchestrator/shorts.ts`
- 압축 프롬프트 규칙에 `유보어("대개/흔히/보통/~일 수 있다/~봐요/가능성")는 군더더기가 아니다 — 남겨라. 원문 결론의 방향("미루라/하지 마라")을 뒤집지 마라` 를 추가.
- `restoreLostHedges(before, after): Plan` (순수): 씬별로 원 내레이션에 유보 토큰이 있는데 압축본에 하나도 없으면 그 씬은 원 내레이션을 유지한다. 예산 초과분은 기존 결정적 트리밍이 마감한다.

(c) 발행면 표식 제거 — `src/output/naverBlog.ts`
- `stripInternalMarkers(md): string` (순수): `[근거: …]` 가운데 URL(`https?://`)이 없는 것을 제거(앞뒤 공백 정리), URL 이 있는 것은 `(출처: URL)` 로 바꾼다. `⚠️ 데이터 없음:` 으로 시작하는 줄(목록 항목 포함)은 줄째 제거한다.
- `bodyMarkdown`·`draft.md` 생성 시 적용한다. 파생·텔레그램 발췌는 `bodyMarkdown` 을 읽으므로 자동 반영된다.

## 7. 데이터 흐름(변경 후)

```
리서치팀 work ──(groundingLedger 기록)──▶ brief ──▶ research_brief.md
      │                                              │
      ▼                                              ▼
 토론 후 deliverable ──▶ verified 승격(원장 대조)   작가 writeBlogBody(forFacts 위키·voiceGuide·브리프)
                                                     │
                                                     ▼
                                     factGateBlog 1차 ──hold──▶ 수정 라운드(revise+브리프) ──▶ 2차
                                                     │
                                                     ▼
                                 fact_gate.json → piece.factGate → maybeAutoNaverDraft(hold면 건너뜀)
                                                     │                      │
                                                     ▼                      ▼
                                   텔레그램(보류 목록 동봉, 버튼 유지)   수동 임시저장 → 파생(parityIssues → 수정 라운드 → factGate 표시)
```

## 8. 오류 처리

- 게이트 LLM 실패: `status: 'error'` → 자동 경로는 hold 와 동일하게 차단(fail-closed), 텔레그램에 `사실 게이트 판정 실패` 표시. 런은 계속된다.
- 수정 라운드 작가 출력이 비거나 소제목이 없으면 1차 본문을 유지하고 2차 판정은 1차 결과를 재사용한다.
- `parityIssues`·`restoreLostHedges`·`stripInternalMarkers`·원장 기록은 전부 fail-open(기존 파이프라인 무중단).
- `fillDanglingFromSource` 는 백그라운드·무해(기존 maintain 과 동일).

## 9. 테스트

vitest 단위 테스트(순수 함수 우선, TDD):
- `factGate.test.ts`: `numericClaimSentences`(단위·월·절기·고유어 월), `buildEvidence` 머리말, hold 판정 조건, 결과 직렬화.
- `standaloneQa.test.ts`: `parityIssues` 프롬프트 조립(모델 게이트 시 빈 배열).
- `llmwiki.test.ts`: `provenanceLabel`, `forFacts` 제외·`maintain:auto` 감가, extract 프롬프트 문구, `fillDanglingFromSource` maxFill·offBrand 게이트.
- `groundingLedger.test.ts`: 기록·조회·상한. `workspace.test.ts`: `acceptVerifiedSource` 수락/거절 표(감사 사례: '동일', 위키 (종합), 성과, ⚠️ 미실측, 표 조각, 커넥터 라벨 일치, URL 일치).
- `shortsCommon.test.ts`: 단어 경계 절단. `shorts.test.ts`: `restoreLostHedges`, quote.source 대조, `applyShortsRevision` quote 편집.
- `naverBlog.test.ts`: `stripInternalMarkers` (URL 유무·데이터 없음 줄).
- `contentNotify.test.ts`: `blogReadyHtml` 보류 블록, 카드·쇼츠 캡션 보류 줄.
- `pieces`/main: `maybeAutoNaverDraft` 의 hold 분기는 순수 판정 함수 `autoDraftBlockedByFactGate(piece)` 로 분리해 테스트.

통합 확인: `pnpm typecheck`, `pnpm test`, 서버 재시작(유휴 시 `launchctl kickstart -k`) 후 자율 런 1편으로 `사실 게이트 —` 로그·`fact_gate.json`·텔레그램 메시지·자동 임시저장 건너뜀을 실측. `scripts/verified_cleanup.ts --dry-run` 결과 검토 후 실행·커밋.

## 10. 파일 목록

신규: `src/content/factGate.ts`(+test), `src/orchestrator/groundingLedger.ts`(+test), `scripts/verified_cleanup.ts`.
수정: `src/orchestrator/org.ts`, `src/orchestrator/agent.ts`, `src/orchestrator/finalize.ts`, `src/orchestrator/reflect.ts`, `src/orchestrator/standaloneQa.ts`, `src/orchestrator/cardnews.ts`, `src/orchestrator/shorts.ts`, `src/tools/shortsCommon.ts`, `src/wiki/llmwiki.ts`, `src/agents/workspace.ts`, `src/content/pieces.ts`, `src/content/cardnews.ts`, `src/content/shorts.ts`, `src/output/naverBlog.ts`, `src/autonomy/contentNotify.ts`, `src/server/main.ts`, `src/config.ts`, `data/company.yaml`, 관련 테스트.
