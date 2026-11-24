"use client";

import { computeEqualWeights, MAX_CONSTITUENTS, MAX_NAME_LENGTH } from "@equityos/core";
import { useState } from "react";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { SourceLine } from "@/components/ui/source-line";
import { formatCount, formatPrice } from "@/lib/format";
import { ineligibilityText, type StudioAsset, type StudioAssets } from "@/lib/studio/assets";
import {
  type Draft,
  normalizePercentText,
  setDescription,
  setName,
  setSlug,
  setWeighting,
  toggleToken,
} from "@/lib/studio/draft";
import { type FieldIssue, issuesFor } from "@/lib/studio/evaluate";
import { rebalanceRules } from "@/lib/indexes/methodology";
import { bpsToPercentText, percentTextToBps } from "@/lib/studio/weights";
import { fieldMessage, Section, UnitInput } from "./parts";
import { WeightEditor } from "./weight-editor";

export type AssetsState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly retry: () => void }
  | { readonly status: "ready"; readonly data: StudioAssets };

export interface EditorProps {
  draft: Draft;
  /** Applies a change to the draft. */
  update: (change: (draft: Draft) => Draft) => void;
  issues: readonly FieldIssue[];
  assets: AssetsState;
  networks: readonly { readonly chainId: number; readonly name: string }[];
  /** A new version of an existing index: its network, fixed, and its identifier before and after. */
  version: {
    readonly network: string;
    readonly identifier: string;
    readonly identifierAfter: string;
  } | null;
}

const PRICE_STATUS: Readonly<Record<StudioAsset["priceStatus"], string>> = {
  live: "Live",
  delayed: "Delayed",
  last_close: "Last close",
  unavailable: "No price",
};

/** The slug of a new version: a change of slug is a change of the canonical identifier, and the hint says so. */
function slugHint(draft: Draft, version: EditorProps["version"]): string {
  if (version === null) {
    return draft.slugEdited ? "Clear it to follow the name again." : "Follows the name. Used in the index link.";
  }
  return version.identifierAfter === version.identifier
    ? `Part of the canonical identifier, ${version.identifier}. Changing it changes the identifier.`
    : `Changes the canonical identifier from ${version.identifier} to ${version.identifierAfter}. Links with the current identifier stop working; links with the index id keep working.`;
}

function Identity({ draft, update, issues, networks, version }: EditorProps) {
  const all = ["name", "slug", "description", "network"] as const;
  return (
    <Section
      number={1}
      title="Identity"
      lead="What the index is called. The name and the slug are part of the published spec."
      issues={all.flatMap((field) => issuesFor(issues, field))}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" {...fieldMessage(issuesFor(issues, "name"), `Up to ${MAX_NAME_LENGTH} characters.`)}>
          {(control) => (
            <Input
              {...control}
              data-field="name"
              value={draft.name}
              onChange={(event) => update((current) => setName(current, event.target.value))}
              autoComplete="off"
              placeholder="Semiconductors Equal Weight"
            />
          )}
        </Field>
        <Field label="Slug" {...fieldMessage(issuesFor(issues, "slug"), slugHint(draft, version))}>
          {(control) => (
            <Input
              {...control}
              data-field="slug"
              value={draft.slug}
              onChange={(event) => update((current) => setSlug(current, event.target.value))}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          )}
        </Field>
      </div>
      <Field
        label="Description"
        {...fieldMessage(
          issuesFor(issues, "description"),
          "Optional. What the index is meant to track, in a sentence.",
        )}
      >
        {(control) => (
          <Textarea
            {...control}
            data-field="description"
            rows={2}
            value={draft.description}
            onChange={(event) => update((current) => setDescription(current, event.target.value))}
          />
        )}
      </Field>
      <Field
        label="Network"
        className="md:max-w-xs"
        hint={
          version === null
            ? "Where the index is published. The chain id is part of the spec, so it changes the hash."
            : "Fixed: every version of an index is published to the registry that holds it."
        }
      >
        {(control) => (
          <Select
            {...control}
            data-field="network"
            disabled={version !== null}
            value={draft.chainId}
            onChange={(event) => update((current) => ({ ...current, chainId: Number(event.target.value) }))}
          >
            {(version === null ? networks : [{ chainId: draft.chainId, name: version.network }]).map(
              ({ chainId, name }) => (
                <option key={chainId} value={chainId}>
                  {name}
                </option>
              ),
            )}
          </Select>
        )}
      </Field>
    </Section>
  );
}

