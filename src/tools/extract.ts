/**
 * 자료 텍스트 추출 — 한국 공문서 중심 멀티포맷(kordoc 제거, 포맷별 전용 도구 사용).
 *  - pdf  : pdftotext(poppler)
 *  - xlsx : 자체 구조화 파서(시트별 행×열 → 마크다운 표, sharedStrings 해석)
 *  - hwp  : pyhwp hwp5html → xhtml(표 보존) → 마크다운
 *  - docx/pptx/hwpx : 자체 ZIP+XML 파서
 *  - xls  : soffice(LibreOffice) 로 xlsx 변환 후 구조화 파서
 *  - txt/md/csv/json : UTF-8
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzip } from '../util/unzip';

/** 외부 도구 비동기 실행(stdin 입력 지원) — execFileSync 를 대체해 이벤트 루프 정지를 없앤다.
 *  (동기 실행은 추출이 끝날 때까지 SSE·취소 포함 모든 요청을 얼렸다 — 대형 PDF/HWP 는 수십 초.) */
function runTool(cmd: string, args: string[], opts: { input?: Buffer; timeoutMs: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 무해 */ } reject(new Error(`${cmd} 타임아웃`)); }, opts.timeoutMs);
    child.stdout!.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${cmd} 종료 코드 ${code}`));
    });
    if (opts.input) { child.stdin!.on('error', () => { /* EPIPE 무해 */ }); child.stdin!.end(opts.input); }
  });
}

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'text', 'log']);
const ZIP_EXT = new Set(['docx', 'pptx', 'hwpx']); // ZIP+XML 텍스트 추출
const HWP_EXT = new Set(['hwp', 'hwp3', 'hwpml']); // pyhwp hwp5html(표 보존)

export function isSupportedExt(filename: string): boolean {
  const e = ext(filename);
  return TEXT_EXT.has(e) || ZIP_EXT.has(e) || HWP_EXT.has(e) || e === 'pdf' || e === 'xlsx' || e === 'xls';
}
function ext(filename: string): string {
  return (filename.split('.').pop() || '').toLowerCase();
}
function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x?[0-9a-fA-F]+;/g, ' ').replace(/&apos;/g, "'");
}
/** OOXML/OWPML 의 모든 텍스트 태그(<w:t>·<a:t>·<hp:t>·<t>) 내용을 모아 반환. */
function allTextTags(xml: string): string {
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) parts.push(decodeEntities(m[1]!.replace(/<[^>]+>/g, '')));
  return parts.join(' ').replace(/[ \t]+/g, ' ').trim();
}

// --- xlsx 구조화 추출 — 시트별 행×열을 마크다운 표로 복원(다중시트 숫자 표·합계행 보존). ---
function colNum(ref: string): number {
  const m = ref.match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const c of m[1]!) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}
function fmtNum(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';
  if (!/^-?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(s)) return raw; // 숫자 아니면 원문 그대로
  const n = Number(s);
  if (!Number.isFinite(n)) return raw;
  // 반올림 금지(실제 값 보존). 단 IEEE754 직렬화/누적 노이즈(349999.799999997=실제 349999.8,
  // 2758236.7200000007=실제 2758236.72)는 제거한다. 노이즈는 14~17번째 유효숫자에 나타나고
  // 예산/결산 수치는 유효숫자 13자리 미만이므로, 소수부가 길 때만 13자리로 정리 → 노이즈만 사라지고
  // 실값·정밀도는 깎이지 않는다(2자리 같은 임의 반올림 아님).
  if (/\.\d{6,}/.test(s)) return String(Number(n.toPrecision(13)));
  return String(n);
}
export function xlsxToTables(data: Buffer): string {
  const z = unzip(data);
  if (z.size === 0) return '';
  const ss: string[] = [];
  const ssx = z.get('xl/sharedStrings.xml')?.toString('utf-8');
  if (ssx) for (const m of ssx.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    ss.push([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1]!)).join(''));
  }
  const sheets = [...z.keys()].filter((n) => /xl\/worksheets\/sheet\d+\.xml/i.test(n)).sort();
  const out: string[] = [];
  for (const sn of sheets) {
    const xml = z.get(sn)!.toString('utf-8');
    const rows: string[][] = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cm of rm[1]!.matchAll(/<c\s+([^>/]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1] || ''; const inner = cm[2] || '';
        const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1] || '';
        const col = ref ? colNum(ref) : cells.length;
        const t = (attrs.match(/t="(\w+)"/) || [])[1];
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (t === 's') val = ss[parseInt(v || '0', 10)] || '';
        else if (t === 'inlineStr') val = decodeEntities((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
        else if (t === 'str') val = decodeEntities(v || '');
        else val = fmtNum(v || '');
        while (cells.length < col) cells.push('');
        cells[col] = val;
      }
      if (cells.some((c) => c.trim())) rows.push(cells);
    }
    if (!rows.length) continue;
    const cols = Math.max(...rows.map((r) => r.length));
    const body = rows.map((r) => '| ' + Array.from({ length: cols }, (_, i) => (r[i] || '').replace(/\|/g, '/').replace(/\n/g, ' ')).join(' | ') + ' |').join('\n');
    out.push(`## ${sn.split('/').pop()}\n${body}`);
  }
  return out.join('\n\n');
}

async function pdfText(data: Buffer): Promise<string> {
  try {
    return (await runTool('pdftotext', ['-q', '-', '-'], { input: data, timeoutMs: 60_000 })).toString('utf-8');
  } catch {
    throw new Error('PDF 추출 실패 — pdftotext(poppler) 미설치(`brew install poppler`)');
  }
}

