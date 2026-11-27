/**
 * Static analysis gate for the contracts. Compares the JSON reports of Slither and Aderyn with the reviewed
 * baseline in `contracts/static-analysis/baseline.json` and fails on any difference.
 *
 *   bun scripts/check-static-analysis.ts --baseline contracts/static-analysis/baseline.json \
 *     --slither slither.json --aderyn aderyn.json
 *
 * Rules:
 * - Every finding in a report must have a baseline entry. A new finding fails until it is fixed or reviewed.
 * - Every baseline entry must still be reported. An entry that no longer matches fails, so the baseline never
 *   hides a finding that changed or keeps one that was fixed.
 * - A High or Medium finding can only be in the baseline as a false positive. Nothing of that severity is
 *   accepted as a known risk.
 *
 * A Slither finding is identified by detector, file and the name of its first element, so it survives line
 * moves. An Aderyn finding is identified by detector, file and the number of instances in that file, so one
 * more instance is a new finding.
 */

export type Tool = "slither" | "aderyn";
export type Severity = "High" | "Medium" | "Low" | "Informational" | "Optimization";
export type Verdict = "false-positive" | "accepted";

export interface Finding {
  readonly tool: Tool;
  readonly detector: string;
  readonly severity: Severity;
  readonly location: string;
}

export interface BaselineEntry extends Finding {
  readonly verdict: Verdict;
  readonly reason: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: Json | undefined, key: string): Json | undefined {
  return isObject(value) ? value[key] : undefined;
}

function text(value: Json | undefined, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${what}`);
  return value;
}

function list(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`missing ${what}`);
  return value;
}

const SEVERITIES: readonly Severity[] = ["High", "Medium", "Low", "Informational", "Optimization"];

function severity(value: string): Severity {
  const found = SEVERITIES.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unknown severity: ${value}`);
  return found;
}

/** Forward slashes, relative to the contracts root when the path is absolute. */
export function normalizePath(path: string): string {
  const forward = path.replaceAll("\\", "/");
  const marker = forward.lastIndexOf("/contracts/");
  return marker === -1 ? forward : forward.slice(marker + "/contracts/".length);
}

export function findingKey({ tool, detector, location }: Finding): string {
  return `${tool} ${detector} ${location}`;
}

/** Findings of a `slither --json` report. */
export function parseSlither(input: unknown): Finding[] {
  const report = input as Json;
  if (field(report, "success") !== true) throw new Error(`slither did not succeed: ${String(field(report, "error"))}`);
  const detectors = field(field(report, "results"), "detectors");
  if (detectors === undefined) return [];
  return list(detectors, "slither results.detectors").map((result) => {
    const [first] = list(field(result, "elements"), "slither elements");
    const file = normalizePath(text(field(field(first, "source_mapping"), "filename_relative"), "slither file"));
    const name = text(field(first, "name"), "slither element name");
    const parent = field(field(field(first, "type_specific_fields"), "parent"), "name");
    const qualified = typeof parent === "string" ? `${parent}.${name}` : name;
    return {
      tool: "slither",
      detector: text(field(result, "check"), "slither check"),
      severity: severity(text(field(result, "impact"), "slither impact")),
      location: `${file}:${qualified}`,
    };
  });
}

/** Findings of an `aderyn -o report.json` report, one per detector and file. */
export function parseAderyn(input: unknown): Finding[] {
  const report = input as Json;
  const findings: Finding[] = [];
  for (const [group, groupSeverity] of [
    ["high_issues", "High"],
    ["low_issues", "Low"],
  ] as const) {
    const issues = field(field(report, group), "issues");
    if (issues === undefined) continue;
    for (const issue of list(issues, `aderyn ${group}.issues`)) {
      const detector = text(field(issue, "detector_name"), "aderyn detector_name");
      const perFile = new Map<string, number>();
      for (const instance of list(field(issue, "instances"), "aderyn instances")) {
        const file = normalizePath(text(field(instance, "contract_path"), "aderyn contract_path"));
        perFile.set(file, (perFile.get(file) ?? 0) + 1);
      }
      for (const [file, count] of perFile) {
        findings.push({
          tool: "aderyn",
          detector,
          severity: groupSeverity,
          location: `${file} (${count} ${count === 1 ? "instance" : "instances"})`,
        });
      }
    }
  }
  return findings;
}

