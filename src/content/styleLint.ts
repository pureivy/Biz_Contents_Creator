/**
 * 문체 결정적 린트(순수) — 3채널 자연스러움 감사(2026-08-11)에서 실측된 "AI 티" 지문을
 * 정규식으로 검출한다. 프롬프트 지시만으로는 샌다는 것이 실증됐기에(쇼츠 "새 가지" 지침 위반 실측)
 * 기존 단독 이해 검산(standaloneIssues)의 1회 수정 라운드에 얹는 2차 방어다. 전량 fail-open 성격:
 * 검출 결과는 수정 라운드 입력일 뿐 파이프라인을 막지 않는다. 자막·본문 원문에는 손대지 않는다.
 */

/** 문장 분리(대략) — 종결부호 기준. 한국어 구어 대본 검사용이라 정밀할 필요 없다. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** '-ㅂ니다/습니다' 계열 종결인가(마침표·물음표 허용). */
function endsHamnida(sentence: string): boolean {
  return /(?:니다)[.!?…]*$/.test(sentence.trim());
}

/**
 * 쇼츠 내레이션 문체 린트 — 실측 지문 4종.
 * ① 한 씬의 2문장 이상이 전부 '-ㅂ니다' 종결(어미 메트로놈, 171문장 중 62% 실측)
 * ② 훅 질문-반전 공식('~보셨나요?/~라고요? + 정작/사실/그럼 이미', 최근 15편 중 7편 실측)
 * ③ '새 가지'(숫자 '세 가지'로 들리는 발음 혼동 — 지침 존재·위반 실측)
 * ④ '~기 때문입니다' 2회 이상 / 'X가 아니라 Y' 재정의 문형 2회 이상(하우스 지문)
 * 반환 문구는 standaloneIssues 와 같은 "항목N: …" 꼴 — 같은 수정 라운드 프롬프트에 섞인다.
 */
export function narrationStyleIssues(narrations: string[]): string[] {
  const issues: string[] = [];
  narrations.forEach((n, i) => {
    const sents = splitSentences(n);
    if (sents.length >= 2 && sents.every(endsHamnida)) {
      issues.push(`항목${i + 1}: 두 문장이 모두 '-ㅂ니다'로 끝난다 — 한 문장을 '~요/~죠/~하세요' 등 다른 어미로 바꿔라`);
    }
    if (n.includes('새 가지')) {
      issues.push(`항목${i + 1}: '새 가지'는 낭독 시 숫자 '세 가지'로 들린다 — '새로 난 가지'처럼 풀어 써라`);
    }
  });
  const hook = narrations[0] ?? '';
  if (/(?:보셨나요|라고요|다고요|시나요)\?/.test(hook) && /(정작|사실|그럼 이미)/.test(hook)) {
    issues.push('항목1: 훅이 "질문+반전(정작/사실~)" 공식이다(최근 편 과다) — 단정 선언·구체 장면·숫자 제시 등 다른 유형으로 다시 써라');
  }
  const all = narrations.join('\n');
  if ((all.match(/기 때문입니다/g) ?? []).length >= 2) {
    issues.push("전체: '~기 때문입니다' 종결이 2회 이상이다 — 1회 이하로 줄이고 이유를 다른 꼴로 이어라");
  }
  if ((all.match(/[가이] 아니라/g) ?? []).length >= 2) {
    issues.push("전체: 'X가 아니라 Y' 재정의 문형이 2회 이상이다 — 1회 이하로 줄여라(하우스 상투)");
  }
  return issues.slice(0, 5);
}