// --- HWP(바이너리) — pyhwp hwp5html 로 xhtml(표 보존) 생성 후 마크다운으로 변환. ---
const HWP_BINS = [
  process.env.HWP5HTML || '',
  'hwp5html',
  `${process.env.HOME || ''}/Library/Python/3.9/bin/hwp5html`,
  '/opt/homebrew/bin/hwp5html', '/usr/local/bin/hwp5html',
].filter(Boolean);
/** xhtml(hwp5html 출력) → 마크다운: 표는 마크다운 표로, 그 외는 텍스트로(문서 순서 보존). */
function xhtmlToMd(xh: string): string {
  const clean = (s: string) => decodeEntities(s.replace(/&#13;/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
  const body = (xh.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || ['', xh])[1]!;
  const parts: string[] = [];
  let last = 0;
  for (const m of body.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const before = clean(body.slice(last, m.index));
    if (before) parts.push(before);
    const rows: string[][] = [];
    for (const tr of m[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean(c[1]!).replace(/\|/g, '/'));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) {
      const cols = Math.max(...rows.map((r) => r.length));
      parts.push(rows.map((r) => '| ' + Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ') + ' |').join('\n'));
    }
    last = (m.index || 0) + m[0].length;
  }
  const tail = clean(body.slice(last));
  if (tail) parts.push(tail);
  return parts.join('\n\n');
}
async function hwpText(data: Buffer): Promise<string> {
  // HWP 5.x 는 OLE2 복합문서(D0CF11E0). 시그니처 불일치면 빠르게 실패(잘못된 입력에 hwp5html 실행 회피).
  if (data.length < 8 || data.readUInt32BE(0) !== 0xD0CF11E0) throw new Error('HWP 추출 실패 — 유효한 HWP(OLE2) 형식 아님');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-'));
  try {
    const inp = path.join(tmp, 'in.hwp');
    await fs.promises.writeFile(inp, data);
    let ran = false;
    for (const bin of HWP_BINS) {
      try { await runTool(bin, ['--output', tmp, inp], { timeoutMs: 120_000 }); ran = true; break; } catch { /* 다음 후보 */ }
    }
    if (!ran) throw new Error('HWP 추출 실패 — hwp5html(pyhwp) 미설치. `pip install pyhwp` 후 PATH 또는 HWP5HTML 환경변수 설정.');
    return xhtmlToMd(await fs.promises.readFile(path.join(tmp, 'index.xhtml'), 'utf-8'));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무해 */ }
  }
}

/** 구형 xls(OLE 바이너리) — soffice 로 xlsx 변환 후 구조화 파서. */
async function xlsToText(data: Buffer): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xls-'));
  try {
    const inp = path.join(tmp, 'in.xls');
    await fs.promises.writeFile(inp, data);
    await runTool('soffice', ['--headless', '--convert-to', 'xlsx', '--outdir', tmp, inp], { timeoutMs: 120_000 });
    const out = fs.readdirSync(tmp).find((f) => f.endsWith('.xlsx'));
    if (out) { const t = xlsxToTables(await fs.promises.readFile(path.join(tmp, out))); if (t) return t; }
    throw new Error('xls 변환 실패');
  } catch {
    throw new Error('XLS 추출 실패 — soffice(LibreOffice) 변환 불가');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 무해 */ }
  }
}

/** docx/pptx/hwpx ZIP+XML 텍스트 추출. */
export function extractZipFallback(e: string, data: Buffer): string {
  const z = unzip(data);
  if (z.size === 0) throw new Error('압축 해제 실패(손상 파일?)');
  if (e === 'docx') return allTextTags(z.get('word/document.xml')?.toString('utf-8') ?? '');
  if (e === 'hwpx') {
    const parts: string[] = [];
    for (const [name, buf] of z) if (/Contents\/section\d+\.xml/i.test(name)) parts.push(allTextTags(buf.toString('utf-8')));
    return parts.filter(Boolean).join('\n');
  }
  if (e === 'pptx') {
    const parts: string[] = [];
    for (const [name, buf] of z) if (/ppt\/slides\/slide\d+\.xml/i.test(name)) parts.push(allTextTags(buf.toString('utf-8')));
    return parts.filter(Boolean).join('\n');
  }
  if (e === 'xlsx') { // 구조화 파서 실패 시 평면 폴백
    const parts: string[] = [];
    const ss = z.get('xl/sharedStrings.xml');
    if (ss) parts.push(allTextTags(ss.toString('utf-8')));
    for (const [name, buf] of z) if (/xl\/worksheets\/sheet\d+\.xml/i.test(name)) parts.push(allTextTags(buf.toString('utf-8')));
    return parts.filter(Boolean).join('\n');
  }
  throw new Error(`지원하지 않는 형식: .${e}`);
}

/** 파일명+바이트 → 추출 텍스트(마크다운). 포맷별 전용 도구로 라우팅(kordoc 제거). */
export async function extractText(filename: string, data: Buffer): Promise<string> {
  const e = ext(filename);
  if (TEXT_EXT.has(e)) return data.toString('utf-8');
  if (e === 'pdf') return pdfText(data);                       // pdftotext(poppler)
  if (e === 'xlsx') {                                          // 구조화 표 복원(시트별 행×열)
    const t = xlsxToTables(data);
    if (t && t.length > 50) return t;
    return extractZipFallback('xlsx', data);                  // 폴백(평면)
  }
  if (HWP_EXT.has(e)) return hwpText(data);                    // pyhwp hwp5html(표 보존)
  if (e === 'xls') return xlsToText(data);                     // soffice → xlsx → 구조화
  if (ZIP_EXT.has(e)) return extractZipFallback(e, data);     // docx/pptx/hwpx (ZIP+XML)
  throw new Error(`지원하지 않는 형식: .${e}`);
}
