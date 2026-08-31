import { describe, it, expect } from 'vitest';
import { extractText, isSupportedExt, extractZipFallback } from './extract';
import { createZip } from '../util/zip';
import { buildHwpx } from '../export/hwpx';

describe('isSupportedExt', () => {
  it('한국 공문서·텍스트 형식 허용(hwp/xls 포함), 그 외 거부', () => {
    for (const f of ['a.hwpx', 'b.docx', 'c.xlsx', 'd.pptx', 'e.pdf', 'f.txt', 'g.md', 'h.csv', 'i.hwp', 'j.xls']) expect(isSupportedExt(f)).toBe(true);
    for (const f of ['x.zip', 'y.exe', 'z.png']) expect(isSupportedExt(f)).toBe(false);
  });
});

// 자체 ZIP 파서(kordoc 미지원/실패 시 폴백) 단위 검증 — 합성 fixture 로 정확 비교.
describe('extractZipFallback (자체 ZIP+XML 파서)', () => {
  it('HWPX(OWPML) — hp:t 텍스트 추출', () => {
    const hwpx = buildHwpx('# 예산 편성\n\n일반회계 운영비 검토.', { title: '예산' });
    const t = extractZipFallback('hwpx', hwpx);
    expect(t).toContain('예산 편성');
    expect(t).toContain('일반회계 운영비');
  });
  it('DOCX — word/document.xml 의 w:t 추출', () => {
    const docx = createZip([
      { name: 'word/document.xml', data: Buffer.from('<w:document><w:body><w:p><w:r><w:t>인사 노무 규정</w:t></w:r></w:p></w:body></w:document>') },
    ]);
    expect(extractZipFallback('docx', docx)).toBe('인사 노무 규정');
  });
  it('XLSX — sharedStrings 의 t 추출', () => {
    const xlsx = createZip([
      { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst><si><t>법인카드</t></si><si><t>집행</t></si></sst>') },
    ]);
    expect(extractZipFallback('xlsx', xlsx)).toContain('법인카드');
  });
  it('XML 엔티티 디코드', () => {
    const docx = createZip([{ name: 'word/document.xml', data: Buffer.from('<w:t>A &amp; B &lt; C</w:t>') }]);
    expect(extractZipFallback('docx', docx)).toBe('A & B < C');
  });
});

describe('extractText (kordoc 1순위 + 폴백)', () => {
  it('텍스트 파일은 UTF-8 그대로', async () => {
    expect(await extractText('m.md', Buffer.from('# 메모\n내용'))).toContain('메모');
  });
  it('미지원 형식·손상 입력은 throw', async () => {
    await expect(extractText('x.zip', Buffer.from('x'))).rejects.toThrow();
    await expect(extractText('old.hwp', Buffer.from('not-a-hwp'))).rejects.toThrow();
  });
});
