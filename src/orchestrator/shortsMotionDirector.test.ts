import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { motionGuideFor, buildMotionDirectorTask, sanitizeMotionPrompt, parseMotionPrompts, directSceneMotion, hasSubjectRisk, cameraOnlyMotionPrompt } from './shortsMotionDirector';

// directSceneMotion 정렬 리맵 검증용 — 비전 호출·게이트만 목킹(순수 함수 테스트에는 영향 없음).
vi.mock('./agent', () => ({ microJSON: vi.fn() }));
vi.mock('./visionCommon', () => ({ stdModel: () => 'claude-sonnet-5', visionCapable: () => true }));

describe('motionGuideFor — 씬 의도별 모션 가이드(순수)', () => {
  it('훅(kind 또는 첫 씬)=시선 포착, 오버레이 3종=절제, cta=마무리, 본문=기본', () => {
    expect(motionGuideFor('hook', false)).toContain('push-in');
    expect(motionGuideFor(undefined, true)).toContain('push-in');   // 첫 씬은 kind 없어도 훅 취급
    for (const k of ['stat', 'list', 'quote'] as const) expect(motionGuideFor(k, false)).toContain('절제');
    expect(motionGuideFor('cta', false)).toContain('마무리');
    expect(motionGuideFor(undefined, false)).toContain('본문');
  });
});

describe('buildMotionDirectorTask — 배치 프롬프트 조립(순수)', () => {
  it('씬 순번·내레이션·자막·스타일 힌트·무텍스트 규칙·JSON 스키마 포함', () => {
    const t = buildMotionDirectorTask(
      [{ narration: '하스카프베리는 두 품종을 심어야 열매가 열립니다', screenText: '두 품종 필수', kind: 'hook' },
       { narration: '수분수 거리는 삼 미터 이내가 좋습니다', kind: 'stat' }],
      '따뜻한 자연광, 밝은 텃밭',
    );
    expect(t).toContain('2장');
    expect(t).toContain('1. [');
    expect(t).toContain('두 품종 필수');
    expect(t).toContain('따뜻한 자연광');
    expect(t).toContain('no text, no captions');
    expect(t).toContain('"motions"');
    expect(t).toContain('이미지 안에 글자가 보여도'); // 인젝션 가드
  });
});

describe('sanitizeMotionPrompt — 결정적 가드(순수)', () => {
  it('정상 프롬프트 통과 + no text 접미 보장', () => {
    const ok = sanitizeMotionPrompt('Slow push-in toward the berry bush, leaves swaying gently in the breeze.');
    expect(ok).toContain('push-in');
    expect(ok?.toLowerCase()).toContain('no text');
    // 이미 no text 있으면 중복 부착 안 함
    const has = sanitizeMotionPrompt('Gentle drift across the garden. no text, no captions.');
    expect(has?.match(/no text/gi)?.length).toBe(1);
  });
  it('비문자열·과단문·금지어(컷·전환·자막 삽입 등)는 null(씬별 폴백)', () => {
    expect(sanitizeMotionPrompt(42)).toBeNull();
    expect(sanitizeMotionPrompt('too short')).toBeNull();
    expect(sanitizeMotionPrompt('Dramatic cut to another scene with fast camera movement everywhere.')).toBeNull();
    expect(sanitizeMotionPrompt('Slow zoom then scene change into a different location entirely here.')).toBeNull();
    expect(sanitizeMotionPrompt('Add text overlay saying hello world on top of the video frame now.')).toBeNull();
  });
  it('400자 캡', () => {
    const long = `Slow cinematic drift over the field. ${'gentle breeze moves the grass. '.repeat(30)}`;
    const out = sanitizeMotionPrompt(long);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(430); // 400 캡 + 접미
  });
});