/**
 * 훅 첫 2초 키워드 낭독 린트(순수) — 쇼츠 조회수 감사(2026-08-20) 실측: 최근 47편 중 17편이
 * 훅 첫 2초(TTS ≈12자)를 검색 키워드·상품명 낭독에 써서 추천 피드 이탈 요인이 됐다.
 * 검색 표기 노출은 제목·화면텍스트·캘리가 담당한다(사용자 확정 e72c6c0) — 낭독 훅만 검사한다.
 * 판정: 훅 '첫 문장'이 공백 제거 후 키워드로 '시작'할 때만 위반(startsWith). 부분 문자열 포함 검사는
 * "곶감나무"⊃"감나무" 오탐과, 지시 준수 대본('잠깐,'+뒷문장 키워드)을 벌주는 이중구속을 만든다(리뷰 실측).
 * 2자 미만 키워드는 통과. 회피 변형("자, 배롱나무…")은 프롬프트 지시가 담당한다 — 린트는 2차 방어일 뿐.
 */
export function hookKeywordLeadIssues(narrations: string[], keyword?: string): string[] {
  const hook = (narrations[0] ?? '').trim();
  const kw = (keyword ?? '').replace(/\s+/g, '');
  if (!hook || kw.length < 2) return [];
  const firstSentence = splitSentences(hook)[0] ?? hook;
  return firstSentence.replace(/\s+/g, '').startsWith(kw)
    ? [`항목1: 훅이 키워드 "${keyword}" 낭독으로 시작한다 — 첫 2초는 긴장·장면·숫자·상황 지목으로 열고, 키워드 명시는 훅 뒷문장 또는 씬2로 미뤄라`]
    : [];
}

/**
 * 카드뉴스 슬라이드 문체 린트 — 실측 지문 2종.
 * ① 같은 종결어미('-ㅂ니다')로 끝나는 장이 3장 연속(40장 중 36장 실측)
 * ② 'X가 아니라 Y' 재정의 문형 2회 이상
 * 검사 대상은 장의 마지막 줄(body 마지막 줄, 없으면 headline).
 */
export function cardStyleIssues(slides: Array<{ headline?: string; body?: string }>): string[] {
  const issues: string[] = [];
  const lastLines = slides.map((s) => {
    const body = (s.body ?? '').trim();
    const last = body.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    return last ?? (s.headline ?? '').trim();
  });
  let run = 0;
  for (let i = 0; i < lastLines.length; i++) {
    run = endsHamnida(lastLines[i]!) ? run + 1 : 0;
    if (run === 3) {
      issues.push(`항목${i - 1}~${i + 1}: 3장 연속 '-ㅂ니다' 종결이다 — 한 장은 질문·명사구·권유형으로 바꿔라`);
      break;
    }
  }
  const all = slides.map((s) => `${s.headline ?? ''}\n${s.body ?? ''}`).join('\n');
  if ((all.match(/[가이] 아니라/g) ?? []).length >= 2) {
    issues.push("전체: 'X가 아니라 Y' 재정의 문형이 2회 이상이다 — 1회 이하로 줄여라(하우스 상투)");
  }
  return issues.slice(0, 4);
}

/**
 * 요약·설명 메타투 린트(순수, 2026-08-27 말투 감사 권고 2) — 블로그 meta(검색 스니펫)와 쇼츠
 * description(유튜브 설명 = 인스타 캡션에 복제)이 "…를 정리했습니다"·"…에 대해 알아봅니다" 로
 * 끝나 채널 전체가 한 템플릿으로 읽혔다(실측). 요약·설명은 "결론 한 줄 + 조건 한 줄" 꼴이어야 한다.
 * 프롬프트(brand.ts 어휘 가드·naverBlog PACK_SYSTEM·쇼츠 기획)가 1차 방어, 여기가 결정적 2차 방어다.
 * 반환 문구는 블로그 meta 재시도 피드백과 쇼츠 수정 라운드(probs) 양쪽에 그대로 실린다 — 형식 하나.
 */
const META_SUMMARY_RE = /정리했습니다|정리했어요|담았습니다|담았어요|알아봅니다|알아보세요|살펴봅니다|살펴보세요|소개합니다|소개해요|함께 알아|에 대해 알아/g;

