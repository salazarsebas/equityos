"use client";

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useConfig, useConnection } from "wagmi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
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
import { formatCount, formatFixed, formatUsd, shortenAddress, toIsoInstant } from "@/lib/format";
import { CHECK_STATUS_TEXT, describeCheck } from "@/lib/execution/check-text";
import {
  ATTESTATION_OMISSIONS,
  EXECUTION_STATEMENTS,
  refusalMessage,
  verificationFailureText,
} from "@/lib/execution/messages";
import { type Acknowledgements, buildExecutionRequest, type ExecutionRefusal } from "@/lib/execution/request";
import { CLIENT_PRICE_BOUND_BPS } from "@/lib/execution/market";
import type { PlanCheck } from "@/lib/execution/response";
import { type ExecutionSnapshot, warningKey } from "@/lib/execution/snapshot";
import type { VerifiedCall } from "@/lib/execution/verify";
import type { ApiPortfolio } from "@/lib/portfolio/api";
import { describeBatching } from "@/lib/wallet/capabilities";
import { chainOf, readChainTime, readWallet } from "./chain";
import { callTitle, exactAmount, quantity, type TokenLabels, tokenLabels } from "./labels";
import { ExecutionProgress } from "./progress-view";
import { executionInFlight, snapshotSpent, useExecution } from "./use-execution";

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-sm break-all">{children}</span>;
}

/**
 * An address shortened to its first and last characters, with the full address in its title and for assistive
 * technology. Positioned, so that the visually hidden full address stays inside a scrolling table instead of
 * widening the page.
 */
function ShortAddress({ address }: { address: string }) {
  return (
    <span className="relative font-mono text-sm text-secondary">
      <span aria-hidden="true" title={address}>
        {shortenAddress(address)}
      </span>
      <span className="sr-only">{address}</span>
    </span>
  );
}

/**
 * A contract address, shortened to its first and last characters with the name the review knows it by. Assistive
 * technology reads the full address, and the copy control places the full address on the clipboard.
 */
function ContractAddress({ address, tokens }: { address: string; tokens: TokenLabels }) {
  const name = tokens.contractName(address);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {name === null ? null : <span>{name}</span>}
      <ShortAddress address={address} />
      <CopyButton value={address} label={`Copy the full address of ${name ?? "the contract"}`} />
    </span>
  );
}

/**
 * The contract a call is addressed to, in the calls table: its name and role on one line, the shortened address
 * and its copy control on the next, so that every row has the same shape.
 */
function ContractCell({ address, kind, tokens }: { address: string; kind: string; tokens: TokenLabels }) {
  const name = tokens.contractName(address);
  return (
    <div className="flex flex-col items-start gap-1 py-2">
      <span>
        {name ?? kind}
        {name !== null && name !== kind ? <span className="text-secondary">, {kind.toLowerCase()}</span> : null}
      </span>
      <span className="inline-flex items-center gap-2">
        <ShortAddress address={address} />
        <CopyButton value={address} label={`Copy the full address of ${name ?? `the ${kind.toLowerCase()}`}`} />
      </span>
    </div>
  );
}

/** One label and value of the expanded detail of a call. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** A full address in the detail of a call, with its name and a copy control. */
function FullAddress({ address, tokens }: { address: string; tokens: TokenLabels }) {
  const name = tokens.contractName(address);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {name === null ? null : <span>{name}</span>}
      <span className="font-mono break-all">{address}</span>
      <CopyButton value={address} label={`Copy the full address of ${name ?? "the contract"}`} />
    </span>
  );
}

/**
 * Everything one call carries, exactly: the full addresses, every amount with all the token's decimals and in base
 * units, and the full calldata that would be signed.
 */
