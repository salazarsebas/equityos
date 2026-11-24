"use client";

import { type Address, TOTAL_WEIGHT_BPS } from "@equityos/core";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { CheckIcon } from "@/components/ui/icons";
import type { StudioAsset } from "@/lib/studio/assets";
import { type Draft, draftWeightsBps, normalizePercentText, setWeight, withEqualWeights } from "@/lib/studio/draft";
import { type FieldIssue, issuesFor } from "@/lib/studio/evaluate";
import { bpsToPercentText, distributeRemainder, sumBps } from "@/lib/studio/weights";
import { UnitInput } from "./parts";

type WeightEditorProps = {
  draft: Draft;
  update: (change: (draft: Draft) => Draft) => void;
  issues: readonly FieldIssue[];
  assets: readonly StudioAsset[];
};

/** Writes weights in basis points back into the draft as percent text. */
function withWeights(draft: Draft, weights: readonly { token: Address; weightBps: number }[]): Draft {
  const text: Record<Address, string> = {};
  for (const { token, weightBps } of weights) text[token] = bpsToPercentText(weightBps);
  return { ...draft, weights: text };
}

/**
 * Fixed weights, one percent field per constituent, with a running total. The total can only leave this
 * editor at 100.00% or with the difference stated next to a button that removes it.
 */
export function WeightEditor({ draft, update, issues, assets }: WeightEditorProps) {
  const symbols = new Map(assets.map((asset) => [asset.address, asset]));
  const rows = draftWeightsBps(draft)
    .map((row) => ({ ...row, asset: symbols.get(row.token) }))
    .sort((a, b) => (a.asset?.symbol ?? a.token).localeCompare(b.asset?.symbol ?? b.token));
  if (rows.length === 0) {
    return <p className="text-secondary">Select constituents in the universe to give them weights.</p>;
  }
  const known = rows.every((row): row is typeof row & { weightBps: number } => row.weightBps !== null);
  const sum = known ? sumBps(rows.map(({ weightBps }) => weightBps ?? 0)) : null;
  const difference = sum === null ? null : TOTAL_WEIGHT_BPS - sum;
  const distribute = () =>
    update((current) => {
      const weights = draftWeightsBps(current);
      return weights.every((row): row is { token: Address; weightBps: number } => row.weightBps !== null)
        ? withWeights(current, distributeRemainder(weights))
        : current;
    });

  return (
    <div className="overflow-hidden rounded-lg border bg-surface">
      <ul aria-label="Fixed weights">
        {rows.map(({ token, asset }) => {
          const rowIssues = issuesFor(issues, "weight", token);
          const wrong = rowIssues.some(({ incomplete }) => !incomplete);
          const label = asset?.symbol ?? token;
          return (
            <li key={token} className="border-b px-3 py-1.5">
              <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_7rem] items-center gap-x-3">
                <span className="font-mono text-sm font-medium">{label}</span>
                <span className="truncate text-secondary">{asset?.name ?? "Not in the asset list"}</span>
                <UnitInput
                  unit="%"
                  data-field="weight"
                  data-token={token}
                  aria-label={`Weight of ${label}`}
                  aria-invalid={wrong || undefined}
                  value={draft.weights[token] ?? ""}
                  placeholder="0.00"
                  onChange={(event) => update((current) => setWeight(current, token, event.target.value))}
                  onBlur={() =>
                    update((current) => setWeight(current, token, normalizePercentText(current.weights[token] ?? "")))
                  }
                />
              </div>
              {rowIssues.map(({ message, incomplete }) => (
                <p key={message} className={cx("mt-1 text-xs", incomplete ? "text-secondary" : "text-negative")}>
                  {message}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 bg-subtle px-3 py-3" data-field="weights" tabIndex={-1}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p aria-live="polite" className="flex items-center gap-2 font-medium">
            {difference === 0 ? <CheckIcon className="shrink-0" /> : null}
            <span>
              Total <span className="num">{sum === null ? "not known" : `${bpsToPercentText(sum)}%`}</span>
            </span>
            {difference !== null && difference !== 0 ? (
              <span className="num font-normal text-negative">
                {difference > 0
                  ? `${bpsToPercentText(difference)}% not assigned`
                  : `${bpsToPercentText(-difference)}% over 100.00%`}
              </span>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            {difference !== null && difference !== 0 ? (
              <Button onClick={distribute}>
                {difference > 0
                  ? `Distribute remaining ${bpsToPercentText(difference)}%`
                  : `Remove excess ${bpsToPercentText(-difference)}%`}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => update(withEqualWeights)}>
              Set equal weights
            </Button>
          </div>
        </div>
        <p className="max-w-measure text-xs text-secondary">
          {sum === null
            ? "A weight is not a percentage with at most two decimals, so the total cannot be worked out."
            : difference === 0
              ? "The weights total exactly 100.00%, which is 10,000 basis points."
              : difference !== null && difference > 0
                ? "A spec is valid only at exactly 100.00%. The button splits what is missing equally between all constituents; what does not divide goes to the lowest token addresses, as in equal weighting."
                : "A spec is valid only at exactly 100.00%. The button takes the excess in equal parts from every constituent above 0.01%, lowest token addresses first for what does not divide."}
        </p>
      </div>
    </div>
  );
}
