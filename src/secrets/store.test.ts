import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText, upsertEnvText, maskSecret, getYoutubeAccount, setYoutubeToken, parseMetaTokens } from './store';

// .env 가 '단일 값 저장소'가 되면서 UI 편집이 파일을 직접 고쳐 쓴다 — 손으로 관리하던
// 주석/빈 줄/모르는 키를 절대 훼손하지 않아야 한다(실 .env 엔 커밋 금지 실키가 있음).

describe('parseEnvText — .env 텍스트 → 값 맵', () => {
  it('기본 KEY=value, 공백/따옴표 허용', () => {
    const v = parseEnvText('A=1\nB = two \nC="with space"\nD=\'single\'\n');
    expect(v).toEqual({ A: '1', B: 'two', C: 'with space', D: 'single' });
  });
  it('주석·빈 줄·비정형 라인 무시, 주석 처리된 키는 값 아님', () => {
    const v = parseEnvText('# NOTE\n\n#SECRET_KEY=hidden\nREAL=x\nnot a line\n');
    expect(v).toEqual({ REAL: 'x' });
  });
  it('중복 키는 마지막 값(loadEnvFile 과 동일 동작)', () => {
    expect(parseEnvText('K=old\nK=new\n').K).toBe('new');
  });
  it('export 접두 허용', () => {
    expect(parseEnvText('export TOK=abc\n').TOK).toBe('abc');
  });
});

describe('upsertEnvText — 키 교체/추가/삭제, 나머지 라인 보존', () => {
  const BASE = '# 결제 키 — 절대 커밋 금지\nAAA=1\n\n#COMMENTED=out\nBBB="b b"\n';
  it('기존 키 교체 — 주석·빈 줄·다른 키 그대로', () => {
    const out = upsertEnvText(BASE, 'AAA', '99');
    expect(out).toBe('# 결제 키 — 절대 커밋 금지\nAAA=99\n\n#COMMENTED=out\nBBB="b b"\n');
  });
  it('새 키는 끝에 추가(개행 정리)', () => {
    const out = upsertEnvText(BASE, 'NEW_KEY', 'v');
    expect(out.endsWith('BBB="b b"\nNEW_KEY=v\n')).toBe(true);
    expect(parseEnvText(out).NEW_KEY).toBe('v');
  });
  it('삭제(undefined) — 해당 라인만 사라짐, 주석 처리된 동명 라인은 보존', () => {
    const out = upsertEnvText('#K=keep\nK=drop\nOTHER=1\n', 'K', undefined);
    expect(out).toBe('#K=keep\nOTHER=1\n');
  });
  it('중복 라인은 하나로 정리', () => {
    const out = upsertEnvText('K=a\nK=b\n', 'K', 'c');
    expect(out).toBe('K=c\n');
  });
  it('공백·# 포함 값은 따옴표로 감싸고 파싱 시 원복(라운드트립)', () => {
    for (const v of ['has space', 'ha#sh', 'quo"te', 'back\\slash', 'plain-token_123']) {
      const out = upsertEnvText('', 'K', v);
      expect(parseEnvText(out).K).toBe(v);
    }
  });
  it('빈 파일에서 추가', () => {
    expect(upsertEnvText('', 'A', '1')).toBe('A=1\n');
  });
});

describe('maskSecret — 항상 마스킹', () => {
  it('짧으면 전부, 길면 앞4·뒤4', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('abcd')).toBe('••••');
    expect(maskSecret('sk-test-1234567890')).toBe('sk-t••••7890');
  });
});