function CallDetail({ call, position, tokens }: { call: VerifiedCall; position: number; tokens: TokenLabels }) {
  const bytes = (call.data.length - 2) / 2;
  return (
    <details className="mt-1">
      <summary className="w-fit cursor-pointer rounded-sm text-sm text-accent hover:underline">
        Calldata and exact amounts<span className="sr-only"> of call {position}</span>
      </summary>
      <dl className="mt-2 flex flex-col gap-2 border-l pl-3">
        <Detail label="Contract">
          <FullAddress address={call.to} tokens={tokens} />
        </Detail>
        {call.kind === "approve" ? (
          <>
            <Detail label="Spender">
              <FullAddress address={call.spender} tokens={tokens} />
            </Detail>
            <Detail label="Amount approved">
              <span className="num">{exactAmount(call.amount, call.token, tokens)}</span>
            </Detail>
          </>
        ) : (
          <>
            <Detail label="Swaps exactly">
              <span className="num">{exactAmount(call.amountIn, call.tokenIn, tokens)}</span>
            </Detail>
            <Detail label="Minimum out, enforced by the router">
              <span className="num">{exactAmount(call.minAmountOut, call.tokenOut, tokens)}</span>
            </Detail>
            <Detail label="Quoted out, not guaranteed">
              <span className="num">{exactAmount(call.quotedAmountOut, call.tokenOut, tokens)}</span>
            </Detail>
            <Detail label="Route deadline">
              <span className="num">
                {toIsoInstant(BigInt(call.deadline))} (Unix time {call.deadline})
              </span>
            </Detail>
          </>
        )}
        <Detail label="Value sent">
          <span className="num">{call.value.toString()} wei</span>
        </Detail>
        <Detail label={`Calldata, ${formatCount(BigInt(bytes))} bytes`}>
          <span className="flex flex-col items-start gap-1">
            <code className="font-mono text-xs break-all">{call.data}</code>
            <CopyButton value={call.data} label={`Copy the calldata of call ${position}`} />
          </span>
        </Detail>
      </dl>
    </details>
  );
}

function amount(value: bigint, token: string, tokens: TokenLabels): string {
  return `${quantity(value, tokens.decimalsOf(token))} ${tokens.symbolOf(token)}`;
}

