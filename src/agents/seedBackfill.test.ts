/**
 * 시드 팀원 보강(ensureSeedMembers) — 기존 data/company.yaml 을 가진 환경(업그레이드)에 숏폼 작가 b·c 가
 * 없으면 assets/company 시드에서 채운다. 시드 복사는 파일 부재 시에만 일어나므로 이 보강이 없으면
 * 작가 3인 로테이션이 전부 리드 작가 프롬프트로 떨어진다(shorts.ts 폴백).
 *
 * CONFIG.dataDir 은 import 시점의 GEPA_DATA_DIR 로 고정되므로 모듈을 리셋하고 동적으로 불러온다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

interface Role { id: string }
interface Team { id: string; members?: Role[] }
interface Doc { teams: Team[] }

const SEED = path.resolve(process.cwd(), 'assets/company/company.yaml');
const prevEnv = process.env['GEPA_DATA_DIR'];

afterEach(() => {
  if (prevEnv === undefined) delete process.env['GEPA_DATA_DIR']; else process.env['GEPA_DATA_DIR'] = prevEnv;
  vi.resetModules();
});

async function loadWith(dir: string): Promise<{ doc: Doc; people: Record<string, string> }> {
  process.env['GEPA_DATA_DIR'] = dir;
  vi.resetModules();
  const mod = await import('./company-loader');
  mod.reloadCompany();
  const doc = YAML.parse(fs.readFileSync(path.join(dir, 'company.yaml'), 'utf-8')) as Doc;
  const people = (fs.existsSync(path.join(dir, 'people.yaml'))
    ? YAML.parse(fs.readFileSync(path.join(dir, 'people.yaml'), 'utf-8')) : {}) as Record<string, string>;
  return { doc, people };
}

describe('ensureSeedMembers — 기존 company.yaml 에 시드 작가 역할 보강', () => {
  it('shorts 팀은 있는데 작가 b·c 가 없으면 시드에서 채우고 people 이름도 붙인다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-company-'));
    const seed = YAML.parse(fs.readFileSync(SEED, 'utf-8')) as Doc;
    const shorts = seed.teams.find((t) => t.id === 'shorts')!;
    shorts.members = (shorts.members ?? []).filter((m) => !/^shorts_writer_/.test(m.id));
    fs.writeFileSync(path.join(dir, 'company.yaml'), YAML.stringify(seed), 'utf-8');
    fs.writeFileSync(path.join(dir, 'people.yaml'), 'shorts_writer: 유하린\n', 'utf-8');

    const { doc, people } = await loadWith(dir);
    const ids = doc.teams.find((t) => t.id === 'shorts')!.members!.map((m) => m.id);
    expect(ids).toContain('shorts_writer_b');
    expect(ids).toContain('shorts_writer_c');
    expect(ids).toContain('shorts_director');
    expect(people['shorts_writer_b']).toBe('임태윤');
    expect(people['shorts_writer']).toBe('유하린'); // 기존 매핑은 그대로
  });

  it('shorts 팀 자체를 지운 환경은 건드리지 않는다 — 사용자의 조직 편집을 되돌리지 않는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-company-'));
    const seed = YAML.parse(fs.readFileSync(SEED, 'utf-8')) as Doc;
    seed.teams = seed.teams.filter((t) => t.id !== 'shorts');
    fs.writeFileSync(path.join(dir, 'company.yaml'), YAML.stringify(seed), 'utf-8');

    const { doc } = await loadWith(dir);
    expect(doc.teams.some((t) => t.id === 'shorts')).toBe(false);
    const all = doc.teams.flatMap((t) => (t.members ?? []).map((m) => m.id));
    expect(all).not.toContain('shorts_writer_b');
  });

  it('이미 있으면 중복으로 넣지 않는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-company-'));
    fs.copyFileSync(SEED, path.join(dir, 'company.yaml'));
    const { doc } = await loadWith(dir);
    const ids = doc.teams.find((t) => t.id === 'shorts')!.members!.map((m) => m.id);
    expect(ids.filter((i) => i === 'shorts_writer_b')).toHaveLength(1);
  });
});