// 브랜드별 네이버 계정 — 범용('')은 평면 키, 브랜드는 NAVER_ACCOUNTS JSON blob, 폴백 없음(격리).
// get/setNaverAccount 는 .env(ENV_FILE=GEPA_ENV_FILE)에 read/write 하므로 임시 파일을 가리키게 한 뒤
// vi.resetModules + 동적 import 로 실제 파일 왕복을 검증한다(모듈 로드 시 ENV_FILE 고정 특성 우회).
describe('네이버 브랜드별 계정 — 격리·라운드트립', () => {
  const NAVER_ENV = ['NAVER_ACCOUNTS', 'NAVER_BLOG_ID', 'NAVER_LOGIN_ID', 'NAVER_LOGIN_PW'];
  let tmpEnv: string;
  let mod: typeof import('./store');
  beforeEach(async () => {
    tmpEnv = path.join(os.tmpdir(), 'naver-acct-store-test.env');
    fs.writeFileSync(tmpEnv, '', { mode: 0o600 });
    process.env.GEPA_ENV_FILE = tmpEnv;
    for (const k of NAVER_ENV) delete process.env[k]; // 이전 테스트의 process.env 미러링 잔재 제거
    vi.resetModules();
    mod = await import('./store');
  });
  afterEach(() => {
    try { fs.rmSync(tmpEnv); } catch { /* 이미 없음 */ }
    delete process.env.GEPA_ENV_FILE;
    for (const k of NAVER_ENV) delete process.env[k];
  });

  it('범용(빈 슬러그)은 평면 키에 저장·조회, blob 미사용', () => {
    mod.setNaverAccount('', { blogId: 'myblog', loginId: 'me', loginPw: 'secret' });
    const txt = fs.readFileSync(tmpEnv, 'utf-8');
    expect(txt).toMatch(/^NAVER_BLOG_ID=myblog$/m);
    expect(txt).not.toContain('NAVER_ACCOUNTS');
    expect(mod.getNaverAccount('')).toEqual({ blogId: 'myblog', loginId: 'me', loginPw: 'secret' });
  });

  it('브랜드는 JSON blob 에 슬러그별 저장, 평면 키·타 브랜드와 섞이지 않음', () => {
    mod.setNaverAccount('cafe-a', { blogId: 'blogA', loginId: 'idA' });
    mod.setNaverAccount('cafe-b', { blogId: 'blogB' });
    expect(mod.getNaverAccount('cafe-a')).toEqual({ blogId: 'blogA', loginId: 'idA', loginPw: '' });
    expect(mod.getNaverAccount('cafe-b')).toEqual({ blogId: 'blogB', loginId: '', loginPw: '' });
    const txt = fs.readFileSync(tmpEnv, 'utf-8');
    expect(txt).toContain('NAVER_ACCOUNTS=');
    expect(txt).not.toMatch(/^NAVER_BLOG_ID=/m); // 브랜드는 평면 키를 건드리지 않음
  });

  it('브랜드는 범용 평면 키로 폴백하지 않는다(미설정 브랜드 = 빈 계정)', () => {
    mod.setNaverAccount('', { blogId: 'globalblog' });
    expect(mod.getNaverAccount('unset-brand')).toEqual({ blogId: '', loginId: '', loginPw: '' });
  });

  it('부분 갱신은 기존 필드 보존, 빈 값은 해당 필드 삭제', () => {
    mod.setNaverAccount('cafe-a', { blogId: 'b1', loginId: 'i1', loginPw: 'p1' });
    mod.setNaverAccount('cafe-a', { loginPw: 'p2' });
    expect(mod.getNaverAccount('cafe-a')).toEqual({ blogId: 'b1', loginId: 'i1', loginPw: 'p2' });
    mod.setNaverAccount('cafe-a', { loginId: '' });
    expect(mod.getNaverAccount('cafe-a')).toEqual({ blogId: 'b1', loginId: '', loginPw: 'p2' });
  });

  it('naverAccountView — blogId 평문, 로그인 마스킹·설정여부', () => {
    mod.setNaverAccount('cafe-a', { blogId: 'openblog', loginId: 'longloginid', loginPw: 'pw' });
    const v = mod.naverAccountView('cafe-a');
    expect(v.blogId).toBe('openblog');
    expect(v.loginIdSet).toBe(true);
    expect(v.loginPwSet).toBe(true);
    expect(v.loginIdMasked).not.toBe('longloginid');
  });
});

