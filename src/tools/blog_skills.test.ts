import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { parseImagePayload, parsePublishPayload, containImageManifest, parseStatsOutput,
  publishDraftToNaver, collectNaverMetrics } from './blog_skills';
import type { BlogDraft } from '../output/formatter';

describe('parseImagePayload', () => {
  it('평문 arg → content, 기본 스타일/limit', () => {
    const p = parseImagePayload('원두 클로즈업 [IMAGE: 매장 외관]');
    expect(p.content).toContain('원두');
    expect(p.draftJson).toBeUndefined();
    expect(p.imageStyle).toBe('photorealistic');
    expect(p.limit).toBe(4);
  });

  it('JSON arg(imageSlots) → draftJson 통째 보존', () => {
    const raw = JSON.stringify({ imageSlots: [{ alt: 'a', prompt: 'p' }], topic: '카페' });
    const p = parseImagePayload(raw);
    expect(p.draftJson).toBe(raw);
    expect(p.content).toBeUndefined();
    expect(p.topic).toBe('카페');
  });

  it('JSON arg(필드) → content + business_type/style/limit 반영', () => {
    const p = parseImagePayload(JSON.stringify({
      content: '본문', business_type: '음식점', image_style: 'watercolor', topic: '국밥집', limit: 20,
    }));
    expect(p.content).toBe('본문');
    expect(p.businessType).toBe('음식점');
    expect(p.imageStyle).toBe('watercolor');
    expect(p.topic).toBe('국밥집');
    expect(p.limit).toBe(8); // 8 로 클램프
  });

  it('깨진 JSON → 평문 content 폴백', () => {
    const p = parseImagePayload('{not json');
    expect(p.content).toBe('{not json');
    expect(p.limit).toBe(4);
  });

  it('limit 하한 클램프', () => {
    expect(parseImagePayload(JSON.stringify({ content: 'x', limit: 0 })).limit).toBe(4);
    expect(parseImagePayload(JSON.stringify({ content: 'x', limit: -3 })).limit).toBe(4);
  });
});

describe('parsePublishPayload', () => {
  it('final_content/image_manifest/dry_run 파싱', () => {
    const p = parsePublishPayload(JSON.stringify({
      final_content: { tags: ['a'] }, image_manifest: { images: [] }, dry_run: true,
    }));
    expect(p.finalContent).toEqual({ tags: ['a'] });
    expect(p.imageManifest).toEqual({ images: [] });
    expect(p.dryRun).toBe(true);
  });

  it('camelCase 별칭 허용', () => {
    const p = parsePublishPayload(JSON.stringify({ finalContent: { t: 1 }, dryRun: true }));
    expect(p.finalContent).toEqual({ t: 1 });
    expect(p.dryRun).toBe(true);
  });

  it('final_content 없으면 undefined(호출부가 안내 반환)', () => {
    const p = parsePublishPayload('{}');
    expect(p.finalContent).toBeUndefined();
    expect(p.dryRun).toBe(false);
  });

  it('비 JSON → 빈 페이로드', () => {
    const p = parsePublishPayload('그냥 발행해줘');
    expect(p.finalContent).toBeUndefined();
    expect(p.dryRun).toBe(false);
  });
});

