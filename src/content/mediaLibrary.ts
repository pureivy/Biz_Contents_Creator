/**
 * 사진·영상 보관소(2026-09-04) — 한 번 올려 두고 여러 콘텐츠가 꺼내 쓴다.
 *
 * 컴포저 첨부는 '이 런에만' 쓰인다. 그래서 같은 수국 사진을 수국 편마다 다시 올려야 했다.
 * 보관소는 그 반복을 없앤다: 올릴 때 어떤 소재인지 붙여 두면, 그 소재 콘텐츠가 만들어질 때
 * 자동으로 꺼내 쓴다.
 *
 * 문서 자료실(/sources)과 분리한 이유는 쓰임이 다르기 때문이다. 문서는 텍스트를 뽑아 위키에
 * 넣는 지식이고, 사진·영상은 화면에 그대로 나가는 소재다. 같은 곳에 두면 둘 다 어중간해진다.
 *
 * 파일 영속 패턴은 promises.ts 와 같다(원자적 교체, data/media/index.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { genId } from '../util/ids';

export type MediaKind = 'image' | 'video';

export interface MediaItem {
  id: string;
  /** 저장 파일의 절대경로. */
  file: string;
  kind: MediaKind;
  /** 원 파일명 — 목록 표시용. */
  name: string;
  bytes: number;
  /** 영상 길이(초). 이미지는 undefined. 씬 배정이 이 값을 본다. */
  seconds?: number;
  /** 소재 이름(species.yaml 의 키) — 이 파일이 무슨 소재인지. 없으면 범용 파일. */
  species?: string;
  /** 자유 태그 — 계절·부위·상황("가을", "열매", "전정"). 매칭 보조. */
  tags?: string[];
  /** 브랜드 슬러그 — 브랜드가 여럿일 때 섞이지 않게. */
  brand?: string;
  /** 사람이 적은 메모. */
  note?: string;
  createdTs: string;
}

const MEDIA_DIR = (): string => path.join(CONFIG.dataDir, 'media');
const INDEX = (): string => path.join(MEDIA_DIR(), 'index.json');

function readAll(): MediaItem[] {
  try { return JSON.parse(fs.readFileSync(INDEX(), 'utf-8')) as MediaItem[]; } catch { return []; }
}
function writeAll(rows: MediaItem[]): void {
  fs.mkdirSync(MEDIA_DIR(), { recursive: true });
  const tmp = `${INDEX()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
  fs.renameSync(tmp, INDEX()); // 원자적 교체 — 쓰기 도중 죽어도 목록이 깨지지 않는다
}

export const mediaDir = MEDIA_DIR;

export function listMedia(brand?: string): MediaItem[] {
  const rows = readAll();
  // 파일이 사라진 항목은 목록에서 뺀다(수동 삭제·이동 대응) — 없는 파일을 씬에 배정하면 렌더가 빈다.
  const alive = rows.filter((r) => { try { return fs.existsSync(r.file); } catch { return false; } });
  return (brand ? alive.filter((r) => !r.brand || r.brand === brand) : alive)
    .sort((a, b) => b.createdTs.localeCompare(a.createdTs));
}

export function addMedia(input: Omit<MediaItem, 'id' | 'createdTs'>): MediaItem {
  const item: MediaItem = { ...input, id: genId('media'), createdTs: new Date().toISOString() };
  writeAll([item, ...readAll()]);
  return item;
}

export function updateMedia(id: string, patch: Partial<Pick<MediaItem, 'species' | 'tags' | 'note'>>): MediaItem | undefined {
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return undefined;
  rows[i] = { ...rows[i]!, ...patch };
  writeAll(rows);
  return rows[i];
}

/** 목록에서 지우고 파일도 지운다. 파일 삭제 실패는 무시 — 목록에서 빠지면 더는 안 쓰인다. */
export function removeMedia(id: string): boolean {
  const rows = readAll();
  const hit = rows.find((r) => r.id === id);
  if (!hit) return false;
  writeAll(rows.filter((r) => r.id !== id));
  try { fs.rmSync(hit.file, { force: true }); } catch { /* 무해 */ }
  return true;
}

/**
 * 주제·키워드에 맞는 소재를 고른다(순수 판정 — 목록을 인자로 받는다).
 *
 * 우선순위가 중요하다. 소재가 일치하는 파일이 먼저다 — 수국 편에 회양목 사진이 들어가면
 * 안 쓰느니만 못하다. 그다음이 태그 일치, 마지막이 범용(소재 없는) 파일이다.
 * 소재가 '다른' 파일은 아예 안 쓴다.
 */
export function matchMedia(
  items: readonly MediaItem[],
  opts: {
    species?: string; text?: string; kind?: MediaKind; limit?: number;
    /**
     * 소재 이름을 표준명으로 바꾸는 함수(2026-09-04). 호출부가 소재 사전을 물려 준다.
     *
     * 왜 필요한가. 운영자가 '음나무'로 딱지를 붙여 올린 영상이 '엄나무' 편에서 배제됐다.
     * 같은 나무(Kalopanax septemlobus)인데 부르는 이름이 둘이고, 코드는 글자만 비교했다.
     * 별칭은 이미 소재 사전이 알고 있다 — 그 판정을 여기로 끌어온다. 사전을 모르는 이름은
     * 그대로 둔다(fail-open): 사전에 없다는 이유로 소재를 버리지 않는다.
     */
    canon?: (name: string) => string;
  },
): MediaItem[] {
  const text = String(opts.text ?? '');
  const canon = (n: string): string => {
    const t = String(n ?? '').trim();
    if (!t) return '';
    try { return String(opts.canon?.(t) ?? t).trim() || t; } catch { return t; }
  };
  const want = canon(opts.species ?? '');
  const scored: Array<{ m: MediaItem; s: number }> = [];
  for (const m of items) {
    if (opts.kind && m.kind !== opts.kind) continue;
    const label = String(m.species ?? '').trim();
    const named = canon(label);
    // 소재 판정 — 사전이 그 소재를 알면 이름으로 맞추고, 모르면 주제 문장에 그 이름이 있는지로 본다.
    //
    // 뒤쪽이 없으면 실측 사고가 난다(2026-09-04): 운영자가 사계장미 영상을 올린 뒤 사계장미 편이
    // 돌았는데, 그 시점 소재 사전에 사계장미가 없어 want 가 비었다. 그래서 '사계장미' 딱지가 붙은
    // 영상이 사계장미 편에서 배제됐다 — 사전에 없다는 이유로. 소재에 사람이 직접 적어 둔 이름이
    // 주제에 그대로 들어 있으면 그게 곧 근거다. 사전은 그 다음이다.
    // 사전이 그 종을 알면 표준명끼리 맞추고, 모르면 주제 문장에 그 이름(사용자가 적은 표기든
    // 표준명이든)이 있는지로 본다.
    const hit = named ? (want ? named === want : text.includes(label) || text.includes(named)) : false;
    if (label && !hit) continue; // 다른 소재·무관한 소재는 배제
    let s = 0;
    if (hit) s += 100;
    for (const t of m.tags ?? []) if (t && text.includes(t)) s += 10;
    if (!label) s += 1; // 범용 소재 — 없는 것보다 낫다
    if (s > 0) scored.push({ m, s });
  }
  scored.sort((a, b) => b.s - a.s || b.m.createdTs.localeCompare(a.m.createdTs));
  return scored.slice(0, opts.limit ?? 8).map((x) => x.m);
}
