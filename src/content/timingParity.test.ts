import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONFIG } from '../config';
import {
  extractTimingNumbers, timingParityIssues, formatTimingIssue, stripUnsourcedStatOverlays,
} from './timingParity';

// CONFIG 는 런타임 가변 객체(readonly 는 타입 힌트일 뿐) — 킬스위치 테스트에서 강제하고 복원한다.
const cfg = CONFIG as unknown as { timingParity: boolean };
let orig: boolean;
beforeEach(() => { orig = cfg.timingParity; cfg.timingParity = true; });
afterEach(() => { cfg.timingParity = orig; });

describe('extractTimingNumbers — 결정적 추출·정규화', () => {
  it('월(숫자·고유어)을 숫자월로 정규화한다', () => {
    expect(extractTimingNumbers('9월 중순에 심습니다')).toContain('9월');
    expect(extractTimingNumbers('10 월에는 늦습니다')).toContain('10월'); // 공백 제거
    expect(extractTimingNumbers('시월에 심으세요')).toContain('10월');   // 고유어 → 숫자월
    expect(extractTimingNumbers('유월 장마')).toContain('6월');
    expect(extractTimingNumbers('정월 대보름')).toContain('1월');
    expect(extractTimingNumbers('십이월 한파')).toContain('12월');
  });
  it('절기명을 뽑는다', () => {
    expect(extractTimingNumbers('처서가 지나면')).toContain('처서');
    expect(extractTimingNumbers('입동 전에 마칩니다')).toContain('입동');
    expect(extractTimingNumbers('곡우 무렵')).toContain('곡우');
  });
  it('숫자+단위를 뽑고 ℃ 는 도로 정규화한다', () => {
    expect(extractTimingNumbers('깊이 20cm 로 팝니다')).toContain('20cm');
    expect(extractTimingNumbers('영하 10℃ 까지')).toContain('10도');
    expect(extractTimingNumbers('3개월 뒤')).toContain('3개월');
    expect(extractTimingNumbers('물 2리터')).toContain('2리터');
    expect(extractTimingNumbers('30% 정도')).toContain('30%');
  });
  it('단위 교대 순서 — 주일/주, ml/m 가 짧은 쪽으로 잘리지 않는다', () => {
    expect(extractTimingNumbers('2주일 간격')).toEqual(['2주일']);
    expect(extractTimingNumbers('2주 간격')).toEqual(['2주']);
    expect(extractTimingNumbers('50ml 씩')).toEqual(['50ml']);
    expect(extractTimingNumbers('간격 3m 확보')).toEqual(['3m']);
  });
  it('시각을 뽑되 시간(기간)은 시각으로 오인하지 않는다', () => {
    expect(extractTimingNumbers('오전 9시에 관수')).toContain('9시');
    expect(extractTimingNumbers('3시간 담가둡니다')).not.toContain('3시');
  });
  it('절기와 형태가 겹치는 상용어를 절기로 오인하지 않는다(하지만·하지 마세요·~에 대한·대한민국)', () => {
    expect(extractTimingNumbers('물을 주지 하지만 과습은 주의')).toEqual([]);
    expect(extractTimingNumbers('지금 옮기지 하지 마세요')).toEqual([]);
    expect(extractTimingNumbers('묘목에 대한 오해')).toEqual([]);
    expect(extractTimingNumbers('대한민국 어디서나')).toEqual([]);
    expect(extractTimingNumbers('필요하지 않습니다')).toEqual([]);
    expect(extractTimingNumbers('하지가 지나면 장마')).toContain('하지'); // 진짜 절기 용례는 살린다
  });
  it('천 단위 쉼표는 매치 전에 지운다(1,200,000원 이 200000원으로 잘리지 않는다)', () => {
    expect(extractTimingNumbers('1,200원 안팎')).toEqual(['1200원']);
    expect(extractTimingNumbers('1200원 안팎')).toEqual(['1200원']);
    expect(extractTimingNumbers('1,200,000원 안팎')).toEqual(['1200000원']); // Fix round 1
  });
  it('절기 뒤 공백은 시간 문맥어일 때만 인정한다(무렵·즈음·경·쯤)', () => {
    for (const tail of ['무렵', '즈음', '경', '쯤']) expect(extractTimingNumbers(`처서 ${tail}에 옮깁니다`)).toContain('처서');
    expect(extractTimingNumbers('처서부터 아침이 서늘합니다')).toContain('처서'); // 붙여 써도 같은 가지
    expect(extractTimingNumbers('절기상 처서.')).toContain('처서');               // 문장부호 = 구절 끝
    // 실코퍼스에서 실제로 온 꼬리 — 이게 빠지면 파생물의 절기가 사라져 원문 대조가 비대칭이 된다.
    expect(extractTimingNumbers('처서 뒤 심는 법')).toContain('처서');
    expect(extractTimingNumbers('추분 뒤에 실행합니다')).toContain('추분');
    expect(extractTimingNumbers('입추 직후에 자릅니다')).toContain('입추');
    expect(extractTimingNumbers('입추 지났다면 늦습니다')).toContain('입추');
  });
  it('공백 뒤에 일반 명사가 오면 절기로 읽지 않는다(묘목 입하 소식·우수 개체) — Fix round 1', () => {
    expect(extractTimingNumbers('묘목 입하 소식을 기다립니다')).toEqual([]);
    expect(extractTimingNumbers('우수 개체를 고르세요')).toEqual([]);
    expect(extractTimingNumbers('우수수 떨어지는 잎')).toEqual([]);
  });
  it('고유어 월은 낱말 경계 안에서만 숫자월이 된다(이월 vs 이월된) — Fix round 1', () => {
    expect(extractTimingNumbers('이월에서 삼월 사이')).toEqual(['2월', '3월']);
    expect(extractTimingNumbers('이월된 묘목은 값이 쌉니다')).toEqual([]);
    expect(extractTimingNumbers('재고 이월분 정리')).toEqual([]);
    expect(extractTimingNumbers('팔월엔 물주기를 넉넉히')).toEqual(['8월']);   // 실코퍼스 회귀: 조사 '엔'
    expect(extractTimingNumbers('구월입니다')).toEqual(['9월']);
    // 붙여 쓴 겹월은 앞 경계에 걸려 하나도 안 잡는다 — 종전처럼 뒤쪽만 잡히면 원문·파생이 비대칭이 된다.
    expect(extractTimingNumbers('지금 팔구월엔 세게 자르지 마세요')).toEqual([]);
  });
  it('숫자와 단위 사이 공백은 줄을 넘지 않는다 — 실측 FP: "4.5~5.5\\n일반 흙" → "5.5일"(Fix round 1)', () => {
    expect(extractTimingNumbers('적정 pH는 4.5~5.5\n일반 흙은 안 맞습니다')).toEqual([]);
    expect(extractTimingNumbers('물은 5\n일에 한 번')).toEqual([]);
    expect(extractTimingNumbers('물은 5 일에 한 번')).toEqual(['5일']); // 같은 줄 공백은 그대로 흡수
  });
  it('계절+시점은 너무 일반이라 뽑지 않는다', () => {
    expect(extractTimingNumbers('늦가을에 심습니다')).toEqual([]);
    expect(extractTimingNumbers('초봄이 좋습니다')).toEqual([]);
  });
  it('같은 토큰은 한 번만(중복 제거)', () => {
    expect(extractTimingNumbers('9월, 그리고 9월 말')).toEqual(['9월']);
  });
});

