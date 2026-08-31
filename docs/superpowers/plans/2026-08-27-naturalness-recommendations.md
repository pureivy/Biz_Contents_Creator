# 말투 감사 권고 8건 이행 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or a Workflow running the same implement→review→fix loop). Tasks are sequential (shared tsx-watch server, shared prompt files).

**Goal:** 2026-08-27 말투 감사(보고서: scratchpad `naturalness/naturalness-report.md`, 아티팩트 86040322) 권고 8건을 전부 코드·설정에 반영한다 — 사용자 지시 "보고서에 나오는 권고 8건을 진행해줘".

**Architecture:** 프롬프트 지시문 수정(brand.ts·org.ts·shorts.ts·cardnews.ts·naverBlog.ts·main.ts) + 결정적 린트 확장(styleLint.ts, 블로그 연결) + 파생 정합 검사에 시기·수치 대조 추가 + 마무리·제목 로테이션(최근 N편 회피, 쇼츠 `recentHooksToAvoid` 패턴 재사용) + 골격 다양화(런별 구조 시드, 킬스위치) + brand.yaml 어휘 치환.

**Tech Stack:** TypeScript, vitest. 프롬프트 문자열은 한국어.

**Spec:** 보고서 §3(원인)·§6(권고) — 각 권고의 "무엇을/어디를"이 요구사항이다. 아래 태스크가 그것을 정확 값으로 옮긴다.

## Global Constraints