export function metaSummaryIssues(text: string): string[] {
  const hits = [...new Set((text ?? '').match(META_SUMMARY_RE) ?? [])];
  return hits.slice(0, 3).map((h) => `설명·요약 메타투 "${h}" — 요약·설명을 그 말로 끝내지 말고 "결론 한 줄 + 조건 한 줄" 꼴로 다시 써라`);
}

/**
 * 블로그 본문 문체 린트(순수, 2026-08-27 말투 감사 권고 3) — 쇼츠·카드에만 걸려 있던 결정적 문체 검사를
 * 본문에도 건다. 검사 4종(실코퍼스 209편 측정으로 경계를 잡았다 — task-3-report.md):
 *   ⓐ 대비문("A가 아니라 B"/"A보다는 B") 3회 이상 — 한 편에서 세 번 넘게 쓰면 하우스 상투로 읽힌다.
 *   ⓑ 합쇼체(습니다/입니다) 종결 비율 60% 초과(산문 20문장 이상일 때만) — 어미 메트로놈.
 *   ⓒ 한 문장에 유보 표현 2개 이상 — "대개 …경우가 많습니다" 꼴로 단정을 두 겹 피하는 문장.
 *   ⓓ 불릿·번호 목록 줄이 서술어 없이 명사로 끝남 — 사람 글은 목록도 말로 끝난다.
 *      (Fix wave 2026-08-27: '>>>' 프레임 줄은 제외 — 프레임 20자 규칙과 충돌. BLOG_LIST_RE 주석 참조.)
 * 검사 전 마크다운 껍데기(표·코드펜스·인용/목록 마커·헤더·강조)를 벗긴다.
 * 비차단 — 결과는 작가 수정 1회(org.ts packageDesignFinalize)의 피드백일 뿐 발행을 막지 않는다.
 * 킬스위치(BLOG_STYLE_LINT)는 호출부가 본다 — 이 모듈은 CONFIG 를 읽지 않는 순수 함수로 남긴다.
 */
/** ⓐ 대비문 — 조사('보다는'/'보다도')를 필수로 둔다. 계획서 원안(`보다\s*(?:는|도)?\s*`)은 조사 없는 일반
 * 비교("가지가 원줄기보다 굵어지면")까지 세어 실코퍼스 209편 중 144편(69%)이 이 가지 하나로 3회를 넘겼다
 * (조사 필수로 좁히면 0편, 대비문 전체 발동은 88%→41%). 지적 대상은 수사적 대비지 사실 비교가 아니다. */
const CONTRAST_RE = /(?:가|이|은|는|도)\s*아니라|보다\s*(?:는|도)\s*/g;
/** ⓒ 유보 표현 — 계획서 지정 목록 그대로. factGate.HEDGE_RE(판정 선분류)와는 목적이 달라 별개로 둔다. */
const BLOG_HEDGE_RE = /대개|보통|흔히|대체로|대부분|경우가 많|수 있|로 봅니다|으로 봅니다|편입니다/g;
/**
 * ⓓ 검사 대상 목록 줄 — 불릿·번호만. **네이버 인용 체크박스('>>>' 프레임)는 일부러 뺐다**(Fix wave 2026-08-27).
 * 프레임은 '각 줄 공백 포함 20자 이내'가 사용자 확정 규칙(2026-08-10, BLOG_BODY_GUIDE 리치 서식)이라
 * '줄마다 서술어를 붙여라'와 양립하지 않는다 — 실코퍼스 60편에서 ⓓ 적중 142건이 전부 '>>>' 줄이었고
 * (불릿·번호 적중 0), 수정 라운드는 STRUCTURE_KEEP_BLOCK('프레임은 초안에 있는 대로 두라') 때문에
 * 프레임을 유지한 채 줄만 늘려 렌더가 어색해졌다(발행 시 잘림은 없다 — QUOTE_LINE_CAP 은 줄 수 캡).
 * 규칙 우선순위를 프레임 폭 쪽으로 확정한 대가로 ⓓ 는 실코퍼스 기준 사실상 무발동이다(감수한 비용).
 * 뒤집으려면(프레임 20자 완화) 실제 발행 1편으로 종결형이 폭 안에 드는지 먼저 확인해야 한다.
 */
