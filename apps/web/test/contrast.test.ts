import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * WCAG 2.x contrast of the design tokens, computed from the values in src/styles/tokens.css.
 * Targets: 4.5:1 for every text role, 3:1 for control outlines.
 */

type Theme = "light" | "dark";
type Tokens = Record<string, Record<Theme, string>>;

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

const tokens: Tokens = {};
for (const match of css.matchAll(/--([a-z-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/g)) {
  const [, name, light, dark] = match;
  if (name && light && dark) tokens[name] = { light, dark };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => channel(Number.parseInt(hex.slice(start, start + 2), 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

function token(name: string, theme: Theme): string {
  const value = tokens[name]?.[theme];
  if (!value) throw new Error(`token --${name} is missing from tokens.css`);
  return value;
}

const surfaces = ["bg-page", "bg-surface", "bg-subtle"];
const semantic = ["positive", "negative", "warning", "info"];

/** [foreground, background, minimum ratio] */
const pairs: [string, string, number][] = [
  ...["text-primary", "text-secondary", "text-tertiary", "accent", ...semantic].flatMap((foreground) =>
    surfaces.map((background): [string, string, number] => [foreground, background, 4.5]),
  ),
  ...semantic.map((name): [string, string, number] => [name, `${name}-subtle`, 4.5]),
  ["accent", "accent-subtle", 4.5],
  ["text-primary", "accent-subtle", 4.5],
  ["accent-fg", "accent", 4.5],
  ["accent-fg", "accent-hover", 4.5],
  ...surfaces.map((background): [string, string, number] => ["border-strong", background, 3]),
  ...surfaces.map((background): [string, string, number] => ["negative", background, 3]),
];

describe("design token contrast", () => {
  test("the token file was parsed", () => {
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(22);
  });

  test("the formula matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const [foreground, background, minimum] of pairs) {
      test(`${theme}: --${foreground} on --${background} is at least ${minimum}:1`, () => {
        expect(contrast(token(foreground, theme), token(background, theme))).toBeGreaterThanOrEqual(minimum);
      });
    }
  }

  test("disabled text stays distinguishable from the surface it sits on", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(contrast(token("text-disabled", theme), token("bg-surface", theme))).toBeGreaterThanOrEqual(3);
    }
  });
});
