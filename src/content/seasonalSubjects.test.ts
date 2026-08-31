import { describe, it, expect } from 'vitest';
import { offSeasonSubject, seasonalSubjectBlock, seasonWindow, formatMonths } from './seasonalSubjects';

const LEX = [
  { term: '단풍', months: [10, 11] },
  { term: '월동', months: [11, 12, 1, 2] },
  { term: '새순', months: [3, 4, 5] },
  { term: '장마', months: [6, 7] },
];
const AUG = new Date('2026-08-27T12:00:00');

describe('offSeasonSubject — 이번 달·다음 달 밖 소재 기각(2026-08-27 단풍 실사고)', () => {
  it('8월 말 단풍 글은 시기 밖(10~11월)', () => {
    expect(offSeasonSubject('활엽수의 계절 변화를 정원에 담기 — 단풍·낙엽·새순의 시기를 미리 보는 법', LEX, AUG)?.term).toBe('단풍');
  });
  it('9월에는 다음 달(10월)이 제철이라 단풍 통과', () => {
    expect(offSeasonSubject('단풍 잘 들게 지금 할 일', LEX, new Date('2026-09-05T12:00:00'))).toBeNull();
  });
  it('12월 롤오버 — 월동은 1월도 제철이라 통과, 새순은 시기 밖', () => {
    const dec = new Date('2026-12-20T12:00:00');
    expect(seasonWindow(dec)).toEqual([12, 1]);
    expect(offSeasonSubject('올리브나무 월동 준비', LEX, dec)).toBeNull();
    expect(offSeasonSubject('새순 나올 때 물주기', LEX, dec)?.term).toBe('새순');
  });
  it('부분 일치 — 단풍나무·단풍철도 단풍 소재', () => {
    expect(offSeasonSubject('정원 단풍나무 심기, 자리 고르는 법', LEX, AUG)?.term).toBe('단풍');
  });
  it('여러 개면 제목에서 먼저 나오는 소재', () => {
    expect(offSeasonSubject('장마 끝 단풍 대비', LEX, AUG)?.term).toBe('장마');
  });
  it('달력 없음·해당 없음이면 null', () => {
    expect(offSeasonSubject('감나무 가을 거름 주는 시기', LEX, AUG)).toBeNull();
    expect(offSeasonSubject('단풍', undefined, AUG)).toBeNull();
    expect(offSeasonSubject('단풍', [], AUG)).toBeNull();
  });
});

describe('seasonalSubjectBlock / formatMonths', () => {
  it('창 밖 소재만 나열하고 지금 달을 밝힌다', () => {
    const b = seasonalSubjectBlock(LEX, AUG);
    expect(b).toContain('지금 8월');
    expect(b).toContain('- 단풍(10~11월)');
    expect(b).toContain('- 월동(1~2·11~12월)');
    expect(b).toContain('- 새순(3~5월)');
    expect(b).toContain('- 장마(6~7월)');
  });
  it('전부 창 안이면 빈 문자열', () => {
    expect(seasonalSubjectBlock([{ term: '단풍', months: [10, 11] }], new Date('2026-10-01T12:00:00'))).toBe('');
    expect(seasonalSubjectBlock(undefined, AUG)).toBe('');
  });
  it('formatMonths 구간 표기', () => {
    expect(formatMonths([10, 11])).toBe('10~11월');
    expect(formatMonths([3, 4, 5])).toBe('3~5월');
    expect(formatMonths([11, 12, 1, 2])).toBe('1~2·11~12월');
    expect(formatMonths([6])).toBe('6월');
  });
});
