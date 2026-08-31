// 자비스 전신 스프라이트 생성 — OpenAI 이미지 API(images/edits)로 '기존 얼굴(jarvis_face.png)을
// 유지한 채 줌아웃해 전신을 그리는' 방식. 결과: frontend/public/sprites/jarvis_<pose>.png (투명배경).
// 사용: node scripts/gen_jarvis_sprite.mjs   (OPENAI_API_KEY 가 .env 에 있어야 함 — 🔑 API 키 탭에서 등록)
// 모델: .env 의 OPENAI_IMAGE_MODEL(기본 gpt-image-2). gpt-image-2 는 투명배경 미지원(400) →
//   순백 배경으로 생성한 뒤 Pillow(가장자리 flood-fill)로 배경을 투명화한다. gpt-image-1 은 네이티브 투명.
// 일시 오류(5xx)는 3회 재시도. 키는 출력하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const FACE = path.join(ROOT, 'frontend/public/avatars/jarvis_face.png');
const OUT_DIR = path.join(ROOT, 'frontend/public/sprites');

// .env 파싱 — 서버(store.ts)와 동일하게 관용적으로: 공백/export 접두 허용.
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
const envVal = (name) => {
  const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)$`, 'm').exec(env);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
};
const KEY = envVal('OPENAI_API_KEY');
const MODEL = envVal('OPENAI_IMAGE_MODEL') || 'gpt-image-2';
if (!KEY) {
  console.error('OPENAI_API_KEY 가 .env 에 없습니다 — 🔑 API 키 탭에서 등록한 뒤 다시 실행하세요.');
  process.exit(1);
}

// 다른 스프라이트(3D 카툰, 투명배경, 전신)와 톤을 맞추되 안드로이드 헤드는 그대로 유지.
const POSES = {
  stand: 'standing straight, facing the viewer, arms relaxed at her sides',
  sit_front: 'sitting on an office chair facing the viewer, hands on her lap',
};
const BASE_PROMPT = (pose) =>
  `Zoom out to reveal the FULL BODY of this character, head to toe, nothing cropped. ` +
  `Keep the input image's android head EXACTLY as it is: same metallic silver-and-gold helmet, ` +
  `same glowing blue eyes, same face. Give her a feminine humanoid android body wearing a smart ` +
  `navy-blue business suit with subtle glowing blue accent lines, ${pose}. ` +
  `Clean stylized 3D cartoon render (Pixar-like) matching a bright modern office game sprite, ` +
  `soft studio lighting, single character centered.`;

// 순백 배경 → 투명 (가장자리 flood-fill — 캐릭터 내부의 흰색은 보존)
const PY_WHITEKEY = `
import sys
from collections import deque
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
w, h = im.size
px = im.load()
seen = bytearray(w * h)
q = deque()
for x in range(w): q.append((x, 0)); q.append((x, h - 1))
for y in range(h): q.append((0, y)); q.append((w - 1, y))
while q:
    x, y = q.popleft()
    if x < 0 or y < 0 or x >= w or y >= h: continue
    i = y * w + x
    if seen[i]: continue
    seen[i] = 1
    r, g, b, a = px[x, y]
    if min(r, g, b) < 232: continue
    px[x, y] = (r, g, b, 0)
    q.append((x + 1, y)); q.append((x - 1, y)); q.append((x, y + 1)); q.append((x, y - 1))
im.save(dst)
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callEdits(model, prompt, transparentNative) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('image', new Blob([fs.readFileSync(FACE)], { type: 'image/png' }), 'jarvis_face.png');
  fd.append('prompt', prompt);
  fd.append('size', '1024x1536');          // 세로형 — 전신 비율
  fd.append('quality', 'high');
  if (transparentNative) fd.append('background', 'transparent');
  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd,
  });
  if (!r.ok) {
    const e = await r.text().catch(() => '');
    const err = new Error(`${model} HTTP ${r.status}: ${e.slice(0, 200)}`);
    err.transient = r.status >= 500 || r.status === 429;
    throw err;
  }
  const j = await r.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${model}: 응답에 이미지 없음`);
  return Buffer.from(b64, 'base64');
}

async function gen(model, pose) {
  const transparentNative = model === 'gpt-image-1'; // gpt-image-2 는 투명배경 미지원
  const prompt = BASE_PROMPT(POSES[pose]) + (transparentNative
    ? ' Plain transparent background.'
    : ' Plain solid pure white (#FFFFFF) background, no floor shadow, no background objects.');
  let buf;
  for (let attempt = 1; ; attempt++) {
    try { buf = await callEdits(model, prompt, transparentNative); break; }
    catch (e) {
      if (e.transient && attempt < 3) { console.warn(`${pose} 시도 ${attempt} 일시 오류 — 재시도`); await sleep(4000 * attempt); continue; }
      throw e;
    }
  }
  const out = path.join(OUT_DIR, `jarvis_${pose}.png`);
  if (transparentNative) {
    fs.writeFileSync(out, buf);
  } else {
    const raw = path.join(OUT_DIR, `jarvis_${pose}.raw.png`);
    fs.writeFileSync(raw, buf);
    execFileSync('python3', ['-c', PY_WHITEKEY, raw, out]);      // 흰 배경 → 투명
    fs.unlinkSync(raw);
  }
  console.log(`saved ${out} (${Math.round(buf.length / 1024)}KB, ${model}${transparentNative ? '' : ' + whitekey'})`);
}

for (const pose of Object.keys(POSES)) {
  try { await gen(MODEL, pose); }
  catch (e) {
    console.warn(String(e.message).slice(0, 200));
    if (MODEL === 'gpt-image-1') throw e;
    console.warn(`${MODEL} 실패 → gpt-image-1 폴백`);
    await gen('gpt-image-1', pose);
  }
}
console.log('완료 — OfficeView 는 /sprites/jarvis_*.png 가 있으면 자동 사용. frontend 빌드로 dist 에 복사하세요.');
