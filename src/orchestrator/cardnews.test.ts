import { describe, it, expect } from 'vitest';
import {
  applyCardRevision, applyProofread, buildCardImagePrompt, buildSlideQaPrompt, buildSlideTranscribePrompt,
  coverIncludesKeyword, extractDesignFromDraftPrompt, findSlidesWithChars, parseSlideNosFromFeedback,
  resolveForcedPreset, stripForDiff, formatRecentEndings, cardVoiceGuide, cardStructureLines,
} from './cardnews';
import { FIXED_STRUCTURE_SEED } from '../content/structureSeed';

type CardPlan = Parameters<typeof applyCardRevision>[0];

describe('coverIncludesKeyword — 표지 키워드 정확 표기 게이트', () => {
  it('headline 또는 body 어느 쪽이든 정확 표기가 있으면 통과(택일 허용 유지)', () => {
    expect(coverIncludesKeyword([{ headline: '배롱나무 여름 관리 실수', body: '' }], '배롱나무')).toBe(true);
    expect(coverIncludesKeyword([{ headline: '라벨 한 줄, 3년을 가른다', body: '블루베리나무화분 구매 전 체크리스트' }], '블루베리나무화분')).toBe(true);
  });
  it('공백 차이는 무시("가을채소 흙준비" ≈ "가을채소흙준비")', () => {
    expect(coverIncludesKeyword([{ headline: '가을채소 흙준비 지금 시작', body: '' }], '가을채소흙준비')).toBe(true);
  });
  it('표지 어디에도 없으면 실패 — 수정 라운드·마지노선 트리거', () => {
    expect(coverIncludesKeyword([{ headline: '라벨 한 줄, 3년을 가른다', body: '구매 전 체크리스트' }], '블루베리나무화분')).toBe(false);
  });
  it('키워드 미지정·슬라이드 없음은 항상 통과', () => {
    expect(coverIncludesKeyword([{ headline: '아무 제목', body: '' }], undefined)).toBe(true);
    expect(coverIncludesKeyword([], '배롱나무')).toBe(true);
  });
});

const base = {
  headline: '가을 첫인사',
  body: '창가에 화분 하나\n계절이 바뀝니다',
  scene: '노을 지는 창가',
  style: '따뜻한 자연광, 파스텔 팔레트',
  title: '가을 인사',
  total: 4,
  hasRefs: false,
};

describe('buildCardImagePrompt — 공통 보존(두 프리셋 모두)', () => {
  for (const preset of ['photorealistic', 'handwritten_poster']) {
    it(`${preset}: 정확 문구·자소 가드·무이모지 정책을 유지`, () => {
      const p = buildCardImagePrompt({ ...base, index: 1, preset });
      expect(p).toContain('한 글자도 바꾸지 말 것');
      expect(p).toContain(base.headline);          // 헤드라인 정확 표기
      expect(p).toContain('창가에 화분 하나 / 계절이 바뀝니다'); // 본문 줄바꿈→ / 치환
      expect(p).toContain('자소(자음·모음) 결합이 틀리면 실패');
      expect(p).toContain(base.style);             // 전 장 공통 스타일 반복
      expect(p).toContain('2:3 세로');              // 네이티브 세로 비율(1024×1536)
      expect(p).not.toContain('정사각');            // 이전 1:1 문구 제거 확인
    });
  }

  it('페이지 번호(1/8·2/3 등)는 어떤 슬라이드에도 넣지 않고, 제외 목록에 명시(사용자 요청 2026-07-22)', () => {
    for (const preset of ['photorealistic', 'handwritten_poster']) {
      for (const index of [0, 2, 4]) {
        const p = buildCardImagePrompt({ ...base, index, total: 5, preset });
        expect(p).not.toContain('페이지 표기');        // 페이지 표기 지시 제거
        expect(p).not.toContain('우측 하단에 작은');    // 옛 페이지번호 문구 흔적 없음
        expect(p).not.toContain(`"${index + 1}/5"`);   // "3/5" 같은 표기 지시 없음
        expect(p).toContain('페이지 번호');            // 제외 목록에 페이지 번호 금지 명시
      }
    }
  });
});

