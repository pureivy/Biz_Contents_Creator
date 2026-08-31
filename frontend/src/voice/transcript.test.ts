import { describe, it, expect } from 'vitest';
import { mergeTranscript } from './transcript';

describe('mergeTranscript', () => {
  it('빈 입력창이면 전사를 그대로 둔다', () => {
    expect(mergeTranscript('', '안녕하세요')).toBe('안녕하세요');
  });
  it('기존 텍스트가 있으면 공백으로 이어붙인다', () => {
    expect(mergeTranscript('예산', '검토해줘')).toBe('예산 검토해줘');
  });
  it('이미 공백으로 끝나면 중복 공백을 넣지 않는다', () => {
    expect(mergeTranscript('예산 ', '검토')).toBe('예산 검토');
  });
});