describe('timingParityIssues — 원문 대조', () => {
  const src = '## 심는 시기\n적기는 봄입니다. 9월에는 뿌리만 확인하세요. 구덩이는 20~30cm 깊이로 팝니다.';

  it('원문에 없는 토큰을 field·token·text 로 보고한다', () => {
    const issues = timingParityIssues(src, [{ field: '씬2 내레이션', text: '8월이 심기 좋은 때예요' }]);
    expect(issues).toEqual([{ field: '씬2 내레이션', token: '8월', text: '8월이 심기 좋은 때예요' }]);
  });
  it('원문에 같은 월이 있으면 통과한다(9월 vs 9월 중순)', () => {
    expect(timingParityIssues(src, [{ field: '자막', text: '9월 중순이 기준' }])).toEqual([]);
  });
  it('원문 범위 안의 값은 통과, 밖의 값은 검출(반올림은 인정하지 않는다)', () => {
    expect(timingParityIssues(src, [{ field: '본문', text: '25cm 깊이' }])).toEqual([]);
    expect(timingParityIssues(src, [{ field: '본문', text: '40cm 깊이' }])[0]?.token).toBe('40cm');
  });
  it('여러 파생 필드를 각각 대조하고 같은 field·token 중복은 접는다', () => {
    const issues = timingParityIssues(src, [
      { field: '씬1', text: '8월입니다. 8월이요.' },
      { field: '씬2', text: '처서 무렵' },
    ]);
    expect(issues.map((i) => `${i.field}/${i.token}`)).toEqual(['씬1/8월', '씬2/처서']);
  });
  // 추출을 좁히면 원문 쪽 인식도 같이 좁아진다 — 그 비대칭이 곧 가짜 지적이라 양쪽을 함께 고정한다(Fix round 1).
  it('원문의 문장부호 끝 절기와 파생의 "처서 무렵"이 어긋나지 않는다(추출 좁힘의 대칭성)', () => {
    expect(timingParityIssues('절기상 처서.', [{ field: '자막', text: '처서 무렵' }])).toEqual([]);
  });
  it('공백 뒤 일반 명사는 파생에서도 절기가 아니라 가짜 지적이 없다', () => {
    expect(timingParityIssues('9월에 심습니다', [{ field: '자막', text: '묘목 입하 소식' }])).toEqual([]);
  });
  it('TIMING_PARITY=off 면 빈 배열', () => {
    cfg.timingParity = false;
    expect(timingParityIssues(src, [{ field: '씬1', text: '8월이 적기' }])).toEqual([]);
  });
  it('원문이 비면 검사하지 않는다(파생이 아닌 단독 생성)', () => {
    expect(timingParityIssues('', [{ field: '씬1', text: '8월이 적기' }])).toEqual([]);
  });
  it('formatTimingIssue 는 수정 라운드용 한 줄을 만든다', () => {
    expect(formatTimingIssue({ field: '씬2 내레이션', token: '8월', text: '8월이 적기' }))
      .toBe('시기·수치 원문 불일치 — 씬2 내레이션: "8월이 적기" (원문에 없는 8월)');
  });
});