describe('hasSubjectRisk / cameraOnlyMotionPrompt — 사람·손·도구 카메라 전용 하드 게이트(2026-07-31)', () => {
  it('사람·손·도구 씬 매칭', () => {
    for (const p of ['정원사가 가지를 자르는 모습', '전정가위로 가지 정리 클로즈업', '손으로 흙을 만지는 장면', '모종삽으로 흙을 뜨는 베란다', '장갑을 낀 채 분갈이', 'a farmer pruning with shears']) {
      expect(hasSubjectRisk(p)).toBe(true);
    }
  });
  it('합성어 오탐 제외 — 손상·삽목·손실·괭이밥·톱니·칼륨은 비매칭', () => {
    for (const p of ['잎이 손상된 배롱나무 가지', '제라늄 삽목 화분이 놓인 선반', '수확 손실을 줄이는 배수', '괭이밥이 자란 화단 구석', '톱니 모양 잎맥의 접사', '칼륨 비료 알갱이와 흙']) {
      expect(hasSubjectRisk(p)).toBe(false);
    }
  });
  it('템플릿 — 마커·정지 지시·no text 포함, kind 별 카메라 반영', () => {
    const base = cameraOnlyMotionPrompt();
    expect(base.startsWith('Camera work only:')).toBe(true);
    expect(base).toContain('perfectly still');
    expect(base.toLowerCase()).toContain('no text');
    expect(cameraOnlyMotionPrompt('hook')).toContain('push-in');
    expect(cameraOnlyMotionPrompt(undefined, true)).toContain('push-in'); // 첫 씬은 kind 없어도 훅 취급
    expect(cameraOnlyMotionPrompt('cta')).toContain('pull-back');
    expect(cameraOnlyMotionPrompt('stat')).toContain('drift');
  });
  it('parseMotionPrompts — subject 분류가 걸리면 LLM 창작 프롬프트를 버리고 템플릿 강제', () => {
    const creative = 'A hand reaches in and prunes the branch with scissors, petals drifting down slowly.';
    const calm = 'Very slow lateral drift across the terracotta pots on the sunlit shelf. no text, no captions.';
    const out = parseMotionPrompts({ motions: [
      { scene: 1, prompt: creative, subject: 'hands' },
      { scene: 2, prompt: calm, subject: 'none' },
      { scene: 3, prompt: calm, subject: 'Tool ' }, // 대소문자·공백 정규화
    ] }, 3, ['hook', undefined, 'cta']);
    expect(out[0]?.startsWith('Camera work only:')).toBe(true);
    expect(out[0]).toContain('push-in');           // kinds[0]=hook 반영
    expect(out[1]).toBe(calm);                     // none 은 종전대로 위생만
    expect(out[2]?.startsWith('Camera work only:')).toBe(true);
    expect(out[2]).toContain('pull-back');         // kinds[2]=cta 반영
  });
});

describe('parseMotionPrompts — 응답 → 슬롯 배열(순수)', () => {
  const P = 'Slow push-in toward the subject, soft ambient movement in the background. no text, no captions.';
  it('순번 매핑·범위밖 무시·누락 씬 null·중복은 첫 유효값 우선', () => {
    const out = parseMotionPrompts({ motions: [
      { scene: 2, prompt: P }, { scene: 5, prompt: P }, { scene: 0, prompt: P },
      { scene: 2, prompt: 'x' }, // 중복 — 첫 유효값 유지(??= 라 불량 첫값 뒤 유효 둘째값은 채워짐)
    ] }, 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeNull();
    expect(out[1]).toContain('push-in');
    expect(out[2]).toBeNull();
  });
  it('null 응답·빈 motions → 전부 null(전체 폴백)', () => {
    expect(parseMotionPrompts(null, 2)).toEqual([null, null]);
    expect(parseMotionPrompts({}, 2)).toEqual([null, null]);
  });
});

describe('directSceneMotion — null 구멍 images 의 origIndex 정렬 리맵(리뷰 MEDIUM 보강)', () => {
  const P1 = 'Slow push-in toward the wilted tree, leaves trembling gently in the draft. no text, no captions.';
  const P2 = 'Very slow lateral drift across the maple pots, branches swaying subtly. no text, no captions.';

  it('images=[A, null, B] → 프롬프트가 슬롯 0·2에 배치, 씬 컨텍스트도 0·2만 전달', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
    const imgA = path.join(dir, 'a.png'); fs.writeFileSync(imgA, 'x');
    const imgB = path.join(dir, 'b.png'); fs.writeFileSync(imgB, 'x');
    const { microJSON } = await import('./agent');
    (microJSON as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      motions: [{ scene: 1, prompt: P1 }, { scene: 2, prompt: P2 }],
    });
    const scenes = [
      { narration: '첫씬 내레이션입니다', kind: 'hook' as const },
      { narration: '이건 비전에 안 가야 함' },
      { narration: '셋째씬 내레이션입니다', kind: 'cta' as const },
    ];
    const out = await directSceneMotion({ images: [imgA, null, imgB], scenes });
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('push-in');   // checked[0]=orig 0
    expect(out[1]).toBeNull();             // null 이미지 슬롯은 그대로 null
    expect(out[2]).toContain('lateral');   // checked[1]=orig 2 — 밀리지 않음
    // 비전 task 에는 non-null 씬(0·2)의 컨텍스트만 순번 1·2로 들어가야 함
    const task = (microJSON as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as string;
    expect(task).toContain('2장');
    expect(task).toContain('첫씬 내레이션');
    expect(task).toContain('셋째씬 내레이션');
    expect(task).not.toContain('비전에 안 가야');
  });

  it('비전이 일부 씬을 누락하면 그 씬만 null(다른 씬으로 밀리지 않음)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
    const imgs = [0, 1, 2].map((i) => { const p = path.join(dir, `s${i}.png`); fs.writeFileSync(p, 'x'); return p; });
    const { microJSON } = await import('./agent');
    (microJSON as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      motions: [{ scene: 1, prompt: P1 }, { scene: 3, prompt: P2 }], // 씬2 누락
    });
    const out = await directSceneMotion({ images: imgs, scenes: imgs.map(() => ({ narration: '내레이션 문장입니다' })) });
    expect(out[0]).toContain('push-in');
    expect(out[1]).toBeNull();
    expect(out[2]).toContain('lateral');
  });

  it('microJSON 예외 → 전부 null(fail-open)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
    const img = path.join(dir, 'x.png'); fs.writeFileSync(img, 'x');
    const { microJSON } = await import('./agent');
    (microJSON as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('vision down'));
    const out = await directSceneMotion({ images: [img], scenes: [{ narration: '내레이션 문장입니다' }] });
    expect(out).toEqual([null]);
  });
});