/** Entries of the baseline file. Throws on a malformed entry. */
export function parseBaseline(input: unknown): BaselineEntry[] {
  const baseline = input as Json;
  return list(field(baseline, "findings"), "baseline findings").map((entry) => {
    const tool = text(field(entry, "tool"), "baseline tool");
    if (tool !== "slither" && tool !== "aderyn") throw new Error(`unknown tool: ${tool}`);
    const verdict = text(field(entry, "verdict"), "baseline verdict");
    if (verdict !== "false-positive" && verdict !== "accepted") throw new Error(`unknown verdict: ${verdict}`);
    return {
      tool,
      detector: text(field(entry, "detector"), "baseline detector"),
      severity: severity(text(field(entry, "severity"), "baseline severity")),
      location: text(field(entry, "location"), "baseline location"),
      verdict,
      reason: text(field(entry, "reason"), "baseline reason"),
    };
  });
}

export interface Comparison {
  /** Reported, not in the baseline. */
  readonly unreviewed: Finding[];
  /** In the baseline, no longer reported. */
  readonly stale: BaselineEntry[];
  /** High or Medium entries accepted instead of shown to be false positives. */
  readonly unresolved: BaselineEntry[];
  /** Reported and in the baseline. */
  readonly reviewed: BaselineEntry[];
}

export function compare(findings: readonly Finding[], baseline: readonly BaselineEntry[]): Comparison {
  const reported = new Set(findings.map(findingKey));
  const known = new Map(baseline.map((entry) => [findingKey(entry), entry]));
  return {
    unreviewed: findings.filter((finding) => !known.has(findingKey(finding))),
    stale: baseline.filter((entry) => !reported.has(findingKey(entry))),
    unresolved: baseline.filter(
      (entry) => (entry.severity === "High" || entry.severity === "Medium") && entry.verdict !== "false-positive",
    ),
    reviewed: baseline.filter((entry) => reported.has(findingKey(entry))),
  };
}

export function passes({ unreviewed, stale, unresolved }: Comparison): boolean {
  return unreviewed.length === 0 && stale.length === 0 && unresolved.length === 0;
}

export function formatComparison(comparison: Comparison): string {
  const lines: string[] = [];
  for (const entry of comparison.reviewed) {
    lines.push(`ok   ${entry.severity} ${findingKey(entry)} (${entry.verdict})`);
  }
  for (const finding of comparison.unreviewed) {
    lines.push(`FAIL ${finding.severity} ${findingKey(finding)}: new finding, fix it or review it in the baseline`);
  }
  for (const entry of comparison.stale) {
    lines.push(`FAIL ${entry.severity} ${findingKey(entry)}: no longer reported, remove it from the baseline`);
  }
  for (const entry of comparison.unresolved) {
    lines.push(`FAIL ${entry.severity} ${findingKey(entry)}: High and Medium findings must be fixed`);
  }
  lines.push(
    passes(comparison)
      ? `static analysis matches the reviewed baseline (${comparison.reviewed.length} findings)`
      : "static analysis differs from the reviewed baseline",
  );
  return lines.join("\n");
}

export function parseArguments(argv: readonly string[]): { baseline: string; slither: string; aderyn: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== "--baseline" && flag !== "--slither" && flag !== "--aderyn") {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    values.set(flag, value);
  }
  const baseline = values.get("--baseline");
  const slither = values.get("--slither");
  const aderyn = values.get("--aderyn");
  if (baseline === undefined || slither === undefined || aderyn === undefined) {
    throw new Error("usage: bun scripts/check-static-analysis.ts --baseline <file> --slither <file> --aderyn <file>");
  }
  return { baseline, slither, aderyn };
}

async function readJson(path: string): Promise<unknown> {
  return await Bun.file(path).json();
}

if (import.meta.main) {
  try {
    const paths = parseArguments(process.argv.slice(2));
    const findings = [...parseSlither(await readJson(paths.slither)), ...parseAderyn(await readJson(paths.aderyn))];
    const comparison = compare(findings, parseBaseline(await readJson(paths.baseline)));
    console.log(formatComparison(comparison));
    if (!passes(comparison)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