describe('stripUnsourcedStatOverlays — stat 오버레이 결정적 제거', () => {
  const src = '적기는 봄입니다. 9월에는 뿌리만 확인하세요.';

  it('원문에 없는 수치는 오버레이(kind·stat)를 통째로 제거하고 값을 보고한다', () => {
    const scenes = [
      { kind: 'stat' as const, stat: { value: 8, unit: '월', label: '낙엽수 식재 시작' } },
      { kind: 'stat' as const, stat: { value: 9, unit: '월', label: '뿌리 확인' } },
    ];
    const r = stripUnsourcedStatOverlays(scenes, src);
    expect(r.removed).toEqual(['8월']);
    expect(r.scenes[0]).toEqual({});            // {} 강등 — normalizeSceneKind 와 같은 표현
    expect(r.scenes[1]).toEqual(scenes[1]);     // 원문에 있는 9월은 유지
  });
  it('내레이션·자막 등 다른 필드는 보존한다', () => {
    const scenes = [{ narration: '지금이 적기', screenText: '적기', kind: 'stat' as const, stat: { value: 8, unit: '월' } }];
    expect(stripUnsourcedStatOverlays(scenes, src).scenes[0]).toEqual({ narration: '지금이 적기', screenText: '적기' });
  });
  it('단위 없는 자명한 숫자(단계 수·항목 수)는 대조 불가라 건드리지 않는다', () => {
    const scenes = [{ kind: 'stat' as const, stat: { value: 3, label: '단계' } }];
    expect(stripUnsourcedStatOverlays(scenes, src).removed).toEqual([]);
  });
  it('stat 이 아닌 kind 는 결정적 제거 대상이 아니다', () => {
    const scenes = [{ kind: 'chart' as const, chart: { series: [{ label: '봄', value: 90 }, { label: '가을', value: 70 }] } }];
    expect(stripUnsourcedStatOverlays(scenes, src).removed).toEqual([]);
  });
  it('TIMING_PARITY=off 면 제거도 하지 않는다', () => {
    cfg.timingParity = false;
    const scenes = [{ kind: 'stat' as const, stat: { value: 8, unit: '월' } }];
    const r = stripUnsourcedStatOverlays(scenes, src);
    expect(r.removed).toEqual([]);
    expect(r.scenes[0]).toEqual(scenes[0]);
  });
  it('원문이 비면 제거하지 않는다', () => {
    const scenes = [{ kind: 'stat' as const, stat: { value: 8, unit: '월' } }];
    expect(stripUnsourcedStatOverlays(scenes, '').removed).toEqual([]);
  });
});

