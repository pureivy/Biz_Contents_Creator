// verified-<brand>.md 소급 정리 실행기 — 실행: npx tsx scripts/verified_cleanup.ts --brand=bionditree [--dry-run]
//   복원(규칙 좁힘 후 재평가): npx tsx scripts/verified_cleanup.ts --brand=bionditree --restore [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { partitionVerified, restoreVerified } from '../src/agents/verifiedCleanup';
import { kstDate } from '../src/util/time';

const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const brand = arg('brand');
const dry = process.argv.includes('--dry-run');
const restoreMode = process.argv.includes('--restore');
if (!brand) { console.error('사용법: --brand=<slug> [--dry-run] [--restore]'); process.exit(1); }

const agentsDir = path.join(process.cwd(), 'data', 'agents');
let total = 0;

if (restoreMode) {
  // 아카이브 재평가 — 좁혀진 거절 규칙으로 지금은 통과하는 줄만 verified 로 복원.
  for (const id of fs.readdirSync(agentsDir)) {
    const af = path.join(agentsDir, id, `verified_archive-${brand}.md`);
    if (!fs.existsSync(af)) continue;
    const { stay, restore } = restoreVerified(fs.readFileSync(af, 'utf-8'));
    if (!restore.length) { console.log(`${id}: 복원 대상 없음`); continue; }
    total += restore.length;
    console.log(`${id}: ${restore.length}줄 복원${dry ? '(dry-run)' : ''}`);
    restore.forEach((l) => console.log(`   ${l.slice(0, 110)}`));
    if (dry) continue;
    fs.writeFileSync(af, stay.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf-8');
    const vf = path.join(agentsDir, id, `verified-${brand}.md`);
    const prev = fs.existsSync(vf) ? fs.readFileSync(vf, 'utf-8') : '';
    fs.writeFileSync(vf, `${prev.replace(/\n+$/, '')}\n${restore.join('\n')}\n`, 'utf-8');
  }
  console.log(`복원 합계 ${total}줄`);
  process.exit(0);
}

for (const id of fs.readdirSync(agentsDir)) {
  const f = path.join(agentsDir, id, `verified-${brand}.md`);
  if (!fs.existsSync(f)) continue;
  const { keep, archive } = partitionVerified(fs.readFileSync(f, 'utf-8'));
  if (!archive.length) { console.log(`${id}: 정리 대상 없음`); continue; }
  total += archive.length;
  console.log(`${id}: ${archive.length}줄 이동${dry ? '(dry-run)' : ''}`);
  if (dry) { archive.slice(0, 3).forEach((l) => console.log(`   ${l.slice(0, 110)}`)); continue; }
  fs.appendFileSync(
    path.join(agentsDir, id, `verified_archive-${brand}.md`),
    `\n## ${kstDate()} 소급 정리(근거 규칙 미달)\n${archive.join('\n')}\n`,
    'utf-8',
  );
  fs.writeFileSync(f, keep.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf-8');
}
console.log(`합계 ${total}줄`);