function AssetRow({
  asset,
  selected,
  full,
  onToggle,
}: {
  asset: StudioAsset;
  selected: boolean;
  full: boolean;
  onToggle: () => void;
}) {
  const blocked = !asset.eligible || (full && !selected);
  return (
    <li className="border-b last:border-b-0">
      <Checkbox
        checked={selected}
        disabled={blocked}
        onChange={onToggle}
        className="flex min-h-9 w-full items-center px-3 py-1.5 pointer-coarse:min-h-11 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1 has-[:enabled]:cursor-pointer has-[:enabled]:hover:bg-subtle"
        label={
          <span className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3">
            <span className="font-mono text-sm font-medium">{asset.symbol}</span>
            <span className="truncate text-secondary">{asset.name}</span>
            {asset.eligible ? (
              <span className="text-right">
                <span className="num text-primary">{asset.priceE8 === null ? "" : formatPrice(asset.priceE8, 8)}</span>
                <span
                  className={cx(
                    "ml-2 text-xs max-sm:hidden",
                    asset.priceStatus === "live" || asset.priceStatus === "last_close"
                      ? "text-secondary"
                      : "text-warning",
                  )}
                >
                  {PRICE_STATUS[asset.priceStatus]}
                </span>
              </span>
            ) : (
              <span className="text-right text-xs text-secondary">
                Not eligible: {ineligibilityText(asset.reasons)}
              </span>
            )}
          </span>
        }
      />
    </li>
  );
}

function Universe({ draft, update, issues, assets }: EditorProps) {
  const [query, setQuery] = useState("");
  const universeIssues = issuesFor(issues, "universe");
  const needle = query.trim().toLowerCase();
  const listed = assets.status === "ready" ? assets.data.assets : [];
  const shown = listed.filter(
    ({ symbol, name, address }) =>
      needle === "" ||
      symbol.toLowerCase().includes(needle) ||
      name.toLowerCase().includes(needle) ||
      address === needle,
  );
  const eligible = listed.filter((asset) => asset.eligible).length;
  const full = draft.tokens.length >= MAX_CONSTITUENTS;
  const message = fieldMessage(universeIssues);
  return (
    <Section
      number={2}
      title="Universe"
      lead="The tokenized stocks the index holds. Only assets with a verified reference feed can be constituents."
      issues={universeIssues}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <Field label="Search assets" className="w-full sm:w-64">
          {(control) => (
            <Input
              {...control}
              data-field="universe"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Symbol or name"
              autoComplete="off"
            />
          )}
        </Field>
        <p className="num text-sm text-secondary" aria-live="polite">
          {formatCount(BigInt(draft.tokens.length))} of {formatCount(BigInt(eligible))} eligible selected · at most{" "}
          {MAX_CONSTITUENTS}
        </p>
      </div>
      {assets.status === "loading" ? (
        <div aria-busy="true" className="h-64 rounded-lg border bg-subtle">
          <span className="sr-only">Loading the asset list</span>
        </div>
      ) : assets.status === "error" ? (
        <Callout tone="negative" role="alert" title="The asset list could not be loaded.">
          Your draft is saved in this browser. Constituents cannot be chosen or validated until the list loads.{" "}
          <button type="button" className="font-medium text-accent underline" onClick={assets.retry}>
            Load the asset list again
          </button>
        </Callout>
      ) : (
        <>
          <ul aria-label="Listed assets" className="max-h-80 overflow-y-auto rounded-lg border bg-surface">
            {shown.map((asset) => (
              <AssetRow
                key={asset.address}
                asset={asset}
                selected={draft.tokens.includes(asset.address)}
                full={full}
                onToggle={() => update((current) => toggleToken(current, asset.address))}
              />
            ))}
            {shown.length === 0 ? (
              <li className="px-3 py-3 text-secondary">No listed asset matches "{query}".</li>
            ) : null}
          </ul>
          <SourceLine
            label="Reference prices (USD per token)"
            source={`Chainlink feeds, Base mainnet block ${formatCount(assets.data.blockNumber)}`}
            asOfUnixSeconds={BigInt(assets.data.blockTimestamp)}
            note="indications of value, not executable prices"
            {...(assets.data.servedStale ? { stale: "source not answering" } : {})}
          />
        </>
      )}
      {message.error ? (
        <p role="alert" className="text-sm text-negative">
          {universeIssues.map(({ message: text }) => text).join(" ")}
        </p>
      ) : null}
      {full ? <p className="text-sm text-secondary">The limit of {MAX_CONSTITUENTS} constituents is reached.</p> : null}
    </Section>
  );
}

const WEIGHTINGS = [
  { value: "equal", label: "Equal", detail: "Every constituent has the same weight." },
  { value: "fixed", label: "Fixed", detail: "You set the weight of each constituent." },
] as const;