describe('containImageManifest(보안 — 샌드박스 경로 컨테인먼트)', () => {
  const sb = '/tmp/sb/agent/workspace';
  const inside = path.join(sb, 'images', 'blog-image-01.png');

  it('샌드박스 하위 file_path 는 유지', () => {
    const r = containImageManifest({ images: [{ file_path: inside }] }, sb);
    expect(r.manifest.images).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it('샌드박스 밖 절대경로(시크릿 유출)는 드롭', () => {
    const r = containImageManifest({ images: [
      { file_path: '/Users/victim/.ssh/id_rsa' },
      { file_path: inside },
      { file_path: '/etc/passwd' },
    ] }, sb);
    expect(r.manifest.images).toHaveLength(1);
    expect((r.manifest.images as Array<{ file_path: string }>)[0]?.file_path).toBe(inside);
    expect(r.dropped).toBe(2);
  });

  it('.. 탈출·비문자열·누락 file_path 드롭', () => {
    const r = containImageManifest({ images: [
      { file_path: path.join(sb, '..', '..', 'secret.png') },
      { file_path: 123 },
      { alt: 'no path' },
    ] }, sb);
    expect(r.manifest.images).toHaveLength(0);
    expect(r.dropped).toBe(3);
  });

  it('images 없거나 매니페스트 아님 → 빈 images', () => {
    expect(containImageManifest({}, sb).manifest.images).toEqual([]);
    expect(containImageManifest(null, sb).manifest.images).toEqual([]);
    expect(containImageManifest('x', sb).manifest.images).toEqual([]);
  });

  it('샌드박스 접두 우회(형제 디렉토리) 차단', () => {
    // /tmp/sb/agent/workspace-evil 은 root(/tmp/sb/agent/workspace/) 접두를 만족하지 않아야 한다.
    const r = containImageManifest({ images: [{ file_path: '/tmp/sb/agent/workspace-evil/x.png' }] }, sb);
    expect(r.manifest.images).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
});

describe('parseStatsOutput(성과 수집 스크립트 출력 파싱)', () => {
  it('RESULT_JSON 줄을 정규화 — views·dwell·유입 키워드', () => {
    const out = '진행 로그...\nRESULT_JSON: {"views":137,"dwellSec":52,"searchInflow":[{"keyword":"장마철 습도","count":18,"rank":1},{"keyword":"제습기 없이","count":7}],"source":"scrape:naver_advisor","note":"","captured":4}\n';
    const r = parseStatsOutput(out)!;
    expect(r.ok).toBe(true);
    expect(r.views).toBe(137);
    expect(r.dwellSec).toBe(52);
    expect(r.searchInflow).toEqual([
      { keyword: '장마철 습도', count: 18, rank: 1 },
      { keyword: '제습기 없이', count: 7 },
    ]);
    expect(r.source).toBe('scrape:naver_advisor');
    expect(r.captured).toBe(4);
  });

  it('RESULT_JSON 없으면 null', () => {
    expect(parseStatsOutput('아무 로그도 결과 줄이 없음\n(exit 0)')).toBeNull();
  });

  it('마지막 RESULT_JSON 을 사용(재시도로 여러 줄이면 최신)', () => {
    const out = 'RESULT_JSON: {"views":1,"searchInflow":[]}\nRESULT_JSON: {"views":9,"searchInflow":[]}';
    expect(parseStatsOutput(out)!.views).toBe(9);
  });

  it('빈 수집(views 0·유입 0)도 ok=true 로 파싱(호출부가 fail-open 판단)', () => {
    const r = parseStatsOutput('RESULT_JSON: {"views":0,"searchInflow":[],"note":"자동 추출 실패"}')!;
    expect(r.ok).toBe(true);
    expect(r.views).toBe(0);
    expect(r.searchInflow).toEqual([]);
    expect(r.note).toContain('자동 추출 실패');
  });

  it('음수·비정상 값 방어(count 음수→0, 비문자 keyword 드롭)', () => {
    const r = parseStatsOutput('RESULT_JSON: {"views":-5,"searchInflow":[{"keyword":"","count":3},{"keyword":"ok","count":-2}]}')!;
    expect(r.views).toBe(0);
    expect(r.searchInflow).toEqual([{ keyword: 'ok', count: 0 }]);
  });
});

// 브랜드 슬러그는 프로필 dir(~/.naver-blog-profiles/<slug>)·세션 파일명(.naver_session-<slug>.json)에
// 그대로 끼워지므로, 구분자·점이 든 슬러그가 FS 경계에 닿기 전에 거절돼야 한다(경로 탈출 차단).
// 정상 경로(activeBrandSlug/piece.brand, 저장 엔드포인트)는 항상 검증된 슬러그만 넘기지만, 방어 계층.
describe('브랜드 슬러그 FS 경계 방어(defense-in-depth)', () => {
  const MINIMAL_DRAFT = { title: 't', bodyMarkdown: 'b' } as unknown as BlogDraft;
  for (const bad of ['a/b', '..', 'a/../b', 'x\\y', 'has space', 'dot.slug']) {
    it(`publishDraftToNaver — 무효 슬러그 '${bad}' 는 발행 전 거절(경로 미생성·spawn 없음)`, async () => {
      const r = await publishDraftToNaver('/tmp/nonexistent-session', MINIMAL_DRAFT, { brand: bad, dryRun: true });
      expect(r.ok).toBe(false);
      expect(r.status).toBe('ERROR');
      expect(r.issues.join(' ')).toContain('무효한 브랜드 슬러그');
    });
  }
  it('collectNaverMetrics — 무효 슬러그는 수집 생략(null, spawn 없음)', async () => {
    const runDir = path.join(os.tmpdir(), 'naver-slug-guard-test');
    expect(await collectNaverMetrics('https://blog.naver.com/x/1', runDir, { brand: '../evil' })).toBeNull();
  });
});

// 실사고(2026-08-31): .env 의 BLOG_PYTHON 이 삭제된 Desktop 사본을 가리켜 naver_stats.py 가 실행조차
// 안 됐는데, runScript 가 돌려준 진짜 사유("스크립트/인터프리터 없음: …")를 parseStatsOutput 이 버리고
// null 로 만들었다. 그 결과 성과탭 새로고침이 94개 글에 "표본 없음(발행 초기 집계 지연 가능)" 만 남겨
// 설정 오류가 '데이터가 아직 없음'으로 읽혔다. 아침의 claude CLI 건과 같은 부류 — 원인 삼킴.
describe('blogSkillProblem — 블로그 스킬 사전 점검', () => {
  it('BLOG_PYTHON 미설정이면 사유를 돌려준다', async () => {
    const { blogSkillProblem } = await import('./blog_skills');
    expect(blogSkillProblem('naver_stats.py', '', '/any/dir')).toMatch(/BLOG_PYTHON/);
  });

  it('인터프리터 경로가 없으면 그 경로를 사유에 담는다', async () => {
    const { blogSkillProblem } = await import('./blog_skills');
    const why = blogSkillProblem('naver_stats.py', '/nonexistent/python', '/nonexistent/dir');
    expect(why).toContain('/nonexistent/python');
  });

  it('인터프리터는 있고 스크립트만 없으면 스크립트 경로를 사유에 담는다', async () => {
    const { blogSkillProblem } = await import('./blog_skills');
    const why = blogSkillProblem('naver_stats.py', '/bin/sh', '/nonexistent/dir');
    expect(why).toContain('naver_stats.py');
  });

  it('인터프리터·스크립트가 모두 있으면 null(문제 없음)', async () => {
    const { blogSkillProblem } = await import('./blog_skills');
    // /bin/sh 를 인터프리터로, /bin/echo 가 있는 /bin 을 스크립트 디렉토리로 삼아 존재성만 확인한다.
    expect(blogSkillProblem('echo', '/bin/sh', '/bin')).toBeNull();
  });
});

// 같은 실사고의 2차 원인 — RESULT_JSON 이 없는 출력을 통째로 null 로 만들어 실패 사유가 증발했다.
// 호출부(measurePiece)는 null 을 받으면 '수집 결과 파싱 실패'라는 자체 문구로 덮어써서, 스크립트가
// 아예 실행되지 않았다는 사실이 어디에도 남지 않았다.
describe('statsResultFrom — 수집 실패 사유 보존', () => {
  it('RESULT_JSON 이 있으면 종전대로 파싱한다', async () => {
    const { statsResultFrom } = await import('./blog_skills');
    const r = statsResultFrom({ ok: true, output: 'RESULT_JSON: {"views":137,"source":"scrape:naver_advisor"}' });
    expect(r?.views).toBe(137);
    expect(r?.source).toBe('scrape:naver_advisor');
  });

  it('스크립트가 실패했고 RESULT_JSON 도 없으면 사유를 note 에 실어 돌려준다', async () => {
    const { statsResultFrom } = await import('./blog_skills');
    const r = statsResultFrom({ ok: false, output: '(파이썬 인터프리터 없음: /gone/python (.env 의 BLOG_PYTHON 확인))' });
    expect(r).not.toBeNull();
    expect(r!.views).toBe(0);
    expect(r!.searchInflow).toEqual([]);
    expect(r!.note).toContain('/gone/python');
  });

  it('정상 종료인데 RESULT_JSON 만 없으면 null(종전 동작 — 데이터 없음)', async () => {
    const { statsResultFrom } = await import('./blog_skills');
    expect(statsResultFrom({ ok: true, output: '로그인 필요' })).toBeNull();
  });

  it('실패 사유가 길어도 note 는 잘려서 담긴다(로그 폭주 방지)', async () => {
    const { statsResultFrom } = await import('./blog_skills');
    const r = statsResultFrom({ ok: false, output: 'x'.repeat(5000) });
    expect(r!.note!.length).toBeLessThanOrEqual(300);
  });
});
