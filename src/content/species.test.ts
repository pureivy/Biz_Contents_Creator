import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpecies, findSpecies as findIn, speciesAnchor, speciesSeasonalHint, speciesNameFrom, appendSpecies, resetSpeciesCache, stripSpeciesNamePrefix, speciesFile } from './species';

// 실제 사전(data/species-<slug>.yaml)은 브랜드 런타임 데이터라 git 에 없다 — 이 저장소는 브랜드가
// 정해지기 전의 범용 스튜디오다. 판정 규칙은 픽스처로 검증하고, 실제 사전은 있을 때만 무결성을 본다.
const FIXTURE = fileURLToPath(new URL('./__fixtures__/species.yaml', import.meta.url));
const LIST = loadSpecies(FIXTURE);
const findSpecies = (text: string, list = LIST) => findIn(text, list);

function integrity(list: ReturnType<typeof loadSpecies>): void {
  for (const s of list) expect(s.latin, s.name).toMatch(/^[A-Z][a-z]+ [a-z-]+$/);
  const keys: string[] = [];
  for (const s of list) { keys.push(s.name); for (const a of s.aliases ?? []) keys.push(a); }
  expect(new Set(keys).size).toBe(keys.length);
  for (const s of list) {
    expect(s.leaf, s.name).toBeTruthy();
    const text = [s.type, s.leaf, s.form, s.flower, s.fruit, s.note].filter(Boolean).join(' ');
    expect(text, `${s.name}: ${text}`).not.toMatch(/아니다|아니라|말고|하지 마|안 된다|금지/);
  }
}

