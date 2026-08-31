import { describe, it, expect } from 'vitest';
import { isPrivateIp, assertPublicHttpsUrl } from './ssrf';

describe('isPrivateIp — 사설·루프백·링크로컬 판정', () => {
  it('IPv4 사설/루프백/링크로컬 = true', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it('IPv4 공개 = false', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '100.128.0.1']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
  it('IPv6 루프백·링크로컬·유니크로컬·매핑 = true', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::3', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it('비정상 문자열 = true(안전 측 거부)', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
  });
});

describe('assertPublicHttpsUrl — fetch 전 게이트', () => {
  it('http·잘못된 URL·내부 호스트 이름 거부(DNS 불필요)', async () => {
    expect((await assertPublicHttpsUrl('http://example.com')).ok).toBe(false);   // 평문
    expect((await assertPublicHttpsUrl('보안없음')).ok).toBe(false);              // 파싱 실패
    expect((await assertPublicHttpsUrl('https://localhost/x')).ok).toBe(false);   // localhost
    expect((await assertPublicHttpsUrl('https://foo.local/x')).ok).toBe(false);   // .local
  });
  it('리터럴 사설 IP 거부 / 공개 IP 허용(DNS 불필요)', async () => {
    expect((await assertPublicHttpsUrl('https://127.0.0.1/x')).ok).toBe(false);
    expect((await assertPublicHttpsUrl('https://169.254.169.254/latest')).ok).toBe(false); // 메타데이터
    expect((await assertPublicHttpsUrl('https://8.8.8.8/x')).ok).toBe(true);
  });
});