// 브랜드별 유튜브 채널 토큰 — NAVER_ACCOUNTS 와 동일 패턴(JSON blob, 폴백 없음, 범용('') 도 blob).
// get/setYoutubeToken 은 .env(ENV_FILE=GEPA_ENV_FILE)에 read/write 하므로 임시 파일을 가리키게 한 뒤
// vi.resetModules + 동적 import 로 실제 파일 왕복을 검증한다(모듈 로드 시 ENV_FILE 고정 특성 우회).
describe('유튜브 브랜드별 채널 토큰 — 격리·라운드트립(네이버 미러)', () => {
  const YT_ENV = ['YOUTUBE_TOKENS'];
  let tmpEnv: string;
  let mod: typeof import('./store');
  beforeEach(async () => {
    tmpEnv = path.join(os.tmpdir(), 'youtube-token-store-test.env');
    fs.writeFileSync(tmpEnv, '', { mode: 0o600 });
    process.env.GEPA_ENV_FILE = tmpEnv;
    for (const k of YT_ENV) delete process.env[k]; // 이전 테스트의 process.env 미러링 잔재 제거
    vi.resetModules();
    mod = await import('./store');
  });
  afterEach(() => {
    try { fs.rmSync(tmpEnv); } catch { /* 이미 없음 */ }
    delete process.env.GEPA_ENV_FILE;
    for (const k of YT_ENV) delete process.env[k];
  });

  it('미연결 브랜드는 빈 토큰 반환(폴백 없음)', () => {
    expect(mod.getYoutubeAccount('unset-brand')).toEqual({ refreshToken: '' });
  });

  it('저장 후 라운드트립 — 브랜드 A 저장 → A로 읽힘', () => {
    mod.setYoutubeToken('brand-a', 'refresh_token_a_value');
    expect(mod.getYoutubeAccount('brand-a')).toEqual({ refreshToken: 'refresh_token_a_value' });
  });

  it('브랜드 격리 — A 저장이 B에 안 보임, B는 여전히 빈 토큰', () => {
    mod.setYoutubeToken('brand-a', 'token_a');
    expect(mod.getYoutubeAccount('brand-b')).toEqual({ refreshToken: '' });
    expect(mod.getYoutubeAccount('brand-a')).toEqual({ refreshToken: 'token_a' });
  });

  it('다른 브랜드 보존 — A·B 저장 후 B 갱신 → A 불변', () => {
    mod.setYoutubeToken('brand-a', 'token_a');
    mod.setYoutubeToken('brand-b', 'token_b');
    mod.setYoutubeToken('brand-b', 'token_b_updated');
    expect(mod.getYoutubeAccount('brand-a')).toEqual({ refreshToken: 'token_a' });
    expect(mod.getYoutubeAccount('brand-b')).toEqual({ refreshToken: 'token_b_updated' });
  });

  it('빈 문자열로 연결 해제 — A 저장 → setYoutubeToken("A", "") → 빈 토큰', () => {
    mod.setYoutubeToken('brand-a', 'token_a');
    mod.setYoutubeToken('brand-a', '');
    expect(mod.getYoutubeAccount('brand-a')).toEqual({ refreshToken: '' });
  });

  it('범용("") 슬러그도 blob 라운드트립', () => {
    mod.setYoutubeToken('', 'universal_token');
    expect(mod.getYoutubeAccount('')).toEqual({ refreshToken: 'universal_token' });
    const txt = fs.readFileSync(tmpEnv, 'utf-8');
    expect(txt).toContain('YOUTUBE_TOKENS=');
  });
});

// 메타(인스타·페북) 계정 파서 — 순수 함수(테스트만 실행, .env 접근 없음)
describe('parseMetaTokens', () => {
  it('정상 blob → 슬러그별 계정', () => {
    const raw = JSON.stringify({ 'brand-a': { pageId: '1', igUserId: '2', pageAccessToken: 't' } });
    expect(parseMetaTokens(raw)['brand-a']).toEqual({ pageId: '1', igUserId: '2', pageAccessToken: 't' });
  });
  it('빈 문자열·깨진 JSON·비객체 → 빈 맵', () => {
    expect(parseMetaTokens('')).toEqual({});
    expect(parseMetaTokens('{broken')).toEqual({});
    expect(parseMetaTokens('"str"')).toEqual({});
  });
});