function Weighting(props: EditorProps) {
  const { draft, update, issues, assets } = props;
  const fields = ["weights", "weight", "maxWeight", "minWeight"] as const;
  const split =
    draft.tokens.length > 0 && draft.tokens.length <= MAX_CONSTITUENTS ? computeEqualWeights(draft.tokens) : [];
  const [high, low] = [split[0]?.weightBps, split.at(-1)?.weightBps];
  const equal =
    high === undefined || low === undefined
      ? null
      : high === low
        ? `Each of the ${split.length} constituents gets ${bpsToPercentText(high)}%.`
        : `${split.length} constituents share 100.00%: ${bpsToPercentText(low)}% each, and ${bpsToPercentText(high)}% for the lowest token addresses, which take the basis points that do not divide.`;
  const bound = (field: "maxWeight" | "minWeight", label: string, hint: string) => (
    <Field label={label} {...fieldMessage(issuesFor(issues, field), hint)}>
      {(control) => (
        <UnitInput
          {...control}
          data-field={field}
          unit="%"
          className="w-32"
          value={draft[field]}
          placeholder="None"
          onChange={(event) => update((current) => ({ ...current, [field]: event.target.value }))}
          onBlur={() => update((current) => ({ ...current, [field]: normalizePercentText(current[field]) }))}
        />
      )}
    </Field>
  );
  return (
    <Section
      number={3}
      title="Weighting"
      lead="The target weight of each constituent. Weights are written in percent with two decimals and always total 100.00%."
      issues={fields.flatMap((field) => issuesFor(issues, field))}
    >
      <fieldset>
        <legend className="sr-only">Weighting scheme</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {WEIGHTINGS.map(({ value, label, detail }) => (
            <label
              key={value}
              className={cx(
                "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors duration-[120ms]",
                draft.weighting === value
                  ? "border-accent bg-accent-subtle"
                  : "border-strong bg-surface hover:bg-subtle",
              )}
            >
              <input
                type="radio"
                name="weighting"
                value={value}
                checked={draft.weighting === value}
                onChange={() => update((current) => setWeighting(current, value))}
                className="mt-0.5 size-4 accent-[var(--accent)]"
              />
              <span>
                <span className="block font-medium text-primary">{label}</span>
                <span className="block text-sm text-secondary">{detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {draft.weighting === "equal" && equal !== null ? (
        <p className="max-w-measure border-l-2 border-strong pl-3 text-primary">{equal}</p>
      ) : null}
      {draft.weighting === "fixed" ? (
        <WeightEditor
          draft={draft}
          update={update}
          issues={issues}
          assets={assets.status === "ready" ? assets.data.assets : []}
        />
      ) : null}
      <div className="flex flex-wrap gap-x-6 gap-y-4">
        {bound("maxWeight", "Maximum weight", "Optional. No constituent may be above it.")}
        {bound("minWeight", "Minimum weight", "Optional. No constituent may be below it.")}
      </div>
      <p className="max-w-measure text-sm text-secondary">
        Bounds are checks, not adjustments: a draft whose weights break a bound is not valid, and no weight is ever
        moved to fit one.
      </p>
    </Section>
  );
}

function Rebalance({ draft, update, issues }: EditorProps) {
  const driftBps = percentTextToBps(draft.driftThreshold);
  const interval = /^\d{1,6}$/.test(draft.minInterval.trim()) ? Number(draft.minInterval.trim()) : null;
  const seconds = interval === null ? null : interval * (draft.minIntervalUnit === "days" ? 86_400 : 3_600);
  const fields = ["driftThreshold", "minInterval"] as const;
  return (
    <Section
      number={4}
      title="Rebalance rule"
      lead="When a wallet that follows the index is due to trade back to the target weights."
      issues={fields.flatMap((field) => issuesFor(issues, field))}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-4">
        <Field
          label="Drift threshold"
          {...fieldMessage(issuesFor(issues, "driftThreshold"), "Percentage points, 0.01 to 100.00.")}
        >
          {(control) => (
            <UnitInput
              {...control}
              data-field="driftThreshold"
              unit="pp"
              className="w-32"
              value={draft.driftThreshold}
              onChange={(event) => update((current) => ({ ...current, driftThreshold: event.target.value }))}
              onBlur={() =>
                update((current) => ({ ...current, driftThreshold: normalizePercentText(current.driftThreshold) }))
              }
            />
          )}
        </Field>
        <Field
          label="Minimum interval"
          {...fieldMessage(issuesFor(issues, "minInterval"), "Whole number. 0 for none.")}
        >
          {(control) => (
            <div className="flex gap-2">
              <Input
                {...control}
                data-field="minInterval"
                inputMode="numeric"
                maxLength={4}
                autoComplete="off"
                className="num w-20 text-right"
                value={draft.minInterval}
                onChange={(event) => update((current) => ({ ...current, minInterval: event.target.value }))}
              />
              <Select
                aria-label="Unit of the minimum interval"
                className="w-28"
                value={draft.minIntervalUnit}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    minIntervalUnit: event.target.value === "hours" ? "hours" : "days",
                  }))
                }
              >
                <option value="days">days</option>
                <option value="hours">hours</option>
              </Select>
            </div>
          )}
        </Field>
      </div>
      {driftBps !== null && driftBps > 0 && seconds !== null ? (
        <p className="max-w-measure border-l-2 border-strong pl-3 text-primary">
          {rebalanceRules({ driftThresholdBps: driftBps, minIntervalSeconds: seconds })
            .map(({ reading }) => reading)
            .join(" ")}
        </p>
      ) : null}
    </Section>
  );
}

/** The four parts of an index, in one scrolling form so that the interaction between rules stays visible. */
export function Editor(props: EditorProps) {
  return (
    <div className="flex flex-col gap-8">
      <Identity {...props} />
      <Universe {...props} />
      <Weighting {...props} />
      <Rebalance {...props} />
    </div>
  );
}
