import { describe, it, expect } from 'vitest';
import { SHORTS_WRITERS, writerById, writerByName, pickWriter } from './shortsWriters';

describe('SHORTS_WRITERS — 작가 풀 계약', () => {
  it('작가는 3명이고 id·이름·목소리가 모두 다르다 — 하나라도 겹치면 분리 효과가 사라진다', () => {
    expect(SHORTS_WRITERS).toHaveLength(3);
    expect(new Set(SHORTS_WRITERS.map((w) => w.id)).size).toBe(3);
    expect(new Set(SHORTS_WRITERS.map((w) => w.name)).size).toBe(3);
    expect(new Set(SHORTS_WRITERS.map((w) => w.voiceId)).size).toBe(3);
  });
  it('문체 지침도 서로 달라야 한다 — 목소리만 갈리면 대본은 그대로다', () => {
    expect(new Set(SHORTS_WRITERS.map((w) => w.styleGuide)).size).toBe(3);
    for (const w of SHORTS_WRITERS) expect(w.styleGuide.length).toBeGreaterThan(40);
  });
  it('종전 작가(유하린)와 그 목소리는 풀에 남아 있다 — 148편의 연속성', () => {
    const haerin = writerByName('유하린');
    expect(haerin?.voiceId).toBe('iWLjl1zCuqXRkW6494ve');
  });
  it('voice_settings 는 작가마다 다르게 잡혀 있다', () => {
    const sigs = SHORTS_WRITERS.map((w) => JSON.stringify(w.voiceSettings));
    expect(new Set(sigs).size).toBe(3);
    for (const w of SHORTS_WRITERS) {
      expect(w.voiceSettings.stability).toBeGreaterThanOrEqual(0);
      expect(w.voiceSettings.stability).toBeLessThanOrEqual(1);
    }
  });
});

describe('writerById·writerByName', () => {
  it('id 로 찾는다 — id 는 company.yaml 역할 id 와 같다', () => { expect(writerById('shorts_writer_b')?.name).toBe('임태윤'); });
  it('초기 배정분의 임시 id 도 해석한다 — 역할 id 로 합치기 전 레코드 호환', () => {
    expect(writerById('w_taeyun')?.id).toBe('shorts_writer_b');
    expect(writerById('w_haerin')?.id).toBe('shorts_writer');
  });
  it('레거시 레코드용 — 이름으로도 찾는다', () => { expect(writerByName('곽재현')?.id).toBe('shorts_writer_c'); });
  it('없으면 undefined', () => {
    expect(writerById('없는id')).toBeUndefined();
    expect(writerByName(undefined)).toBeUndefined();
  });
});

describe('pickWriter — 최근 쓴 작가 회피(순수)', () => {
  it('직전 작가는 다시 고르지 않는다', () => {
    expect(pickWriter(['shorts_writer']).id).not.toBe('shorts_writer');
  });
  it('아무도 안 썼으면 첫 작가부터', () => {
    expect(pickWriter([]).id).toBe('shorts_writer');
  });
  it('가장 오래 안 쓴 작가를 고른다 — 최신순 목록 기준', () => {
    // 최근 순서: 태윤(방금) → 재현 → 하린 → 하린 이므로 가장 오래된 건 하린
    expect(pickWriter(['shorts_writer_b', 'shorts_writer_c', 'shorts_writer', 'shorts_writer']).id).toBe('shorts_writer');
  });
  it('한 명만 계속 썼으면 나머지 중 목록 앞쪽을 고른다', () => {
    expect(pickWriter(['shorts_writer', 'shorts_writer', 'shorts_writer']).id).toBe('shorts_writer_b');
  });
  it('미지정(레거시)이 섞여 있어도 깨지지 않는다', () => {
    expect(SHORTS_WRITERS.map((w) => w.id)).toContain(pickWriter([undefined, 'shorts_writer', undefined]).id);
  });
  it('세 명을 돌아가며 배정한다 — 연속 중복 없음', () => {
    const recent: string[] = [];
    const picked: string[] = [];
    for (let i = 0; i < 6; i++) {
      const w = pickWriter(recent);
      picked.push(w.id);
      recent.unshift(w.id); // 최신순 유지
    }
    for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1]);
    expect(new Set(picked).size).toBe(3);
  });
});