describe('buildCardImagePrompt — handwritten_poster 분기', () => {
  it('붓펜 캘리 고정·임베드·상호작용 지시를 담고, 인쇄 에디토리얼 문구는 안 씀', () => {
    const p = buildCardImagePrompt({ ...base, index: 1, preset: 'handwritten_poster' });
    expect(p).toContain('붓펜 캘리그래피');              // 서체 고정(사용자 확정 2026-07-30)
    expect(p).toContain('크레용체·색연필체·마커체·둥근 고딕풍 손글씨는 절대 금지');
    expect(p).toContain('배경과 소품에만 적용');          // 톤 질감의 글씨 오염 격리
    expect(p).toContain('피사체-텍스트 상호작용');
    expect(p).toContain('평면 스티커처럼 얹지 않는다');
    expect(p).not.toContain('산세리프');                 // 에디토리얼 전용 문구 배제
    expect(p).not.toContain('인쇄 에디토리얼 질감');
  });

  it('표지=히어로 캘리, 본문=가독성 우선으로 분기', () => {
    const cover = buildCardImagePrompt({ ...base, index: 0, preset: 'handwritten_poster' });
    const body = buildCardImagePrompt({ ...base, index: 1, preset: 'handwritten_poster' });
    expect(cover).toContain('히어로 캘리그래피');
    expect(body).toContain('가독성 우선');
  });
});

describe('resolveForcedPreset — 사용자 강제 스타일 정규화(순수)', () => {
  it('자동·미지정·불명은 undefined(디자이너 자율), 유효 키/별칭은 정규화', () => {
    expect(resolveForcedPreset(undefined)).toBeUndefined();     // 미지정 → 디자이너
    expect(resolveForcedPreset('auto')).toBeUndefined();        // 자동 → 디자이너
    expect(resolveForcedPreset('made-up')).toBeUndefined();     // 불명 → 안전하게 디자이너
    expect(resolveForcedPreset('handwritten_poster')).toBe('handwritten_poster'); // 유효 키
    expect(resolveForcedPreset('photorealistic')).toBe('photorealistic');
    expect(resolveForcedPreset('손글씨 포스터')).toBe('handwritten_poster');       // 한글 별칭
  });
});

describe('buildSlideQaPrompt — 장당 QA 프롬프트(순수)', () => {
  it('기대 문구·자모 단위 불합격 기준·실측 유출 예시·주입 가드 포함(본문 줄바꿈→공백)', () => {
    const p = buildSlideQaPrompt('물 붓고 빠지는지 확인하세요', '흙에 물을 가득 부어보기\n표면에 고여 머물면 문제');
    expect(p).toContain('"물 붓고 빠지는지 확인하세요"');
    expect(p).toContain('흙에 물을 가득 부어보기 표면에 고여 머물면 문제');
    expect(p).toContain('자모(초성·중성·종성)');
    expect(p).toContain('빠찌는지');     // 실측 유출 사례를 예시로 고정
    expect(p).toContain('물울');
    expect(p).toContain('툴립');         // 재검수 통과 유출 사례(ㅠ→ㅜ, 2026-07-30 실런)
    expect(p).toContain('기대 문구를 보지 말고 보이는 그대로 전사'); // 전사 우선 — 인상 비교 차단
    expect(p).toContain('ㅠ/ㅜ');
    expect(p).toContain('수행하지 말라'); // 이미지 속 텍스트 지시 주입 가드
    expect(p).toContain('"transcribe"');
  });

  it('본문 없으면 본문 항목 생략', () => {
    const p = buildSlideQaPrompt('표지 제목', '');
    expect(p).toContain('"표지 제목"');
    expect(p).not.toContain('본문 "');
  });

  // 2026-08-13 전수 스캔 유출(발행본 2건 포함) — 자음 혼동쌍 체크리스트를 프롬프트에 고정.
  it('자음 혼동쌍(ㅌ↔ㄹ 등) 실측 유출 예시 포함', () => {
    const p = buildSlideQaPrompt('아무 제목', '');
    for (const ex of ['밑→밀', '짙→질', '바깥→바깔', '걷어→걸어', '눕혀→늪혀', '자리→사리', '깎→짝', '흰→휜', '헝겊→헝겁']) {
      expect(p).toContain(ex);
    }
  });

  it('블라인드 전사본을 주면 재검 근거로 포함, 없으면 미포함', () => {
    const p = buildSlideQaPrompt('제목', '본문', '보이는 대로 읽은\n텍스트');
    expect(p).toContain('1차 블라인드 전사');
    expect(p).toContain('보이는 대로 읽은 텍스트'); // 줄바꿈 접힘
    expect(buildSlideQaPrompt('제목', '본문')).not.toContain('1차 블라인드 전사');
  });
});