describe('수종 사전 — 데이터 무결성', () => {
  it('픽스처가 로드되고 학명이 모두 있다', () => {
    expect(LIST.length).toBeGreaterThan(5);
    for (const s of LIST) expect(s.latin).toMatch(/^[A-Z][a-z]+ [a-z-]+$/);
  });
  it('활성 브랜드의 실제 사전(있을 때만) — 학명·별칭 충돌·잎·긍정문 규칙을 지킨다', () => {
    resetSpeciesCache();
    const real = fs.existsSync(speciesFile()) ? loadSpecies(speciesFile()) : [];
    resetSpeciesCache();
    integrity(real); // 파일이 없으면 빈 목록 — 통과. 있으면 사람이 손으로 쓴 항목까지 검사한다.
  });
  it('이름·별칭이 겹치지 않는다 — 겹치면 매칭이 엉킨다', () => {
    const keys: string[] = [];
    for (const s of LIST) { keys.push(s.name); for (const a of s.aliases ?? []) keys.push(a); }
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('잎 정보가 다 있다 — 가장 자주 틀리는 항목이다', () => {
    for (const s of LIST) expect(s.leaf, s.name).toBeTruthy();
  });
});

describe('findSpecies — 키워드에서 수종 찾기', () => {
  it('키워드 그대로', () => {
    expect(findSpecies('남천')?.latin).toBe('Nandina domestica');
    expect(findSpecies('수국')?.latin).toBe('Hydrangea macrophylla');
  });
  it('구절 안에서도 찾는다', () => {
    expect(findSpecies('산수유 열매 적을 때')?.name).toBe('산수유');
    expect(findSpecies('측백나무 생울타리 몇 그루')?.name).toBe('측백나무');
    expect(findSpecies('9월 수국 관리, 가위 들기 전에')?.name).toBe('수국');
  });
  it('별칭으로도 찾는다', () => {
    expect(findSpecies('태추단감묘목')?.name).toBe('감나무');
    expect(findSpecies('도토리나무심기')?.name).toBe('참나무');
    expect(findSpecies('흰배롱나무')?.name).toBe('배롱나무');
  });
  it("배롱나무를 '백일홍'으로 불러도 같은 나무다", () => {
    // 사장님이 '백일홍'으로 딱지를 붙여 올린 영상이 '배롱나무 묘목' 편에서 배제됐다(2026-09-05).
    // matchMedia 는 멀쩡했다 — 별칭 표에 이 이름이 없었을 뿐이다. 표준명이 잡히면(want='배롱나무')
    // 딱지와 글자로 비교하므로, 사전이 모르는 별칭은 곧 소재 유실이다.
    // 일반 국어에서 '백일홍'은 한해살이 초백일홍을 뜻하기도 하지만, 이 사전은 묘목장 수목 31종이고
    // 초백일홍은 없다. 이 브랜드에서 백일홍은 배롱나무다.
    expect(findSpecies('백일홍')?.name).toBe('배롱나무');
    expect(findSpecies('목백일홍')?.name).toBe('배롱나무');
    expect(findSpecies('백일홍 묘목 심는 시기')?.name).toBe('배롱나무');
  });
  it('긴 이름이 먼저 잡힌다 — 짧은 이름이 먼저 걸리면 엉뚱한 종이 된다', () => {
    // '보리수나무'가 있고 '수국'도 있다 — 부분 문자열 충돌을 확인
    expect(findSpecies('보리수나무묘목')?.name).toBe('보리수나무');
  });
  it('흔한 원예 표현이 수종으로 오인되지 않는다 — 별칭은 부분문자열로 걸린다', () => {
    // findSpecies 는 t.includes(key) 다. 그래서 짧은 별칭 하나가 표 전체를 오염시킨다:
    // '배'를 배나무 별칭에 넣으면 '배수·배치·배양토'가 전부 배나무가 되고,
    // '밤'을 넣으면 '한밤중 물주기'가 밤나무가 된다. 그래서 한 글자 별칭은 넣지 않았다.
    // 별칭을 추가할 때 이 목록이 깨지면, 추가한 별칭이 너무 짧은 것이다.
    expect(findSpecies('화분 배수가 안 될 때 속흙 확인')).toBeUndefined();
    expect(findSpecies('묘목 배치 간격 정하기')).toBeUndefined();
    expect(findSpecies('배양토 고르는 법')).toBeUndefined();
    expect(findSpecies('한밤중 물주기는 피하세요')).toBeUndefined();
    expect(findSpecies('밤에 기온이 떨어질 때 서리 대비')).toBeUndefined();
    // 진짜 수종은 그대로 잡혀야 한다 — 위 방어가 과하면 이쪽이 깨진다
    expect(findSpecies('배나무 묘목 심는 시기')?.name).toBe('배나무');
    expect(findSpecies('밤나무 밤송이 수확')?.name).toBe('밤나무');
    expect(findSpecies('배롱나무 전정 시기')?.name).toBe('배롱나무');
  });
  it('모르는 소재는 undefined — 표가 파이프라인을 막지 않는다', () => {
    expect(findSpecies('9월 정원 준비')).toBeUndefined();
    expect(findSpecies('')).toBeUndefined();
    expect(findSpecies('나무 상처 치료제')).toBeUndefined();
  });
});

describe('speciesAnchor — 앵커 문구', () => {
  it('종류·잎·수형을 담는다', () => {
    const a = speciesAnchor(findSpecies('남천')!);
    expect(a).toContain('남천');
    expect(a).toContain('깃꼴겹잎');
    expect(a.length).toBeLessThanOrEqual(200);
  });
  it('실사고 재현 — 남천이 손바닥잎으로 안 나온다', () => {
    expect(speciesAnchor(findSpecies('남천')!)).not.toContain('손바닥');
  });
});

describe('speciesSeasonalHint — 꽃·열매는 그 씬이 다룰 때만', () => {
  const sansuyu = () => findSpecies('산수유')!;
  it('열매 씬이면 열매 정보', () => {
    const h = speciesSeasonalHint(sansuyu(), '가지에 붉은 열매가 달린 모습');
    expect(h).toContain('열매');
    expect(h).not.toContain('꽃:');
  });
  it('꽃 씬이면 꽃 정보', () => {
    expect(speciesSeasonalHint(sansuyu(), '노란 꽃이 핀 가지')).toContain('꽃:');
  });
  it('둘 다 아니면 빈 문자열 — 꽃 없는 계절에 꽃이 그려지면 안 된다', () => {
    expect(speciesSeasonalHint(sansuyu(), '줄자로 담장 길이를 재는 손')).toBe('');
  });
});

describe('데이터 서술 원칙 — 긍정문만', () => {
  it('부정 표현이 없다 — 이미지 모델은 부정을 잘 못 다뤄 오히려 그 형태를 그린다', () => {
    for (const s of LIST) {
      const text = [s.type, s.leaf, s.form, s.flower, s.fruit, s.note].filter(Boolean).join(' ');
      expect(text, `${s.name}: ${text}`).not.toMatch(/아니다|아니라|말고|하지 마|안 된다|금지/);
    }
  });
});

describe('speciesNameFrom — 디렉터 값에서 이름 뽑기', () => {
  it('구분자 앞이 이름', () => {
    expect(speciesNameFrom('남천 — 깃꼴겹잎, 붉은 잎')).toBe('남천');
    expect(speciesNameFrom('회양목(상록 관목)')).toBe('회양목');
  });
  it('subject 가 비면 키워드를 쓴다', () => {
    expect(speciesNameFrom('', '치자나무')).toBe('치자나무');
  });
  it('수종명이 아닌 구절은 버린다 — 쓰레기가 사전에 쌓이면 안 된다', () => {
    for (const bad of ['9월 정원 준비', '나무 상처 치료제', '', '가', '아주아주긴이름이계속이어지는것']) {
      expect(speciesNameFrom(bad)).toBe('');
    }
  });
});

describe('appendSpecies — 새 수종 자동 축적', () => {
  const tmp = () => {
    const f = path.join(os.tmpdir(), `sp-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(f, 'species:\n  기존종:\n    latin: Existing species\n    leaf: 홑잎\n');
    return f;
  };
  it('새 종을 덧붙이고 다시 읽힌다', () => {
    const f = tmp();
    expect(appendSpecies({ name: '치자나무', latin: 'Gardenia jasminoides', leaf: '마주나기 홑잎' }, f)).toBe(true);
    resetSpeciesCache();
    expect(findSpecies('치자나무', loadSpecies(f))?.latin).toBe('Gardenia jasminoides');
    resetSpeciesCache();
  });
  it('이미 있으면 안 넣는다(이름·학명 둘 다로 판정)', () => {
    const f = tmp();
    expect(appendSpecies({ name: '기존종', latin: 'Other species' }, f)).toBe(false);
    resetSpeciesCache();
    expect(appendSpecies({ name: '다른이름', latin: 'Existing species' }, f)).toBe(false);
    resetSpeciesCache();
  });
  it('이름이나 학명이 없으면 안 넣는다', () => {
    const f = tmp();
    expect(appendSpecies({ name: '', latin: 'Aaa bbb' }, f)).toBe(false);
    expect(appendSpecies({ name: '무언가', latin: '' }, f)).toBe(false);
  });
  it('자동 추가분은 auto·verified 로 표시된다 — 검증된 것이 아니다', () => {
    const f = tmp();
    appendSpecies({ name: '치자나무', latin: 'Gardenia jasminoides' }, f);
    const txt = fs.readFileSync(f, 'utf-8');
    expect(txt).toContain('auto: true');
    expect(txt).toContain('verified: false');
    resetSpeciesCache();
  });
});

describe('stripSpeciesNamePrefix — 앵커 앞머리 이름 제거(순수)', () => {
  const tmp = () => {
    const f = path.join(os.tmpdir(), `sp-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(f, 'species:\n  기존종:\n    latin: Existing species\n    leaf: 홑잎\n');
    return f;
  };
  it('"이름 — 특징"에서 이름을 뗀다', () => {
    expect(stripSpeciesNamePrefix('사계장미', '사계장미 — 홀수 깃꼴겹잎, 가시 있는 줄기'))
      .toBe('홀수 깃꼴겹잎, 가시 있는 줄기');
  });
  it('붙임표 종류(—, –, -)를 모두 본다', () => {
    expect(stripSpeciesNamePrefix('남천', '남천 - 깃꼴겹잎')).toBe('깃꼴겹잎');
    expect(stripSpeciesNamePrefix('남천', '남천 – 깃꼴겹잎')).toBe('깃꼴겹잎');
  });
  it('앞머리가 이름이 아니면 그대로 둔다', () => {
    expect(stripSpeciesNamePrefix('남천', '깃꼴겹잎, 붉은 열매')).toBe('깃꼴겹잎, 붉은 열매');
  });
  it('빈 값·이름만 있는 값은 undefined', () => {
    expect(stripSpeciesNamePrefix('남천', '')).toBeUndefined();
    expect(stripSpeciesNamePrefix('남천', undefined)).toBeUndefined();
    expect(stripSpeciesNamePrefix('남천', '남천 — ')).toBeUndefined();
  });
  it('저장된 leaf 에 이름이 남지 않는다 — speciesAnchor 가 이름을 다시 붙이므로', () => {
    const f = tmp();
    appendSpecies({ name: '치자나무', latin: 'Gardenia jasminoides', leaf: '치자나무 — 마주나기 홑잎, 흰 꽃' }, f);
    resetSpeciesCache();
    const sp = findSpecies('치자나무', loadSpecies(f))!;
    expect(sp.leaf).toBe('마주나기 홑잎, 흰 꽃');
    expect(speciesAnchor(sp)).not.toContain('치자나무 — 치자나무');
    resetSpeciesCache();
  });
});
