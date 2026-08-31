import { describe, it, expect } from 'vitest';
import { buildVideoMeta, buildMultipartBody, extractVideoId } from './youtubeUpload';

describe('buildVideoMeta — 블로그 링크 줄(2026-07-31)', () => {
  it('설명 본문과 태그 줄 사이에 링크, 미지정 시 종전과 동일', () => {
    const url = 'https://blog.naver.com/biondi_tree/224345904342';
    const m = buildVideoMeta('t', '설명', ['#shorts'], url) as { snippet: { description: string } };
    expect(m.snippet.description).toBe(`설명\n\n📖 전체 가이드(블로그): ${url}\n\n#shorts`);
    const none = buildVideoMeta('t', '설명', ['#shorts']) as { snippet: { description: string } };
    expect(none.snippet.description).toBe('설명\n\n#shorts');
  });
});

describe('buildVideoMeta — 캡·해시태그 합성·private·AI 공개 고정(순수)', () => {
  it('꺾쇠 제거·설명에 해시태그 줄·tags 변환(# 제거·빈 항목 제외)', () => {
    const m = buildVideoMeta('제목 <b>테스트</b>', '설명', ['#shorts', '#화분', '']) as {
      snippet: { title: string; description: string; tags: string[]; categoryId: string };
      status: { privacyStatus: string; selfDeclaredMadeForKids: boolean; containsSyntheticMedia: boolean };
    };
    expect(m.snippet.title).toBe('제목 b테스트/b');
    expect(m.snippet.description).toBe('설명\n\n#shorts #화분');
    expect(m.snippet.tags).toEqual(['shorts', '화분']);
    expect(m.snippet.categoryId).toBe('22');
    expect(m.status.privacyStatus).toBe('private');
    expect(m.status.selfDeclaredMadeForKids).toBe(false);
    // AI 사용 공개('예') — 쇼츠는 전량 AI 생성(스크립트·TTS·배경)이라 상시 선언(유튜브 정책 의무).
    expect(m.status.containsSyntheticMedia).toBe(true);
  });
  it('제목 100자 캡·빈 제목 폴백, 설명 5000자 캡', () => {
    const m = buildVideoMeta('x'.repeat(120), 'y'.repeat(6000), []) as { snippet: { title: string; description: string } };
    expect(m.snippet.title.length).toBe(100);
    expect(m.snippet.description.length).toBe(5000);
    const empty = buildVideoMeta('  ', '', []) as { snippet: { title: string } };
    expect(empty.snippet.title).toBe('쇼츠');
  });
  it('설명·태그의 꺾쇠도 제거(유튜브 API 제약)', () => {
    const m = buildVideoMeta('t', '1->2단계 <중요>', ['#a<b>']) as { snippet: { description: string; tags: string[] } };
    expect(m.snippet.description).toBe('1-2단계 중요\n\n#ab');
    expect(m.snippet.tags).toEqual(['ab']);
  });
});
describe('buildMultipartBody — multipart/related 조립(순수)', () => {
  it('메타 JSON + 비디오 바이트 + 종료 경계', () => {
    const buf = buildMultipartBody({ a: 1 }, Buffer.from('VIDEO'), 'BB');
    const s = buf.toString('utf-8');
    expect(s.startsWith('--BB\r\n')).toBe(true);
    expect(s).toContain('{"a":1}');
    expect(s).toContain('Content-Type: video/mp4');
    expect(s).toContain('VIDEO');
    expect(s.endsWith('\r\n--BB--\r\n')).toBe(true);
  });
});
describe('extractVideoId — 정상/이형(순수)', () => {
  it('비어있지 않은 문자열 id 만 통과', () => {
    expect(extractVideoId({ id: 'abc123' })).toBe('abc123');
    expect(extractVideoId({})).toBeNull();
    expect(extractVideoId(null)).toBeNull();
    expect(extractVideoId({ id: 5 })).toBeNull();
    expect(extractVideoId({ id: '' })).toBeNull();
  });
});