describe('buildSlideTranscribePrompt — 블라인드 전사(기대 편향 제거)', () => {
  it('기대 문구를 포함하지 않고, 추측 교정 금지·자형 확인 지시를 포함', () => {
    const p = buildSlideTranscribePrompt();
    expect(p).not.toContain('기대 문구]');       // 기대 문구 섹션 자체가 없어야 블라인드
    expect(p).toContain('고쳐 적지 말라');
    expect(p).toContain('ㅌ인지 ㄹ인지');
    expect(p).toContain('"transcribe"');
  });
});

describe('stripForDiff — 공백만 허용 차이(줄바꿈·띄어쓰기)', () => {
  it('공백·줄바꿈 제거 후 동일 판정', () => {
    expect(stripForDiff('밑에서 걷어\n냅니다')).toBe('밑에서걷어냅니다');
    expect(stripForDiff('밑에서걷어냅니다') === stripForDiff('밀에서 걷어냅니다')).toBe(false); // 자음 오염은 불일치
  });
});

describe('extractDesignFromDraftPrompt — 구 카드 수선용 역파싱(순수)', () => {
  it('실제 buildCardImagePrompt 출력에서 스타일·장면·프리셋을 복원한다', () => {
    const prompt = buildCardImagePrompt({
      headline: '제목', body: '본문', scene: '노을 지는 창가, 화분 하나',
      style: '따뜻한 자연광, 파스텔 팔레트', title: '가을 인사',
      index: 2, total: 4, hasRefs: false, preset: 'handwritten_poster',
    });
    const d = extractDesignFromDraftPrompt(prompt);
    expect(d.style).toBe('따뜻한 자연광, 파스텔 팔레트');
    expect(d.scene).toBe('노을 지는 창가, 화분 하나');
    expect(d.preset).toBe('handwritten_poster');
  });
  it('에디토리얼(비손글씨) 분기도 복원 — 표지(index 0) 접미문 제거 포함', () => {
    const prompt = buildCardImagePrompt({
      headline: '제목', body: '', scene: '책상 위 스케치',
      style: '단색 배경, 잉크 질감', title: '표지', index: 0, total: 3, hasRefs: true, preset: 'flat_design',
    });
    const d = extractDesignFromDraftPrompt(prompt);
    expect(d.style).toBe('단색 배경, 잉크 질감');
    expect(d.scene).toBe('책상 위 스케치');
    expect(d.preset).toBe('photorealistic'); // 비손글씨는 프리셋 구분 불가 — 범용 폴백
  });
});

describe('applyProofread — 교정 병합 안전핀(순수)', () => {
  const plan = {
    title: '가을채소 흙준비',
    caption: '캡션 원문입니다',
    hashtags: ['#텃밭'],
    slides: [
      { headline: '물빠짐 확인이 마지막 관문', body: '고이면 뿌리가 물러 무릅니다' },
      { headline: '표지', body: '' },
    ],
  };

  it('소폭 교정은 수용, 후보 없는 필드·빈 본문은 원본 유지', () => {
    const out = applyProofread(plan, { slides: [{ body: '고이면 뿌리가 물러집니다' }, {}] });
    expect(out.slides[0]!.body).toBe('고이면 뿌리가 물러집니다');       // 겹말 교정 수용
    expect(out.slides[0]!.headline).toBe(plan.slides[0]!.headline);    // 후보 없음 → 원본
    expect(out.slides[1]!.body).toBe('');                              // 빈 본문 유지
    expect(out.title).toBe(plan.title);
    expect(out.hashtags).toEqual(['#텃밭']);                           // 교정 대상 외 필드 보존
  });

  it('길이가 크게 달라진 후보(재작성·설명문)는 원본 유지, null 후보는 원본 그대로', () => {
    const blown = applyProofread(plan, { title: '완전히 새로 쓴 아주 길고 긴 다른 제목으로 바꿔버리기 시도' });
    expect(blown.title).toBe(plan.title);
    expect(applyProofread(plan, null)).toEqual(plan);
  });
});

