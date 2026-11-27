/**
 * Coverage gate for the contracts. Reads the lcov report written by `forge coverage` and fails when line or
 * branch coverage of any file under `src/` is below the floor.
 *
 *   bun scripts/check-contracts-coverage.ts contracts/coverage/lcov.info
 *   bun scripts/check-contracts-coverage.ts contracts/coverage/lcov.info --min 95
 *
 * Only `src/` counts: tests, mocks and the deployment script are excluded on purpose. A file with no branches
 * passes the branch check. It prints one line per file and exits with 1 when any file is below the floor or
 * when the report contains no `src/` file at all.
 */

/** Minimum line and branch coverage, in percent. */
export const DEFAULT_MIN_PERCENT = 95;

export interface FileCoverage {
  readonly file: string;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly branchesFound: number;
  readonly branchesHit: number;
}

/** Totals per source file, from the `SF`, `LF`, `LH`, `BRF` and `BRH` records of an lcov report. */
export function parseLcov(report: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let file: string | null = null;
  let totals = { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0 };

  for (const rawLine of report.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      file = line.slice(3).replaceAll("\\", "/");
      totals = { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0 };
    } else if (line === "end_of_record") {
      if (file !== null) files.push({ file, ...totals });
      file = null;
    } else if (file !== null) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      const key = line.slice(0, separator);
      const value = Number.parseInt(line.slice(separator + 1), 10);
      if (!Number.isFinite(value)) continue;
      if (key === "LF") totals.linesFound = value;
      else if (key === "LH") totals.linesHit = value;
      else if (key === "BRF") totals.branchesFound = value;
      else if (key === "BRH") totals.branchesHit = value;
    }
  }
  return files;
}

/** Coverage in percent. Nothing to cover counts as fully covered. */
export function percent(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

export interface CoverageCheck {
  readonly file: string;
  readonly linesPercent: number;
  readonly branchesPercent: number;
  readonly ok: boolean;
}

/** The files under `src/`, each checked against `minPercent` for lines and branches. */
export function checkCoverage(files: readonly FileCoverage[], minPercent: number): CoverageCheck[] {
  return files
    .filter(({ file }) => file.startsWith("src/") || file.includes("/src/"))
    .map((entry) => {
      const linesPercent = percent(entry.linesHit, entry.linesFound);
      const branchesPercent = percent(entry.branchesHit, entry.branchesFound);
      return {
        file: entry.file,
        linesPercent,
        branchesPercent,
        ok: linesPercent >= minPercent && branchesPercent >= minPercent,
      };
    });
}

export function formatCoverageReport(checks: readonly CoverageCheck[], minPercent: number): string {
  if (checks.length === 0) return "FAIL no src/ file in the coverage report";
  const lines = checks.map(
    ({ file, linesPercent, branchesPercent, ok }) =>
      `${ok ? "ok  " : "FAIL"} ${file}: lines ${linesPercent.toFixed(2)}%, branches ${branchesPercent.toFixed(2)}%`,
  );
  lines.push(`floor: ${minPercent}% lines and branches per file`);
  return lines.join("\n");
}

export function parseArguments(argv: readonly string[]): { path: string; minPercent: number } {
  const [path, ...rest] = argv;
  if (path === undefined || path.startsWith("--")) {
    throw new Error("usage: bun scripts/check-contracts-coverage.ts <lcov.info> [--min <percent>]");
  }
  let minPercent = DEFAULT_MIN_PERCENT;
  if (rest[0] === "--min") {
    const value = Number(rest[1]);
    if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error(`invalid --min: ${rest[1]}`);
    minPercent = value;
  } else if (rest.length > 0) {
    throw new Error(`unknown argument: ${rest[0]}`);
  }
  return { path, minPercent };
}

if (import.meta.main) {
  try {
    const { path, minPercent } = parseArguments(process.argv.slice(2));
    const checks = checkCoverage(parseLcov(await Bun.file(path).text()), minPercent);
    console.log(formatCoverageReport(checks, minPercent));
    if (checks.length === 0 || checks.some(({ ok }) => !ok)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
