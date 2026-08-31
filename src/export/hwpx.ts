/**
 * 마크다운 산출물 → 한글(HWPX) 변환. GEPA hwpx_export.py 의 Node 포팅(순수 Node, 의존성 없음).
 *
 * report 템플릿(assets/hwpx/report/{header,section0}.xml)의 스타일을 재사용해 section0.xml 을
 * 조립하고, base 템플릿(assets/hwpx/base/*)에 오버레이한 뒤 createZip 으로 .hwpx(ZIP) 생성.
 * charPr: 0 본문·7 제목·8 소제목·13 섹션헤더 / paraPr: 0 양끝·20 가운데·24 들여쓰기.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createZip } from '../util/zip';
import type { ZipEntry } from '../util/zip';

const ASSETS = path.resolve(process.cwd(), 'assets/hwpx');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cleanInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[\[(.+?)\]\]/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim();
}
// 개조식 계층 들여쓰기 — 글머리/번호 마커로 레벨을 판정한다. □(0)→○(1)→-(2)→·(3), 번호형(1./가./1)/(1)/①).
// 들여쓰기는 전각 공백(U+3000)으로 표현(템플릿 paraPr 의존·자동번호 충돌 없이 한글에서 일관 렌더).
const FW = '　';
// 모든 문단 왼쪽 여백(hc:left) = 0pt (사용자 요청). 계층 들여쓰기는 본문의 전각공백(레벨×2)으로만 표현.
// (이전엔 - / · 에 paraPr 28/29 의 왼쪽여백 49.4/66.5pt 를 줘 "왼쪽 여백 49.9pt" 가 나왔다 → 모두 paraPr 0 으로.)
function hierItem(line: string): { level: number; text: string; pp: number } | null {
  const s = cleanInline(line);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^□\s*(.*)/))) return { level: 0, text: '□ ' + m[1]!.trim(), pp: 0 };
  if ((m = s.match(/^[○◦]\s*(.*)/))) return { level: 1, text: '○ ' + m[1]!.trim(), pp: 0 };
  if ((m = s.match(/^[-*+]\s+(.*)/))) return { level: 2, text: '- ' + m[1]!.trim(), pp: 0 };
  if ((m = s.match(/^[·▪●]\s*(.*)/))) return { level: 3, text: '· ' + m[1]!.trim(), pp: 0 };
  if ((m = s.match(/^(\d+)[.)]\s+(.*)/))) return { level: 0, text: `${m[1]}. ${m[2]!.trim()}`, pp: 0 };
  if ((m = s.match(/^([가-힣])[.)]\s+(.*)/))) return { level: 1, text: `${m[1]}. ${m[2]!.trim()}`, pp: 0 };
  if ((m = s.match(/^\((\d+)\)\s*(.*)/))) return { level: 2, text: `(${m[1]}) ${m[2]!.trim()}`, pp: 0 };
  if ((m = s.match(/^([①-⑳])\s*(.*)/))) return { level: 2, text: `${m[1]} ${m[2]!.trim()}`, pp: 0 };
  return null;
}

function para(pid: number, paraPr: number, charPr: number, text: string): string {
  const inner = text ? `<hp:t>${esc(text)}</hp:t>` : '<hp:t/>';
  return `<hp:p id="${pid}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}">${inner}</hp:run></hp:p>`;
}

// --- 마크다운 파이프 표 → 한글 표(hp:tbl) ---
const TBL_W = 42520;
const ROW_H = 2800;
function isTableSep(line: string): boolean {
  const s = line.trim();
  return !!s && s.includes('|') && s.includes('-') && [...s].every((ch) => '|:- \t'.includes(ch));
}
function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
function tableXml(rows: string[][], startPid: number): { xml: string; pid: number } {
  let pid = startPid;
  const R = rows.length;
  const C = Math.max(...rows.map((r) => r.length), 0);
  if (R === 0 || C === 0) return { xml: '', pid };
  const cw = Math.floor(TBL_W / C);
  const widths = C > 1 ? [...Array(C - 1).fill(cw), TBL_W - cw * (C - 1)] : [TBL_W];
  const tblId = pid++;
  const parts: string[] = [
    `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${R}" colCnt="${C}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">`,
    `<hp:sz width="${TBL_W}" widthRelTo="ABSOLUTE" height="${ROW_H * R}" heightRelTo="ABSOLUTE" protect="0"/>`,
    '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>',
    '<hp:outMargin left="0" right="0" top="0" bottom="0"/>',
    '<hp:inMargin left="0" right="0" top="0" bottom="0"/>',
  ];
  rows.forEach((row, r) => {
    const isHead = r === 0;
    const bfill = isHead ? '6' : '3';
    const cpr = isHead ? 13 : 0;
    const ppr = isHead ? 20 : 0;
    parts.push('<hp:tr>');
    for (let c = 0; c < C; c++) {
      const cell = c < row.length ? cleanInline(row[c]!) : '';
      const inner = cell ? `<hp:t>${esc(cell)}</hp:t>` : '<hp:t/>';
      parts.push(
        `<hp:tc name="" header="${isHead ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${bfill}">` +
          '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
          `<hp:p paraPrIDRef="${ppr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0" id="${pid}"><hp:run charPrIDRef="${cpr}">${inner}</hp:run></hp:p>` +
          '</hp:subList>' +
          `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>` +
          '<hp:cellSpan colSpan="1" rowSpan="1"/>' +
          `<hp:cellSz width="${widths[c]}" height="${ROW_H}"/>` +
          '<hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>',
      );
      pid++;
    }
    parts.push('</hp:tr>');
  });
  parts.push('</hp:tbl>');
  const p = `<hp:p id="${pid}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${parts.join('')}</hp:run></hp:p>`;
  pid++;
  return { xml: p, pid };
}

export function markdownToSection(md: string, title?: string): string {
  const tmpl = fs.readFileSync(path.join(ASSETS, 'report', 'section0.xml'), 'utf-8');
  const cut = tmpl.indexOf('</hp:p>');
  if (cut === -1) throw new Error('report section template missing first paragraph');
  const preamble = tmpl.slice(0, cut + '</hp:p>'.length);

  const paras: string[] = [];
  let pid = 1000000100;
  const add = (paraPr: number, charPr: number, text: string): void => {
    paras.push(para(pid, paraPr, charPr, text));
    pid += 1;
  };

  // 옵션 제목은 본문이 자체 H1(# ...)을 갖지 않을 때만 추가 — 둘 다면 동일 제목이 두 번 찍힌다.
  // (opf:title 메타데이터는 patchMeta 에서 별도로 항상 설정되므로 여기서 생략해도 파일 제목엔 영향 없음.)
  if (title && !md.trimStart().startsWith('# ')) { add(20, 7, cleanInline(title)); add(0, 0, ''); }

  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const s = (lines[i] ?? '').trim();
    if (s.startsWith('```')) {
      const lang = s.slice(3).trim().toLowerCase();
      i++;
      const start = i;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) i++;
      if (i < lines.length) {
        // 닫는 펜스 발견 → 코드블록 스킵.
        i++;
        if (lang.startsWith('mermaid')) add(24, 0, '▷ [다이어그램(mermaid)은 한글 변환에서 생략됨]');
      } else {
        // 닫히지 않은 펜스 → 내용 손실 방지: 펜스 마커만 버리고 내용은 일반 본문으로 재처리.
        i = start;
      }
      continue;
    }
    if (s.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) {
      const block: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) { block.push(lines[i]!); i++; }
      const rows = block.filter((ln) => ln.trim() && !isTableSep(ln)).map(splitRow).filter((r) => r.some(Boolean));
      if (rows.length) { const t = tableXml(rows, pid); paras.push(t.xml); pid = t.pid; add(0, 0, ''); }
      continue;
    }
    if (!s) { add(0, 0, ''); i++; continue; }
    if ([...s].every((ch) => '-=*_ '.includes(ch)) && s.length >= 3) { add(0, 0, ''); i++; continue; }
    if (s.startsWith('#### ') || s.startsWith('### ')) { add(0, 8, cleanInline(s.replace(/^#+/, '').trim())); i++; continue; }
    if (s.startsWith('## ')) { add(0, 13, cleanInline(s.slice(3))); i++; continue; }
    if (s.startsWith('# ')) { add(20, 7, cleanInline(s.slice(2))); i++; continue; }
    // 개조식 계층 — 첫줄 위치는 전각공백(레벨×2)으로, 여백왼쪽 0 + 줄바꿈 정렬은 paraPr 내어쓰기(- 49.4pt, · 66.5pt)로.
    const hi = hierItem(s);
    if (hi) { add(hi.pp, 0, FW.repeat(hi.level * 2) + hi.text); i++; continue; }
    add(0, 0, cleanInline(s));
    i++;
  }
  return preamble + '\n' + paras.join('\n') + '\n</hs:sec>\n';
}

function patchMeta(hpf: string, opts: { title?: string; creator?: string }): string {
  let out = hpf;
  if (opts.title) out = out.replace('<opf:title/>', `<opf:title>${esc(opts.title)}</opf:title>`);
  if (opts.creator) out = out.replace('<opf:meta name="creator" content="text"/>', `<opf:meta name="creator" content="${esc(opts.creator)}"/>`);
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

export function hwpxAvailable(): boolean {
  return fs.existsSync(path.join(ASSETS, 'base', 'mimetype'))
    && fs.existsSync(path.join(ASSETS, 'report', 'section0.xml'))
    && fs.existsSync(path.join(ASSETS, 'report', 'header.xml'));
}

/** 마크다운 → HWPX 바이트(ZIP). mimetype 을 STORED 첫 엔트리로. */
export function buildHwpx(md: string, opts: { title?: string; creator?: string } = {}): Buffer {
  const baseDir = path.join(ASSETS, 'base');
  const section = markdownToSection(md, opts.title);
  const files = walk(baseDir).map((abs) => ({ rel: path.relative(baseDir, abs).split(path.sep).join('/'), abs }));

  const entries: ZipEntry[] = [];
  const mime = files.find((f) => f.rel === 'mimetype');
  if (!mime) throw new Error('base/mimetype 누락');
  entries.push({ name: 'mimetype', data: fs.readFileSync(mime.abs), store: true });

  for (const f of files) {
    if (f.rel === 'mimetype') continue;
    let data: Buffer;
    if (f.rel === 'Contents/header.xml') data = fs.readFileSync(path.join(ASSETS, 'report', 'header.xml'));
    else if (f.rel === 'Contents/section0.xml') data = Buffer.from(section, 'utf-8');
    else if (f.rel === 'Contents/content.hpf') data = Buffer.from(patchMeta(fs.readFileSync(f.abs, 'utf-8'), opts), 'utf-8');
    else data = fs.readFileSync(f.abs);
    entries.push({ name: f.rel, data });
  }
  return createZip(entries);
}
