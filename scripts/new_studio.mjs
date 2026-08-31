#!/usr/bin/env node
// 새 기업 스튜디오 온보딩 — 기업 정보를 받아 독립 인스턴스(데이터 디렉토리·env·브랜드 프로필)를 만든다.
//
//   node scripts/new_studio.mjs --name "한빛수제청" --port 8788 \
//     --industry 식품 --products "유자청:국산 유자 100%,자몽청:저당 레시피" \
//     --audience "3040 건강 관심 주부" --tone "친근한 존댓말" --seeds "수제청,과일청 선물"
//
// 만들어지는 것: <dir>/data (부팅 시 직원 조직 자동 시드) + <dir>/data/brand.yaml + <dir>/.env
// 기동: GEPA_ENV_FILE=<dir>/.env pnpm start  (프로젝트 루트에서 — UI 정적 서빙이 cwd 기준)
// 네이버 로그인 프로필은 NAVER_PROFILE_DIR 로 인스턴스별 분리(기업별 네이버 계정 혼선 방지).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (k, d = '') => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const name = opt('name');
if (!name) {
  console.error('사용법: node scripts/new_studio.mjs --name "업체명" [--port 8788] [--dir ~/studios/slug]');
  console.error('        [--industry 업종] [--products "이름:특징,이름:특징"] [--audience 타겟]');
  console.error('        [--tone 톤] [--seeds "키워드1,키워드2"] [--channel 채널설명]');
  process.exit(1);
}

const slug = opt('slug', name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'studio');
const dir = path.resolve(opt('dir', path.join(os.homedir(), 'studios', slug)));
const port = opt('port', '8788');
const dataDir = path.join(dir, 'data');
const envFile = path.join(dir, '.env');

if (fs.existsSync(envFile)) {
  console.error(`중단: ${envFile} 이 이미 존재합니다(기존 스튜디오 보호). --dir 로 다른 경로를 지정하세요.`);
  process.exit(1);
}
fs.mkdirSync(dataDir, { recursive: true });

// 브랜드 프로필 — 서버의 normalizeBrand 와 같은 스키마(YAML 수동 직렬화로 의존성 0).
const yq = (s) => JSON.stringify(String(s)); // YAML 안전 인용(JSON 문자열은 유효한 YAML 스칼라)
const products = opt('products').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const [n, f] = x.split(':').map((y) => y.trim());
  return { name: n, features: f };
}).filter((p) => p.name);
const seeds = opt('seeds').split(',').map((x) => x.trim()).filter(Boolean);
const lines = [`name: ${yq(name)}`];
if (opt('industry')) lines.push(`industry: ${yq(opt('industry'))}`);
if (opt('description')) lines.push(`description: ${yq(opt('description'))}`);
if (products.length) {
  lines.push('products:');
  for (const p of products) {
    lines.push(`  - name: ${yq(p.name)}`);
    if (p.features) lines.push(`    features: ${yq(p.features)}`);
  }
}
if (opt('audience')) lines.push(`audience: ${yq(opt('audience'))}`);
if (opt('tone')) lines.push(`tone: ${yq(opt('tone'))}`);
if (opt('channel')) lines.push(`channel: ${yq(opt('channel'))}`);
if (seeds.length) lines.push('seedKeywords:', ...seeds.map((k) => `  - ${yq(k)}`));
fs.writeFileSync(path.join(dataDir, 'brand.yaml'), lines.join('\n') + '\n', 'utf-8');

// 인스턴스 env — GEPA_ENV_FILE 로 부팅 시 로드됨(config.ts). 값은 API 키 탭에서도 편집 가능(GEPA_ENV_FILE 이 저장소).
fs.writeFileSync(envFile, [
  `# ${name} — AI 콘텐츠 스튜디오 인스턴스 (생성: new_studio.mjs)`,
  `GEPA_DATA_DIR=${dataDir}`,
  `PORT=${port}`,
  `NAVER_PROFILE_DIR=${path.join(dir, '.naver-profile')}`,
  `NAVER_SESSION_FILE=${path.join(dataDir, '.naver_session.json')}`,
  `# 이 기업의 네이버 계정을 채워 넣으세요(임시저장·성과수집에 필요):`,
  `# NAVER_BLOG_ID=`,
  `# NAVER_LOGIN_ID=`,
  `# NAVER_LOGIN_PW=`,
  `# 선택: 이미지 생성/검색 키(비우면 공유 .env 대신 이 파일만 사용됨)`,
  `# OPENAI_API_KEY=`,
  ``,
].join('\n'), 'utf-8');

console.log(`✅ "${name}" 스튜디오 생성 완료`);
console.log(`   데이터: ${dataDir} (첫 부팅 시 직원 조직 자동 시드)`);
console.log(`   브랜드: ${path.join(dataDir, 'brand.yaml')} — 제품 ${products.length}종, 시드 키워드 ${seeds.length}개`);
console.log(`   환경:   ${envFile} — 네이버 계정을 채워 넣으세요`);
console.log('');
console.log('기동(프로젝트 루트에서):');
console.log(`   GEPA_ENV_FILE=${envFile} pnpm start`);
console.log(`   → http://127.0.0.1:${port}`);
console.log('');
console.log('참고: 여러 인스턴스가 네이버 브라우저 작업(임시저장·성과수집)을 동시에 돌리지 않도록');
console.log('      PERF_SYNC_TIME 등 스케줄을 인스턴스별로 어긋나게 설정하는 것을 권장합니다.');
