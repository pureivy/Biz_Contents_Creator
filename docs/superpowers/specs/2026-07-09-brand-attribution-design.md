# 성과 강화 산출물 브랜드 귀속 수정 설계

- 날짜: 2026-07-09
- 상태: 설계 승인됨(브레인스토밍), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 성과 강화 파이프라인(piece·쇼츠 공통)

## 1. 목표

성과 강화가 기록하는 **역할 메모리와 위키 페이지가 "틱 실행 시점의 활성 브랜드"가 아니라
"그 콘텐츠의 브랜드"에 귀속**되게 한다. 현재는 브랜드 A 콘텐츠의 교훈이 B 활성 중에
강화되면 B 의 메모리·위키에 적재된다 — 브랜드 격리 원칙([[brand-scoped-data-separation]],
사용자 확정 2026-07-06) 위배. piece(`reinforceFromPerformance`)와 쇼츠(`reinforceShorts`)
두 파이프라인의 공통 결함(쇼츠 성과 사이클 최종 리뷰에서 발견).

## 2. 확정된 결정 (브레인스토밍)

| 결정 | 선택 | 근거 |
|---|---|---|
| 방식 | **명시 brand 옵션 인자 + `llmWikiFor` 전용 접근자** | 기존 호출자(llmWiki 25곳·appendMemory 1곳) 무변경 — 파급 최소. `updateStrategy({brand})` 선례와 일치 |
| appendActivity | 무변경 | activity.log 는 브랜드 접미 없는 역할별 단일 파일(브랜드 무관 UI 피드) — 오귀속 자체가 없음 |
| reflect.ts 의 appendMemory | 무변경 | 자기 성찰은 런 실행 맥락에서 호출 — 그 시점 활성 브랜드가 곧 콘텐츠 브랜드(정상) |

## 3. 현재 상태 (기준선)

- `brandFileSuffix()`(src/content/brand.ts:72) = `activeBrandSlug() ? '-<slug>' : ''`.
- `appendMemory(id, insight)`(src/agents/workspace.ts:92) — `memory${brandFileSuffix()}.md` 에 기록
  (활성 브랜드 암묵 귀속). 비테스트 호출자 3곳: reflect.ts:49(정상), reinforce.ts:33(결함),
  shortsPerf.ts:88(결함).
- `llmWiki()`(src/wiki/llmwiki.ts:1010) — `brandFileSuffix()` 로 위키 디렉터리 해석
  (`data/wiki` | `data/wiki-<slug>`), 디렉터리 변경 시 인스턴스 스왑 캐시. 호출자 25곳.
- 강화 경로: `reinforceFromPerformance(pieceId, metrics)`(reinforce.ts:41) —
  `reinforceWriter(title, keyword, signal)` 내부에서 appendMemory + llmWiki().upsertPage.
  `reinforceShorts(s, m)`(shortsPerf.ts) — appendMemory ×2 역할 + llmWiki().upsertPage.
  두 경로 모두 콘텐츠 레코드(piece/short)에 `brand?: string` 존재.

## 4. 설계

### 4.1 `src/content/brand.ts` — 순수 접미 함수

```ts
/** 슬러그 → 브랜드 파일 접미(순수). undefined/''(범용) → ''. */
export function brandFileSuffixFor(slug: string | undefined): string {
  return slug ? `-${slug}` : '';
}
export function brandFileSuffix(): string { return brandFileSuffixFor(activeBrandSlug()); }
```
(기존 `brandFileSuffix()` 동작 바이트 동일 — 위임만.)

### 4.2 `src/agents/workspace.ts` — appendMemory 명시 brand

```ts
const memoryFile = (id: string, brand?: string): string =>
  path.join(dir(id), `memory${brand !== undefined ? brandFileSuffixFor(brand) : brandFileSuffix()}.md`);
export function appendMemory(id: string, insight: string, brand?: string): void { /* memoryFile(id, brand) 사용, 나머지 동일 */ }
```
- `brand` 미지정(undefined) = 현행(활성 브랜드) — 기존 호출자 무변경.
- `brand: ''` = 범용 파일에 명시 기록(콘텐츠가 범용일 때).
- `memoryArchiveFile` 등 다른 파일 헬퍼는 이 사이클 범위 밖(강화가 안 쓰는 경로).

### 4.3 `src/wiki/llmwiki.ts` — llmWikiFor

```ts
/** 명시 브랜드의 위키 인스턴스 — 강화 등 "콘텐츠 브랜드 ≠ 활성 브랜드" 일 수 있는 경로용. */
export function llmWikiFor(brand: string | undefined): LlmWiki {
  const suffix = brandFileSuffixFor(brand);
  const dir = suffix ? path.join(path.dirname(CONFIG.wikiDir), `${path.basename(CONFIG.wikiDir)}${suffix}`) : CONFIG.wikiDir;
  if (!_wiki || _wikiDir !== dir) { _wiki = new LlmWiki(dir); _wikiDir = dir; }
  return _wiki;
}
export function llmWiki(): LlmWiki { return llmWikiFor(activeBrandSlug() || undefined); }
```
(기존 인스턴스 스왑 캐시 재사용 — `llmWiki()` 동작 불변. 강화가 다른 브랜드 위키를 쓰고
나면 다음 `llmWiki()` 호출이 활성 브랜드로 다시 스왑 — 일일 틱 빈도라 스왑 비용 무해.)

### 4.4 강화 경로 2곳 — 콘텐츠 브랜드 전달

- `reinforce.ts`: `reinforceWriter(title, keyword, signal, brand: string | undefined)` 로 확장,
  내부 `appendMemory(writerId, ..., brand ?? '')`. `reinforceFromPerformance` 에서
  `reinforceWriter(piece.title, piece.keyword, signal, piece.brand)` + 위키는
  `llmWikiFor(piece.brand).upsertPage({...})`.
- `shortsPerf.ts` `reinforceShorts`: `appendMemory(role, ..., s.brand ?? '')` +
  `llmWikiFor(s.brand).upsertPage({...})`.
- 참고: `appendActivity` 호출은 그대로(§2).

## 5. 에러 처리

- 동작 변화는 "기록되는 파일/디렉터리"뿐 — 기존 try/catch(fail-open) 구조 불변.
- brand 슬러그는 콘텐츠 레코드에서 오므로(생성 시 `activeBrandSlug()` 저장) 추가 검증 불요.

## 6. 테스트

- 단위(vitest): ① `brandFileSuffixFor`(undefined → ''·'' → ''·'슬러그' → '-슬러그') 순수
  테스트. ② `appendMemory` 3-인자 직접 호출 1건 — 임시 데이터 디렉터리 하네스에서
  `appendMemory('x', '교훈', '브랜드A')` 후 `memory-브랜드A.md` 파일 존재·내용 검증
  (활성 브랜드는 다른 값으로 두어 오귀속 회귀를 잡는 형태).
- 회귀: brand 미전달 경로(reflect.ts·기존 25 llmWiki 호출자)는 바이트 동일. 기존 전체 스위트.

## 7. 의존성

- 없음(내부 리팩터). 강화 첫 발화까지 ≥7일 유예 내 배포되면 오염 0으로 시작.

## 8. 완료 기준

- 강화 산출물(역할 memory·위키 performance 페이지)이 활성 브랜드와 무관하게 **콘텐츠
  브랜드**의 파일/디렉터리에 기록된다(단위테스트로 파일 경로 검증).
- 기존 호출자(llmWiki 25곳·reflect.ts) 무변경·동작 불변. 전체 테스트·tsc 0.