// 브랜드별 커스텀 키 카드 — 정의(secrets.json)에 brand 를 달아 카드가 브랜드별로 갈린다.
// 값은 여전히 .env 평면 키(단일 저장소·process.env 미러 유지) — 같은 키 이름은 브랜드 간
// 공유가 아니라 '충돌'이므로 다른 브랜드에서의 동명 추가는 거부한다(값 덮어쓰기 원천 차단).
describe('브랜드별 커스텀 키 — 정의 격리·동명 충돌 거부', () => {
  let tmpEnv: string;
  let tmpData: string;
  let mod: typeof import('./store');
  beforeEach(async () => {
    tmpEnv = path.join(os.tmpdir(), `custom-keys-store-test-${process.pid}.env`);
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-keys-data-'));
    fs.writeFileSync(tmpEnv, '', { mode: 0o600 });
    process.env.GEPA_ENV_FILE = tmpEnv;
    process.env.GEPA_DATA_DIR = tmpData;
    delete process.env.MY_TEST_KEY;
    vi.resetModules();
    mod = await import('./store');
  });
  afterEach(() => {
    try { fs.rmSync(tmpEnv); } catch { /* 이미 없음 */ }
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 이미 없음 */ }
    delete process.env.GEPA_ENV_FILE;
    delete process.env.GEPA_DATA_DIR;
    delete process.env.MY_TEST_KEY;
  });

  const customs = (): { key: string; brand?: string }[] =>
    mod.listKeys().filter((k) => !k.builtin).map((k) => ({ key: k.key, brand: k.brand }));

  it('브랜드로 추가한 키 카드는 brand 를 달고 나온다(값은 .env 평면 키)', () => {
    expect(mod.addCustom('MY_TEST_KEY', '내 키', '', 'v1', 'cafe-a').ok).toBe(true);
    expect(customs()).toEqual([{ key: 'MY_TEST_KEY', brand: 'cafe-a' }]);
    expect(fs.readFileSync(tmpEnv, 'utf-8')).toMatch(/^MY_TEST_KEY=v1$/m);
  });

  it('공용(빈 브랜드) 추가·기존(brand 없는) 정의는 brand="" 로 나온다', () => {
    expect(mod.addCustom('MY_TEST_KEY', '', '', '', '').ok).toBe(true);
    expect(customs()).toEqual([{ key: 'MY_TEST_KEY', brand: '' }]);
    // 레거시 정의(brand 필드 자체가 없음)도 "" 로 정규화되는지 — secrets.json 직접 기록으로 재현
    fs.writeFileSync(path.join(tmpData, 'secrets.json'),
      JSON.stringify({ custom: [{ key: 'LEGACY_KEY', label: 'L', icon: '', desc: '' }], hidden: [] }));
    expect(customs()).toEqual([{ key: 'LEGACY_KEY', brand: '' }]);
  });

  it('다른 브랜드의 동명 키 추가는 거부 — 정의·값 모두 불변', () => {
    expect(mod.addCustom('MY_TEST_KEY', '', '', 'v1', 'cafe-a').ok).toBe(true);
    const r = mod.addCustom('MY_TEST_KEY', '', '', 'v2', 'cafe-b');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(customs()).toEqual([{ key: 'MY_TEST_KEY', brand: 'cafe-a' }]);
    expect(fs.readFileSync(tmpEnv, 'utf-8')).toMatch(/^MY_TEST_KEY=v1$/m);
  });

  it('같은 브랜드 재추가는 값만 갱신(정의 중복 없음)', () => {
    expect(mod.addCustom('MY_TEST_KEY', '', '', 'v1', 'cafe-a').ok).toBe(true);
    expect(mod.addCustom('MY_TEST_KEY', '', '', 'v2', 'cafe-a').ok).toBe(true);
    expect(customs()).toEqual([{ key: 'MY_TEST_KEY', brand: 'cafe-a' }]);
    expect(fs.readFileSync(tmpEnv, 'utf-8')).toMatch(/^MY_TEST_KEY=v2$/m);
  });

  it('브랜드 키 삭제 — 정의·값 완전 제거(기존 동작 유지)', () => {
    expect(mod.addCustom('MY_TEST_KEY', '', '', 'v1', 'cafe-a').ok).toBe(true);
    expect(mod.deleteKey('MY_TEST_KEY').ok).toBe(true);
    expect(customs()).toEqual([]);
    expect(fs.readFileSync(tmpEnv, 'utf-8')).not.toContain('MY_TEST_KEY');
  });
});

