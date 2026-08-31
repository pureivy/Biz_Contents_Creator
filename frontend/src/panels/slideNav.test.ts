import { describe, expect, it } from "vitest";
import { canStep, clampIndex, neighborIndexes, slideName, slideUrl, stepIndex } from "./slideNav";

describe("slideNav", () => {
  it("slideName: 0-based → 1-based 2자리 파일명", () => {
    expect(slideName(0)).toBe("slide_01.png");
    expect(slideName(6)).toBe("slide_07.png");
    expect(slideName(9)).toBe("slide_10.png");
  });

  it("slideUrl: version 유무에 따라 캐시 무효화 쿼리", () => {
    expect(slideUrl("c1", 0)).toBe("/cardnews/c1/slides/slide_01.png");
    expect(slideUrl("c1", 2, "2026-07-27T02:41:18.067Z"))
      .toBe("/cardnews/c1/slides/slide_03.png?v=2026-07-27T02%3A41%3A18.067Z");
  });

  it("clampIndex: 범위 밖·비정상 입력을 안전한 인덱스로", () => {
    expect(clampIndex(3, 7)).toBe(3);
    expect(clampIndex(-2, 7)).toBe(0);
    expect(clampIndex(99, 7)).toBe(6);
    expect(clampIndex(NaN, 7)).toBe(0);
    expect(clampIndex(3, 0)).toBe(0); // 장수 0 — 뷰어가 뜨지 않는 경로지만 방어
  });

  it("stepIndex: 양끝에서 멈춘다(순환 없음)", () => {
    expect(stepIndex(0, 7, 1)).toBe(1);
    expect(stepIndex(6, 7, 1)).toBe(6); // 마지막 장에서 → 는 제자리
    expect(stepIndex(0, 7, -1)).toBe(0); // 첫 장에서 ← 는 제자리
    expect(stepIndex(6, 7, -1)).toBe(5);
  });

  it("canStep: 화살표 비활성 판정", () => {
    expect(canStep(0, 7, -1)).toBe(false);
    expect(canStep(0, 7, 1)).toBe(true);
    expect(canStep(6, 7, 1)).toBe(false);
    expect(canStep(0, 1, 1)).toBe(false); // 1장짜리는 양쪽 다 비활성
    expect(canStep(0, 0, 1)).toBe(false);
  });

  it("neighborIndexes: 존재하는 앞뒤만 프리로드", () => {
    expect(neighborIndexes(3, 7)).toEqual([2, 4]);
    expect(neighborIndexes(0, 7)).toEqual([1]);
    expect(neighborIndexes(6, 7)).toEqual([5]);
    expect(neighborIndexes(0, 1)).toEqual([]);
  });
});