describe('selectI2vScenes — 결정적 I2V 컷 선정(상한제, 순수)', () => {
  const base = (n: number) => ({
    kinds: Array.from({ length: n }, () => undefined) as Array<'hook' | 'stat' | 'list' | 'quote' | 'cta' | undefined>,
    motionPrompts: Array.from({ length: n }, () => null) as Array<string | null>,
    subjectScenes: new Set<number>(),
    scenePrompts: Array.from({ length: n }, () => '나무가 있는 풍경'),
    images: Array.from({ length: n }, (_, i) => `/img/${i}.png`) as Array<string | null>,
  });
  it('훅(첫 씬)이 항상 1순위 — 상한 1이면 훅만', async () => {
    const { selectI2vScenes } = await import('./shortsMotionDirector');
    const r = selectI2vScenes({ ...base(6), max: 1 });
    expect([...r.allowed]).toEqual([0]);
    expect(r.reasons[0]).toContain('훅');
  });
  it('서열: 훅 > 본문 > cta > 오버레이, 동점은 앞 씬 우선', async () => {
    const { selectI2vScenes } = await import('./shortsMotionDirector');
    const o = base(6);
    o.kinds = ['hook', 'stat', undefined, undefined, 'list', 'cta'];
    const r = selectI2vScenes({ ...o, max: 3 });
    expect([...r.allowed].sort()).toEqual([0, 2, 3]); // 훅 + 본문 2(앞 씬 우선)
  });
  it('eligible 필터 — 이미지 없음·subject 씬·Camera-only·묘사 위험은 제외', async () => {
    const { selectI2vScenes } = await import('./shortsMotionDirector');
    const o = base(5);
    o.images[0] = null;                                  // 훅: 이미지 없음
    o.subjectScenes = new Set([1]);                      // 씬2: 비전 판정
    o.motionPrompts[2] = 'Camera work only: slow drift'; // 씬3: 카메라 전용 마커
    o.scenePrompts[3] = '가위로 가지를 자르는 손';          // 씬4: 묘사 위험
    const r = selectI2vScenes({ ...o, max: 3 });
    expect([...r.allowed]).toEqual([4]); // 씬5만 생존
  });
  it('상한 0=빈 셋(전 씬 스킵), 상한이 eligible 수보다 크면 전원', async () => {
    const { selectI2vScenes } = await import('./shortsMotionDirector');
    expect(selectI2vScenes({ ...base(4), max: 0 }).allowed.size).toBe(0);
    expect(selectI2vScenes({ ...base(4), max: 8 }).allowed.size).toBe(4);
  });
});
