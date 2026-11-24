"use client";

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Address, Chain, Hex } from "viem";
import { useConfig, useConnection } from "wagmi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CheckIcon, CircleIcon, WarningIcon } from "@/components/ui/icons";
import { Link } from "@/components/ui/link";
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
import { formatFixed, formatTokenQuantity, formatUtcDateTime } from "@/lib/format";
import {
  appendHistory,
  browserStore,
  type HistoryEntry,
  type HistoryResult,
  readHistory,
} from "@/lib/execution/history";
import { ATTESTATION_OMISSIONS, attestationRefusalMessage, refusalMessage } from "@/lib/execution/messages";
import { driftAfter } from "@/lib/execution/outcome";
import { type StepState, summarizeSequential } from "@/lib/execution/progress";
import type { RecordedAttestation } from "@/lib/execution/receipts";
import { buildAttestationRequest } from "@/lib/execution/request";
import type { ExecutionSnapshot } from "@/lib/execution/snapshot";
import type { ApiPortfolio } from "@/lib/portfolio/api";
import type { TxState } from "@/lib/tx/machine";
import { txFailureMessage } from "@/lib/tx/errors";
import { readBalances, transactionUrl } from "./chain";
import { callTitle, type TokenLabels } from "./labels";
import { type ExecutionState, executionInFlight, sentTransactions, type useExecution } from "./use-execution";

type Execution = ReturnType<typeof useExecution>;

function TxLink({ chain, hash }: { chain: Chain | undefined; hash: Hex }) {
  const url = transactionUrl(chain, hash);
  return url === null ? (
    <span className="font-mono text-sm break-all">{hash}</span>
  ) : (
    <Link href={url} className="font-mono text-sm break-all">
      {hash}
    </Link>
  );
}

/** One line per state of a transaction of the sequential path. */
function stepText(state: StepState): string {
  switch (state.status) {
    case "idle":
      return "Not sent";
    case "awaiting_signature":
      return "Waiting for your confirmation in the wallet";
    case "rejected":
      return "Declined in the wallet. Not sent";
    case "failed":
      return txFailureMessage(state.failure);
    case "submitted":
      return "Sent, waiting to be mined";
    case "verifying":
      return "Mined, checking the receipt";
    case "confirmed":
      return "Confirmed";
    case "unverified":
      return `Mined, but not confirmed: ${state.reason}`;
    case "reverted":
      return "Mined and reverted: it took no effect, the network fee was paid";
    case "replaced":
      return "Replaced in the wallet by another transaction";
    case "dropped":
      return "No receipt was found in time. It may still be mined";
  }
}

function StepIcon({ status }: { status: StepState["status"] }) {
  if (status === "confirmed") return <CheckIcon className="mt-0.5 shrink-0" />;
  if (status === "idle" || status === "awaiting_signature" || status === "submitted" || status === "verifying") {
    return <CircleIcon className="mt-0.5 shrink-0 text-tertiary" />;
  }
  return <WarningIcon className="mt-0.5 shrink-0 text-warning" />;
}

function hashOf(state: TxState<unknown, string>): string | null {
  return "hash" in state ? state.hash : null;
}

function Attestation({ found, chain }: { found: RecordedAttestation; chain: Chain | undefined }) {
  return (
    <div data-testid="attestation-event" className="flex flex-col gap-1 text-base">
      <p className="font-medium">
        RebalanceRecorded(account {found.account}, indexId {found.indexId}, version {found.version})
      </p>
      <p className="text-sm text-secondary">
        Emitted by RebalanceLog <span className="font-mono">{found.log}</span> in{" "}
        <TxLink chain={chain} hash={found.transactionHash} />. It is a claim by your account that it rebalanced toward
        this version, and moves no token.
      </p>
    </div>
  );
}

function points(bps: number | null): string {
  return bps === null ? "-" : `${formatFixed(BigInt(bps), 2, 2)} pp`;
}

/**
 * Balances read again on the chain after the execution, and drift recomputed against the index with the same
 * reference prices as the comparison above. Shown for a complete and for a partial execution alike.
 */