/** The reference the browser read for a swap's leg, and how far the swap's worst price is from it. */
function PriceBound({ snapshot, leg }: { snapshot: ExecutionSnapshot; leg: number }) {
  if (!snapshot.verification.ok) return null;
  const market = snapshot.verification.market.find((entry) => entry.leg === leg);
  if (market === undefined || market.reference.status === "unavailable" || market.adverseBps === null) return null;
  const bps = market.adverseBps;
  const percent = `${formatFixed(bps < 0n ? -bps : bps, 2, 2)}%`;
  return (
    <span className="block text-sm text-secondary">
      Reference {formatUsd(market.reference.priceE8, 8)} USD a token, read in this browser from its feed (
      {market.reference.status}): the minimum is {percent} {bps > 0n ? "worse" : "better"} than it, within the{" "}
      {formatFixed(BigInt(CLIENT_PRICE_BOUND_BPS), 2, 2)}% this site allows
    </span>
  );
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
                <div className="min-w-64 py-2 whitespace-normal">
                  {call.kind === "approve" ? (
                    <>
                      Exactly <span className="num">{amount(call.amount, call.token, tokens)}</span> to the{" "}
                      {tokens.contractName(call.spender) === "Router" ? "router" : "spender"}{" "}
                      <ShortAddress address={call.spender} />
                    </>
                  ) : (
                    <>
                      Swap <span className="num">{amount(call.amountIn, call.tokenIn, tokens)}</span> for at least{" "}
                      <span className="num">{amount(call.minAmountOut, call.tokenOut, tokens)}</span>
                      <span className="block text-sm text-secondary">
                        Quoted {amount(call.quotedAmountOut, call.tokenOut, tokens)}, not guaranteed
                      </span>
                      <PriceBound snapshot={snapshot} leg={call.leg} />
                      <span className="block text-sm text-secondary">
                        Reverts after {toIsoInstant(BigInt(call.deadline))}, the route deadline decoded from its
                        calldata
                      </span>
                    </>
                  )}
                  <CallDetail call={call} position={index + 1} tokens={tokens} />
                </div>
              </TableCell>
              <TableCell className="align-top">
                <ContractCell address={call.to} kind={call.kind === "approve" ? "Token" : "Router"} tokens={tokens} />
              </TableCell>
            </TableRow>
          ))}
          {attestation.status === "included" ? (
            <TableRow>
              <TableCell numeric>{calls.length + 1}</TableCell>
              <TableRowHeader>Record the rebalance</TableRowHeader>
              <TableCell>
                <div className="min-w-64 py-2 whitespace-normal">
                  recordRebalance of version {attestation.call.version} of this index. Moves no token.
                  <details className="mt-1">
                    <summary className="w-fit cursor-pointer rounded-sm text-sm text-accent hover:underline">
                      Calldata<span className="sr-only"> of call {calls.length + 1}</span>
                    </summary>
                    <dl className="mt-2 flex flex-col gap-2 border-l pl-3">
                      <Detail label="Contract">
                        <FullAddress address={attestation.call.to} tokens={tokens} />
                      </Detail>
                      <Detail label="Index id">
                        <span className="font-mono break-all">{attestation.call.indexId}</span>
                      </Detail>
                      <Detail label="Value sent">
                        <span className="num">{attestation.call.value.toString()} wei</span>
                      </Detail>
                      <Detail label={`Calldata, ${formatCount(BigInt((attestation.call.data.length - 2) / 2))} bytes`}>
                        <span className="flex flex-col items-start gap-1">
                          <code className="font-mono text-xs break-all">{attestation.call.data}</code>
                          <CopyButton
                            value={attestation.call.data}
                            label={`Copy the calldata of call ${calls.length + 1}`}
                          />
                        </span>
                      </Detail>
                    </dl>
                  </details>
                </div>
              </TableCell>
              <TableCell className="align-top">
                <ContractCell address={attestation.call.to} kind="Rebalance log" tokens={tokens} />
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

/**
 * Allowances toward the router that already exceed what the plan swaps, as the server read them. The plan does not
 * approve these tokens again; the existing allowance lets the router pull more than this plan if it were ever
 * called with other calldata.
 */
function AllowancesAbovePlan({ snapshot, tokens }: { snapshot: ExecutionSnapshot; tokens: TokenLabels }) {
  const above = snapshot.plan.approvals.filter(
    ({ required, currentAllowance, amount: planned }) => !required && currentAllowance > planned,
  );
  if (above.length === 0) return null;
  return (
    <Callout tone="warning" title="Your wallet already allows the router to spend more than this plan swaps.">
      <ul className="flex flex-col gap-1">
        {above.map(({ token, spender, currentAllowance, amount: planned }) => (
          <li key={token}>
            {tokens.symbolOf(token)}: allowed{" "}
            <span className="num">
              {currentAllowance >= 2n ** 255n ? "an unlimited amount" : amount(currentAllowance, token, tokens)}
            </span>
            , this plan swaps <span className="num">{amount(planned, token, tokens)}</span>. Spender{" "}
            <ContractAddress address={spender} tokens={tokens} />
          </li>
        ))}
      </ul>
      <span className="mt-1 block">
        This plan does not approve these tokens again. The router could pull up to the allowed amount if it were ever
        called with other calldata. To reduce it, approve a lower amount, or zero, for this spender from your wallet or
        a token approval tool. Allowances as read by the server when it checked the plan.
      </span>
    </Callout>
  );
}

function Totals({ snapshot, tokens }: { snapshot: ExecutionSnapshot; tokens: TokenLabels }) {
  if (!snapshot.verification.ok) return null;
  const { totals } = snapshot.verification;
  const usdc = (value: bigint) => amount(value, snapshot.network?.usdc ?? "", tokens);
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
              <TableCell numeric>{quantity(before, tokens.decimalsOf(token))}</TableCell>
              <TableCell numeric>{quantity(afterAtMinimum, tokens.decimalsOf(token))}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The codes of a check as the server sent them, for developers: check, status, reason and detail. */
function CheckCode({ check }: { check: PlanCheck }) {
  return (
    <code className="block font-mono text-xs break-all text-secondary">
      {[check.check, check.status, check.reason, check.detail].filter((part) => part !== null).join(" ")}
    </code>
  );
}

/** The name of a check and the token or leg it concerns. */
function checkTitle(check: PlanCheck, tokens: TokenLabels): string {
  const { title } = describeCheck(check);
  if (check.token !== null) return `${title} (${tokens.symbolOf(check.token)})`;
  return check.leg === null ? title : `${title} (trade ${check.leg + 1})`;
}

function CheckRow({ check, tokens }: { check: PlanCheck; tokens: TokenLabels }) {
  const blocking = check.status !== "pass" && check.status !== "warn";
  const text = describeCheck(check);
  return (
    <li className="flex gap-2 border-t py-2 first:border-t-0" data-status={check.status}>
      <span
        className={
          blocking || check.status === "warn" ? "mt-0.5 shrink-0 text-warning" : "mt-0.5 shrink-0 text-primary"
        }
      >
        {check.status === "pass" ? <CheckIcon /> : <WarningIcon />}
      </span>
      <div className="flex min-w-0 max-w-measure flex-col gap-0.5">
        <p>
          <span className="font-medium">{checkTitle(check, tokens)}</span>
          <span className="text-secondary">: {CHECK_STATUS_TEXT[check.status]}</span>
        </p>
        <p className="text-sm text-secondary">
          {text.checked} {text.result}
        </p>
        {text.meaning === null ? null : <p className="text-sm text-secondary">{text.meaning}</p>}
        <CheckCode check={check} />
      </div>
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
  const tokens = useMemo(() => tokenLabels(snapshot, comparison), [snapshot, comparison]);
  const execution = useExecution(snapshot, tokens);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [clickRefusal, setClickRefusal] = useState<ExecutionRefusal | null>(null);
  const { plan, verification } = snapshot;
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
    const [now, wallet] = await Promise.all([
      readChainTime(config, plan.chainId).catch(() => null),
      readWallet(config),
    ]);
    const fresh = buildExecutionRequest(
      snapshot,
      wallet.address,
      wallet.chainId,
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
        <p className="mt-1 text-sm text-secondary">
          Index id <Mono>{comparison.index.indexId}</Mono>, version {comparison.index.version}, from the comparison on
          this page. The plan must name the same, and the attestation names these.
        </p>
      </div>

      {plan.status === "blocked" ? (
        <Callout tone="warning" role="alert" title="The plan is blocked: no call can be signed.">
          <ul className="flex flex-col gap-1">
            {plan.blockedBy.map((check) => (
              <li key={warningKey(check)}>
                <span className="font-medium">{checkTitle(check, tokens)}</span>: {describeCheck(check).result}
                <CheckCode check={check} />
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
          <AllowancesAbovePlan snapshot={snapshot} tokens={tokens} />
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
            const text = describeCheck(warning);
            return (
              <div key={key} className="flex max-w-measure flex-col gap-1">
                <Checkbox
                  checked={acknowledged.has(key)}
                  disabled={busy}
                  onChange={(event) => toggle(key, event.target.checked)}
                  label={`I acknowledge this warning. ${checkTitle(warning, tokens)}: ${text.result}`}
                />
                <div className="flex flex-col gap-0.5 pl-6">
                  {text.meaning === null ? null : <p className="text-sm text-secondary">{text.meaning}</p>}
                  <CheckCode check={warning} />
                </div>
              </div>
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
