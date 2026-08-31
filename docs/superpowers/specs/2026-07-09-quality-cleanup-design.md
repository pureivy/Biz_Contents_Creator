# 품질 후속 정리 사이클 설계

- 날짜: 2026-07-09
- 상태: 설계 승인됨(브레인스토밍 — 스코프 트리아지), 스펙 리뷰 대기
- 대상: AI_ContentsCreator (B) — 누적 비차단 후속 일괄 상환

## 1. 목표·트리아지

여러 사이클(씬 QA·데이터 시각화·I2V·유튜브 발행·성과 루프)에서 누적된 비차단 후속 중
**잠재 버그·실비용·과금 보호** 항목 10건을 4개 영역으로 묶어 상환한다. 신기능 없음 —
전 항목이 기존 동작의 하드닝·중복 상환이다.

**제외(사용자 승인·근거 원장 기록):** 유튜브 일일 업로드 카운터(볼륨 미달), force 재업로드
(케이스 없음), /api/* 미러(lite 사용 미확인), 앱 전체 CSRF(별도 사이클), anim JSDoc(취향),
resolveContentBrand(추측성). **⑤ Remotion 번들 캐싱 — 조사 후 제외 권고**: 커밋 4ccf9f0 이
동시 렌더 안전을 위해 번들 outDir 을 렌더별 격리했고, 캐싱은 공유 outDir(레이스) 또는
file:// 에셋(모션 렌더러 스펙이 안정성 사유로 기각) 을 요구 — 일 1~2편 볼륨에서 ~20초
절감 대비 위험 과다.

## 2. 영역 A — 비전 QA 공유화 (①②③)

### A-① 공유 헬퍼 + cardnews `r.ok` 수정
- 신설 `src/orchestrator/visionCommon.ts`:
  `stdModel()`, `visionCapable()`(표준 모델 `claude-` 프리픽스),
  `parseBadIndices(issues: unknown, key: string, count: number): number[]`
  (유효 1..count·중복 제거·정렬·`Math.floor` 방어 — 기존 `parseBadScenes` 일반화, key 로
  'scene'/'slide' 대응).
- `shortsSceneQa.ts`: 자체 `stdModel`/`visionCapable` 제거 → import.
  `parseBadScenes(issues, count)` 는 `parseBadIndices(issues, 'scene', count)` 위임 래퍼로
  **유지·export**(기존 테스트·소비 호환).
- `cardnews.ts`: 자체 `stdModel`/`visionCapable`(33~34행) 제거 → import(파일 내 다른 사용처도
  동일 의미이므로 안전 — 구현 시 grep 확인). QA 루프의 인라인 배드리스트 파싱(301~303행)을
  `parseBadIndices(qa?.issues, 'slide', slideMap.length)` 로 치환.
  retry `generateImagesForDraft` 결과에 `if (!r.ok) → 교체 스킵(로그)` 추가 —
  shortsSceneQa 와 동일한 스테일 매니페스트 방지(잠재 버그 수정).

### A-② 씬undefined 코스메틱 로그
`shortsSceneQa.ts` 의 `out.issues` 조립을 검증 후로 이동 — scene 값이 유효(1..count)한
항목만 `씬N: problem` 으로 포맷(현재는 원시 값이라 `씬undefined:` 가능).

### A-③ 리맵 순수 헬퍼
`shortsSceneQa.ts` 의 checked→origIndex 리맵을
`mapBadToOrig(bad: number[], checked: Array<{ origIndex: number }>): number[]` 순수 함수로
추출(visionCommon 아닌 shortsSceneQa 에 export — QA 전용) + 단위테스트(빈/경계/순서).

## 3. 영역 B — 폴백 TTS 이중합성 방지 (④)

`shortsRender.ts`(ffmpeg 폴백)의 씬 루프: `synthesize()` 호출 전에
`dir/remotion/narr_<NN>.mp3` 존재 시 그 파일을 `segments/narr_<NN>.mp3` 로 복사해 재사용
(Remotion 경로가 이미 합성한 TTS — 같은 잡의 같은 씬 배열이라 내레이션 동일).
없으면 현행 합성. 재사용 시 `issues` 에 기록하지 않음(정상 경로). 실비용 절감:
폴백 발생 잡에서 TTS 비용 1회분 제거.

## 4. 영역 C — I2V·시각화 하드닝 (⑥⑦⑧⑨)

### C-⑥ fal cancel_url
`shortsSceneClips.ts` `falQueueRun`: 큐 제출 응답의 `cancel_url` 보관(fal.run 호스트 검증
동일 적용). 타임아웃·취소·FAILED 로 throw 하기 직전 fire-and-forget
`void fetch(cancel_url, { method: 'PUT', headers }).catch(() => {})` — 서버측 잡 중단으로
과금 즉시 종료. cancel 실패는 무해(기존 동작과 동일).

### C-⑦ 다운로드 데드라인 통합
`i2vSceneClips` 씬 처리에서 **씬 단위 결합 시그널** 생성:
`const sceneSignal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);`
— `falQueueRun` 과 클립 다운로드 fetch 양쪽에 전달(120초 캡이 폴링+다운로드 전체를 커버).
`falQueueRun` 내부 deadline 은 폴링 슬립 탈출용으로 유지.

### C-⑧ videoSrc 분기 단위테스트
`shortsRenderRemotion.ts` 의 클립 스테이징 판정을
`resolveClipSrc(clip: string | null | undefined, nn: string): string | null`
(존재+파일존재 → `clip_<NN>.mp4`, 아니면 null — fs.existsSync 만 수행) 로 추출·export,
propScenes 는 이를 사용(복사는 기존 위치 유지). tmp 파일 픽스처로 단위테스트(존재/부재/null).

### C-⑨ stat.value 자릿수 상한
`shortsCommon.ts` `normalizeSceneKind` stat 분기에 `Math.abs(value) >= 1e12 → 강등` 추가
(12자리+ CountUp 패널 넘침 방지) + 테스트 1케이스.

## 5. 영역 D — 유튜브·성과 마이너 (⑩⑪)

### D-⑩ YT_REDIRECT 포트 파생
`server/main.ts`: `const YT_REDIRECT = \`http://127.0.0.1:${CONFIG.port}/youtube/oauth/callback\`;`
— PORT 변경 시 OAuth 가 조용히 깨지던 문제 해소. 스펙 부록 가이드(유튜브 발행 스펙 §9)에
"PORT 변경 시 구글 콘솔 리디렉션 URI 도 함께" 한 줄 추가.

### D-⑪ 성과·표시 마이너 4건
- **삭제영상 무한 due 캡**: `shortsPerfDue` 에 포기 지평 추가 — `now - t > days * 4 * 86_400_000`
  (측정창의 4배) 이면 미강화라도 `false`(영구 비공개/삭제 영상 포기 — 이후 공개 시 수동 재개는
  범위 밖). 기존 테스트 갱신 + 케이스 추가.
- **fmtCount 롤오버**: `ShortsView.tsx` — `n >= 9950` 이면 만 단위(9999→"1.0만"), 천 경계 동일
  원리(`n >= 950` 검토는 불요 — 1000 미만은 원값).
- **isSafeBrandSlug 재검증**: `shortsPerf.ts` `reinforceShorts` 에서
  `const brand = s.brand && isSafeBrandSlug(s.brand) ? s.brand : '';` 로 정규화해 사용
  (파일 경로 싱크 재검증 관례 정합 — strategy.ts 와 달리 throw 대신 범용 강등: 강화는 fail-open).
- **테스트 tmp 경로 병렬 충돌**: workspace·llmwiki 테스트 하네스 tmp 경로에 `-${process.pid}`
  접미(병렬 vitest 세션 충돌 방지).

## 6. 에러 처리·회귀

- 전 항목이 기존 fail-open/try-catch 구조 안의 수정 — 실패 시맨틱 불변.
- 회귀 가드: 기존 전체 스위트(350+) + 각 항목의 신규/갱신 테스트. cardnews·쇼츠 QA 는
  실런 없이 코드 리뷰+단위테스트로 검증(비전 호출 무변경 — 파싱·게이트만 이동).

## 7. 완료 기준

- 10건 전부 반영: visionCommon 공유(중복 제거 diff 로 확인), cardnews r.ok 가드,
  TTS 재사용(폴백 경로에서 synthesize 미호출 조건 확인), cancel_url·씬 시그널,
  resolveClipSrc·stat 상한·due 캡·fmtCount·slug 재검증·tmp pid — 각 테스트 통과.
- 전체 스위트·루트+remotion tsc 0·프론트 빌드 성공. 기존 동작 회귀 없음.
