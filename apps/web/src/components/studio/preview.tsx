"use client";

import { type Constituent, MAX_SPEC_BYTES } from "@equityos/core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DownloadIcon } from "@/components/ui/icons";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFoot,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@/components/ui/table";
import { formatCount, formatPercent } from "@/lib/format";
import type { StudioAsset } from "@/lib/studio/assets";
import type { Evaluation, FieldIssue, ValidDraft } from "@/lib/studio/evaluate";
import { describeMethodology } from "@/lib/indexes/methodology";
import { type BaseVersion, describeChanges, isUnchanged } from "@/lib/studio/version";
import { sumBps } from "@/lib/studio/weights";
import { issueSummary, StatusMark } from "./parts";

/** Moves focus to the control an issue is about, which also scrolls it into view. */
function focusField({ field, token }: FieldIssue) {
  const selector = token === undefined ? `[data-field="${field}"]` : `[data-field="weight"][data-token="${token}"]`;
  const target =
    document.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>('[data-field="weights"]');
  target?.focus();
  target?.scrollIntoView({ block: "center" });
}

/** Saves the canonical bytes as a file. The file holds exactly the bytes that are hashed, with no newline. */
export function exportSpec(valid: ValidDraft) {
  const url = URL.createObjectURL(new Blob([valid.specBytes.slice()], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${valid.spec.slug}.equityos-index.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** The weights of a composition, heaviest first, with a bar scaled to the largest weight. */
export function CompositionTable({
  title,
  constituents,
  assets,
  dense = true,
}: {
  title: string;
  constituents: readonly Constituent[];
  assets: readonly StudioAsset[];
  dense?: boolean;
}) {
  const symbols = new Map(assets.map((asset) => [asset.address, asset]));
  const rows = constituents
    .map((constituent) => ({ ...constituent, asset: symbols.get(constituent.token) }))
    .sort(
      (a, b) => b.weightBps - a.weightBps || (a.asset?.symbol ?? a.token).localeCompare(b.asset?.symbol ?? b.token),
    );
  const largest = Math.max(1, ...rows.map(({ weightBps }) => weightBps));
  const total = sumBps(rows.map(({ weightBps }) => weightBps));
  return (
    <Table label={title} dense={dense} maxHeight="24rem">
      <TableCaption>
        <span>{title}</span>
        <span className="num text-sm font-normal text-secondary">{formatCount(BigInt(rows.length))} constituents</span>
      </TableCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Asset</TableHeader>
          <TableHeader className="w-full">
            <span className="sr-only">Share of the index</span>
          </TableHeader>
          <TableHeader numeric>Target weight</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(({ token, weightBps, asset }) => (
          <TableRow key={token}>
            <TableRowHeader className="font-mono text-sm">{asset?.symbol ?? `${token.slice(0, 10)}…`}</TableRowHeader>
            <TableCell>
              <span
                aria-hidden="true"
                className="block h-2 rounded-sm bg-[var(--border-strong)]"
                style={{ width: `${Math.max(1, Math.round((weightBps * 100) / largest))}%` }}
              />
            </TableCell>
            <TableCell numeric>{formatPercent(BigInt(weightBps))}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFoot>
        <TableRow>
          <TableRowHeader>Total</TableRowHeader>
          <TableCell />
          <TableCell numeric>{formatPercent(BigInt(total))}</TableCell>
        </TableRow>
      </TableFoot>
    </Table>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t pt-4">
      <h3 className="text-sm font-medium text-secondary">{title}</h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * What a valid draft changes against the version it is based on, in the phrases of the version history of the
 * index profile, which come from the same module.
 */
export function Changes({ valid, base }: { valid: ValidDraft | null; base: BaseVersion }) {
  if (valid === null) return <p className="text-secondary">The changes appear once the spec is valid.</p>;
  if (isUnchanged(valid, base)) {
    return (
      <p className="text-primary" data-testid="unchanged">
        Nothing changed: this spec is version {base.version}, byte for byte. A new version must change something.
      </p>
    );
  }
  const changes = describeChanges(valid, base);
  return (
    <ul aria-label={`Changes from version ${base.version}`} className="flex list-disc flex-col gap-1 pl-4">
      {(changes.length === 0 ? [`The canonical bytes differ from version ${base.version}`] : changes).map((change) => (
        <li key={change}>{change}</li>
      ))}
    </ul>
  );
}

/** The exact canonical text, wrapped for reading. Selecting all of it copies the bytes that are hashed. */
export function CanonicalJson({ text }: { text: string }) {
  return (
    <section
      aria-label="Canonical JSON"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
      tabIndex={0}
      className="max-h-64 overflow-auto rounded-md border bg-subtle p-3"
    >
      <pre className="font-mono text-xs break-all whitespace-pre-wrap text-primary">{text}</pre>
    </section>
  );
}

type PreviewProps = {
  /** `null` while the asset list, which the validation of constituents needs, has not loaded. */
  evaluation: Evaluation | null;
  assets: readonly StudioAsset[];
  assetsFailed: boolean;
  /** The latest version of the index a new version is based on. `null` for a new index. */
  base: BaseVersion | null;
};

/** What the draft produces, recomputed in the browser on every edit: composition, methodology, bytes and hash. */
export function Preview({ evaluation, assets, assetsFailed, base }: PreviewProps) {
  if (evaluation === null) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Preview</h2>
        <p className="text-secondary" role="status">
          {assetsFailed
            ? "The preview cannot be calculated: the asset list did not load. Your draft is saved in this browser."
            : "Waiting for the asset list."}
        </p>
      </div>
    );
  }
  const { issues, valid, previewWeights } = evaluation;
  const summary = issueSummary(issues);
  const todo = issues.filter(({ incomplete }) => incomplete).length;
  const wrong = issues.length - todo;
  const sizeBps = valid === null ? 0 : Math.round((valid.specBytes.length * 100) / MAX_SPEC_BYTES);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-medium">Preview</h2>
        <StatusMark tone={summary.tone}>
          {valid !== null
            ? "Valid spec"
            : [wrong > 0 ? `${wrong} ${wrong === 1 ? "issue" : "issues"}` : null, todo > 0 ? `${todo} to do` : null]
                .filter(Boolean)
                .join(", ")}
        </StatusMark>
      </div>

      {issues.length > 0 ? (
        <ul aria-label="What is left before the spec is valid" className="flex flex-col gap-1 text-sm">
          {issues.map((issue) => (
            <li key={`${issue.path} ${issue.code}`}>
              <button
                type="button"
                onClick={() => focusField(issue)}
                className={
                  issue.incomplete
                    ? "rounded-sm text-left text-secondary underline-offset-[3px] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                    : "rounded-sm text-left text-negative underline-offset-[3px] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                }
              >
                {issue.message}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {base === null ? null : (
        <Block title={`Changes from version ${base.version}`}>
          <Changes valid={valid} base={base} />
        </Block>
      )}

      {previewWeights === null ? (
        <p className="text-secondary">The composition appears once every weight is a percentage.</p>
      ) : previewWeights.length === 0 ? (
        <p className="text-secondary">The composition appears here as you select constituents.</p>
      ) : (
        <CompositionTable title="Composition" constituents={previewWeights} assets={assets} />
      )}

      {valid === null ? (
        <Block title="Spec hash">
          <p className="text-secondary">The canonical JSON and its hash exist once the spec is valid.</p>
        </Block>
      ) : (
        <>
          <Block title="Methodology">
            <ul className="flex flex-col gap-1 text-primary">
              {describeMethodology(valid.spec).map(({ rule, reading }) => (
                <li key={rule}>{reading}</li>
              ))}
            </ul>
          </Block>
          <Block title="Spec hash">
            <p className="font-mono text-sm break-all text-primary" data-testid="spec-hash">
              {valid.specHash}
            </p>
            <p className="mt-1 text-xs text-secondary">
              keccak256 of the canonical JSON below, computed in this browser.
            </p>
          </Block>
          <Block title="Size">
            <p className="num text-primary">
              {formatCount(BigInt(valid.specBytes.length))} of {formatCount(BigInt(MAX_SPEC_BYTES))} bytes
            </p>
            <div className="mt-2 h-1 rounded-sm bg-subtle" aria-hidden="true">
              <div className="h-1 rounded-sm bg-[var(--border-strong)]" style={{ width: `${Math.max(1, sizeBps)}%` }} />
            </div>
          </Block>
          <Block title="Canonical JSON">
            <CanonicalJson text={new TextDecoder().decode(valid.specBytes)} />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={() => exportSpec(valid)}>
                <DownloadIcon />
                Export spec JSON
              </Button>
              <p className="text-xs text-secondary">The file holds exactly these bytes.</p>
            </div>
          </Block>
        </>
      )}
    </div>
  );
}
