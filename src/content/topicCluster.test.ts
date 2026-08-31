import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClusterStore, pickNextSibling, SIBLINGS_PER_SEED, PENDING_CAP, CONSUME_CAP_PER_SEED } from './topicCluster';
import type { ClusterTopic } from './topicCluster';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-'));

const sib = (n: number): { keyword: string; title: string } =>
  ({ keyword: `추희자두 형제${n}`, title: `추희자두 형제${n} 이야기` });

describe('ClusterStore — 등록·중복·캡·브랜드 격리', () => {
  let store: ClusterStore;
  beforeEach(() => { store = new ClusterStore(tmp()); });

  it('형제 N건 등록 + 같은 keyword 재등록은 중복 제외', () => {
    const a = store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(1), sib(2)] });
    expect(a).toHaveLength(2);
    const b = store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(2), sib(3)] });
    expect(b.map((x) => x.keyword)).toEqual(['추희자두 형제3']); // 형제2는 중복
  });

  it('시드당 상한 — SIBLINGS_PER_SEED 초과분은 버린다', () => {
    const many = Array.from({ length: 10 }, (_, i) => sib(i));
    expect(store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: many })).toHaveLength(SIBLINGS_PER_SEED);
  });

  it('브랜드 pending 캡 — PENDING_CAP 도달 시 추가 등록 안 됨', () => {
    for (let s = 0; s < 5; s++) {
      store.createMany({ brand: 'b1', seedKeyword: `시드${s}`,
        siblings: Array.from({ length: 6 }, (_, i) => ({ keyword: `시드${s} 갈래${i}`, title: `시드${s} 갈래${i} 글` })) });
    }
    expect(store.pending('b1').length).toBeLessThanOrEqual(PENDING_CAP);
  });

  it('브랜드 격리 — 다른 브랜드 pending 은 안 보인다', () => {
    store.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(1)] });
    expect(store.pending('b2')).toHaveLength(0);
  });

  it('재로드 영속 — 새 인스턴스로 읽어도 남아 있다', () => {
    const dir = tmp();
    const s1 = new ClusterStore(dir);
    s1.createMany({ brand: 'b1', seedKeyword: '추희자두', siblings: [sib(1)] });
    expect(new ClusterStore(dir).pending('b1')).toHaveLength(1);
  });
});

describe('pickNextSibling — 쿨다운·소진 상한(순수)', () => {
  const mk = (id: string, seed: string, status: ClusterTopic['status'], ts: string): ClusterTopic => ({
    id, seedKeyword: seed, keyword: `${seed} ${id}`, title: `${seed} ${id} 글`,
    status, createdTs: ts, updatedTs: ts, brand: 'b1',
  });

  it('쿨다운 — 최근 자율 3편 안에 같은 시드 형제가 있으면 그 시드는 건너뛰고 다른 시드 선택', () => {
    const all = [mk('a1', '추희자두', 'pending', '1'), mk('b1x', '배롱나무', 'pending', '2')];
    // 최근 자율 blog: 가장 최근 것이 추희자두 형제(a0)였다 → 추희자두 시드 쿨다운
    const picked = pickNextSibling(all, [...all, mk('a0', '추희자두', 'consumed', '0')],
      ['a0', undefined, undefined]);
    expect(picked?.seedKeyword).toBe('배롱나무');
  });

  it('소진 상한 — consumed 4편인 시드는 제외', () => {
    const consumed = Array.from({ length: CONSUME_CAP_PER_SEED }, (_, i) => mk(`c${i}`, '추희자두', 'consumed', '0'));
    const all = [...consumed, mk('a9', '추희자두', 'pending', '5'), mk('b1x', '배롱나무', 'pending', '6')];
    expect(pickNextSibling(all.filter((t) => t.status === 'pending'), all, [])?.seedKeyword).toBe('배롱나무');
  });

  it('후보 없으면 null', () => {
    expect(pickNextSibling([], [], [])).toBeNull();
  });

  it('등록 오래된 순 — 같은 조건이면 createdTs 이른 것', () => {
    const all = [mk('n2', '감나무', 'pending', '2'), mk('n1', '배롱나무', 'pending', '1')];
    expect(pickNextSibling(all, all, [])?.id).toBe('n1');
  });
});
