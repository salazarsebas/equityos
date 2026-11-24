"use client";

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useConfig, useConnection } from "wagmi";
import { getConnection } from "wagmi/actions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/field";
import { ArrowLeftIcon, CheckIcon, WarningIcon } from "@/components/ui/icons";
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
import { Tag } from "@/components/ui/tag";
import { useWalletCapabilities } from "@/components/wallet/hooks";
import { formatCount, formatTokenQuantity } from "@/lib/format";
import {
  ATTESTATION_OMISSIONS,
  EXECUTION_STATEMENTS,
  refusalMessage,
  verificationFailureText,
} from "@/lib/execution/messages";
import { type Acknowledgements, buildExecutionRequest, type ExecutionRefusal } from "@/lib/execution/request";
import type { PlanCheck } from "@/lib/execution/response";
import { type ExecutionSnapshot, warningKey } from "@/lib/execution/snapshot";
import type { ApiPortfolio } from "@/lib/portfolio/api";
import { describeBatching } from "@/lib/wallet/capabilities";
import { chainOf, readChainTime } from "./chain";
import { callTitle, type TokenLabels, tokenLabels } from "./labels";
import { ExecutionProgress } from "./progress-view";
import { executionInFlight, snapshotSpent, useExecution } from "./use-execution";

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-sm break-all">{children}</span>;
}

function usdc(value: bigint): string {
  return `${formatTokenQuantity(value, 6)} USDC`;
}

function amount(value: bigint, token: string, tokens: TokenLabels): string {
  return `${formatTokenQuantity(value, tokens.decimalsOf(token))} ${tokens.symbolOf(token)}`;
}

