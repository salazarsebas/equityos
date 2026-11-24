"use client";

import { useState } from "react";
import type { Address } from "viem";
import { isAddressEqual } from "viem";
import { useConfig, useConnection } from "wagmi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useExecutionAvailability } from "@/components/wallet/hooks";
import { ConnectDialog } from "@/components/wallet/connect-dialog";
import { rebalanceLogToRead } from "@/lib/execution/attestation";
import { builderCodeSuffix, InvalidBuilderCodeError } from "@/lib/execution/builder-code";
import { executionNetwork } from "@/lib/execution/networks";
import { PlanShapeError, parseExecutionPlan } from "@/lib/execution/response";
import { type ExecutionSnapshot, takeExecutionSnapshot } from "@/lib/execution/snapshot";
import { type ApiPortfolio, isApiError, readEnvelope } from "@/lib/portfolio/api";
import { EXECUTION_UNAVAILABLE_MESSAGES } from "@/lib/wallet/execution";
import { readCode } from "./chain";
import { ExecutionReview } from "./review";

type Mode = "rebalance" | "buy_only";

/** Why a plan could not be prepared, in words. The API's own message is never the only text shown. */
function prepareErrorText(error: unknown): string {
  if (error instanceof InvalidBuilderCodeError) {
    return "This site's Builder Code setting is not valid, so it prepares no plan. Nothing was signed or sent.";
  }
  if (error instanceof PlanShapeError) {
    return "The server's answer does not have the documented shape, so this browser refused it. Nothing was signed or sent.";
  }
  const code = isApiError(error) ? error.code : null;
  switch (code) {
    case "execution_unavailable":
      return "This server does not build executable plans: it serves recorded market data.";
    case "rate_limited":
      return "Too many plans were requested from this address. Wait a little and try again.";
    case "provider_rate_limited":
      return "The quote provider does not allow more quotes right now. Try again in a few seconds.";
    case "deadline_exceeded":
      return "The plan could not be built in time. Try again.";
    case "upstream_unavailable":
      return "Base mainnet did not answer the reads the plan needs. Try again.";
    case null:
      return "The executable plan could not be read. Nothing was signed or sent.";
    default:
      return "The executable plan could not be prepared. Nothing was signed or sent.";
  }
}

async function requestPlan(body: Record<string, unknown>) {
  const response = await fetch("/api/v1/portfolio/execution-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const envelope = await readEnvelope<unknown>(response);
  return parseExecutionPlan(envelope);
}

/**
 * The step after the plan preview: ask for an executable plan for the compared address and index, verify it in
 * this browser and review it. Shown only to the connected owner of the compared address, and only where
 * execution is available. Preparing signs nothing and sends nothing.
 */
export function ExecutePanel({
  comparison,
  version,
  mode,
  depositIgnored,
}: {
  comparison: ApiPortfolio;
  version: number | null;
  mode: Mode;
  /** A deposit is typed in the preview: an executable plan spends only what the address holds. */
  depositIgnored: boolean;
}) {
  const config = useConfig();
  const { address: connected } = useConnection();
  const availability = useExecutionAvailability();
  const [connecting, setConnecting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const owner = connected !== undefined && isAddressEqual(connected, comparison.address as Address);

  async function prepare(account: Address) {
    setPreparing(true);
    setError(null);
    try {
      const suffix = builderCodeSuffix();
      const plan = await requestPlan({
        address: comparison.address,
        index: comparison.index.identifier,
        ...(version === null ? {} : { version }),
        mode,
      });
      const network = executionNetwork(plan.chainId);
      const log = rebalanceLogToRead(network);
      const logCode = log === null ? null : await readCode(config, plan.chainId, log);
      setSnapshot(
        takeExecutionSnapshot({
          plan,
          account,
          network,
          constituents: comparison.constituents.map(({ token }) => token as Address),
          logCode,
          suffix,
        }),
      );
    } catch (caught) {
      setError(prepareErrorText(caught));
    } finally {
      setPreparing(false);
    }
  }

  if (snapshot !== null && connected !== undefined) {
    return (
      <ExecutionReview
        snapshot={snapshot}
        comparison={comparison}
        executionAvailable={availability.executionAvailable}
        preparing={preparing}
        onNewPlan={() => {
          setSnapshot(null);
          void prepare(connected);
        }}
        onClose={() => setSnapshot(null)}
      />
    );
  }

  return (
    <section aria-labelledby="execute-heading" className="flex flex-col gap-3 border-t pt-6">
      <div>
        <h2 id="execute-heading" className="text-lg font-medium">
          Execute from your wallet
        </h2>
        <p className="mt-1 max-w-measure text-secondary">
          An executable plan quotes each leg with a third-party aggregator, checks it against the chain and lists the
          exact calls your wallet would sign. Preparing it signs and sends nothing.
        </p>
      </div>
      {!availability.executionAvailable ? (
        <Callout title="Execution is not available.">{EXECUTION_UNAVAILABLE_MESSAGES[availability.reason]}</Callout>
      ) : connected === undefined ? (
        <div className="flex flex-col items-start gap-2">
          <p className="max-w-measure text-secondary">Connect the wallet of this address to prepare a plan for it.</p>
          <Button onClick={() => setConnecting(true)}>Connect wallet</Button>
        </div>
      ) : !owner ? (
        <Callout title="The connected wallet is not this address.">
          A plan is prepared only for the connected account, which signs every call. Compare the connected address to
          execute for it.
        </Callout>
      ) : (
        <div className="flex flex-col items-start gap-2">
          {depositIgnored ? (
            <p className="max-w-measure text-sm text-secondary">
              The deposit typed above is not part of an executable plan: it spends only what the address holds.
            </p>
          ) : null}
          <Button
            variant="primary"
            loading={preparing}
            loadingLabel="Preparing the plan"
            onClick={() => void prepare(connected)}
          >
            Prepare to execute
          </Button>
          {error === null ? null : (
            <p role="alert" className="max-w-measure text-sm text-negative">
              {error}
            </p>
          )}
        </div>
      )}
      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
    </section>
  );
}
