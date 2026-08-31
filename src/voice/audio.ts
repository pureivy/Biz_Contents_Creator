/** 음성 외부 바이너리(ffmpeg·mlx_whisper·say) 단일 캡슐화 — async spawn(비블로킹) + 순수 헬퍼.
 *  외부 호출을 audio.run 한 곳에 모아 테스트에서 vi.spyOn(audio,'run') 가능하게 한다. */
import { spawn, execFileSync } from 'node:child_process';

export interface RunResult { stdout: Buffer; code: number }

export const audio = {
  /** 외부 바이너리 실행(async). stdin=opts.input, stdout 캡처. 0 아님/error 시 reject. */
  run(bin: string, args: string[], opts: { input?: Buffer; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(bin, args, { shell: false, signal: opts.signal });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
      timer.unref();
      child.stdout?.on('data', (d: Buffer) => chunks.push(d));
      child.stderr?.on('data', (d: Buffer) => errChunks.push(d));
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout: Buffer.concat(chunks), code: 0 });
        else {
          const stderr = Buffer.concat(errChunks).toString('utf-8').slice(0, 500);
          if (code !== null) {
            reject(new Error(`${bin} 종료코드 ${code}: ${stderr}`));
          } else {
            reject(new Error(`${bin} 신호종료(${signal}): ${stderr}`));
          }
        }
      });
      if (opts.input) { child.stdin?.write(opts.input); child.stdin?.end(); }
    });
  },
  /** PATH 에서 바이너리 존재 여부(동기, 가용성 체크용). */
  which(bin: string): boolean {
    try { execFileSync('which', [bin], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
    catch { return false; }
  },
};

/** TTS 낭독용 텍스트 정제: 마크다운/링크/이모지 제거, 공백 정리, 길이 상한. */
export function sanitizeForTts(text: string, maxLen = 4000): string {
  let t = text ?? '';
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');           // [라벨](url) -> 라벨
  t = t.replace(/[*_`#>~|]/g, ' ');                          // 마크다운 기호
  t = t.replace(/https?:\/\/\S+/g, ' ');                     // 남은 URL
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' '); // 이모지/기호
  t = t.replace(/\s+/g, ' ').trim();
  // "잎" 오독 보정 — ElevenLabs(multilingual v2)가 단독 음절 "잎"을 로마자 ip("아이피")로 읽는다.
  // 1차(2026-08-07, 보리수 씬3·6): 발화 첫머리만 관측돼 좁게 치환. 2차(2026-08-08, 참나무 씬1
  // "도토리 잎 사진"→"도토리 IP 사진"): 문중에서도 확률적으로 재발 → 발음이 동일한 전 위치로 확대.
  // 규칙: 단어 시작(앞이 한글 아님)의 잎 + {끝·비한글·자음 초성 음절} → "입"(종성 중화로 발음 동일).
  // 제외: 모음 초성 결합(잎이[이피]≠입이[이비] — 연음)과 복합어 속 잎(깻잎[깬닙]). previous_text·
  // language_code 는 실측 무효. 자막·본문은 원문 유지(이 함수는 TTS 입력 전용).
  // 아-잏 = ㅇ 초성 음절(아~잏) — 이 뒤에서만 연음이 일어나 발음이 달라진다.
  t = t.replace(/(^|[^가-힣])잎(?=$|[^가-힣]|[가-힣])/g, (m, pre: string, offset: number, s: string) => {
    const next = s[offset + m.length] ?? '';
    if (next >= '아' && next <= '잏') return m; // 모음(ㅇ 초성) 결합 — 연음이라 보존
    return `${pre}입`;
  });
  // "봉오리" 오독 보정(실측 2026-08-07) — ElevenLabs 가 위치 무관하게 [봉고리]로 읽는다(배롱나무 개화시기
  // 쇼츠 씬3·4, 복합어 꽃봉오리 포함 STT 재현). 하이픈 경계("봉-오리")가 발음 [봉오리]를 복원하고
  // 재생 길이가 원문과 동일(쉼 없음). 후보 실측: 띄어쓰기=어절 분리, 제로폭 공백=된소리화,
  // 아포스트로피=5회 중 1회 된소리 이탈, 하이픈=4회 전부 정상. 자막·본문은 원문 유지.
  t = t.replace(/봉오리/g, '봉-오리');
  // "놀이" 오독 보정(실측 2026-08-11) — "아이 놀이 공간"의 놀이를 [도리]로 읽어 "아이돌의 공간"으로
  // 들림(원문 3/3 재현·STT p=0.955). 후보 실측: 표기 교체 "노리"=3회 중 2회 여전히 [도리](철자 무관,
  // ㄴ 초성 자체가 흐려짐), 하이픈 "놀-이"=3회 전부 정상(연음 경계 복원, 봉오리 전례). 어절 시작
  // (앞이 한글 아님)의 놀이만 치환 — 조사 결합(놀이를)·후행 복합(놀이터)도 발음 동일이라 포함하되,
  // 선행 복합(물놀이)은 미관측이라 보존(잎 2차 교훈: 발음 동일이 보장되는 범위까지만 넓게).
  t = t.replace(/(^|[^가-힣])놀이/g, '$1놀-이');
  // "순치기" 오독 보정(실측 2026-08-11) — 위치 무관 [순칙]으로 음절 축약(원문 3/3 재현, 포도나무 쇼츠
  // 씬6 — 다음 편 예고 키워드라 예고 이행 루프에도 영향). 후보 실측: "순-치기"=3/3 실패, "순 치기"=
  // 2/3 실패, "순치-기"=3/3 실패, 음절별 "순-치-기"=3회 전부 정상(재생 리듬 자연, 자막·본문 원문 유지).
  t = t.replace(/순치기/g, '순-치-기');
  // "손끝"·"간격" 오독 보정(실측 2026-08-11, 블루베리 수확 쇼츠 사용자 청취 제보) — ㄴ+연구개음 연쇄에서
  // 비음화+자음 약화: 손끝→[송귿]("송긋", 씬2·6 재현·재현율 1/3), 간격→[강역](씬4 실물 관측, 재합성
  // 재현 0/3 = 확률성 — 고릅니다와 달리 발행 예정 실물에서 확정돼 등재). 후보 실측: 손-끝=3/3 정상,
  // 표기 교체 "손끗"=1/3 재발+1회 "송급" 악화로 기각, 간-격=3/3 무해. 자막·본문은 원문 유지.
  t = t.replace(/손끝/g, '손-끝');
  t = t.replace(/간격/g, '간-격');
  // "잔가지" 오독 보정(실측 2026-08-13, 나무 잎 색 변화 쇼츠 사용자 청취 제보) — 손끝·간격과 같은
  // ㄴ+연구개음(ㄱ) 비음화·약화로 [장가지/장아지](원문 3/3 재현, STT 전부 "장아지"). 하이픈
  // "잔-가지"=3/3 정상(같은 부류 전례와 동일 처방). 자막·본문은 원문 유지(이 함수는 TTS 입력 전용).
  t = t.replace(/잔가지/g, '잔-가지');
  return t.slice(0, maxLen);
}

/** `say -v '?'` 출력 파싱 → ko_KR 음성 이름 목록(괄호 앞 토큰). */
export function parseSayVoices(raw: string): string[] {
  const out: string[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!/\bko_KR\b/.test(line)) continue;
    const name = line.trim().split(/\s{2,}|\s\(/)[0]?.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