function CallsTable({ snapshot, tokens }: { snapshot: ExecutionSnapshot; tokens: TokenLabels }) {
  if (!snapshot.verification.ok) return null;
  const { calls } = snapshot.verification;
  const { attestation } = snapshot;
  return (
    <div className="flex flex-col gap-2">
      <Table label="Calls you would sign">
        <TableCaption>
          <span>Calls you would sign</span>
          <span className="text-sm font-normal text-secondary">in this order, decoded in this browser</span>
        </TableCaption>
        <TableHead>
          <TableRow>
            <TableHeader numeric>#</TableHeader>
            <TableHeader>Call</TableHeader>
            <TableHeader>What it does</TableHeader>
            <TableHeader>Contract</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {calls.map((call, index) => (
            <TableRow key={call.data}>
              <TableCell numeric>{index + 1}</TableCell>
              <TableRowHeader>{callTitle(call, tokens)}</TableRowHeader>
              <TableCell>
                {call.kind === "approve" ? (
                  <>
                    Exactly <span className="num">{amount(call.amount, call.token, tokens)}</span> to the router{" "}
                    <Mono>{call.spender}</Mono>
                  </>
                ) : (
                  <>
                    Swap <span className="num">{amount(call.amountIn, call.tokenIn, tokens)}</span> for at least{" "}
                    <span className="num">{amount(call.minAmountOut, call.tokenOut, tokens)}</span>
                    <span className="block text-sm text-secondary">
                      Quoted {amount(call.quotedAmountOut, call.tokenOut, tokens)}, not guaranteed
                    </span>
                  </>
                )}
              </TableCell>
              <TableCell>
                <Mono>{call.to}</Mono>
                <span className="block text-sm text-secondary">{call.kind === "approve" ? "Token" : "Router"}</span>
              </TableCell>
            </TableRow>
          ))}
          {attestation.status === "included" ? (
            <TableRow>
              <TableCell numeric>{calls.length + 1}</TableCell>
              <TableRowHeader>Record the rebalance</TableRowHeader>
              <TableCell>
                recordRebalance of version {attestation.call.version} of this index. Moves no token.
              </TableCell>
              <TableCell>
                <Mono>{attestation.call.to}</Mono>
                <span className="block text-sm text-secondary">RebalanceLog</span>
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {attestation.status === "omitted" ? (
        <p className="max-w-measure text-sm text-secondary">{ATTESTATION_OMISSIONS[attestation.reason]}</p>
      ) : null}
    </div>
  );
}

function Totals({ snapshot, tokens }: { snapshot: ExecutionSnapshot; tokens: TokenLabels }) {
  if (!snapshot.verification.ok) return null;
  const { totals } = snapshot.verification;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-x-8 gap-y-1 text-base sm:grid-cols-3">
        <div>
          <dt className="text-xs text-secondary">Minimum USDC from sells</dt>
          <dd className="num text-md font-medium">{usdc(totals.minUsdcFromSells)}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">Maximum USDC spent by buys</dt>
          <dd className="num text-md font-medium">{usdc(totals.maxUsdcForBuys)}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">USDC held when checked</dt>
          <dd className="num text-md font-medium">{usdc(totals.usdcBefore)}</dd>
        </div>
      </dl>
      <Table label="Expected balances at minimum amounts out">
        <TableCaption>
          <span>Expected balances at minimum amounts out</span>
          <span className="text-sm font-normal text-secondary">a swap can return more, never less</span>
        </TableCaption>
        <TableHead>
          <TableRow>
            <TableHeader>Asset</TableHeader>
            <TableHeader numeric>Before</TableHeader>
            <TableHeader numeric>After, at least</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {totals.endBalances.map(({ token, before, afterAtMinimum }) => (
            <TableRow key={token}>
              <TableRowHeader className="font-mono text-sm">{tokens.symbolOf(token)}</TableRowHeader>
              <TableCell numeric>{formatTokenQuantity(before, tokens.decimalsOf(token))}</TableCell>
              <TableCell numeric>{formatTokenQuantity(afterAtMinimum, tokens.decimalsOf(token))}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CheckRow({ check, tokens }: { check: PlanCheck; tokens: TokenLabels }) {
  const blocking = check.status !== "pass" && check.status !== "warn";
  return (
    <li className="flex gap-2 border-t py-1.5 first:border-t-0" data-status={check.status}>
      <span className={blocking ? "mt-0.5 shrink-0 text-warning" : "mt-0.5 shrink-0 text-primary"}>
        {check.status === "pass" ? <CheckIcon /> : <WarningIcon />}
      </span>
      <span className="min-w-0">
        <code className="font-mono text-sm">{check.check}</code> {check.status}: {check.reason}
        {check.token === null ? null : <span className="text-secondary"> ({tokens.symbolOf(check.token)})</span>}
      </span>
    </li>
  );
}

/** Seconds left by this device's clock, for display only. The expiry is enforced by chain time at signing. */
function useSecondsLeft(expiresAt: number | null): number | null {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return expiresAt === null ? null : Math.max(0, expiresAt - now);
}

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Timestamp of the latest block of the plan's chain, read every few seconds while the review is open. */
function useChainTime(chainId: number, enabled: boolean): number | null {
  const config = useConfig();
  const query = useQuery({
    queryKey: ["execution", "chain-time", chainId],
    queryFn: () => readChainTime(config, chainId),
    enabled,
    refetchInterval: 5_000,
    retry: false,
  });
  return query.data ?? null;
}

/**
 * The review of an executable plan: everything that would be signed, decoded and verified in this browser, the
 * checks and warnings, the expiry and the one button that signs. The button's click handler exists only when
 * `buildExecutionRequest` allows it, and the click decides again with the chain time read at that moment.
 */
export function ExecutionReview({
  snapshot,
  comparison,
  executionAvailable,
  preparing,
  onNewPlan,
  onClose,
}: {
  snapshot: ExecutionSnapshot;
  comparison: ApiPortfolio;
  executionAvailable: boolean;
  preparing: boolean;
  onNewPlan: () => void;
  onClose: () => void;
}) {
  const config = useConfig();
  const { address, chainId: walletChainId } = useConnection();
  const batching = useWalletCapabilities();
  const execution = useExecution(snapshot);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [clickRefusal, setClickRefusal] = useState<ExecutionRefusal | null>(null);
  const { plan, verification } = snapshot;
  const tokens = tokenLabels(snapshot, comparison);
  const started = execution.state.mode !== "none";
  const chainTime = useChainTime(plan.chainId, plan.status === "ready" && !started);
  const secondsLeft = useSecondsLeft(plan.expiresAt);
  const chain = chainOf(config, plan.chainId);
  const acknowledgements: Acknowledgements | null =
    plan.planHash === null ? null : { planHash: plan.planHash, keys: acknowledged };
  const busy = execution.running || executionInFlight(execution.state) || snapshotSpent(execution.state);
  const gate = { executionAvailable, busy };
  const decision = buildExecutionRequest(
    snapshot,
    address ?? null,
    walletChainId ?? null,
    batching,
    acknowledgements,
    chainTime,
    gate,
  );
  const callCount = verification.ok
    ? verification.calls.length + (batching.mode === "atomic" && snapshot.attestation.status === "included" ? 1 : 0)
    : 0;
  const expired =
    verification.ok && chainTime !== null && chainTime >= verification.expiresAt
      ? true
      : !decision.ok && decision.refusal.reason === "expired";

  /** Decides again at the click, with the chain time and the connection of that moment, and sends only if allowed. */
  async function sign() {
    setClickRefusal(null);
    const now = await readChainTime(config, plan.chainId).catch(() => null);
    const connection = getConnection(config);
    const fresh = buildExecutionRequest(
      snapshot,
      connection.address ?? null,
      connection.chainId ?? null,
      batching,
      acknowledgements,
      now,
      gate,
    );
    if (!fresh.ok) {
      setClickRefusal(fresh.refusal);
      return;
    }
    await execution.execute(fresh.request);
  }

  const toggle = (key: string, checked: boolean) => {
    const next = new Set(acknowledged);
    if (checked) next.add(key);
    else next.delete(key);
    setAcknowledged(next);
  };

  return (
    <section aria-labelledby="review-heading" className="flex flex-col gap-6 border-t pt-6">
      <div>
        {busy ? null : (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-sm text-accent hover:underline"
          >
            <ArrowLeftIcon />
            Back to the plan preview
          </button>
        )}
        <h2 id="review-heading" className="mt-3 text-lg font-medium">
          Review the executable plan
        </h2>
        <p className="mt-1 max-w-measure text-secondary">
          {plan.index.name} version {plan.index.version}, for <Mono>{plan.address}</Mono> on{" "}
          {chain?.name ?? `chain ${plan.chainId}`}. Nothing is sent until you sign in your wallet.
        </p>
      </div>

      {plan.status === "blocked" ? (
        <Callout tone="warning" role="alert" title="The plan is blocked: no call can be signed.">
          <ul className="flex flex-col gap-1">
            {plan.blockedBy.map((check) => (
              <li key={warningKey(check)}>
                <code className="font-mono text-sm">{check.check}</code> {check.reason}
                {check.token === null ? null : ` (${tokens.symbolOf(check.token)})`}
              </li>
            ))}
          </ul>
        </Callout>
      ) : !verification.ok ? (
        <Callout tone="negative" role="alert" title="This browser refused the plan. Nothing can be signed.">
          <ul className="flex flex-col gap-1">
            {verification.failures.map((failure) => (
              <li key={`${failure.code}:${failure.call}:${failure.leg}:${failure.detail}`}>
                {verificationFailureText(failure)}{" "}
                <code className="font-mono text-xs text-secondary">{failure.code}</code>
              </li>
            ))}
          </ul>
        </Callout>
      ) : !verification.hashMatches ? (
        <Callout tone="negative" role="alert" title="The plan hash does not match. Nothing can be signed.">
          Computed here <Mono>{verification.localPlanHash}</Mono>, sent by the server <Mono>{plan.planHash ?? ""}</Mono>
          .
        </Callout>
      ) : null}

      {verification.ok ? (
        <>
          <CallsTable snapshot={snapshot} tokens={tokens} />
          <Totals snapshot={snapshot} tokens={tokens} />
          <p className="text-sm text-secondary">
            Plan hash <Mono>{verification.localPlanHash}</Mono>, recomputed in this browser from the calls above.
          </p>
        </>
      ) : null}

      <section aria-labelledby="checks-heading">
        <h3 id="checks-heading" className="text-md font-medium">
          Pre-trade checks
        </h3>
        <ul aria-label="Pre-trade checks" className="mt-2 border-y">
          {plan.checks.map((check) => (
            <CheckRow key={warningKey(check)} check={check} tokens={tokens} />
          ))}
        </ul>
      </section>

      {plan.warnings.length === 0 || !verification.ok ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-md font-medium">Warnings to acknowledge</legend>
          {plan.warnings.map((warning) => {
            const key = warningKey(warning);
            return (
              <Checkbox
                key={key}
                checked={acknowledged.has(key)}
                disabled={busy}
                onChange={(event) => toggle(key, event.target.checked)}
                label={`I acknowledge ${warning.check}: ${warning.reason}${warning.token === null ? "" : ` for ${tokens.symbolOf(warning.token)}`}.`}
              />
            );
          })}
        </fieldset>
      )}

      <div className="flex max-w-measure flex-col gap-1 text-sm text-secondary">
        {EXECUTION_STATEMENTS.map((statement) => (
          <p key={statement}>{statement}</p>
        ))}
      </div>

      {plan.status === "ready" && verification.ok && verification.hashMatches && !started ? (
        <div className="flex flex-col items-start gap-3">
          <p data-testid="plan-expiry" className="text-sm text-secondary">
            {expired ? (
              <span className="font-medium text-warning">This plan expired by the time of the latest block.</span>
            ) : (
              <>
                <span className="num font-medium text-primary">
                  Expires in {secondsLeft === null ? "-" : countdown(secondsLeft)}
                </span>{" "}
                by this device's clock. The expiry is checked against the latest block when you sign.
              </>
            )}
          </p>
          <p className="max-w-measure text-sm text-secondary">
            <Tag>{describeBatching(batching).label}</Tag>{" "}
            {batching.mode === "atomic"
              ? "Your wallet sends these calls as one batch: all of them take effect, or none does."
              : "Your wallet asks you to confirm each call in turn. If one fails, the ones after it are not sent."}
          </p>
          {expired ? null : (
            <Button
              variant="primary"
              size="lg"
              disabled={!decision.ok}
              loading={execution.running}
              loadingLabel="Waiting for the wallet"
              onClick={decision.ok ? () => void sign() : undefined}
            >
              {batching.mode === "atomic"
                ? `Sign ${callCount} calls in your wallet`
                : `Sign ${callCount} transactions in your wallet, one at a time`}
            </Button>
          )}
          {!decision.ok && decision.refusal.reason !== "expired" ? (
            <p data-testid="send-refusal" className="max-w-measure text-sm text-secondary">
              {refusalMessage(decision.refusal)}
            </p>
          ) : null}
          {clickRefusal === null ? null : (
            <p role="alert" className="max-w-measure text-sm text-negative">
              {refusalMessage(clickRefusal)}
            </p>
          )}
        </div>
      ) : null}

      {started ? (
        <ExecutionProgress
          snapshot={snapshot}
          comparison={comparison}
          tokens={tokens}
          execution={execution}
          chain={chain}
        />
      ) : null}

      {execution.running || executionInFlight(execution.state) ? null : (
        <div>
          <Button loading={preparing} loadingLabel="Preparing the plan" onClick={onNewPlan}>
            Get a new plan
          </Button>
          {plan.checkedAtBlock === null ? null : (
            <span className="ml-3 text-xs text-secondary">
              Checked at block <span className="num">{formatCount(plan.checkedAtBlock.number)}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}
