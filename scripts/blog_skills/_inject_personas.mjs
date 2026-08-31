// 페르소나 주입(1회성) — data/company.yaml + assets/company/company.yaml 의 content_lead·reviewer
// system_prompt 에 블로그 라이터/크리틱 규칙을 병합하고 툴을 grant 한다. YAML.stringify 로 안전 기록.
// node 가 이 파일 위치에서 상위로 node_modules/yaml 을 해석하므로 프로젝트 안에서 실행해야 한다.
//
// [실행 차단 — 2026-07-06] 전 역할 시스템 프롬프트가 Claude 기준으로 전면 재작성되어
// (company.yaml 참조), 이 스크립트의 내장 WRITER/CRITIC 은 구버전이다(이모지 사용 지시 등
// 현행 '이모지 0' 정책과 정면 모순). 재실행하면 신규 프롬프트를 구버전으로 덮어쓴다.
// 다시 쓰려면 아래 가드를 지우고 페르소나 원문을 현행 기준으로 갱신할 것.
console.error('[중단] _inject_personas.mjs 는 2026-07-06 프롬프트 전면 재작성 이전의 1회성 스크립트입니다.');
console.error('재실행하면 company.yaml 의 신규 시스템 프롬프트를 구버전으로 덮어씁니다. (가드 해제: 소스 참조)');
process.exit(1);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // AI_ContentsCreator/
const TARGETS = [
  path.join(ROOT, 'data', 'company.yaml'),
  path.join(ROOT, 'assets', 'company', 'company.yaml'),
];

const WRITER = `당신은 AI 콘텐츠 스튜디오의 수석 작가입니다. 리서치·SEO 브리프를 바탕으로 네이버 블로그(정보/하우투·리뷰) 본문을 독자가 끝까지 읽게 씁니다.

[문체] 1문장 40자 이내(모바일 가독성). 문단은 3~5문장으로 핵심→설명→예시 순. 능동태 우선("~할 수 있습니다"보다 "~하세요"). 자연스러운 구어체 혼용 허용. 구체적 수치로 신뢰를 준다.
[구조] 소제목은 H2(##)로 쓰고 앞에 관련 이모지 1개를 반드시 붙인다(예: "## ☕ 카페 창업, 혼자 시작하지 않아도 됩니다"). 소제목 바로 아래 핵심 문장 1개로 시작. 중요한 정보는 굵게. 실용 정보 리스트 항목엔 이모지 1개(📍주소·⏰시간·💰가격 등). 이미지가 필요한 자리는 "[IMAGE: 설명]" 마크업으로 표시. 마지막 CTA 문장엔 이모지 1~2개.
[SEO] 메인 키워드를 제목·첫 100자·소제목 최소 1곳에 자연스럽게 넣되 과최적화(키워드 남용)는 금지. 연관 키워드는 본문 전반에 분산.
[분량] 약 2500자(±20%, 2000~3000자, 공백 포함 한국어 글자 수). 태그 5~10개.
[금지] 사실 확인 안 된 수치·정책, 근거 없는 과장 수식("최고의"·"완벽한"), 개인정보 수집 유도, 특정 업체 광고성 내용.
[이미지] 초안의 [IMAGE:] 슬롯에 맞춰 image_generate 툴로 이미지를 생성할 수 있다(gpt-image-2, 승인 필요).`;

const CRITIC = `당신은 팩트체커·리뷰어이자 팀의 검증자입니다. 협업에서는 초안을 직접 쓰지 않고 팀원·작가의 산출물을 검증합니다 — 사실오류·출처누락·과장, 그리고 네이버 SEO 린트(제목 길이·키워드 배치·가독성·과최적화)를 점검하고 wiki에 결론을 기록합니다.

[7개 기준 채점, 각 0~10점] ①정확성 ②실용성 ③논리 ④가독성 ⑤차별성 ⑥SEO ⑦이모지 활용.
[이모지(10점 배분)] 소제목 이모지 4점(모든 소제목 이모지→4, 50% 이상→2, 없음→0), 실용 리스트 항목 이모지 3점, 마지막 CTA 이모지 3점. 같은 이모지 반복·문장 중간 삽입은 각 -1점.
[판정] 총점 49/70(70%) 이상이면 APPROVED, 미만이면 REVISION_NEEDED.
[피드백] 구체적·실행 가능하게. 나쁜 예: "가독성이 떨어집니다". 좋은 예: "3섹션 첫 문장이 65자로 깁니다. 두 문장으로 나눠주세요." 각 지적에 준수 가능한 대안을 함께 제시.
[원칙] 독립성(작가 의도 추정 말고 결과물만)·일관성·건설성. 소상공인 블로그 맥락으로 판단(학술 논문 기준 아님), 문턱은 합리적으로 엄격.`;

// role_id → { prompt?, addTools? }
const EDITS = {
  content_lead: { prompt: WRITER, addTools: ['image_generate'] },
  reviewer: { prompt: CRITIC },
  ceo: { addTools: ['blog_publish'], appendPrompt: '\n\n[발행] 최종 취합 후 blog_publish 툴로 네이버 블로그에 "임시저장(초안)"까지만 자동화한다(발행 버튼은 누르지 않음 — 사람이 검토 후 수동 발행). 발행 툴은 항상 승인 게이트를 거친다.' },
};

function allRoles(doc) {
  const out = [];
  if (doc.ceo) out.push(doc.ceo);
  for (const t of doc.teams ?? []) {
    if (t.lead) out.push(t.lead);
    for (const m of t.members ?? []) out.push(m);
  }
  return out;
}

function applyEdits(doc) {
  for (const r of allRoles(doc)) {
    const e = EDITS[r.id];
    if (!e) continue;
    if (e.prompt) r.system_prompt = e.prompt;
    if (e.appendPrompt) r.system_prompt = (r.system_prompt || '') + e.appendPrompt;
    if (e.addTools) {
      const cur = Array.isArray(r.tools) ? r.tools.map(String) : [];
      r.tools = [...new Set([...cur, ...e.addTools])];
    }
  }
}

let allOk = true;
for (const file of TARGETS) {
  if (!fs.existsSync(file)) { console.log(`SKIP(없음): ${file}`); continue; }
  const doc = YAML.parse(fs.readFileSync(file, 'utf-8')) || {};
  applyEdits(doc);
  const yaml = YAML.stringify(doc);
  // 재파싱 검증 + 길이 검증(sanitizeField 4000자 캡 미만 확인)
  const re = YAML.parse(yaml);
  const roles = allRoles(re);
  const cl = roles.find((r) => r.id === 'content_lead');
  const rv = roles.find((r) => r.id === 'reviewer');
  const ceo = roles.find((r) => r.id === 'ceo');
  const clLen = (cl?.system_prompt || '').length;
  const rvLen = (rv?.system_prompt || '').length;
  const ok =
    clLen > 400 && clLen < 4000 && (cl?.tools || []).includes('image_generate') &&
    rvLen > 400 && rvLen < 4000 &&
    (ceo?.tools || []).includes('blog_publish');
  allOk = allOk && ok;
  fs.writeFileSync(file, yaml, 'utf-8');
  console.log(`WROTE ${path.relative(ROOT, file)} — content_lead ${clLen}자(image_generate:${(cl?.tools||[]).includes('image_generate')}), reviewer ${rvLen}자, ceo blog_publish:${(ceo?.tools||[]).includes('blog_publish')} → ${ok ? 'OK' : 'FAIL'}`);
}
console.log(allOk ? 'ALL_OK' : 'SOME_FAIL');
process.exit(allOk ? 0 : 1);
