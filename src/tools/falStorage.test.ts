import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

// CONFIG.falKey 는 env 의존 → 테스트용 고정 키로 목킹(falStorage 는 CONFIG 만 참조).
vi.mock('../config', () => ({ CONFIG: { falKey: 'testkey' } }));
import { uploadToFalStorage } from './falStorage';

afterEach(() => vi.restoreAllMocks());

describe('uploadToFalStorage', () => {
  it('initiate→PUT→공개 URL 반환(초기화 먼저, 이후 바이너리 PUT)', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('x'));
    const calls: Array<{ url: string; method?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url); calls.push({ url: u, method: (init as RequestInit | undefined)?.method });
      if (u.includes('/storage/upload/initiate')) {
        return new Response(JSON.stringify({ file_url: 'https://v3.fal.media/files/x.png', upload_url: 'https://v3.fal.media/upload/x?sig=1' }), { status: 200 });
      }
      return new Response('', { status: 200 }); // PUT
    });
    const url = await uploadToFalStorage('/a/slide.png', 'image/png');
    expect(url).toBe('https://v3.fal.media/files/x.png');       // 서명 없는 file_url 반환(upload_url 아님)
    expect(calls[0]!.url).toContain('/storage/upload/initiate');
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.url).toContain('v3.fal.media/upload');
  });
  it('fal.media 아닌 호스트 응답 → 이형 throw(SSRF/이형 가드, PUT 미도달)', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ file_url: 'https://evil.example.com/x.png', upload_url: 'https://evil.example.com/up' }), { status: 200 }),
    );
    await expect(uploadToFalStorage('/a/slide.png', 'image/png')).rejects.toThrow('이형');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // initiate 만, PUT 미실행
  });
  it('initiate 실패(HTTP 500) → throw', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(uploadToFalStorage('/a/slide.png', 'image/png')).rejects.toThrow('initiate');
  });
  it('파일 없음 → throw(네트워크 호출 없음)', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(uploadToFalStorage('/a/none.png', 'image/png')).rejects.toThrow('파일');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