// 브랜드 삭제 동반 정리 — 남기면 카드 도달 불가(선택자에 없는 브랜드) + 동명 재추가 영구 거부
// + .env 값이 앱 전역(process.env)에 계속 주입되는 고아 정의가 된다.
describe('purgeCustomKeysForBrand — 브랜드 삭제 시 커스텀 키 동반 제거', () => {
  let tmpEnv: string;
  let tmpData: string;
  let mod: typeof import('./store');
  beforeEach(async () => {
    tmpEnv = path.join(os.tmpdir(), `purge-keys-store-test-${process.pid}.env`);
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-keys-data-'));
    fs.writeFileSync(tmpEnv, '', { mode: 0o600 });
    process.env.GEPA_ENV_FILE = tmpEnv;
    process.env.GEPA_DATA_DIR = tmpData;
    for (const k of ['KEY_A', 'KEY_B', 'KEY_COMMON']) delete process.env[k];
    vi.resetModules();
    mod = await import('./store');
  });
  afterEach(() => {
    try { fs.rmSync(tmpEnv); } catch { /* 이미 없음 */ }
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 이미 없음 */ }
    delete process.env.GEPA_ENV_FILE;
    delete process.env.GEPA_DATA_DIR;
    for (const k of ['KEY_A', 'KEY_B', 'KEY_COMMON']) delete process.env[k];
  });

  it('해당 브랜드 정의·값만 제거, 타 브랜드·공용은 보존', () => {
    mod.addCustom('KEY_A', '', '', 'va', 'cafe-a');
    mod.addCustom('KEY_B', '', '', 'vb', 'cafe-b');
    mod.addCustom('KEY_COMMON', '', '', 'vc', '');
    expect(mod.purgeCustomKeysForBrand('cafe-a')).toBe(1);
    const customs = mod.listKeys().filter((k) => !k.builtin).map((k) => k.key);
    expect(customs.sort()).toEqual(['KEY_B', 'KEY_COMMON']);
    const txt = fs.readFileSync(tmpEnv, 'utf-8');
    expect(txt).not.toContain('KEY_A');
    expect(txt).toMatch(/^KEY_B=vb$/m);
    expect(txt).toMatch(/^KEY_COMMON=vc$/m);
    // 제거 후 같은 이름을 다른 브랜드에서 재사용 가능(점유 해제)
    expect(mod.addCustom('KEY_A', '', '', 'v2', 'cafe-b').ok).toBe(true);
  });

  it('빈 슬러그는 no-op(공용 키 대량 삭제 방지) — 0 반환', () => {
    mod.addCustom('KEY_COMMON', '', '', 'vc', '');
    expect(mod.purgeCustomKeysForBrand('')).toBe(0);
    expect(mod.listKeys().filter((k) => !k.builtin)).toHaveLength(1);
  });
});

