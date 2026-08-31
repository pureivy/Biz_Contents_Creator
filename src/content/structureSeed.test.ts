import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../config';
import {
  pickStructureSeed, structureBlock, currentStructureSeed, resolveStructureSeed, inheritStructureSeed,
  FIXED_STRUCTURE_SEED, STRUCTURE_KEEP_BLOCK, type StructureSeed,
} from './structureSeed';

// CONFIG 는 런타임 가변 객체(readonly 는 타입 힌트일 뿐) — 킬스위치·세션 경로를 강제하고 복원한다.
const cfg = CONFIG as unknown as { structureVariety: boolean; sessionsDir: string };
let origVariety: boolean;
let origSessions: string;
let tmpDir = '';
beforeEach(() => {
  origVariety = cfg.structureVariety;
  origSessions = cfg.sessionsDir;
  cfg.structureVariety = true;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-seed-'));
  cfg.sessionsDir = tmpDir;
});
afterEach(() => {
  cfg.structureVariety = origVariety;
  cfg.sessionsDir = origSessions;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 결정적 난수(LCG) — 카운터형 가짜 rand 는 뽑는 순서에 따라 퇴화 시드를 만든다. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

describe('pickStructureSeed — 시드 분포', () => {
  it('1000회 샘플에서 각 값이 모두 등장한다', () => {
    const seeds: StructureSeed[] = [];
    for (let i = 0; i < 1000; i++) seeds.push(pickStructureSeed(Math.random));
    for (const v of ['none', 'after-hook', 'mid', 'before-close']) {
      expect(seeds.some((s) => s.thesisQuote === v)).toBe(true);
    }
    for (const v of ['scene', 'question', 'claim', 'contrast']) {
      expect(seeds.some((s) => s.openers === v)).toBe(true);
    }
    for (const v of [2, 3, 4, 5]) expect(seeds.some((s) => s.cardLines === v)).toBe(true);
    for (const v of [10, 11, 12, 13, 14, 15]) expect(seeds.some((s) => s.hashtags === v)).toBe(true);
    for (const v of [4, 5, 6]) expect(seeds.some((s) => s.shortsScenes === v)).toBe(true);
  });

  it('값 범위를 벗어나지 않는다(rand 경계 0·1 포함)', () => {
    for (const r of [() => 0, () => 0.999999, () => 1]) {
      const s = pickStructureSeed(r);
      expect(['none', 'after-hook', 'mid', 'before-close']).toContain(s.thesisQuote);
      expect(['scene', 'question', 'claim', 'contrast']).toContain(s.openers);
      expect(s.cardLines).toBeGreaterThanOrEqual(2);
      expect(s.cardLines).toBeLessThanOrEqual(5);
      expect(s.hashtags).toBeGreaterThanOrEqual(10);
      expect(s.hashtags).toBeLessThanOrEqual(15);
      expect(s.shortsScenes).toBeGreaterThanOrEqual(4);
      expect(s.shortsScenes).toBeLessThanOrEqual(6);
    }
  });

  it('선택 블록(표·체크리스트·예고)은 항상 정확히 2개만 true', () => {
    const offCount = { table: 0, checklist: 0, teaser: 0 };
    const rand = lcg(20260827);
    for (let i = 0; i < 1000; i++) {
      const s = pickStructureSeed(rand);
      expect([s.table, s.checklist, s.teaser].filter(Boolean).length).toBe(2);
      if (!s.table) offCount.table++;
      if (!s.checklist) offCount.checklist++;
      if (!s.teaser) offCount.teaser++;
    }
    // 세 블록 모두가 꺼지는 쪽으로 뽑힌 적이 있어야 한다(한 블록만 계속 꺼지는 퇴화 방지).
    expect(offCount.table).toBeGreaterThan(0);
    expect(offCount.checklist).toBeGreaterThan(0);
    expect(offCount.teaser).toBeGreaterThan(0);
  });
});

describe('currentStructureSeed — 킬스위치', () => {
  it('STRUCTURE_VARIETY=off 면 고정 시드(after-hook·표+체크리스트·4줄·12개·5씬)', () => {
    cfg.structureVariety = false;
    const s = currentStructureSeed(lcg(1));
    expect(s).toEqual(FIXED_STRUCTURE_SEED);
    expect(s.thesisQuote).toBe('after-hook');
    expect(s.table).toBe(true);
    expect(s.checklist).toBe(true);
    expect(s.teaser).toBe(false);
    expect(s.cardLines).toBe(4);
    expect(s.hashtags).toBe(12);
    expect(s.shortsScenes).toBe(5);
  });

  it('on 이면 rand 로 뽑는다(고정 시드와 다른 조합이 나온다)', () => {
    const rand = lcg(7);
    const many = Array.from({ length: 200 }, () => currentStructureSeed(rand));
    expect(many.some((s) => JSON.stringify(s) !== JSON.stringify(FIXED_STRUCTURE_SEED))).toBe(true);
  });
});

describe('structureBlock — 작가 프롬프트 주입 문자열', () => {
  const seed: StructureSeed = {
    thesisQuote: 'mid', table: true, checklist: false, teaser: true,
    openers: 'contrast', cardLines: 3, hashtags: 11, shortsScenes: 6,
  };

  it('머리표와 다섯 항목(도입·중심 명제·표·체크리스트·예고)을 모두 담는다', () => {
    const b = structureBlock(seed);
    expect(b).toContain('[이번 글 구조]');
    expect(b).toContain('도입');
    expect(b).toContain('중심 명제');
    expect(b).toContain('표');
    expect(b).toContain('체크리스트');
    expect(b).toContain('예고');
  });

  it('도입 유형 4종을 각각 다른 문구로 지시한다', () => {
    const texts = (['scene', 'question', 'claim', 'contrast'] as const)
      .map((o) => structureBlock({ ...seed, openers: o }));
    expect(new Set(texts).size).toBe(4);
    expect(structureBlock({ ...seed, openers: 'scene' })).toContain('장면');
    expect(structureBlock({ ...seed, openers: 'question' })).toContain('질문');
    expect(structureBlock({ ...seed, openers: 'claim' })).toContain('단정');
    expect(structureBlock({ ...seed, openers: 'contrast' })).toContain('통념');
  });

  it('중심 명제 인용 위치 4값을 구분해 쓴다', () => {
    expect(structureBlock({ ...seed, thesisQuote: 'none' })).toContain('쓰지 마라');
    expect(structureBlock({ ...seed, thesisQuote: 'after-hook' })).toContain('도입 훅 직후');
    expect(structureBlock({ ...seed, thesisQuote: 'mid' })).toContain('본문 중간');
    expect(structureBlock({ ...seed, thesisQuote: 'before-close' })).toContain('마무리 직전');
  });

  it('표·체크리스트는 시드에 따라 켜고 끈다', () => {
    const on = structureBlock({ ...seed, table: true, checklist: true, teaser: false });
    const off = structureBlock({ ...seed, table: false, checklist: false, teaser: true });
    expect(on).toContain('표: 넣는다');
    expect(on).toContain('체크리스트(">>> " 프레임): 넣는다');
    expect(off).toContain('표: 넣지 마라');
    expect(off).toContain('체크리스트(">>> " 프레임): 넣지 마라');
  });

  it('예고는 켜져도 "결론을 예고로 미루기"를 허용하지 않는다(결론 의무 자산 보존)', () => {
    const on = structureBlock({ ...seed, teaser: true });
    expect(on).toContain('마무리를 완결한 뒤');
    expect(on).toContain('한 줄');
    expect(structureBlock({ ...seed, teaser: false })).toContain('예고: 넣지 마라');
  });

  it('리비전 모드는 골격을 "유지하라"로 말한다(재구성 유도 금지)', () => {
    const w = structureBlock(seed);
    const r = structureBlock(seed, { revise: true });
    expect(r).toContain('유지');
    expect(r).not.toBe(w);
  });
});

describe('resolveStructureSeed / inheritStructureSeed — sessions/<runId>/structure.json 저장·재사용', () => {
  it('새 런은 시드를 뽑아 structure.json 에 남긴다', () => {
    const s = resolveStructureSeed('run-A');
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'run-A', 'structure.json'), 'utf-8')) as StructureSeed;
    expect(saved).toEqual(s);
  });

  it('리비전 런(baseRunId)은 원 런과 같은 시드를 승계하고 자기 런에도 남긴다(연쇄 리비전)', () => {
    const base = resolveStructureSeed('run-B');
    const rev = inheritStructureSeed('run-B-rev', 'run-B');
    expect(rev).toEqual(base);
    const chained = JSON.parse(fs.readFileSync(path.join(tmpDir, 'run-B-rev', 'structure.json'), 'utf-8')) as StructureSeed;
    expect(chained).toEqual(base);
  });

  // 승계는 '같은 시드'다 — 없는 골격을 새로 뽑아 "유지하라"고 말하면 그건 재구성 지시가 된다.
  it('원 런에 structure.json 이 없으면(이 기능 이전 런) null — 새로 뽑지도, 파일을 만들지도 않는다', () => {
    expect(inheritStructureSeed('run-C-rev', 'run-없음')).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'run-C-rev', 'structure.json'))).toBe(false);
  });

  it('baseRunId 자체가 없어도 null(초안을 만든 런을 모르는 리비전)', () => {
    expect(inheritStructureSeed('run-F-rev')).toBeNull();
  });

  // Fix round(finding 2) — 킬스위치는 시드를 '뽑는' 동작만 지배한다. 기록된 시드를 고정 시드로 갈아치우면
  // 다양화 시드로 쓰인 초안의 리비전이 "표·프레임을 유지하라"는 지시를 받아 없던 구조를 새로 만든다.
  it('off 여도 기록된 시드를 그대로 승계한다(고정 시드로 갈아치우지 않는다)', () => {
    fs.mkdirSync(path.join(tmpDir, 'run-D'), { recursive: true });
    const varied: StructureSeed = {
      thesisQuote: 'none', table: false, checklist: true, teaser: true,
      openers: 'claim', cardLines: 2, hashtags: 15, shortsScenes: 4,
    };
    fs.writeFileSync(path.join(tmpDir, 'run-D', 'structure.json'), JSON.stringify(varied), 'utf-8');
    cfg.structureVariety = false;
    expect(inheritStructureSeed('run-D-rev', 'run-D')).toEqual(varied);
    // 연쇄 리비전도 같은 골격을 물려받는다 — off 경로의 종전 구현은 이 파일을 아예 남기지 않았다.
    const chained = JSON.parse(fs.readFileSync(path.join(tmpDir, 'run-D-rev', 'structure.json'), 'utf-8')) as StructureSeed;
    expect(chained).toEqual(varied);
  });

  it('off 이고 물려받을 기록도 없으면 null(호출부가 유지 블록을 쓴다)', () => {
    cfg.structureVariety = false;
    expect(inheritStructureSeed('run-G-rev', 'run-없음')).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'run-G-rev', 'structure.json'))).toBe(false);
  });

  it('손상된 structure.json 은 승계하지 않는다(null)', () => {
    fs.mkdirSync(path.join(tmpDir, 'run-E'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'run-E', 'structure.json'), '{"thesisQuote":', 'utf-8');
    expect(inheritStructureSeed('run-E-rev', 'run-E')).toBeNull();
  });
});

// BLOG_BODY_GUIDE 가 인용구·프레임·표를 [이번 글 구조] 에 위임하므로, 시드를 모르는 자리(승계 실패 리비전·
// 지적만 고치는 수정 라운드)에도 블록이 있어야 한다 — 없으면 작가가 "안 켜졌다"로 읽고 걷어낸다.
describe('STRUCTURE_KEEP_BLOCK — 시드를 모르는 자리의 유지 블록', () => {
  it('같은 머리표를 쓰고, 인용구·프레임·표를 그대로 두라고 말한다', () => {
    expect(STRUCTURE_KEEP_BLOCK.startsWith('[이번 글 구조]')).toBe(true);
    expect(STRUCTURE_KEEP_BLOCK).toContain('그대로 유지');
    expect(STRUCTURE_KEEP_BLOCK).toContain('>>');
    expect(STRUCTURE_KEEP_BLOCK).toContain('표');
    expect(STRUCTURE_KEEP_BLOCK).toContain('새로 넣거나 빼지 마라');
  });
});
