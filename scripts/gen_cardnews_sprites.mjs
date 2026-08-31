// 카드뉴스팀 스프라이트 생성 — 송하영(기획)·민준호(디자인)의 stand/sit_front/face 3종.
// gen_jarvis_sprite.mjs 와 동일 파이프라인: gpt-image 로 순백 배경 전신 생성 → 가장자리
// flood-fill 로 배경 투명화. 캐릭터 일관성을 위해 sit 포즈는 stand 결과를 입력으로 edits 변환.
// face 는 stand 에서 머리 영역을 Pillow 로 크롭(생성 1회분 절약 + 얼굴 완전 일치).
// 사용: node scripts/gen_cardnews_sprites.mjs   (OPENAI_API_KEY 필요)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const OUT_DIR = path.join(ROOT, 'frontend/public/sprites');

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
const envVal = (name) => {
  const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)$`, 'm').exec(env);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
};
const KEY = envVal('OPENAI_API_KEY');
const MODEL = envVal('OPENAI_IMAGE_MODEL') || 'gpt-image-2';
if (!KEY) { console.error('OPENAI_API_KEY 가 .env 에 없습니다.'); process.exit(1); }

// 기존 스프라이트(3D 카툰 오피스 게임 아바타)와 동일 톤 지시 + 순백 배경(후처리 투명화).
const STYLE =
  'Clean stylized 3D cartoon render (Pixar-like) matching a bright modern office game sprite, ' +
  'soft studio lighting, single character centered, full body head to toe, nothing cropped. ' +
  'Plain solid pure white (#FFFFFF) background, no floor shadow, no background objects.';

const CHARS = {
  cardplanner: {
    who: 'A young Korean woman in her late 20s, a card-news content planner with a warm friendly smile, ' +
      'shoulder-length dark hair tucked behind one ear, wearing a coral knit cardigan over a white tee, ' +
      'holding a small stack of square storyboard cards with colorful sticky notes',
  },
  carddesigner: {
    who: 'A young Korean man in his early 30s, a visual card designer with a calm confident look, ' +
      'short dark hair and round glasses, wearing a mustard-yellow shirt with rolled-up sleeves, ' +
      'holding a graphics drawing tablet and a stylus pen',
  },
};

// 순백 배경 → 투명 (가장자리 flood-fill — 캐릭터 내부 흰색 보존). gen_jarvis_sprite.mjs 동일.
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

// 투명 배경 전신에서 머리 영역을 정사각 크롭 → face 헤드샷(기존 <char>_face.png 규격과 유사).
const PY_FACECROP = `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
bbox = im.getbbox()
if not bbox: sys.exit('empty image')
l, t, r, b = bbox
bw, bh = r - l, b - t
side = int(bw * 0.72)              # 머리+어깨 폭 근사
cx = l + bw // 2
box = (max(0, cx - side // 2), t, min(im.width, cx + side // 2), min(im.height, t + side))
face = im.crop(box).resize((256, 256), Image.LANCZOS)
face.save(dst)
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callImages(endpoint, fdOrJson) {
  const isForm = fdOrJson instanceof FormData;
  const r = await fetch(`https://api.openai.com/v1/images/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
    body: isForm ? fdOrJson : JSON.stringify(fdOrJson),
  });
  if (!r.ok) {
    const e = await r.text().catch(() => '');
    const err = new Error(`${endpoint} HTTP ${r.status}: ${e.slice(0, 200)}`);
    err.transient = r.status >= 500 || r.status === 429;
    throw err;
  }
  const j = await r.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${endpoint}: 응답에 이미지 없음`);
  return Buffer.from(b64, 'base64');
}

async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e.transient && attempt < 3) { console.warn(`일시 오류(시도 ${attempt}) — 재시도`); await sleep(4000 * attempt); continue; }
      throw e;
    }
  }
}

function whitekey(buf, out) {
  const raw = out.replace(/\.png$/, '.raw.png');
  fs.writeFileSync(raw, buf);
  execFileSync('python3', ['-c', PY_WHITEKEY, raw, out]);
  fs.unlinkSync(raw);
}

for (const [char, def] of Object.entries(CHARS)) {
  // 1) stand — 텍스트→이미지 생성
  const standPath = path.join(OUT_DIR, `${char}_stand.png`);
  const standBuf = await withRetry(() => callImages('generations', {
    model: MODEL, size: '1024x1536', quality: 'high',
    prompt: `${def.who}, standing straight facing the viewer, arms relaxed. ${STYLE}`,
  }));
  whitekey(standBuf, standPath);
  console.log(`saved ${standPath}`);

  // 2) sit_front — stand 결과를 입력으로 edits(캐릭터 일관성 유지)
  const sitPath = path.join(OUT_DIR, `${char}_sit_front.png`);
  const fd = new FormData();
  fd.append('model', MODEL);
  fd.append('image', new Blob([fs.readFileSync(standPath)], { type: 'image/png' }), `${char}_stand.png`);
  fd.append('prompt',
    'Keep this EXACT same character (same face, same hair, same outfit, same held items) but now ' +
    'sitting on a modern office chair facing the viewer, hands on lap or holding their items. ' + STYLE);
  fd.append('size', '1024x1536');
  fd.append('quality', 'high');
  const sitBuf = await withRetry(() => callImages('edits', fd));
  whitekey(sitBuf, sitPath);
  console.log(`saved ${sitPath}`);

  // 3) face — stand 에서 머리 크롭(추가 생성 없음, 얼굴 완전 일치)
  const facePath = path.join(OUT_DIR, `${char}_face.png`);
  execFileSync('python3', ['-c', PY_FACECROP, standPath, facePath]);
  console.log(`saved ${facePath}`);
}
console.log('완료 — officeSprites ROLE_SPRITE 매핑 + frontend 빌드로 반영하세요.');
