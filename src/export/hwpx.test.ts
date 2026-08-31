import { describe, it, expect } from 'vitest';
import { markdownToSection, buildHwpx } from './hwpx';
import { createZip } from '../util/zip';

describe('markdownToSection', () => {
  it('제목·불릿·표를 OWPML 단락으로 변환', () => {
    const md = '# 제목\n\n## 섹션\n\n- 항목1\n- 항목2\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
    const xml = markdownToSection(md, '문서제목');
    expect(xml).toContain('</hs:sec>');
    expect(xml).toContain('<hp:t>제목</hp:t>');
    // 개조식 계층 렌더(hwpx.ts): 마크다운 '-' → 레벨2 '-' 마커 + 전각공백(U+3000) 들여쓰기.
    expect(xml).toContain('- 항목1'); // 마커·본문 보존(들여쓰기 접두엔 무관한 substring 검증)
    expect(xml).toContain('<hp:tbl'); // 마크다운 표 → 한글 표
    expect(xml).toContain('charPrIDRef="7"'); // 제목 스타일
  });
  it('XML 특수문자 이스케이프 + 인라인 마크다운 제거', () => {
    expect(markdownToSection('a < b & **굵게**')).toContain('a &lt; b &amp; 굵게');
  });
  it('닫힌 코드펜스는 스킵', () => {
    const xml = markdownToSection('앞\n\n```js\nconst a=1;\n```\n\n뒤');
    expect(xml).toContain('<hp:t>앞</hp:t>');
    expect(xml).toContain('<hp:t>뒤</hp:t>');
    expect(xml).not.toContain('const a=1');
  });
  it('닫히지 않은 코드펜스도 본문을 보존(데이터 손실 방지)', () => {
    const xml = markdownToSection('정상 단락\n\n```js\n펜스 안 본문이 살아있어야 함');
    expect(xml).toContain('펜스 안 본문이 살아있어야 함');
  });
});

describe('createZip', () => {
  it('PK 시그니처 + mimetype STORED(method=0) 첫 엔트리', () => {
    const zip = createZip([
      { name: 'mimetype', data: Buffer.from('application/hwp+zip'), store: true },
      { name: 'a.xml', data: Buffer.from('<x/>') },
    ]);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b); // 'PK'
    expect(zip.readUInt16LE(8)).toBe(0); // 첫 엔트리 압축방식 = STORED
  });
});

describe('buildHwpx', () => {
  it('유효 ZIP 생성, mimetype 이 첫 엔트리', () => {
    const buf = buildHwpx('# 테스트 문서\n\n본문 단락입니다.', { title: '테스트' });
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf.toString('utf-8', 30, 38)).toBe('mimetype'); // 로컬헤더(30B) 직후 파일명
  });
});