const BLOG_LIST_RE = /^\s*(?:[-*]\s+|\d+\.\s+)/;
/**
 * ⓑ 분모에서 뺄 비산문 줄 — 목록 + 프레임('>>>'). ⓓ 대상과 **별개 상수여야 한다**: 프레임 줄(20자 명사구)이
 * 산문 분모에 섞이면 합쇼체 비율이 구조적으로 희석돼, 아무도 요청하지 않은 ⓑ 약화가 된다.
 */
const BLOG_NONPROSE_RE = /^\s*(?:[-*]\s+|\d+\.\s+|>{3}\s*)/;
/** ⓓ 서술어 종결 — 끝 글자가 서술어 어미면 통과(세요·니다는 요·다에 포함되지만 계획서 표기를 그대로 둔다). */
const PREDICATE_END_RE = /(?:다|요|죠|까|세요|니다)$/;

export function blogStyleIssues(bodyMarkdown: string): string[] {
  const src = String(bodyMarkdown ?? '');
  if (!src.trim()) return [];
  const clipLine = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  // 표·코드펜스는 문체가 아니다(수치 표·명령어) — 벗기되 줄 구조는 유지한다(ⓓ가 줄 단위 검사).
  const lines = src.replace(/```[\s\S]*?```/g, '\n').split('\n').filter((l) => !/^\s*\|/.test(l));
  const isList = (l: string): boolean => BLOG_LIST_RE.test(l);
  const isProse = (l: string): boolean => !BLOG_NONPROSE_RE.test(l);
  // 인용 마커 제거는 '>' 깊이 전부(> · >> · >>>) — ⓐ·ⓒ 는 프레임 줄도 계속 본다(ⓓ 만 좁혔다).
  const plain = (l: string): string =>
    l.replace(BLOG_LIST_RE, '').replace(/^\s*>+\s*/, '').replace(/[*_`]/g, '').trim();
  // 헤더는 문장이 아니다(제목은 원래 명사형) — 4종 검사 모두에서 뺀다.
  const bodyLines = lines.filter((l) => !/^\s*#{1,6}\s/.test(l));
  // 문장 분리는 '줄 먼저, 그다음 종결부호' — 마침표 없는 목록 줄이 뒷 문장과 한 덩어리가 되는 것을 막는다.
  const sentencesOf = (ls: string[]): string[] => ls
    .map(plain).filter(Boolean)
    .flatMap((l) => l.split(/(?<=[.!?…])\s+/))
    .map((s) => s.trim()).filter(Boolean);
  const allSentences = sentencesOf(bodyLines);
  // ⓑ의 분모는 산문 문장만 — 명사로 끝나는 목록·프레임 줄을 분모에 넣으면 비율이 구조적으로 낮아져 검사가 죽는다.
  const proseSentences = sentencesOf(bodyLines.filter(isProse));

  const issues: string[] = [];
  const contrast = (bodyLines.map(plain).join('\n').match(CONTRAST_RE) ?? []).length;
  if (contrast >= 3) issues.push(`대비문("A가 아니라 B") ${contrast}회 — 2회 이하로`);
  if (proseSentences.length >= 20) {
    const ratio = proseSentences.filter((s) => /(?:습니다|입니다)[.!?…]*$/.test(s)).length / proseSentences.length;
    // 실코퍼스 209편 최대 59% — 60% 초과는 '지금보다 나빠지면 잡는' 상한 가드다(현행 중앙값 31%).
    if (ratio > 0.60) issues.push(`합쇼체 비율 ${Math.round(ratio * 100)}% — 60% 이하로(문단 통째로 말투를 정하라)`);
  }
  const hedgeStacked = allSentences.filter((s) => (s.match(BLOG_HEDGE_RE) ?? []).length >= 2);
  issues.push(...hedgeStacked.slice(0, 3).map((s) => `유보 중첩 — "${clipLine(s)}"`));
  const listItems: string[] = [];
  lines.forEach((l) => {
    if (!isList(l)) return;
    const t = plain(l);
    if (t) listItems.push(t);
  });
  const nounEnded = listItems.filter((t) => !PREDICATE_END_RE.test(t.replace(/[.!?…·,:;)"'\]]+$/, '')));
  // 길이 상한을 지적에 함께 싣는다 — 안 그러면 수정 라운드가 '서술어를 붙여라'만 읽고 줄을 길게 늘려
  // 목록 규칙('항목 3~5개, 각 1줄로 짧게', BLOG_BODY_GUIDE)과 충돌한다.
  issues.push(...nounEnded.slice(0, 3).map((t) => `명사형 종결 목록 — "${clipLine(t)}"(줄은 한 줄로 짧게 둔 채 서술어로만 맺어라)`));
  return issues;
}

/** 수정본이 원본의 몇 배 이하로 줄면 퇴화로 본다 — 문체 수정은 문장을 다듬는 일이라 분량은 거의 그대로다. */
const STYLE_REVISION_MIN_RATIO = 0.6;

/**
 * 문체 린트 수정본 채택 가드(Fix round 1) — 작가가 퇴화 응답("네, 고쳤습니다")을 내면 완성된 본문이 통째로
 * 그 답변으로 대체되던 결함을 막는다. 반환값은 폐기 사유(채택 가능하면 null)라 호출부가 로그에 사유를 적는다.
 *
 * 두 겹으로 본다.
 *  · 구조 — 원본에 소제목(H2+)이 있었으면 수정본에도 있어야 한다. 원본에 없었으면 요구하지 않는다(소제목 없는
 *    짧은 본문의 정상 수정본을 헛되이 버리지 않으려는 것 — 대신 그 경우는 분량 바닥이 유일한 방어다).
 *  · 분량 — 원본의 60% 미만이면 폐기. **구조 검사만으로는 못 막는 경로가 있다**: 원본에 H2 가 없으면 구조
 *    가지는 통과라, 짧은 메타 답변을 걸러 내는 것은 이 바닥뿐이다. 지우지 말 것.
 * 형제 경로(사실 게이트 작가 재작성)는 factGate.ts 의 `if (!repaired || !/^#{2,}\s/m.test(repaired))` 가 같은
 * 일을 더 엄격하게(항상 H2 요구) 한다 — 게이트는 판정 뒤 재작성이라 원본 구조가 보장된 자리라서 그렇다.
 */
export function styleRevisionReject(original: string, revised: string): '빈 응답' | '구조 손실' | '분량 급감' | null {
  const rev = String(revised ?? '').trim();
  if (!rev) return '빈 응답';
  const orig = String(original ?? '').trim();
  const hasH2 = (s: string): boolean => /^#{2,}\s/m.test(s);
  if (hasH2(orig) && !hasH2(rev)) return '구조 손실';
  if (rev.length < orig.length * STYLE_REVISION_MIN_RATIO) return '분량 급감';
  return null;
}

/**
 * 자막 대본 딱지 린트(순수, 2026-08-27 말투 감사 권고 5) — screenText 는 시청자에게 보여 주는 '말'인데,
 * 대본 구조 라벨("정의"·"구분법"·"요약"·"정리"·"핵심")이 그대로 화면에 올라간 실측이 있었다. 목차 딱지가
 * 붙으면 영상이 강의 슬라이드처럼 읽힌다. 그 라벨로 **끝나는** 명사구만 잡는다 — "정리한 뒤 심으세요"
 * 처럼 서술어로 이어지는 자막은 정상이라 통과한다(원예 상용어 과차단 금지 원칙).
 * 명사구 가드 2겹(실데이터 808건 실측, 2026-08-27 리뷰) — 접미 정규식만으로는 적중의 과반이 오탐이었다:
 *   (a) 주격·주제격 조사 뒤의 라벨은 서술형 주장이다("물주기 간격**이** 핵심" = 독자에게 하는 말, 목차 딱지 아님).
 *   (b) "가지/눈/순/잎/열매/알/뿌리 + 정리"는 전정·눈따기를 뜻하는 원예 상용어다("속가지 정리").
 * 비차단: 결과는 쇼츠 수정 라운드(probs)의 입력일 뿐 발행을 막지 않는다. 단 오탐 1건이면 멀쩡한 플랜이
 * 재생성 라운드를 한 번 더 돌므로(비용·변형 위험) 가드를 앞에 둔다.
 */
const SCREEN_LABEL_RE = /(정의|구분법|구별법|요약|정리|핵심)$/;
/** (a) 서술형 주장 — 조사 뒤 라벨. */
const SCREEN_LABEL_PREDICATIVE_RE = /(?:이|가|은|는|도)\s+(?:정의|구분법|구별법|요약|정리|핵심)$/;
/** (b) 원예 행위어 — 'X 정리'(가지 정리=전정). */
const SCREEN_LABEL_HORTI_RE = /(?:가지|순|잎|열매|알|눈|뿌리)\s*정리$/;

export function screenTextLabelIssues(screenTexts: string[]): string[] {
  const issues: string[] = [];
  screenTexts.forEach((t, i) => {
    const s = String(t ?? '').trim().replace(/[.!?…:·,]+$/, '');
    if (SCREEN_LABEL_PREDICATIVE_RE.test(s)) return;
    if (SCREEN_LABEL_HORTI_RE.test(s)) return;
    if (!s || !SCREEN_LABEL_RE.test(s)) return;
    issues.push(`항목${i + 1}: 자막 "${s}" 는 대본용 딱지다 — 화면에는 독자에게 하는 말만 써라(예: "잎 끝부터 봅니다")`);
  });
  return issues.slice(0, 3);
}

/**
 * 고유어 월 → 숫자 월(순수·결정적, 2026-08-27 권고 5) — 고유어 월("시월")은 TTS 낭독 교정(fixMonthNames)
 * 이라 **내레이션에만** 유효하다. title·titles·description·screenText·hashtags 에 새면 검색 표기가 깨지고
 * (유튜브 제목·해시태그는 검색 노출 자산) 화면 글자가 낯설게 읽힌다. 프롬프트 지시는 새므로 여기서 결정적으로 되돌린다.
 * 경계 두 겹 — 앞 글자가 한글이면 치환하지 않고(다른 낱말의 꼬리를 자르지 않는다), 뒤는 조사·구분자·문말만 허용한다:
 *   "이월된 재고"(그대로) vs "이월에 심는다"(→2월). 목록은 긴 것부터 둬 "십이월"이 "이월"로 쪼개지지 않게 한다.
 * '정월'은 뜻이 1월과 어긋나는 관용어(정월 대보름)라 목록에서 뺀다.
 */
const MONTH_WORD_RE =
  /(?<![가-힣])(십이월|십일월|시월|구월|팔월|칠월|유월|오월|사월|삼월|이월)(?=에|부터|까지|중|말|초|은|는|이|의|,|\s|$)/g;
const MONTH_NUM: Record<string, string> = {
  이월: '2월', 삼월: '3월', 사월: '4월', 오월: '5월', 유월: '6월', 칠월: '7월',
  팔월: '8월', 구월: '9월', 시월: '10월', 십일월: '11월', 십이월: '12월',
};

export function monthWordOutsideNarration(field: string): string {
  return String(field ?? '').replace(MONTH_WORD_RE, (m) => MONTH_NUM[m] ?? m);
}
