// 새 프롬프트(specialty 노출 + 비서자가처리 + 팀장규칙) 직접 검증 — 서버 재시작 없이 jarvisChat() 호출.
import { jarvisChat } from '../src/jarvis/chat';

type C = [string, string, string]; // id, 발화, before(이전 결과)
const CASES: C[] = [
  // 결함 케이스(이전 오배정) — 개선 기대
  ['c04', '신규 직원 채용 공고 내고 노무 계약서 검토해줘', 'support_legal→support_m 기대'],
  ['g04', '감사 준비하고 인사 평가도 하고 계약서도 검토해줘', 'support_ops→support_lead 기대'],
  ['g05', '내 일정 정리하고 외부 미팅 좀 잡아줘', 'support_m→자가처리or support_lead 기대'],
  ['g06', '이 내용 받아적고 정리해서 메모로 남겨둬', 'support_m→자가처리 기대'],
  ['g12', '회계 마감하고 그 결과로 경영평가 지표까지 분석해줘', 'planning_strategy→support_m2 기대'],
  // 회귀 가드(이전 정답 유지해야)
  ['c01', '이번 분기 급여 대장하고 기금 회계 정리해줘', 'support_budget 유지'],
  ['c02', '전산 장비 교체하고 정보화 보안 점검 일정 잡아줘', 'planning_risk 유지'],
  ['c07', 'ESG 마케팅 캠페인 기획안 만들어줘', 'support_m2 유지'],
  ['c13', '전략기획팀 회의 소집하고 내년도 사업계획 방향 잡아줘', 'planning_lead 유지'],
  ['c15', '자비스', 'no-delegate 유지'],
  // 신규 회계 변별(재원별)
  ['n01', '일반회계 법인카드 불출 등록 처리해줘', 'support_budget 기대'],
  ['n02', '수탁사업 법인카드 등록하고 지출결의 정리해줘', 'support_m3 기대'],
];

for (const [id, msg, before] of CASES) {
  try {
    const t0 = Date.now();
    const r = await jarvisChat([{ role: 'user', content: msg }]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const a = r.delegate?.agent ?? '-';
    const d = r.delegate?.task ? 'Y' : 'N';
    console.log(`${id}  ${secs}s  del=${d}  agent=${a}\t:: ${msg.slice(0, 26)}  [${before}]`);
  } catch (e) {
    console.log(`${id}  ERROR ${(e as Error).message}`);
  }
}