function AfterExecution({
  snapshot,
  comparison,
  tokens,
  blockNumber,
}: {
  snapshot: ExecutionSnapshot;
  comparison: ApiPortfolio;
  tokens: TokenLabels;
  blockNumber: bigint | null;
}) {
  const config = useConfig();
  const usdc = snapshot.network?.usdc ?? null;
  const constituents = comparison.constituents.map(({ token }) => token as Address);
  const query = useQuery({
    queryKey: ["execution", "after", snapshot.plan.planHash, blockNumber?.toString() ?? "latest"],
    queryFn: () =>
      readBalances(
        config,
        snapshot.plan.chainId,
        snapshot.account,
        usdc === null ? constituents : [usdc, ...constituents],
        blockNumber,
      ),
    retry: 2,
  });
  if (usdc === null) return null;
  if (query.isPending) return <p className="text-secondary">Reading your balances again</p>;
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-negative">
        Your balances could not be read again. <Button onClick={() => void query.refetch()}>Read again</Button>
      </p>
    );
  }
  const balances = query.data;
  const after = driftAfter({
    constituents: comparison.constituents.map(({ token, decimals, targetWeightBps, referencePrice }) => ({
      token: token as Address,
      decimals,
      targetWeightBps,
      priceE8: referencePrice.priceE8 === null ? null : BigInt(referencePrice.priceE8),
      priceStatus: referencePrice.status,
    })),
    driftThresholdBps: comparison.index.driftThresholdBps,
    balances,
    usdcBalance: balances.get(usdc) ?? null,
  });
  if (after.status === "incomplete") {
    return (
      <p role="alert" className="text-sm text-negative">
        Some balances could not be read again, so the drift after is not computed.
      </p>
    );
  }
  const afterOf = new Map(after.positions.map((position) => [position.token.toLowerCase(), position]));
  return (
    <section aria-labelledby="after-heading" className="flex flex-col gap-3">
      <h3 id="after-heading" className="text-md font-medium">
        Before and after
      </h3>
      <dl className="grid gap-x-8 gap-y-1 text-base sm:grid-cols-2">
        <div>
          <dt className="text-xs text-secondary">Largest drift before</dt>
          <dd className="num text-md font-medium">{points(comparison.drift?.maxAbsDriftBps ?? null)}</dd>
        </div>
        <div>
          <dt className="text-xs text-secondary">Largest drift after</dt>
          <dd data-testid="drift-after" className="num text-md font-medium">
            {points(after.maxAbsDriftBps)}
          </dd>
        </div>
      </dl>
      <Table label="Balances before and after">
        <TableCaption>
          <span>Balances before and after</span>
          <span className="text-sm font-normal text-secondary">
            read again on the chain, valued at reference prices
          </span>
        </TableCaption>
        <TableHead>
          <TableRow>
            <TableHeader>Asset</TableHeader>
            <TableHeader numeric>Balance before</TableHeader>
            <TableHeader numeric>Balance after</TableHeader>
            <TableHeader numeric>Drift before</TableHeader>
            <TableHeader numeric>Drift after</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {comparison.constituents.map((position) => {
            const next = afterOf.get(position.token.toLowerCase());
            return (
              <TableRow key={position.token}>
                <TableRowHeader className="font-mono text-sm">{tokens.symbolOf(position.token)}</TableRowHeader>
                <TableCell numeric>{formatTokenQuantity(BigInt(position.balance), position.decimals)}</TableCell>
                <TableCell numeric>
                  {next === undefined ? "-" : formatTokenQuantity(next.balance, position.decimals)}
                </TableCell>
                <TableCell numeric>{points(position.driftBps)}</TableCell>
                <TableCell numeric>{points(next?.driftBps ?? null)}</TableCell>
              </TableRow>
            );
          })}
          <TableRow>
            <TableRowHeader className="font-mono text-sm">USDC</TableRowHeader>
            <TableCell numeric>{formatTokenQuantity(BigInt(comparison.totals.quoteBalance), 6)}</TableCell>
            <TableCell numeric>{formatTokenQuantity(after.usdcBalance, 6)}</TableCell>
            <TableCell numeric>-</TableCell>
            <TableCell numeric>-</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="max-w-measure text-sm text-secondary">
        Drift uses the reference prices of the comparison above, as the comparison does. They are not the prices the
        swaps executed at.
      </p>
    </section>
  );
}

