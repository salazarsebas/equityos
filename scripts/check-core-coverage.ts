/**
 * Coverage gate for `packages/core`. Reads the Istanbul coverage map written by `scripts/core-coverage-preload.ts`
 * and fails when statement or branch coverage of `packages/core/src` as a whole is below the floor.
 *
 *   bun run test:coverage:core
 *   bun scripts/check-core-coverage.ts packages/core/coverage/istanbul.json packages/core/src --min 95
 *
 * Every `.ts` file of the source directory must be in the map: a file that no test loads is not instrumented, so
 * it would otherwise be left out of the totals instead of counting as uncovered. It prints one line per file and
 * the totals, and exits with 1 when the totals are below the floor or a file is missing.
 */
import { readdirSync } from "node:fs";
import { DEFAULT_MIN_PERCENT, percent } from "./check-contracts-coverage.ts";

export interface Counts {
  readonly covered: number;
  readonly total: number;
}

export interface FileCoverage {
  readonly file: string;
  readonly statements: Counts;
  readonly branches: Counts;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function record(value: Json | undefined, what: string): { [key: string]: Json } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`missing ${what}`);
  return value;
}

function count(value: Json, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${what}`);
  return value;
}

/** Forward slashes, from `src/` on when the path contains it. */
export function relativeSource(path: string): string {
  const forward = path.replaceAll("\\", "/");
  const marker = forward.lastIndexOf("/src/");
  return marker === -1 ? forward : forward.slice(marker + 1);
}

/** Statement and branch counts per file of an Istanbul coverage map. Each arm of a branch counts once. */
export function parseCoverageMap(input: unknown): FileCoverage[] {
  const map = record(input as Json, "coverage map");
  return Object.entries(map)
    .map(([path, entry]) => {
      const file = record(entry, `coverage of ${path}`);
      const statements = Object.values(record(file.s, `statements of ${path}`)).map((hits) =>
        count(hits, `statement count of ${path}`),
      );
      const arms = Object.values(record(file.b, `branches of ${path}`)).flatMap((hits) => {
        if (!Array.isArray(hits)) throw new Error(`invalid branch counts of ${path}`);
        return hits.map((arm) => count(arm, `branch count of ${path}`));
      });
      return {
        file: relativeSource(path),
        statements: { covered: statements.filter((hits) => hits > 0).length, total: statements.length },
        branches: { covered: arms.filter((hits) => hits > 0).length, total: arms.length },
      };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export interface CoreCoverageCheck {
  readonly files: readonly FileCoverage[];
  /** Source files that are not in the map. */
  readonly missing: readonly string[];
  readonly statementsPercent: number;
  readonly branchesPercent: number;
  readonly ok: boolean;
}

function sum(counts: readonly Counts[]): Counts {
  return counts.reduce(
    (total, { covered, total: all }) => ({ covered: total.covered + covered, total: total.total + all }),
    {
      covered: 0,
      total: 0,
    },
  );
}

/** `sources` are the `src/...` paths that must be present. */
export function checkCoreCoverage(
  files: readonly FileCoverage[],
  sources: readonly string[],
  minPercent: number,
): CoreCoverageCheck {
  const present = new Set(files.map(({ file }) => file));
  const missing = sources.filter((source) => !present.has(source));
  const statements = sum(files.map(({ statements }) => statements));
  const branches = sum(files.map(({ branches }) => branches));
  const statementsPercent = percent(statements.covered, statements.total);
  const branchesPercent = percent(branches.covered, branches.total);
  return {
    files,
    missing,
    statementsPercent,
    branchesPercent,
    ok: files.length > 0 && missing.length === 0 && statementsPercent >= minPercent && branchesPercent >= minPercent,
  };
}

function line(label: string, statements: Counts, branches: Counts): string {
  const share = ({ covered, total }: Counts) => `${percent(covered, total).toFixed(2)}% (${covered}/${total})`;
  return `${label}: statements ${share(statements)}, branches ${share(branches)}`;
}

export function formatCoreCoverage(check: CoreCoverageCheck, minPercent: number): string {
  const lines = check.files.map(({ file, statements, branches }) => `     ${line(file, statements, branches)}`);
  for (const file of check.missing) lines.push(`FAIL ${file}: not loaded by any test`);
  const totals = line(
    "packages/core/src",
    sum(check.files.map((file) => file.statements)),
    sum(check.files.map((file) => file.branches)),
  );
  lines.push(`${check.ok ? "ok  " : "FAIL"} ${totals}`);
  lines.push(`floor: ${minPercent}% statements and branches over packages/core/src`);
  return lines.join("\n");
}

export function parseArguments(argv: readonly string[]): { path: string; sourceDir: string; minPercent: number } {
  const [path, sourceDir, ...rest] = argv;
  if (path === undefined || sourceDir === undefined || path.startsWith("--") || sourceDir.startsWith("--")) {
    throw new Error("usage: bun scripts/check-core-coverage.ts <coverage.json> <src directory> [--min <percent>]");
  }
  let minPercent = DEFAULT_MIN_PERCENT;
  if (rest[0] === "--min") {
    const value = Number(rest[1]);
    if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`invalid --min: ${rest[1]}`);
    minPercent = value;
  } else if (rest.length > 0) {
    throw new Error(`unknown argument: ${rest[0]}`);
  }
  return { path, sourceDir, minPercent };
}

if (import.meta.main) {
  try {
    const { path, sourceDir, minPercent } = parseArguments(process.argv.slice(2));
    const sources = readdirSync(sourceDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/${name}`);
    const check = checkCoreCoverage(parseCoverageMap(await Bun.file(path).json()), sources, minPercent);
    console.log(formatCoreCoverage(check, minPercent));
    if (!check.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
