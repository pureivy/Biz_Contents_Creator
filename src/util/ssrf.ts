/**
 * SSRF 가드 — 외부에서 받은/설정된 URL 을 서버가 fetch 하기 전 검사한다.
 * 커스텀 커넥터 endpoint·docsUrl 처럼 값이 사용자·AI·외부 문서에서 오는 URL 은
 * (1) https 만 허용, (2) DNS 해석 결과가 루프백·사설·링크로컬 대역이면 거부해
 * 내부망 스캔·클라우드 메타데이터 접근·http 평문 시크릿 유출을 막는다.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** IPv4/IPv6 문자열이 루프백·사설·링크로컬·유니크로컬 대역인가(순수). */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    const a = p[0] ?? -1, b = p[1] ?? -1;
    if (a === 127 || a === 10 || a === 0) return true;               // 루프백·사설·"this host"
    if (a === 172 && b >= 16 && b <= 31) return true;                // 172.16/12
    if (a === 192 && b === 168) return true;                         // 192.168/16
    if (a === 169 && b === 254) return true;                         // 링크로컬(클라우드 메타데이터)
    if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT 100.64/10
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === '::1' || s === '::') return true;                      // 루프백·미지정
    if (s.startsWith('fe80')) return true;                          // 링크로컬
    if (s.startsWith('fc') || s.startsWith('fd')) return true;      // 유니크로컬 fc00::/7
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));    // IPv4-매핑
    return false;
  }
  return true; // 판별 불가(비정상) → 안전 측 거부
}

/**
 * 외부 fetch 대상으로 안전한 공개 https URL 인가 — 아니면 사유 반환.
 * DNS 해석까지 해서 이름이 사설 IP 로 풀리는 리바인딩성 우회도 차단한다.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: '잘못된 URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https 만 허용됩니다' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return { ok: false, reason: '내부 호스트 차단' };
  // 리터럴 IP 는 즉시 판정, 이름은 DNS 해석 후 전 IP 검사(하나라도 사설이면 거부).
  if (net.isIP(host)) {
    return isPrivateIp(host) ? { ok: false, reason: '사설·루프백 IP 차단' } : { ok: true };
  }
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return { ok: false, reason: 'DNS 해석 실패' };
    if (addrs.some((a) => isPrivateIp(a.address))) return { ok: false, reason: '사설 IP 로 해석되는 호스트 차단' };
    return { ok: true };
  } catch { return { ok: false, reason: 'DNS 해석 실패' }; }
}
