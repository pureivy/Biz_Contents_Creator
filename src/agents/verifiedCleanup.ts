// verified-<brand>.md 소급 정리 — 이미 승격된 줄에 Task 12 거절 규칙을 재적용해 근거 미달 줄을 걸러낸다(원장 없음, 순수 함수).
import { rejectVerifiedLine } from './workspace';

const LINE_RE = /^- \((\d{4}-\d{2}-\d{2})\) (.*?) _\(근거: (.*)\)_\s*$/;

/** 검증 줄 1개를 파싱 — 형식이 맞으면 { raw, claim, source }, 아니면 { raw } 만. */
export function splitVerifiedLines(
  text: string,
): Array<{ raw: string; claim: string; source: string } | { raw: string }> {
  return text.split('\n').map((raw) => {
    const m = LINE_RE.exec(raw);
    if (!m) return { raw };
    return { raw, claim: m[2] ?? '', source: m[3] ?? '' };
  });
}

/** 형식이 맞는 줄만 거절 규칙으로 재심사 — 통과(keep) / 미달(archive). 형식 밖 줄은 keep. */
export function partitionVerified(text: string): { keep: string[]; archive: string[] } {
  const keep: string[] = [];
  const archive: string[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) { keep.push(line); continue; }
    (rejectVerifiedLine(m[2] ?? '', m[3] ?? '') ? archive : keep).push(line);
  }
  return { keep, archive };
}

/** 아카이브 재평가 — 규칙이 좁혀진 뒤 지금은 통과하는 줄만 restore 로 뽑아낸다. 여전히 거절되는 줄·헤더·빈 줄 등 형식 밖 줄은 stay(아카이브 잔류). */
export function restoreVerified(text: string): { stay: string[]; restore: string[] } {
  const stay: string[] = [];
  const restore: string[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) { stay.push(line); continue; }
    (rejectVerifiedLine(m[2] ?? '', m[3] ?? '') ? stay : restore).push(line);
  }
  return { stay, restore };
}
