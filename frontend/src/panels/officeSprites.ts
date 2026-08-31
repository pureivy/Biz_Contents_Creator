// 오피스 뷰 스프라이트 — 참고 프로젝트(AI_Contents_Office/office-view)의 멀티포즈 아바타 재사용.
// 콘텐츠 역할 → 캐릭터 매핑 + 상태→포즈 선택(순수). 스프라이트는 /sprites/<char>_<pose>.png.
// 참고 엔진: sit/stand/walk 포즈, 좌향은 walkR/sit_right 를 좌우 반전(scaleX(-1))해 재사용.

export type Pose = "stand" | "sit_front" | "sit_right" | "lounge" | "walkF1" | "walkF2" | "walkR1" | "walkR2";

// 역할 id → 스프라이트 캐릭터(참고 아바타 세트). 캐릭터가 역할과 맞는 것으로 재사용.
// 페르소나 성별에 맞춘 캐릭터 배정(사용자 확정): 남성=김도현·정하람 / 여성=서다인·오세라·이수민·문하은 / 중성=한지원.
const ROLE_SPRITE: Record<string, string> = {
  ceo: "main",                  // 한지원 (중성 디렉터)
  content_lead: "blogger",      // 문하은 (여)
  perf_analyst: "analyst",      // 이수민 (여)
  reviewer: "reflect",          // 정하람 (남) — critic-fact 는 여성이라 남성 캐릭터 사용
  research_lead: "wiki-ingest", // 서다인 (여, 리서치·지식)
  trend_researcher: "cardnews", // 오세라 (여, 트렌드·크리에이티브)
  seo_strategist: "propose",    // 김도현 (남, 전략·제안)
  image_designer: "critic-platform", // 윤소이 (여, 이미지 디자이너 — 디지털 크리에이티브)
  cardnews_planner: "cardplanner",   // 송하영 (여, 카드뉴스 기획자 — gpt-image 생성 2포즈 세트)
  cardnews_designer: "carddesigner", // 민준호 (남, 카드 디자이너 — gpt-image 생성 2포즈 세트)
  shorts_writer: "shortswriter",     // 유하린 (여, 숏폼 작가 — gpt-image 생성 2포즈 세트)
  shorts_director: "shortsdirector", // 서준영 (남, 숏폼 영상 디렉터 — gpt-image 생성 2포즈 세트)
  jarvis: "jarvis",             // 자비스 — 2포즈 스프라이트(jarvis_stand/jarvis_sit_front) 사용(TWO_POSE_CHARS).
                                //   두 파일이 모두 없을 때만 '얼굴+SVG 정장' 폴백(OfficeView TwoPoseFigure).
  secretary: "jarvis",          // 자비스 로스터 정식 id — Avatar(직원 탭·타임라인)는 id 만으로 해석하므로 id 매핑 필수
};

/** 2포즈(stand/sit_front) 축약 캐릭터 — 9포즈 풀세트 없이 생성된 아바타. OfficeView 가 포즈를 둘로 접는다. */
export const TWO_POSE_CHARS = new Set(["jarvis", "cardplanner", "carddesigner", "shortswriter", "shortsdirector"]);

/** 역할 id/레벨/직무 → 스프라이트 캐릭터. 매칭 없으면 null(이모지 폴백). */
export function spriteFor(id = "", level = "", title = ""): string | null {
  if (ROLE_SPRITE[id]) return ROLE_SPRITE[id];
  const k = (id + " " + title).toLowerCase();
  if (level === "ceo" || /편집장|총괄|editor|chief/.test(k)) return "main";
  // 발행 담당(배도윤, 여) — content 규칙보다 먼저: 자동 생성 멤버 id(content_mN)에 'content' 가 들어가
  //   작가(blogger)와 같은 아바타로 떨어지는 것 방지(실사고: 배도윤·문하은 동일 아바타).
  if (/발행|퍼블리|publish/.test(k)) return "critic-fact";
  if (/작가|카피|content|writer|copy/.test(k)) return "blogger";
  if (/성과|분석|analyst|perf/.test(k)) return "analyst";
  if (/트렌드|trend/.test(k)) return "cardnews";                              // 트렌드(여) — research 규칙보다 먼저(trend_researcher 가로채임 방지)
  if (/디렉터|research_lead|리서치|wiki|사서/.test(k)) return "wiki-ingest";  // 리서치디렉터·지식(여)
  if (/seo|키워드|keyword|strategist/.test(k)) return "propose";              // SEO(남)
  if (/디자이너|이미지|일러스트|designer|image/.test(k)) return "critic-platform"; // 이미지 디자이너(여)
  if (/비서|자비스|jarvis|assistant/.test(k)) return "jarvis";                // 비서 — 원래 자비스 이미지
  if (/리뷰|팩트|검증|비평|review|critic|fact/.test(k)) return "reflect";     // 리뷰어(남)
  if (level === "lead") return "wiki-ingest";   // 미지 리드 폴백
  return null;
}

/**
 * 상태·이동 → 포즈 + 좌우반전. 참고 엔진 pose-selection 이식:
 *  - 이동 중: 아래로(정면) 이동이면 walkF 워크사이클, 그 외엔 walkR(좌향이면 반전).
 *  - 작업(책상): sit_front · 휴식: lounge · 그 외(회의·잡담·커피·통화·유휴): stand.
 */
export function poseFor(
  actKind: string, walking: boolean, movingDown: boolean, frame: 0 | 1, faceLeft: boolean,
  face: "up" | "down" | "left" | "right" = "down",
): { pose: Pose; flip: boolean } {
  if (walking) {
    if (movingDown) return { pose: frame ? "walkF2" : "walkF1", flip: false };
    return { pose: frame ? "walkR2" : "walkR1", flip: faceLeft };
  }
  if (actKind === "rest") return { pose: "lounge", flip: false };
  if (actKind === "work") {
    // 데스크 방향에 맞춰 착석 포즈 — 좌우 열은 측면 착석(sit_right, 한쪽은 반전), 상하 행은 정면.
    if (face === "left") return { pose: "sit_right", flip: true };   // 오른쪽 열(왼쪽을 봄)
    if (face === "right") return { pose: "sit_right", flip: false };  // 왼쪽 열(오른쪽을 봄)
    return { pose: "sit_front", flip: false };
  }
  return { pose: "stand", flip: false }; // chat/huddle/coffee/phone/idle
}