describe('buildCardImagePrompt — 기존 에디토리얼 분기 보존', () => {
  it('전시 포스터·산세리프 구조를 유지하고, 손글씨 분기 문구는 안 씀', () => {
    const p = buildCardImagePrompt({ ...base, index: 1, preset: 'photorealistic' });
    expect(p).toContain('전시 포스터처럼');
    expect(p).toContain('산세리프');
    expect(p).not.toContain('손글씨 캘리그래피');
  });
});

describe('applyCardRevision — 수정 요청 개정안 적용(순수)', () => {
  const base: CardPlan = {
    title: '올리브 제목', caption: '캡션', hashtags: ['#a'],
    slides: [
      { headline: 'h1', body: 'b1' },
      { headline: 'h2', body: 'b2\n둘째 줄' },
    ],
  };
  it('바뀐 슬라이드만 반영하고 번호를 돌려준다(1-base)', () => {
    const r = applyCardRevision(base, { slides: [{ index: 2, headline: '새 헤드라인' }] });
    expect(r).not.toBeNull();
    expect(r!.changedSlides).toEqual([2]);
    expect(r!.plan.slides[1]!.headline).toBe('새 헤드라인');
    expect(r!.plan.slides[1]!.body).toBe('b2\n둘째 줄'); // 미지정 필드 보존
    expect(r!.plan.slides[0]!.headline).toBe('h1');
  });
  it('범위 밖 번호·빈 문자열·동일 문구는 무시, 유효 변경 없으면 null', () => {
    expect(applyCardRevision(base, { slides: [{ index: 9, headline: 'x' }] })).toBeNull();
    expect(applyCardRevision(base, { slides: [{ index: 1, headline: '  ' }] })).toBeNull();
    expect(applyCardRevision(base, { slides: [{ index: 1, headline: 'h1' }] })).toBeNull();
    expect(applyCardRevision(base, null)).toBeNull();
  });
  it('캡션·해시태그(# 접두 보정)는 metaChanged 로 표시', () => {
    const r = applyCardRevision(base, { caption: '새 캡션', hashtags: ['나무', '#정원'] });
    expect(r!.metaChanged).toBe(true);
    expect(r!.changedSlides).toEqual([]);
    expect(r!.plan.caption).toBe('새 캡션');
    expect(r!.plan.hashtags).toEqual(['#나무', '#정원']);
  });
});

describe('findSlidesWithChars — 렌더 오타 신고 라우팅(순수)', () => {
  const slides = [
    { headline: '가지에 붙은 흰 것', body: '배롱나무' },
    { headline: '손톱으로 밀기', body: '흰가루병은 가루' },
    { headline: '물로 씻기', body: '헝겊으로 훑는다' },
  ];
  it('지목 글자가 든 슬라이드 번호(1-base)를 돌려준다', () => {
    expect(findSlidesWithChars(slides, ['흰'])).toEqual([1, 2]);
    expect(findSlidesWithChars(slides, ['훑'])).toEqual([3]);
    expect(findSlidesWithChars(slides, ['흰', '훑'])).toEqual([1, 2, 3]);
  });
  it('빈·과대 입력은 무시', () => {
    expect(findSlidesWithChars(slides, [])).toEqual([]);
    expect(findSlidesWithChars(slides, ['', '  '])).toEqual([]);
    expect(findSlidesWithChars(slides, ['일곱글자를넘는긴문자열'])).toEqual([]);
  });
});

describe('parseSlideNosFromFeedback — 명시 지목 슬라이드 파싱(순수)', () => {
  it("'N번 슬라이드'·'슬라이드 N'·'N번째 장' 꼴을 번호로 파싱한다", () => {
    expect(parseSlideNosFromFeedback('3번 슬라이드 오타 수정', 7)).toEqual([3]);
    expect(parseSlideNosFromFeedback('슬라이드 5 글자가 깨졌어요', 7)).toEqual([5]);
    expect(parseSlideNosFromFeedback('2번째 장이랑 6번 카드 오타', 7)).toEqual([2, 6]);
    expect(parseSlideNosFromFeedback('3번 슬라이드 오타 수정, 누렇거나, 뒷면, 옮겨', 7)).toEqual([3]); // 실사고 원문
  });
  it('범위 밖·매수 표현·번호 없음은 무시', () => {
    expect(parseSlideNosFromFeedback('9번 슬라이드', 7)).toEqual([]); // maxSlides 초과
    expect(parseSlideNosFromFeedback('전체적으로 8장 전부 좋아요', 7)).toEqual([]); // 'N장' 단독=매수
    expect(parseSlideNosFromFeedback('오탈자를 확인해서 수정해줘', 7)).toEqual([]);
  });
});

