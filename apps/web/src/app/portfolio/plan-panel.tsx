"use client";

import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { Field, Input } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@/components/ui/table";
import { StatusTag } from "@/components/ui/tag";
import { formatFixed, formatTokenQuantity, formatUsd } from "@/lib/format";
import {
  type ApiIssue,
  type ApiPlan,
  type ApiPortfolio,
  type ComparisonState,
  comparisonQuery,
  readEnvelope,
} from "@/lib/portfolio/api";
import { DEPOSIT_ERRORS, parseDepositUsd } from "@/lib/portfolio/deposit";
import { describeIssues, transferWarningLines } from "@/lib/portfolio/issues";
import { Missing } from "./drift-table";
import { ExecutePanel } from "./execute/execute-panel";

type Mode = "rebalance" | "buy_only";

/** The plan options in the URL: `plan=buy_only` and `deposit=<USD>`, next to the comparison state. */
function readPlanOptions(): { mode: Mode; deposit: string } {
  const query = new URLSearchParams(window.location.search);
  return { mode: query.get("plan") === "buy_only" ? "buy_only" : "rebalance", deposit: query.get("deposit") ?? "" };
}

function writePlanOptions(mode: Mode, deposit: string): void {
  const query = new URLSearchParams(window.location.search);
  query.delete("plan");
  query.delete("deposit");
  if (mode === "buy_only") query.set("plan", mode);
  if (mode === "buy_only" && deposit !== "") query.set("deposit", deposit);
  window.history.replaceState(window.history.state, "", `?${query}`);
}

function points(bps: number | null): string {
  return bps === null ? "-" : `${formatFixed(BigInt(bps), 2, 2)} pp`;
}

/** The findings of a plan in words, each with its code for developers. */
export function IssueList({ issues, symbolOf }: { issues: readonly ApiIssue[]; symbolOf: (token: string) => string }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {describeIssues(issues, symbolOf).map(({ code, severity, text }) => (
        <li key={`${severity}:${code}`} className="max-w-measure">
          <span className={severity === "blocker" ? "font-medium text-warning" : "text-primary"}>{text}</span>{" "}
          <code className="font-mono text-xs text-secondary">{code}</code>
        </li>
      ))}
    </ul>
  );
}

function ModeOption({
  value,
  current,
  label,
  onSelect,
}: {
  value: Mode;
  current: Mode;
  label: string;
  onSelect: (mode: Mode) => void;
}) {
  return (
    <label
      className={cx(
        "inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border px-3 text-base pointer-coarse:h-11",
        value === current ? "border-accent bg-accent-subtle text-primary" : "border-strong bg-surface text-secondary",
      )}
    >
      <input
        type="radio"
        name="plan-mode"
        value={value}
        checked={value === current}
        onChange={() => onSelect(value)}
        className="accent-(--accent)"
      />
      {label}
    </label>
  );
}