/** The executions recorded in this browser for the account. Never sent anywhere. */
export function ExecutionHistory({
  account,
  chain,
  refresh,
}: {
  account: Address;
  chain: Chain | undefined;
  refresh: number;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    void refresh;
    setEntries(readHistory(browserStore(), account));
  }, [account, refresh]);
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-2">
      <h3 id="history-heading" className="text-md font-medium">
        Executions from this browser
      </h3>
      <p className="text-sm text-secondary">
        Stored only in this browser. No server keeps this list, and another browser or device does not show it.
      </p>
      <ul aria-label="Executions from this browser" className="flex flex-col gap-2 border-y py-2">
        {entries.map((entry) => (
          <li key={`${entry.at}:${entry.planHash}`} className="text-sm">
            <span className="font-medium">{formatUtcDateTime(BigInt(Math.floor(entry.at / 1000)))}</span>:{" "}
            {entry.index.name} version {entry.index.version}, {entry.mode}, {entry.result}
            {entry.transactions.map(({ hash, label }) => (
              <span key={hash} className="block">
                {label}: <TxLink chain={chain} hash={hash} />
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function resultOf(state: ExecutionState): HistoryResult | null {
  if (state.mode === "atomic") {
    const { status } = state.batch;
    if (status === "confirmed") return "complete";
    if (status === "unverified") return "unverified";
    return status === "reverted" || status === "dropped" || status === "replaced" ? "none" : null;
  }
  if (state.mode === "sequential") {
    const summary = summarizeSequential(state);
    if (!summary.settled) return null;
    if (summary.complete) return "complete";
    if (summary.failed?.state.status === "unverified") return "unverified";
    return summary.confirmed.length > 0 ? "partial" : "none";
  }
  return null;
}

function Status({
  tone,
  title,
  children,
}: {
  tone: "info" | "negative" | "warning" | "neutral";
  title: string;
  children?: ReactNode;
}) {
  return (
    <Callout tone={tone} role={tone === "negative" || tone === "warning" ? "alert" : "status"} title={title}>
      {children}
    </Callout>
  );
}

/**
 * What happened after the click: each transaction or the batch, then the result, the attestation, the balances
 * read again and the drift after. A declined request is a calm state with nothing sent.
 */
export function ExecutionProgress({
  snapshot,
  comparison,
  tokens,
  execution,
  chain,
}: {
  snapshot: ExecutionSnapshot;
  comparison: ApiPortfolio;
  tokens: TokenLabels;
  execution: Execution;
  chain: Chain | undefined;
}) {
  const { state } = execution;
  const { address, chainId: walletChainId } = useConnection();
  const [historyVersion, setHistoryVersion] = useState(0);
  const recorded = useRef<string | null>(null);
  const calls = snapshot.verification.ok ? snapshot.verification.calls : [];
  const label = (index: number) => {
    const call = calls[index];
    return call === undefined ? `Call ${index + 1}` : callTitle(call, tokens);
  };
  const result = resultOf(state);
  const attestationDone =
    state.mode === "sequential" && state.attestation.status === "confirmed" ? state.attestation.result : null;

  // Records the run once it settles, and again when the optional attestation is added to it.
  useEffect(() => {
    if (result === null || executionInFlight(state) || state.mode === "none" || snapshot.plan.planHash === null) return;
    const transactions = sentTransactions(state, label);
    const attestationHash =
      state.mode === "atomic"
        ? state.batch.status === "confirmed"
          ? (state.batch.result.attestation?.transactionHash ?? null)
          : null
        : (attestationDone?.attestation?.transactionHash ?? null);
    const key = `${result}:${transactions.length}:${attestationHash ?? ""}`;
    if (recorded.current === key) return;
    recorded.current = key;
    appendHistory(browserStore(), {
      at: Date.now(),
      chainId: snapshot.plan.chainId,
      account: snapshot.account,
      index: snapshot.plan.index,
      planHash: snapshot.plan.planHash,
      mode: state.mode,
      result,
      transactions,
      attestation: attestationHash,
    });
    setHistoryVersion((version) => version + 1);
  });

  let body: ReactNode = null;
  let blockNumber: bigint | null = null;
  let attestation: RecordedAttestation | null = null;
  let showAfter = false;

  if (state.mode === "atomic") {
    const batch = state.batch;
    const hash = hashOf(batch);
    switch (batch.status) {
      case "idle":
      case "awaiting_signature":
        body = (
          <Status tone="info" title="Confirm the batch in your wallet.">
            Nothing has been sent. The wallet shows the same {state.request.sendCalls.calls.length} calls, in this
            order.
          </Status>
        );
        break;
      case "rejected":
        body = (
          <Status tone="neutral" title="You declined the request in the wallet.">
            Nothing was sent and your holdings are unchanged.{" "}
            <Button onClick={execution.retry}>Back to the review</Button>
          </Status>
        );
        break;
      case "failed":
        body = (
          <Status tone="negative" title={txFailureMessage(batch.failure)}>
            <Button onClick={execution.retry}>Back to the review</Button>
          </Status>
        );
        break;
      case "submitted":
      case "verifying":
        body = (
          <Status tone="info" title="Sent as one batch. Waiting for the wallet to report it mined.">
            Batch <span className="font-mono text-sm break-all">{hash}</span>
          </Status>
        );
        break;
      case "confirmed":
        blockNumber = batch.result.blockNumber;
        attestation = batch.result.attestation;
        showAfter = true;
        body = (
          <Status tone="neutral" title="Executed: every call of the batch confirmed and its receipts were checked.">
            <ul className="flex flex-col gap-1">
              {batch.result.transactionHashes.map((transaction) => (
                <li key={transaction}>
                  <TxLink chain={chain} hash={transaction} />
                </li>
              ))}
            </ul>
          </Status>
        );
        break;
      case "unverified":
        showAfter = true;
        body = (
          <Status tone="negative" title="The batch was mined, but its receipts do not confirm the plan.">
            {batch.reason} Read your balances below before doing anything else.
          </Status>
        );
        break;
      case "reverted":
        body = (
          <Status tone="warning" title="The batch failed: none of its calls took effect.">
            Your holdings are unchanged, apart from any network fee. Get a new plan to try again.
          </Status>
        );
        break;
      case "replaced":
      case "dropped":
        showAfter = true;
        body = (
          <Status tone="warning" title="The wallet did not report a final status in time.">
            The batch may still be mined. Check it in your wallet before preparing another plan.
          </Status>
        );
        break;
    }
  }

  if (state.mode === "sequential") {
    const summary = summarizeSequential(state);
    const lastConfirmed = summary.confirmed.at(-1);
    const lastStep = lastConfirmed === undefined ? undefined : state.steps[lastConfirmed];
    blockNumber = lastStep?.status === "confirmed" ? lastStep.result.blockNumber : null;
    attestation = attestationDone?.attestation ?? null;
    showAfter = summary.settled && summary.confirmed.length > 0;
    const confirmedApprovals = summary.confirmed.filter((index) => calls[index]?.kind === "approve");
    const unswapped = confirmedApprovals.length > 0 && !summary.complete;
    const offer =
      snapshot.attestation.status === "included"
        ? buildAttestationRequest(
            state.request,
            summary.confirmed.length,
            address ?? null,
            walletChainId ?? null,
            execution.running || executionInFlight(state),
          )
        : null;
    body = (
      <div className="flex flex-col gap-4">
        <ol aria-label="Transactions" className="flex flex-col gap-2 border-y py-2">
          {state.steps.map((step, index) => {
            const hash = hashOf(step);
            return (
              <li key={state.request.transactions[index]?.data} data-status={step.status} className="flex gap-2">
                <StepIcon status={step.status} />
                <span className="min-w-0">
                  <span className="font-medium">
                    {index + 1}. {label(index)}
                  </span>
                  : {stepText(step)}
                  {hash === null ? null : (
                    <span className="block">
                      <TxLink chain={chain} hash={hash as Hex} />
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
        {state.stopped === null ? null : (
          <Status tone="warning" title={`Stopped before transaction ${state.stopped.before + 1}.`}>
            {refusalMessage(state.stopped.refusal)}
          </Status>
        )}
        {summary.settled ? (
          <Status
            tone={summary.complete ? "neutral" : "warning"}
            title={
              summary.complete
                ? "Executed: every transaction confirmed and its receipt was checked."
                : summary.confirmed.length === 0
                  ? "Nothing was executed."
                  : "Partially executed."
            }
          >
            <span data-testid="execution-summary" className="block">
              {summary.confirmed.length} confirmed:{" "}
              {summary.confirmed.map((index) => label(index)).join(", ") || "none"}.{" "}
              {summary.failed === null ? "" : `Failed: ${label(summary.failed.index)}. `}
              {summary.notSent.length} not sent: {summary.notSent.map((index) => label(index)).join(", ") || "none"}.
            </span>
            {unswapped ? (
              <span className="mt-1 block">
                Approvals that confirmed stay in place for their exact amounts toward the router:{" "}
                {confirmedApprovals.map((index) => label(index)).join(", ")}. A later plan can use them, or you can set
                them to zero in your wallet.
              </span>
            ) : null}
            {summary.complete || summary.confirmed.length === 0 ? null : (
              <span className="mt-1 block">Your position is shown below as read from the chain now.</span>
            )}
          </Status>
        ) : null}
        {summary.complete && snapshot.attestation.status === "included" && state.attestation.status !== "confirmed" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="max-w-measure text-sm text-secondary">
              Optional: record this rebalance onchain with RebalanceLog. It emits an event naming your account, this
              index and version {snapshot.attestation.call.version}, moves no token and costs a network fee. Your
              rebalance is complete without it.
            </p>
            <Button
              disabled={offer === null || !offer.ok}
              loading={execution.running}
              loadingLabel="Waiting for the wallet"
              onClick={offer?.ok ? () => void execution.attest(offer.transaction) : undefined}
            >
              Sign 1 more transaction to record the rebalance
            </Button>
            {state.attestation.status === "idle" ? null : (
              <p className="text-sm text-secondary">
                {stepText(state.attestation)}
                {hashOf(state.attestation) === null ? null : (
                  <>
                    {" "}
                    <TxLink chain={chain} hash={hashOf(state.attestation) as Hex} />
                  </>
                )}
              </p>
            )}
            {offer !== null && !offer.ok && offer.refusal.reason !== "busy" ? (
              <p className="text-sm text-secondary">{attestationRefusalMessage(offer.refusal)}</p>
            ) : null}
          </div>
        ) : null}
        {summary.settled &&
        summary.confirmed.length === 0 &&
        state.stopped === null &&
        summary.failed !== null &&
        (summary.failed.state.status === "rejected" || summary.failed.state.status === "failed") ? (
          <div>
            <Button onClick={execution.retry}>Back to the review</Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-labelledby="progress-heading" className="flex flex-col gap-4">
      <h3 id="progress-heading" className="text-md font-medium">
        Execution
      </h3>
      {body}
      {attestation === null ? (
        state.mode !== "none" && snapshot.attestation.status === "omitted" && result === "complete" ? (
          <p className="text-sm text-secondary">{ATTESTATION_OMISSIONS[snapshot.attestation.reason]}</p>
        ) : null
      ) : (
        <Attestation found={attestation} chain={chain} />
      )}
      {showAfter ? (
        <AfterExecution snapshot={snapshot} comparison={comparison} tokens={tokens} blockNumber={blockNumber} />
      ) : null}
      <ExecutionHistory account={snapshot.account} chain={chain} refresh={historyVersion} />
    </section>
  );
}