// ── 2026-08-27 말투 감사 권고 5 — 카드 마무리 로테이션(최근 5세트 회피 블록) ────────────────
describe('formatRecentEndings — 최근 마무리 원문 회피 블록(순수)', () => {
  it('마무리 장 headline/body 와 캡션 끝줄을 블록으로 만든다', () => {
    const block = formatRecentEndings([
      { headline: '오늘 할 일 세 가지', body: '물 아끼고 바람 통하게', captionTail: '저장해두고 비 오는 날마다 꺼내보세요.' },
      { headline: '내일 확인할 것', body: '', captionTail: '' },
    ]);
    expect(block).toContain('[최근 마무리');
    expect(block).toContain('오늘 할 일 세 가지');
    expect(block).toContain('물 아끼고 바람 통하게');
    expect(block).toContain('저장해두고 비 오는 날마다 꺼내보세요.');
    expect(block).toContain('내일 확인할 것');
  });

  it('마무리 원문이 없으면 빈 문자열(무주입)', () => {
    expect(formatRecentEndings([])).toBe('');
    expect(formatRecentEndings([{ headline: '', body: '', captionTail: '' }])).toBe('');
  });
});

// Fix wave(2026-08-27, 소견 3) — [말맛] 지시가 킬스위치를 보지 않아 두 구멍이 있었다:
//  ① VOICE_ROTATION=off 여도 로테이션 문구가 남아 base 로 안 돌아갔다.
//  ② off·신규 브랜드·읽기 실패로 endingsAvoid 가 비면 '아래 [최근 마무리]' 가 없는 블록을 가리켰다.
// 두 조건(스위치·원문 유무)에서 세 상태를 만든다.
describe('cardVoiceGuide — [말맛] 마무리 지시(VOICE_ROTATION × 최근 마무리 유무)', () => {
  it('off 면 base 문구(마무리 장은 권유형 고정)로 돌아간다', () => {
    const g = cardVoiceGuide(false, false);
    expect(g).toContain('마무리 장은 권유형("-해 보세요")으로');
    expect(g).not.toContain('[최근 마무리]');
    expect(g).not.toContain('관찰 장면');
  });

  it('on + 최근 마무리 없음 → 유형 로테이션만, 없는 블록을 참조하지 않는다', () => {
    const g = cardVoiceGuide(true, false);
    expect(g).toContain('관찰 장면');
    expect(g).toContain('조건문');
    expect(g).not.toContain('[최근 마무리]');
  });

  it('on + 최근 마무리 있음 → 참조 문구가 붙는다', () => {
    const g = cardVoiceGuide(true, true);
    expect(g).toContain('아래 [최근 마무리] 와 같은 문형·같은 첫 어절 금지');
    expect(g).toContain('관찰 장면');
  });

  it('세 상태 모두 보호 자산(어미 배합·행동 지시 목적어·안전 이유)을 유지한다', () => {
    for (const g of [cardVoiceGuide(false, false), cardVoiceGuide(true, false), cardVoiceGuide(true, true)]) {
      expect(g).toContain('전 장을 "-습니다"로 끝내지 마라');
      expect(g).toContain('손 높이 아래로');
      expect(g).toContain('위험·안전의 이유');
    }
  });
});

// Fix wave(2026-08-27, 소견 2) — 줄 수·해시태그 지시는 base(194bed6d) 프롬프트에 아예 없던 두 줄이다.
// STRUCTURE_VARIETY=off 면 시드 값만 고정되는 게 아니라 그 두 줄이 통째로 빠져야 base 와 같아진다.
describe('cardStructureLines — 카드 골격 지시(STRUCTURE_VARIETY)', () => {
  it('off 면 줄 수·해시태그 지시가 아예 빠진다(base 프롬프트)', () => {
    expect(cardStructureLines(FIXED_STRUCTURE_SEED, false)).toEqual([]);
  });
  it('on 이면 시드 값이 그대로 실린다', () => {
    const lines = cardStructureLines({ ...FIXED_STRUCTURE_SEED, cardLines: 3, hashtags: 11 }, true).join('\n');
    expect(lines).toContain('3줄');
    expect(lines).toContain('11개');
  });
});
