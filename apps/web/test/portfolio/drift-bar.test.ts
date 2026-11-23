import { describe, expect, test } from "bun:test";
import { driftBar, driftScaleBps } from "../../src/lib/portfolio/drift-bar";

describe("drift bar geometry", () => {
  test("the scale is a multiple of the threshold of at least twice it, covering the largest drift", () => {
    expect(driftScaleBps(0, 500)).toBe(1_000);
    expect(driftScaleBps(1_000, 500)).toBe(1_000);
    expect(driftScaleBps(1_001, 500)).toBe(1_500);
    expect(driftScaleBps(1_500, 500)).toBe(1_500);
    expect(driftScaleBps(9_000, 250)).toBe(9_000);
  });

  test("a bar starts at the centre and extends right above target and left below it", () => {
    expect(driftBar(1_500, 500, 1_500)).toEqual({
      left: "50.00%",
      width: "50.00%",
      lowerTick: "33.34%",
      upperTick: "66.66%",
      beyond: true,
    });
    expect(driftBar(-500, 500, 1_500)).toMatchObject({ left: "33.34%", width: "16.66%", beyond: true });
    expect(driftBar(-499, 500, 1_000)).toMatchObject({ left: "25.05%", width: "24.95%", beyond: false });
    expect(driftBar(0, 500, 1_000)).toMatchObject({ left: "50.00%", width: "0.00%", beyond: false });
  });

  test("widths round toward the centre and never pass the edge of the track", () => {
    expect(driftBar(1, 500, 1_500).width).toBe("0.03%");
    expect(driftBar(3_000, 500, 1_500)).toMatchObject({ left: "50.00%", width: "50.00%" });
    expect(driftBar(-3_000, 500, 1_500)).toMatchObject({ left: "0.00%", width: "50.00%" });
  });
});