// 브랜드 삭제 시 채널 계정 blob 동반 정리 — 잔존 시 죽은 브랜드의 로그인·토큰이 .env 에 남고
// 동명 재생성 브랜드가 옛 계정을 승계한다(실사고: 국민원예종묘 삭제 후 YOUTUBE_TOKENS 잔재, 2026-07-22).
describe('purgeBrandAccounts — 삭제 브랜드의 계정 blob 정리', () => {
  const KEYS = ['NAVER_ACCOUNTS', 'YOUTUBE_TOKENS', 'META_TOKENS'];
  let tmpEnv: string;
  let mod: typeof import('./store');
  beforeEach(async () => {
    tmpEnv = path.join(os.tmpdir(), 'purge-acct-store-test.env');
    fs.writeFileSync(tmpEnv, '', { mode: 0o600 });
    process.env.GEPA_ENV_FILE = tmpEnv;
    for (const k of KEYS) delete process.env[k];
    vi.resetModules();
    mod = await import('./store');
  });
  afterEach(() => {
    try { fs.rmSync(tmpEnv); } catch { /* 이미 없음 */ }
    delete process.env.GEPA_ENV_FILE;
    for (const k of KEYS) delete process.env[k];
  });

  it('세 blob 에서 해당 슬러그만 제거, 타 브랜드는 보존', () => {
    mod.setNaverAccount('dead', { blogId: 'b', loginId: 'i', loginPw: 'p' });
    mod.setNaverAccount('alive', { blogId: 'keep' });
    mod.setYoutubeToken('dead', 'rt-dead');
    mod.setYoutubeToken('alive', 'rt-alive');
    mod.setMetaToken('dead', { igUserId: 'ig1', pageAccessToken: 'tok1' });
    expect(mod.purgeBrandAccounts('dead')).toBe(3);
    expect(mod.getNaverAccount('dead')).toEqual({ blogId: '', loginId: '', loginPw: '' });
    expect(mod.getYoutubeAccount('dead').refreshToken).toBe('');
    expect(mod.getMetaAccount('dead').pageAccessToken).toBe('');
    expect(mod.getNaverAccount('alive').blogId).toBe('keep');
    expect(mod.getYoutubeAccount('alive').refreshToken).toBe('rt-alive');
    const txt = fs.readFileSync(tmpEnv, 'utf-8');
    expect(txt).not.toContain('dead'); // 기밀 잔존 없음(.env 텍스트 차원)
  });

  it('항목 없는 브랜드·범용은 no-op 0', () => {
    mod.setYoutubeToken('', 'rt-generic'); // 범용('') 은 브랜드 아님 — 보호
    expect(mod.purgeBrandAccounts('ghost')).toBe(0);
    expect(mod.purgeBrandAccounts('')).toBe(0);
    expect(mod.getYoutubeAccount('').refreshToken).toBe('rt-generic');
  });

  // 메타는 IG·FB 두 연결이 한 항목에 공존 → 부분 해제 setter 로는 절반이 남는다. 브랜드 삭제는 통째 제거여야
  // 죽은 브랜드의 페이지 토큰이 .env 에 잔존하지 않는다(위 '기밀 잔존 없음' 계약을 FB 축까지 확장).
  it('메타 IG+FB 양쪽 연결된 브랜드도 통째 제거(페이지 토큰 잔존 없음)', () => {
    mod.setMetaToken('dead', { igUserId: 'ig-dead', pageAccessToken: 'igtok-dead' });
    mod.setMetaPage('dead', { pageId: 'PG-dead', pageToken: 'pgtok-dead' });
    mod.setMetaPage('alive', { pageId: 'PG-alive', pageToken: 'pgtok-alive' });
    expect(mod.purgeBrandAccounts('dead')).toBe(1);
    expect(mod.getMetaAccount('dead')).toEqual({ pageId: '', igUserId: '', pageAccessToken: '', pageToken: '' });
    expect(mod.getMetaAccount('alive').pageToken).toBe('pgtok-alive'); // 타 브랜드 페이지 연결 보존
    const txt = fs.readFileSync(tmpEnv, 'utf-8');
    expect(txt).not.toContain('pgtok-dead');
    expect(txt).not.toContain('igtok-dead');
  });
});

