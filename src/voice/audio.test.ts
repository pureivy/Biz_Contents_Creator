import { describe, it, expect } from 'vitest';
import { sanitizeForTts, parseSayVoices } from './audio';

describe('sanitizeForTts', () => {
  it('마크다운/링크/이모지를 제거하고 공백을 정리한다', () => {
    const out = sanitizeForTts('**굵게** [링크](http://x) 끝 🎉\n\n다음줄');
    expect(out).not.toContain('**');
    expect(out).not.toContain('](http');
    expect(out).not.toContain('🎉');
    expect(out).toContain('굵게');
    expect(out).toContain('링크');
    expect(out).toContain('다음줄');
  });

  it('maxLen 으로 길이를 자른다', () => {
    expect(sanitizeForTts('가'.repeat(5000), 100).length).toBeLessThanOrEqual(100);
  });

  // "잎" 오독 보정 — 1차(2026-08-07): 발화 첫머리만 좁게 치환했으나, 2차 실측(2026-08-08 참나무 쇼츠
  // 씬1 "도토리 잎 사진"→"도토리 IP 사진")에서 **문중 단독 잎**도 확률적으로 오독됨이 드러나 전 위치로
  // 확대. 규칙: 단어 시작(앞이 한글 아님) 잎 + {끝·비한글·자음 초성 음절} → "입"(종성 중화로 발음 동일).
  // 연음으로 발음이 달라지는 모음 초성 결합(잎이[이피])과 복합어 속 잎(깻잎[깬닙])은 보존.
  describe('잎 → 입 (발음 동일 치환, TTS 입력 전용)', () => {
    it('문두 "잎과"·"잎 "·단독 "잎"은 입으로', () => {
      expect(sanitizeForTts('잎과 뿌리만 보면 헷갈릴 일 없어요.')).toMatch(/^입과/);
      expect(sanitizeForTts('잎 뒷면에 은빛 비늘이 있으면')).toMatch(/^입 /);
      expect(sanitizeForTts('잎')).toBe('입');
      expect(sanitizeForTts('잎도 봅니다')).toMatch(/^입도/);
    });

    it('문중 단독 잎도 치환한다 — 2차 실측("도토리 잎 사진"→IP) 재발 방지', () => {
      expect(sanitizeForTts('도토리 잎 사진, 검색해도 참나무까지만 나오죠?')).toContain('도토리 입 사진');
      expect(sanitizeForTts('그래서 잎과 열매로 구분합니다')).toContain('그래서 입과');
      expect(sanitizeForTts('자루 있는 넷은 잎 모양으로 나뉩니다')).toContain('입 모양');
    });

    it('모음 조사(잎이·잎을)는 발음이 달라지므로 치환하지 않는다 — 실측상 오독도 없음', () => {
      expect(sanitizeForTts('잎이 나야 봄입니다.')).toMatch(/^잎이/);
      expect(sanitizeForTts('도토리 잎이 넓습니다')).toContain('잎이');
    });

    it('복합어 속 잎(앞이 한글)은 보존한다 — 깻잎[깬닙] 발음 붕괴 방지', () => {
      expect(sanitizeForTts('깻잎 요리와 갈잎 더미')).toContain('깻잎');
      expect(sanitizeForTts('깻잎 요리와 갈잎 더미')).toContain('갈잎');
    });
  });

  // "봉오리" 오독 보정(실측 2026-08-07) — ElevenLabs 가 위치 무관하게 [봉고리]로 읽음(배롱나무 개화시기
  // 쇼츠 씬3·4 + 복합어 꽃봉오리까지 STT 재현). 하이픈 경계("봉-오리")가 발음 [봉오리]를 복원하며
  // 재생 길이 원문 동일(실측: 띄어쓰기=어절 분리, 제로폭=된소리화, 아포스트로피=간헐 된소리).
  describe('봉오리 → 봉-오리 (발음 경계 삽입, TTS 입력 전용)', () => {
    it('단독·조사·복합어 전 위치 치환', () => {
      expect(sanitizeForTts('초록 봉오리가 많으면')).toContain('봉-오리가');
      expect(sanitizeForTts('꽃봉오리가 맺혔습니다')).toContain('꽃봉-오리가');
      expect(sanitizeForTts('봉오리')).toBe('봉-오리');
    });
  });

  // "놀이" 오독 보정(실측 2026-08-11) — "아이 놀이 공간"→[아이도리]("아이돌의"로 들림, 원문 3/3 재현).
  // 표기 교체("노리")는 2/3 재발 — ㄴ 초성 자체가 흐려지는 문제라 하이픈 경계만 유효(3/3 정상).
  describe('놀이 → 놀-이 (어절 시작, TTS 입력 전용)', () => {
    it('단독·조사·후행 복합은 치환한다', () => {
      expect(sanitizeForTts('아이 놀이 공간과 떼어 놓아야')).toContain('놀-이 공간');
      expect(sanitizeForTts('놀이를 위한 자리')).toContain('놀-이를');
      expect(sanitizeForTts('놀이터 옆이라면')).toContain('놀-이터');
    });
    it('선행 복합(앞이 한글)은 보존한다 — 미관측 선제 확장 금지', () => {
      expect(sanitizeForTts('물놀이 자리는 피합니다')).toContain('물놀이');
    });
  });

  // "순치기" 오독 보정(실측 2026-08-11) — 위치 무관 [순칙] 축약(3/3 재현). 후보 실측: 순-치기·순치-기
  // 전패, 음절별 "순-치-기"만 3/3 정상.
  describe('순치기 → 순-치-기 (음절별 경계, TTS 입력 전용)', () => {
    it('전 위치 치환', () => {
      expect(sanitizeForTts('다음은 포도나무 순치기입니다')).toContain('순-치-기입니다');
      expect(sanitizeForTts('순치기')).toBe('순-치-기');
    });
  });

  // "손끝"·"간격" 오독 보정(실측 2026-08-11) — ㄴ+연구개음 비음화·약화([송긋]·[강역], 블루베리 쇼츠
  // 사용자 청취 제보). 하이픈 후보 각 3/3 정상, 표기 교체 "손끗"은 기각(1/3 재발+"송급" 악화).
  describe('손끝·간격 → 손-끝·간-격 (발음 경계, TTS 입력 전용)', () => {
    it('전 위치 치환', () => {
      expect(sanitizeForTts('색 대신 손끝 저항감으로 판단하세요')).toContain('손-끝 저항감');
      expect(sanitizeForTts('며칠 간격으로 나눠 따세요')).toContain('간-격으로');
    });
  });

  // "잔가지" 오독 보정(실측 2026-08-13) — 손끝·간격과 같은 ㄴ+ㄱ 비음화([장가지/장아지], 원문 3/3
  // 재현·STT 대조). 하이픈 "잔-가지" 3/3 정상 — 같은 부류 전례와 동일 처방.
  describe('잔가지 → 잔-가지 (발음 경계, TTS 입력 전용)', () => {
    it('전 위치 치환', () => {
      expect(sanitizeForTts('경계가 잔가지 끝에 머물면 심는 쪽')).toContain('잔-가지 끝');
      expect(sanitizeForTts('마른 잔가지를 정리하세요')).toContain('잔-가지를');
    });
  });
});

describe('parseSayVoices', () => {
  it('say -v ? 출력에서 ko_KR 음성 이름만 추출한다', () => {
    const raw = [
      'Alex                en_US    # Most people recognize me by my voice.',
      'Yuna                ko_KR    # 안녕하세요. 제 이름은 유나입니다.',
      'Eddy (한국어(한국))      ko_KR    # 안녕하세요.',
      'Sandy               en_US    # Hello',
    ].join('\n');
    const v = parseSayVoices(raw);
    expect(v).toContain('Yuna');
    expect(v).toContain('Eddy');
    expect(v).not.toContain('Alex');
  });
});