// 실사고(활엽수 편, 2026-08-27)의 **실데이터**로 확인한 이 축의 경계 — 사고 재현이 아니라 반증이다.
// 원문: data/sessions/370d4a20682a/draft.json 의 bodyMarkdown 58·60·62·66 행 그대로.
// 파생: data/shorts/short_4c0b420c51/plan.json 의 씬5(내레이션·자막·stat 오버레이) 그대로.
// 원문 66 행에 "8월"이 실제로 있으므로(값은 같고 주장만 뒤집혔다) 토큰 존재 대조는 아무것도 잡지 못하고
// 오버레이도 남는다. 이 절반은 구조적으로 LLM 정합 축(parityIssues)의 몫인데, 이 조각에서는 그쪽도
// 침묵했다(레코드 factGate: null). 권고 1 은 이 태스크로 닫히지 않았다 — task-1-report.md 의 Fix round 참고.
describe('활엽수 편 실데이터 — 토큰 대조의 구조적 경계(권고 1 잔여 갭)', () => {
  const blog = [
    '먼저 사실부터 짚습니다. 나무 심는 적기는 보통 봄, 3월 중순에서 4월 중순으로 봅니다. 조림 지침이 제시하는 기준도 봄이에요. 가을이 봄보다 낫다고 말할 근거는 확실치 않습니다.',
    '그럼에도 잎을 떨구는 활엽수에 한해 가을이 선택지가 되는 이유는 단순합니다. 잎을 다 떨군 나무는 잎으로 나가는 수분 손실이 줄거든요. 심고 나서 뿌리가 자리 잡는 동안 나무가 견뎌야 할 부담도 그만큼 가벼워집니다.',
    '> 겨울에도 잎을 달고 있는 나무는 이 논리가 통하지 않습니다. 상록수와 침엽수를 낙엽 활엽수와 같은 시점에 심지 마세요.',
    '그래서 8월 말에 할 일은 심기가 아니라 정하기입니다. 어느 칸의 나무를 살지, 그 나무를 마당 어디에 둘지를 이번 달에 결론 냅니다.',
  ].join('\n\n');
  const scene5 = {
    narration: '잎 지는 나무는 지금이 심기 좋은 때예요. 물 손실이 적어 뿌리내리기 수월해요.',
    screenText: '낙엽나무는 지금 적기',
    kind: 'stat' as const,
    stat: { value: 8, unit: '월', label: '낙엽수 식재 시작' },
  };

  it('원문에 8월이 있어 지적이 하나도 나오지 않는다 — 이 사고는 이 축으로 안 잡힌다', () => {
    expect(extractTimingNumbers(blog)).toEqual(['3월', '4월', '8월']);
    expect(timingParityIssues(blog, [
      { field: '씬5 내레이션', text: scene5.narration },
      { field: '씬5 자막', text: scene5.screenText },
      { field: '씬5 오버레이', text: `${scene5.stat.value}${scene5.stat.unit} ${scene5.stat.label}` },
    ])).toEqual([]);
  });
  it('오버레이 8월도 제거되지 않고 그대로 남는다', () => {
    const r = stripUnsourcedStatOverlays([scene5], blog);
    expect(r.removed).toEqual([]);
    expect(r.scenes[0]).toEqual(scene5);
  });
  it('이 축이 실제로 막는 것은 원문에 없는 값이다(가정 사례 — 사고 재현 아님)', () => {
    const issues = timingParityIssues(blog, [{ field: '씬5 오버레이', text: '10월 낙엽수 식재 시작' }]);
    expect(issues.map((i) => i.token)).toEqual(['10월']);
    expect(formatTimingIssue(issues[0]!))
      .toBe('시기·수치 원문 불일치 — 씬5 오버레이: "10월 낙엽수 식재 시작" (원문에 없는 10월)');
    const r = stripUnsourcedStatOverlays([{ ...scene5, stat: { ...scene5.stat, value: 10 } }], blog);
    expect(r.removed).toEqual(['10월']);
    expect(r.scenes[0]).toEqual({ narration: scene5.narration, screenText: scene5.screenText });
  });
});