function PlanResult({
  plan,
  symbolOf,
  shown,
}: {
  plan: ApiPlan["plan"];
  symbolOf: (token: string) => string;
  shown: ReadonlySet<string>;
}) {
  // Findings of the valuation are already stated above the drift table; only the plan's own are added here.
  const warnings = plan.warnings.filter(({ code }) => !shown.has(code));
  if (plan.status === "blocked") {
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="warning" title="No plan: the arithmetic is blocked, so no leg is listed.">
          <IssueList issues={plan.blockers} symbolOf={symbolOf} />
        </Callout>
        <IssueList issues={warnings} symbolOf={symbolOf} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-base sm:grid-cols-[auto_auto_auto] sm:justify-start sm:gap-x-8">
        <div>
          <dt className="text-xs text-secondary">Largest drift now</dt>
          <dd className="num text-md font-medium">{points(plan.currentMaxAbsDriftBps)}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">Largest drift after the legs</dt>
          <dd className="num text-md font-medium">{points(plan.projected.maxAbsDriftBps)}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">USDC left after the legs</dt>
          <dd className="num text-md font-medium">
            {formatUsd(BigInt(plan.projected.quoteBalance), 6)}
            <span className="ml-1 text-sm font-normal text-secondary">USDC</span>
          </dd>
        </div>
      </dl>
      {plan.legs.length === 0 ? null : (
        <Table label="Legs at reference prices">
          <TableCaption>
            <span>Legs at reference prices</span>
            <StatusTag status="Reference" />
            <span className="text-sm font-normal text-secondary">Sells first, then buys</span>
          </TableCaption>
          <TableHead>
            <TableRow>
              <TableHeader>Asset</TableHeader>
              <TableHeader>Side</TableHeader>
              <TableHeader numeric>Quantity (tokens)</TableHeader>
              <TableHeader numeric>Reference value (USD)</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {plan.legs.map((leg) => (
              <TableRow key={`${leg.side}:${leg.token}`}>
                <TableRowHeader className="font-mono text-sm">{leg.symbol ?? leg.token}</TableRowHeader>
                <TableCell>{leg.side === "sell" ? "Sell" : "Buy"}</TableCell>
                <TableCell numeric>
                  {leg.decimals === null ? <Missing /> : formatTokenQuantity(BigInt(leg.tokenQuantity), leg.decimals)}
                </TableCell>
                <TableCell numeric>{formatUsd(BigInt(leg.valueUsdE8), 8)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <IssueList issues={warnings} symbolOf={symbolOf} />
    </div>
  );
}

/**
 * The reference-price plan of the methodology for the compared address, in rebalance or buy-only mode, and
 * below it the step that prepares an executable plan for the connected owner of the address. The preview is
 * arithmetic shown for reading; only the review of an executable plan can ask a wallet to sign.
 */
export function PlanPanel({
  state,
  comparison,
  symbolOf,
  shown,
}: {
  state: ComparisonState;
  /** The comparison the plan is for: its constituents bound what an executable plan may trade. */
  comparison: ApiPortfolio;
  symbolOf: (token: string) => string;
  /** Finding codes the page already states, which the plan does not repeat. */
  shown: ReadonlySet<string>;
}) {
  const [initial] = useState(readPlanOptions);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [draft, setDraft] = useState(initial.deposit);
  const [deposit, setDeposit] = useState(initial.deposit);
  const parsed = deposit === "" ? null : parseDepositUsd(deposit);
  const draftParse = draft === "" ? null : parseDepositUsd(draft);
  const depositUsdE8 = mode === "buy_only" && parsed?.ok ? parsed.usdE8 : 0n;
  const query = comparisonQuery(state);
  query.set("mode", mode);
  if (depositUsdE8 > 0n) query.set("depositUsdE8", depositUsdE8.toString());
  const result = useQuery({
    queryKey: ["api", "v1", "portfolio", "plan", query.toString()],
    queryFn: async ({ signal }) =>
      (await readEnvelope<ApiPlan>(await fetch(`/api/v1/portfolio/plan?${query}`, { signal }))).data,
    retry: false,
    staleTime: 15_000,
  });

  function select(next: Mode) {
    setMode(next);
    writePlanOptions(next, deposit);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draftParse !== null && !draftParse.ok) return;
    setDeposit(draft.trim());
    writePlanOptions(mode, draft.trim());
  }

  return (
    <section aria-labelledby="plan-heading" className="flex flex-col gap-4 border-t pt-6">
      <div>
        <h2 id="plan-heading" className="text-lg font-medium">
          Plan preview at reference prices
        </h2>
        <p className="mt-1 max-w-measure text-secondary">
          The legs the calculation of the methodology gives for this address, toward the published target weights. The
          same holdings, version and prices always give the same legs.
        </p>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Plan mode</legend>
        <div className="flex flex-wrap gap-2">
          <ModeOption value="rebalance" current={mode} label="Rebalance: sells and buys" onSelect={select} />
          <ModeOption value="buy_only" current={mode} label="Buy only: never sells" onSelect={select} />
        </div>
        {mode === "buy_only" ? (
          <form onSubmit={apply} className="flex max-w-md items-start gap-2">
            <Field
              label="Deposit added before the plan (USD)"
              className="min-w-0 flex-1"
              {...(draftParse !== null && !draftParse.ok
                ? { error: DEPOSIT_ERRORS[draftParse.reason] }
                : { hint: "Counted as USDC next to the USDC already held. Leave empty for none." })}
            >
              {(control) => (
                <Input
                  {...control}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  className="num"
                />
              )}
            </Field>
            <Button type="submit" className="mt-6">
              Calculate
            </Button>
          </form>
        ) : null}
      </fieldset>
      <div aria-live="polite">
        {result.isPending ? (
          <p aria-busy="true" className="text-secondary">
            Computing the plan
          </p>
        ) : result.isError ? (
          <ErrorState
            title="The plan could not be computed"
            action={<Button onClick={() => void result.refetch()}>Try again</Button>}
          >
            {result.error.message} Nothing was sent anywhere: this page only reads.
          </ErrorState>
        ) : (
          <PlanResult plan={result.data.plan} symbolOf={symbolOf} shown={shown} />
        )}
      </div>
      <div className="flex max-w-measure flex-col gap-1 border-t pt-3 text-xs text-secondary">
        <p>
          This preview is arithmetic toward the published target weights at reference prices. It contains no executable
          quote, no slippage and no gas, so executable prices will differ, and it is not an instruction to trade.
        </p>
        {result.data === undefined
          ? null
          : transferWarningLines(result.data.transferWarnings).map((line) => (
              <p key={line} className="text-warning">
                {line}
              </p>
            ))}
      </div>
      {result.data?.plan.status === "ready" && result.data.plan.legs.length > 0 ? (
        <ExecutePanel
          key={`${mode}:${query.toString()}`}
          comparison={comparison}
          version={state.version}
          mode={mode}
          depositIgnored={depositUsdE8 > 0n}
        />
      ) : null}
    </section>
  );
}