// 인스타 연결과 페이스북 페이지 연결은 앱·토큰·호스트가 다른 독립 축이다. 한쪽 재연결·해제가 다른 쪽
// 자격증명을 지우면 '연결됐다고 표시되는데 발행만 실패'가 되어 진단이 불가능해진다(설계 불변식).
describe('메타 IG·FB 연결 독립성', () => {
  let tmpEnv: string; let mod: typeof import('./store');
  beforeEach(async () => {
    tmpEnv = path.join(os.tmpdir(), 'meta-link-store-test.env');
    fs.writeFileSync(tmpEnv, '', { mode: 0o600 });
    process.env.GEPA_ENV_FILE = tmpEnv;
    delete process.env.META_TOKENS;
    vi.resetModules();
    mod = await import('./store');
  });
  afterEach(() => {
    try { fs.rmSync(tmpEnv); } catch { /* 이미 없음 */ }
    delete process.env.GEPA_ENV_FILE;
    delete process.env.META_TOKENS;
  });

  it('페이지 연결이 IG 자격증명을 보존하고, IG 재연결이 페이지 토큰을 보존', () => {
    mod.setMetaToken('b', { igUserId: 'IG1', pageAccessToken: 'IGTOK1' });
    mod.setMetaPage('b', { pageId: 'PG1', pageToken: 'PGTOK1' });
    expect(mod.getMetaAccount('b')).toEqual({ igUserId: 'IG1', pageAccessToken: 'IGTOK1', pageId: 'PG1', pageToken: 'PGTOK1' });
    mod.setMetaToken('b', { igUserId: 'IG2', pageAccessToken: 'IGTOK2' }); // 인스타 재연결(60일 토큰 갱신)
    expect(mod.getMetaAccount('b')).toEqual({ igUserId: 'IG2', pageAccessToken: 'IGTOK2', pageId: 'PG1', pageToken: 'PGTOK1' });
    mod.setMetaPage('b', { pageId: 'PG2', pageToken: 'PGTOK2' });          // 페이지 재연결
    expect(mod.getMetaAccount('b')).toEqual({ igUserId: 'IG2', pageAccessToken: 'IGTOK2', pageId: 'PG2', pageToken: 'PGTOK2' });
  });

  it('한쪽 해제는 다른 쪽만 남긴다(연결 축 부분 해제)', () => {
    mod.setMetaToken('b', { igUserId: 'IG1', pageAccessToken: 'IGTOK1' });
    mod.setMetaPage('b', { pageId: 'PG1', pageToken: 'PGTOK1' });
    mod.setMetaPage('b', null);                                  // 페북만 해제
    expect(mod.getMetaAccount('b')).toEqual({ igUserId: 'IG1', pageAccessToken: 'IGTOK1', pageId: '', pageToken: '' });
    mod.setMetaPage('b', { pageId: 'PG1', pageToken: 'PGTOK1' });
    mod.setMetaToken('b', null);                                 // 인스타만 해제
    expect(mod.getMetaAccount('b')).toEqual({ igUserId: '', pageAccessToken: '', pageId: 'PG1', pageToken: 'PGTOK1' });
  });

  it('FB 전용 연결(IG 없음)도 blob 에 보존된다 — 페북 먼저 연결하는 순서 지원', () => {
    mod.setMetaPage('b', { pageId: 'PG1', pageToken: 'PGTOK1' });
    expect(mod.getMetaAccount('b').pageToken).toBe('PGTOK1');
    // 다른 브랜드를 저장해도(정리 루프 통과) FB 전용 항목이 떨어져 나가지 않아야 한다
    mod.setMetaToken('other', { igUserId: 'IG9', pageAccessToken: 'IGTOK9' });
    expect(mod.getMetaAccount('b').pageToken).toBe('PGTOK1');
  });

  it('양쪽 다 해제되면 항목 자체가 사라진다(빈 자격증명 잔존 금지)', () => {
    mod.setMetaToken('b', { igUserId: 'IG1', pageAccessToken: 'IGTOK1' });
    mod.setMetaPage('b', { pageId: 'PG1', pageToken: 'PGTOK1' });
    mod.setMetaToken('b', null);
    mod.setMetaPage('b', null);
    expect(fs.readFileSync(tmpEnv, 'utf-8')).not.toContain('META_TOKENS');
  });
});

// setKey 값 위생 — 개행·제어문자로 .env 에 임의 env 라인을 주입하는 것 차단(보안점검 2026-07-22).
describe('setKey — 개행·제어문자 주입 거부', () => {
  const KEYS = ['ANTHROPIC_API_KEY'];
  let tmpEnv: string; let mod: typeof import('./store');
  beforeEach(async () => {
    tmpEnv = path.join(os.tmpdir(), 'setkey-inject-test.env');
    fs.writeFileSync(tmpEnv, '', { mode: 0o600 });
    process.env.GEPA_ENV_FILE = tmpEnv;
    for (const k of KEYS) delete process.env[k];
    vi.resetModules(); mod = await import('./store');
  });
  afterEach(() => { try { fs.rmSync(tmpEnv); } catch { /* */ } delete process.env.GEPA_ENV_FILE; for (const k of KEYS) delete process.env[k]; });

  it('개행 포함 값 거부 — .env 에 EVIL 라인 안 생김', () => {
    const r = mod.setKey('ANTHROPIC_API_KEY', 'sk-ant-abc\nEVIL_KEY=pwned');
    expect(r.ok).toBe(false);
    const txt = fs.readFileSync(tmpEnv, 'utf-8');
    expect(txt).not.toContain('EVIL_KEY');
  });
  it('정상 값은 통과', () => {
    expect(mod.setKey('ANTHROPIC_API_KEY', 'sk-ant-valid123').ok).toBe(true);
  });
});
