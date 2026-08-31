/**
 * 최소 ZIP 리더(의존성 없음) — 중앙 디렉토리를 읽어 엔트리별 압축 해제.
 * HWPX/DOCX/XLSX/PPTX 텍스트 추출용(이들은 ZIP+XML). zlib.inflateRawSync 사용.
 */
import zlib from 'node:zlib';

const PER_ENTRY_MAX = 64 * 1024 * 1024;    // 엔트리 1개 해제 상한(64MB) — 압축폭탄 단일엔트리 방어
const ARCHIVE_MAX = 256 * 1024 * 1024;     // 아카이브 전체 해제 총량 상한(256MB)

export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (buf.length < 22) return out;
  let total = 0; // 전 엔트리 누적 해제 바이트 — 예산 초과 시 중단(zip bomb 방어, 보안점검)
  // EOCD(0x06054b50) 를 끝에서 탐색(주석 최대 65535B 고려).
  let eocd = -1;
  const minI = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minI; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // 중앙 디렉토리 오프셋
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    if (lho + 30 <= buf.length) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      try {
        // 엔트리별 출력 상한(maxOutputLength)으로 단일 엔트리 폭탄 방어, 누적 총량으로 아카이브 폭탄 방어.
        const data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp, { maxOutputLength: PER_ENTRY_MAX });
        total += data.length;
        if (total > ARCHIVE_MAX) break; // 전체 예산 초과 → 이후 엔트리 중단(부분 결과 반환)
        out.set(name, data);
      } catch { /* 깨진 엔트리·상한 초과는 건너뜀 */ }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
