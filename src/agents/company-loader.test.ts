/**
 * 처리 등급(tier) ↔ 모델명 round-trip 회귀망.
 * 직원 탭의 '모델' 필드를 등급(micro|standard|heavy)으로 일원화하면서 도입한 매핑이
 * 미래 수정으로 조용히 깨지지 않도록 고정한다(적대적 리뷰 wajqd53rl 지적).
 */
import { describe, it, expect } from 'vitest';
import { normalizeModel, tierFor, tierToModel } from './company-loader';

describe('tier↔model 매핑', () => {
  it('normalizeModel: 모델명·등급·대소문자·무효값', () => {
    // 클라우드 모델명은 그대로
    expect(normalizeModel('opus')).toBe('opus');
    expect(normalizeModel('sonnet')).toBe('sonnet');
    expect(normalizeModel('haiku')).toBe('haiku');
    // 등급 → 대표 모델명
    expect(normalizeModel('micro')).toBe('haiku');
    expect(normalizeModel('standard')).toBe('sonnet');
    expect(normalizeModel('heavy')).toBe('opus');
    // 대소문자 무관
    expect(normalizeModel('MICRO')).toBe('haiku');
    expect(normalizeModel('Opus')).toBe('opus');
    // 무효값 → null(편집 거부)
    expect(normalizeModel('')).toBeNull();
    expect(normalizeModel(undefined)).toBeNull();
    expect(normalizeModel('gpt-9')).toBeNull();
    expect(normalizeModel('gemma3:4b')).toBeNull();
  });

  it('tierFor: 모델→등급, 누락 시 레벨 기본', () => {
    expect(tierFor('opus', 'member')).toBe('heavy');
    expect(tierFor('haiku', 'member')).toBe('micro');
    expect(tierFor('sonnet', 'member')).toBe('standard');
    // 누락 시 레벨 기본값
    expect(tierFor(undefined, 'ceo')).toBe('heavy');
    expect(tierFor(undefined, 'lead')).toBe('heavy');
    expect(tierFor(undefined, 'member')).toBe('standard');
    // 비표준/로컬 모델명은 기본 등급으로 수렴(원문은 r.model 에 보존됨 — editRole 가 책임)
    expect(tierFor('gemma3:4b', 'member')).toBe('standard');
    expect(tierFor('llama3', 'ceo')).toBe('heavy');
  });

  it('tierToModel: 등급→대표 모델', () => {
    expect(tierToModel('heavy')).toBe('opus');
    expect(tierToModel('standard')).toBe('sonnet');
    expect(tierToModel('micro')).toBe('haiku');
  });

  it('round-trip: 각 등급이 저장(model)·복원(tier)에서 보존', () => {
    for (const tier of ['micro', 'standard', 'heavy'] as const) {
      const stored = normalizeModel(tier); // 등급 → YAML 저장용 모델명
      expect(stored).not.toBeNull();
      expect(tierFor(stored!, 'member')).toBe(tier); // 로드 → 동일 등급 복원
    }
  });
});