- 서버는 launchd `pnpm dev`(tsx watch): `src/` 저장 = 재시작 = 진행 중 런 사망. 자율 사이클은 컨트롤러가 꺼 둠. 매 저장·테스트 전 유휴 확인 `curl -s http://127.0.0.1:8787/runs | grep -c '"status":"running"'` → 0 AND `pgrep -f naver_publish.py` 비어 있음. `pnpm dev` 금지, 서버 POST 금지.
- `pnpm typecheck` + `pnpm test` green. `git add` 는 바꾼 파일만(`git add -A` 금지). `rm` 대신 `trash`.
- 커밋 트레일러 2줄 필수: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01HUSNN1pJkNxMnbvjqRHdmN`.
- **지켜야 할 자산(보고서 §5) — 절대 약화 금지**: 손·눈으로 확인하는 판단 동작 지시, 파는 쪽에 불리한 말(약통 열지 않기·올해 심은 나무 손대지 않기), 흔한 오진 차단, NO_FABRICATED_EXPERIENCE, 사실 게이트·사실 카드·유보어 규칙(org.ts:116/120 은 **상한만 추가**, 삭제 금지), 키워드 정확 표기 1회 규칙, 원예 상용어(전정·관수·도장지·시비 등) 과차단 금지.
- 린트는 **발행을 막지 않는다**: 실패 시 수정 라운드 1회 → 잔존은 로그+텔레그램 표시. 새 LLM 콜은 태스크당 명시된 수 이내.
- 모든 새 동작에 킬스위치(env, `.env.example` 문서화). 브랜드 격리 유지(brand.yaml 에 업종 어휘, 코드엔 넣지 않음).

---

### Task 1: 채널 간 시기·수치 대조(권고 1)

**Files:**
- Create: `src/content/timingParity.ts` (+ `timingParity.test.ts`)
- Modify: 파생 정합 검사 호출부 — `src/orchestrator/standaloneQa.ts`(`parityIssues` 계열)·`src/orchestrator/shorts.ts`·`src/orchestrator/cardnews.ts` 의 기존 정합 수정 라운드에 합류
- Modify: `src/autonomy/contentNotify.ts`(텔레그램 줄) — 기존 `factGateLines` 의 '원문 정합' 경로 재사용

**Requirements (exact):**
- `export function extractTimingNumbers(text: string): string[]` — 결정적 추출: 월(`\d{1,2}\s*월`, 고유어 월 정월~십이월), 절기명(입추·처서·백로·추분·한로·상강·입동·소설·대설·동지·소한·대한·입춘·우수·경칩·춘분·청명·곡우·입하·소만·망종·하지·소서·대서), 계절+시점(`(초|중|늦)?(봄|여름|가을|겨울)(초|중순|말)?` 는 제외 — 너무 일반), 숫자+단위(`\d+(?:[.,]\d+)?\s*(?:일|주|개월|년|회|번|배|도|℃|cm|m|kg|g|ml|리터|원|%|주일)`), 시각(`\d{1,2}\s*시`). 정규화: 공백 제거, `℃`→`도`, 고유어 월→숫자월(시월→10월).
- `export function timingParityIssues(sourceBody: string, derived: { field: string; text: string }[]): Array<{ field: string; token: string; text: string }>` — 파생 텍스트(내레이션·screenText·slides headline/body·caption·dataviz 오버레이 값)에 있는 토큰이 원문(정규화 집합)에 없으면 issue. 원문에 같은 **월**이 있으면 그 월은 통과(9월 vs 9월 중순 허용). 숫자는 반올림 허용 안 함(원문 20cm ↔ 파생 20cm 만 통과; 단 원문 "20~30cm" 범위 안의 값은 통과).
- 쇼츠 dataviz 오버레이(`kind: 'stat'` 씬의 수치 필드 — shorts 플랜 스키마에서 찾을 것)는 **결정적으로**: 값이 원문에 없으면 오버레이 자체를 제거하고 로그 `[숏폼] 오버레이 수치 원문 부재 → 제거 — "값"`.
- 이슈는 기존 파생 정합 수정 라운드(parity repair)에 문자열로 합류: `시기·수치 원문 불일치 — <field>: "<text>" (원문에 없는 <token>)`. 잔존 시 텔레그램 줄 `⚠ 원문과 다른 시기·수치 N건` + 최대 2줄 예시(기존 정합 표시와 같은 형식).
- 킬스위치 `TIMING_PARITY=off`(config `timingParity`, 기본 on). `.env.example` 문서화.
- 테스트: 추출(월·절기·단위·시각·고유어 월 정규화), 범위 통과, 월 부분 일치 통과, 원문 부재 토큰 검출, 오버레이 제거, off 시 빈 배열.

**Commit:** `feat(parity): 파생 콘텐츠 시기·수치 원문 대조 — 불일치는 정합 수정 라운드 합류·오버레이 수치는 원문 없으면 제거(TIMING_PARITY)`

---

### Task 2: 요약·설명 칸 메타투 금지(권고 2) + 검색어 규칙 통일(권고 7)

**Files:**
- Modify: `src/content/brand.ts:235`, `src/output/naverBlog.ts:24`, `src/orchestrator/shorts.ts:579`(설명 지시), `src/server/main.ts:2170`
- Modify: `src/content/styleLint.ts` — `export function metaSummaryIssues(text: string): string[]`
- Modify: 블로그 meta 생성부(`naverBlog.ts`)·쇼츠 설명 생성부 — 린트 실패 시 1회 재생성
- Test: `styleLint.test.ts`, `naverBlog.test.ts`

**Requirements (exact):**
- brand.ts:235 의 예시 `"정리했습니다/알아봅니다"처럼 블로그 말투로` → 삭제하고 대신: `메타 요약투 금지 — "정리했습니다/담았어요/알아봅니다/알아보세요/살펴봅니다/소개합니다" 로 요약·설명을 끝내지 마라. 요약·설명은 "결론 한 줄 + 조건 한 줄" 꼴로 쓴다(예: "잎이 상한 나무는 9월에 비료를 줘도 소용없습니다. 갈변이 어디서 시작됐는지부터 보세요.").`
- naverBlog.ts:24 meta 지시에 같은 금지·대체 형식 1문장 추가. shorts.ts description 지시에 동일 추가(설명이 캡션에 복제되므로 한 곳).
- `metaSummaryIssues`: 정규식 `(정리했습니다|정리했어요|담았습니다|담았어요|알아봅니다|알아보세요|살펴봅니다|살펴보세요|소개합니다|소개해요|함께 알아|~에 대해 알아)` 매치 시 이슈. 블로그 meta·쇼츠 description 생성 직후 검사 → 이슈면 같은 콜 1회 재시도(피드백 포함) → 잔존은 로그 `[메타] 요약투 잔존 — "..."`(발행 차단 없음).
- main.ts:2170 `본문 전체에 2~4회 정확히 이 표기로` → `첫 문단에 1회, 소제목 1곳까지만 정확히 이 표기로 — 그 밖에는 조사·어순을 바꾼 변형으로(네이버는 형태소 분석이라 손실 없음)`.
- 테스트: metaSummaryIssues 양성 4·음성 3(예: "정리한 뒤 심습니다" 는 통과), 재시도 1회 후 잔존 로그.

**Commit:** `fix(prompt): 요약·설명 메타투 금지+결론/조건 형식·린트 재시도, SEO 리비전 검색어 규칙을 본문 규칙과 통일`

---

### Task 3: 블로그 문체 린트 연결(권고 3)

**Files:**
- Modify: `src/content/styleLint.ts` — `export function blogStyleIssues(bodyMarkdown: string): string[]`
- Modify: `src/orchestrator/org.ts` `packageDesignFinalize` — 사실 게이트 **앞**에 린트 → 이슈면 `writeBlogBody` revise 1회(피드백 = 이슈 목록, `REVISE_NO_NEW_FACTS` 유지) → 재린트는 로그만
- Modify: `src/config.ts` `blogStyleLint: envBool('BLOG_STYLE_LINT', true)`, `.env.example`
- Test: `styleLint.test.ts`

**Requirements (exact):**
- 검사 4종(마크다운 표·코드·인용 마커는 벗기고 문장 단위로): ⓐ `(?:가|이|은|는|도)\s*아니라|보다\s*(?:는|도)?\s*` 대비문 3회 이상 → `대비문("A가 아니라 B") N회 — 2회 이하로` ⓑ 문장 종결 중 `습니다|입니다` 비율 > 0.60(문장 20개 이상일 때만) → `합쇼체 비율 N% — 60% 이하로(문단 통째로 말투를 정하라)` ⓒ 한 문장에 유보 표현 2개 이상(`대개|보통|흔히|대체로|대부분|경우가 많|수 있|로 봅니다|으로 봅니다|편입니다`) → `유보 중첩 — "문장"` (문장별) ⓓ 체크리스트/목록 줄(`^[-*]\s|^\d+\.\s|^>>>` 블록 내 줄)이 서술어 없이 끝남(끝이 `다|요|죠|까|세요|니다` 가 아니고 명사/구로 끝) → `명사형 종결 목록 — "줄"`(최대 3줄).
- 이슈 있으면 작가 revise 1회: 지시 `[문체 린트] 아래 지적만 고치고 사실·수치·구조는 그대로` + 이슈 목록. 재린트 결과는 로그 `[문체린트] 블로그 — 이슈 N → M(수정 1회)`; `fact_gate` 와 독립(린트가 본문을 바꾸면 사실 게이트는 그 뒤에 돈다 — 순서 보장).
- 텔레그램: 잔존 이슈 있으면 `✍ 문체 N건 잔존` 1줄(기존 검토 메시지에 추가, `factGateLines` 옆).
- 테스트: 4종 각 양성·음성, 원예 상용어("전정·관수") 미차단, 표/코드 블록 무시, 문장 20개 미만이면 ⓑ 생략.

**Commit:** `feat(style): 블로그 문체 린트 4종 + 수정 1회 연결(BLOG_STYLE_LINT) — 대비문·합쇼체 비율·유보 중첩·명사형 목록`

---

### Task 4: 마무리·제목 로테이션(권고 5) + 쇼츠 압축 안전선(권고 6)

**Files:**
- Modify: `src/orchestrator/cardnews.ts:264`(마무리 권유형 고정 해제), `src/orchestrator/shorts.ts:579`(제목 후보 유형)·`:565`(압축·월 표기)·`:374`(내레이션 위생), `src/content/shorts.ts:34`
- Modify: `src/orchestrator/cardnews.ts` — `recentEndingsToAvoid(brand, excludeId, limit=5)`(shorts.ts:397 `recentHooksToAvoid` 와 같은 구조: 최근 5세트의 마무리 장 headline/body + 캡션 마지막 줄)
- Modify: `src/orchestrator/org.ts` — 블로그 마무리 회피: `priorCoverage.ts` 에 최근 5편 마무리 문단 첫 문장 목록 주입(`recentBlogEndings(brand, limit=5)`)
- Modify: `src/content/styleLint.ts` — `screenTextLabelIssues(screenTexts: string[])`, `monthWordOutsideNarration(fields)`
- Test: `cardnews.test.ts`/`shorts.test.ts`(있으면) + `styleLint.test.ts`

**Requirements (exact):**
- 카드 마무리: `마무리 장은 권유형("-해 보세요")으로` → `마무리 장 유형은 [권유형 "-해 보세요" / 관찰 장면(손에 잡히는 한 장면) / 결론 단정 / 조건문 "~이면 ~합니다"] 중 최근 5세트에서 쓰지 않은 유형으로 — 아래 [최근 마무리] 와 같은 문형·같은 첫 어절 금지`. `recentEndingsToAvoid` 블록을 프롬프트에 주입(비어 있으면 생략).
- 쇼츠 제목 후보: `["정보형","후킹형","질문형"]` 고정 → 유형 풀 `[정보형, 후킹형, 질문형, 결론형("~은 ~입니다"), 장면형(손에 잡히는 한 장면)]` 에서 **런마다 3개를 고르되 질문형은 최근 3편 중 1편 이하**(`recentHooksToAvoid` 가 읽는 plan.json 의 `titles` 로 판단). `src/content/shorts.ts:34` 주석·타입 갱신(`titles: string[]` 유지).
- 블로그 마무리: org.ts 마무리 지시에 `[최근 마무리 문단 첫 문장 — 같은 문형 금지]` 블록(최근 5편, `data/sessions/<runId>/draft.md` 마지막 문단) 주입. 비어 있으면 생략.
- 쇼츠 압축 안전선: shorts.ts:565 지시에 추가 `압축 안전선: 40초에 맞추더라도 조사·주어는 남겨라("이 시기 질소 거름 주면" 금지 → "이 시기엔 질소 거름을 주면"). 앞 문장의 주어가 바뀌면 새 주어를 밝혀라. screenText 에 "정의·구분법·요약·정리" 같은 대본용 딱지를 쓰지 마라 — 화면에는 독자에게 하는 말만.` 고유어 월은 **내레이션에만**: `title·titles·description·screenText·hashtags 에는 숫자 월("9월")을 쓴다`. 결정적 정규화: 내레이션 외 필드의 고유어 월(정월 제외: 이월·삼월·사월·오월·유월·칠월·팔월·구월·시월·십일월·십이월)을 숫자월로 치환(단어 경계: 앞이 한글이 아니고 뒤가 `에|부터|까지|중|말|초|은|는|이|의|,|\s|$` 일 때만).
- `screenTextLabelIssues`: screenText 가 `(정의|구분법|구별법|요약|정리|핵심)$` 로 끝나는 명사구면 이슈 → 기존 쇼츠 수정 라운드에 합류(발행 차단 없음).
- 테스트: 유형 선택(질문형 상한), recentEndingsToAvoid 포맷, 월 치환 경계(이월 vs "이월된"), screenText 라벨 검출.

**Commit:** `feat(voice): 카드·블로그 마무리 로테이션(최근 5편 회피)+쇼츠 제목 유형 풀·질문형 상한, 쇼츠 압축 안전선·고유어 월 내레이션 한정·자막 딱지 린트`

---

### Task 5: 골격 다양화(권고 4) — 킬스위치 STRUCTURE_VARIETY

**Files:**
- Create: `src/content/structureSeed.ts` (+ test) — `export function pickStructureSeed(rand: () => number): StructureSeed`, `export function structureBlock(seed: StructureSeed): string`
- Modify: `src/orchestrator/org.ts` 작가 지시(`:126-132` 인용구·목록 자리 고정 문구), `src/orchestrator/cardnews.ts`(줄 수·해시태그 수), `src/orchestrator/shorts.ts`(씬 수)
- Modify: `src/config.ts` `structureVariety: envBool('STRUCTURE_VARIETY', true)`, `.env.example`
- Test: `structureSeed.test.ts`

**Requirements (exact):**
- `StructureSeed = { thesisQuote: 'none'|'after-hook'|'mid'|'before-close'; table: boolean; checklist: boolean; teaser: boolean; openers: 'scene'|'question'|'claim'|'contrast'; cardLines: 2|3|4|5; hashtags: number(10~15); shortsScenes: 4|5|6 }`. `pickStructureSeed` 는 `rand` 로 결정(테스트 가능): 선택 블록(표·체크리스트·예고) 중 **2개만 true**, `thesisQuote` 는 4값 균등, `openers` 는 4값 균등.
- org.ts: `">> "=따옴표: 글의 중심 명제 한 문장(글당 1곳, 도입 훅 직후가 최적)` → `(글당 0~1곳 — 아래 [이번 글 구조] 지시를 따른다)`; `">>> "=프레임 … 글당 1곳` → `(아래 [이번 글 구조] 에서 켜졌을 때만)`; 표·체크리스트·예고 문단도 시드에 따라 켜고 끔. `structureBlock(seed)` 를 작가 프롬프트에 `[이번 글 구조]` 로 주입: 도입 유형(장면/질문/주장/대비), 중심 명제 인용 위치, 표 유무, 체크리스트 유무, 예고 유무. 리비전 런은 **같은 시드**(`sessions/<runId>/structure.json` 에 저장·재사용).
- cardnews.ts: `body` 줄 수 지시를 `seed.cardLines`(2~5) 로, 해시태그 개수 `seed.hashtags`(10~15) 로. shorts.ts: 씬 수 `seed.shortsScenes`(4~6) — 40초 예산은 기존 트리밍이 보장.
- `STRUCTURE_VARIETY=off` 면 시드 고정(현재 기본: after-hook, table+checklist true, teaser 조건부, 4줄, 12개, 5씬) → 동작 불변.
- 테스트: 시드 분포(1000회 샘플에서 각 값 등장), 선택 블록 정확히 2개, off 고정값, structureBlock 문자열에 각 항목 포함, structure.json 재사용.

**Commit:** `feat(structure): 런별 구조 시드로 블로그·카드·쇼츠 골격 다양화(STRUCTURE_VARIETY) — 자리 고정 문구 제거, 리비전은 시드 승계`

---

### Task 6: 한자어 치환 목록(권고 8) — brand.yaml 양쪽

**Files:**
- Modify: `data/brand.yaml`(활성) 과 `data/brands/bionditree.yaml`(레지스트리) 의 `avoidJargon`(기존 형식을 그대로 따를 것 — 먼저 읽고 형식 확인)
- Test: 기존 lexicon 테스트가 있으면 치환 반영 확인 1건 추가(`src/content/brand.test.ts` 등)

**Requirements (exact):**
- 추가 10항목(정확히 이것만, 원예 상용어는 넣지 않는다): 흡즙 → 즙을 빨아 · 고착 → 한자리에 붙어 · 회차 → 이번 차례 · 미착근 → 뿌리를 아직 못 내림 · 부적합 → 쓰기 어렵다 · 완만히 → 느슨하게 옆으로 · 급수 → 물 주기 · 증발량 → 마르는 양 · 정지기 → 쉬는 철 · 확연히 → 눈에 띄게.
- 두 파일 모두 수정(한쪽만 고치면 무반영 — 08-14 전례). 서버 재시작 불필요(데이터 파일)이나 활성 파일이 재로드되는지 확인(로드 경로 grep) — 캐시가 있으면 보고서에 적시.
- 커밋은 이 두 파일만.

**Commit:** `data(brand): 톤에서 튀는 한자어 10개 우리말 치환(avoidJargon, 활성+레지스트리)`
