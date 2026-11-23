"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { Chain, Hex } from "viem";
import { useConfig, useConnection, useSwitchChain } from "wagmi";
import { writeContract } from "wagmi/actions";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { Checkbox } from "@/components/ui/field";
import { ArrowLeftIcon, CheckIcon, CircleIcon, DownloadIcon, WarningIcon } from "@/components/ui/icons";
import { Link } from "@/components/ui/link";
import { ConnectDialog } from "@/components/wallet/connect-dialog";
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
import { formatCount, formatPercent } from "@/lib/format";
import { publishFailureText } from "@/lib/studio/messages";
import { methodologyText } from "@/lib/studio/methodology-text";
import { type ChecklistItem, publishChecklist, type RegistryPresence } from "@/lib/studio/preflight";
import {
  buildPublishPlan,
  type NetworkPolicy,
  type PublishPlan,
  type PublishResult,
  verifyPublication,
} from "@/lib/studio/publish";
import {
  type Acknowledgement,
  acknowledgementEnds,
  buildPublishRequest,
  type PublishWriteRequest,
  publishPlanKey,
} from "@/lib/studio/request";
import type { ReviewSnapshot } from "@/lib/studio/snapshot";
import { isTxInFlight, type TxState } from "@/lib/tx/machine";
import { useTransaction } from "@/lib/tx/use-transaction";
import { registryChain, usePreflight } from "./chain";
import { CanonicalJson, exportSpec } from "./preview";

type ReviewProps = {
  /** What is reviewed and sent, taken when the review opened. Nothing else of the draft is read here. */
  snapshot: ReviewSnapshot;
  chain: Chain;
  policy: NetworkPolicy;
  presence: RegistryPresence;
  onBack: () => void;
  /** Replaces the salt of the draft with a new random one, on an explicit click. */
  onNewSalt: () => void;
  onNewDraft: () => void;
};

function explorerLink(chain: Chain, kind: "tx" | "address", value: string): string | null {
  const explorer = chain.blockExplorers?.default;
  return explorer === undefined ? null : `${explorer.url}/${kind}/${value}`;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-sm break-all">{children}</span>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-0.5 border-t py-2 first:border-t-0 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-secondary">{term}</dt>
      <dd className="min-w-0 text-primary">{children}</dd>
    </div>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const { state, label, detail } = item;
  return (
    <li className="flex gap-2 border-t py-2 first:border-t-0" data-state={state}>
      <span
        className={cx(
          "mt-0.5 shrink-0",
          state === "blocked" ? "text-warning" : state === "done" ? "text-primary" : "text-tertiary",
        )}
      >
        {state === "done" ? (
          <CheckIcon />
        ) : state === "blocked" ? (
          <WarningIcon />
        ) : state === "checking" ? (
          <span className="block size-4 animate-spin rounded-full border-[1.5px] border-current border-r-transparent motion-reduce:animate-none" />
        ) : (
          <CircleIcon />
        )}
      </span>
      <span className="min-w-0">
        <span className={cx("block", state === "done" ? "text-primary" : "font-medium text-primary")}>
          {label}
          <span className="sr-only">: {state === "done" ? "done" : state === "blocked" ? "blocked" : "not done"}</span>
        </span>
        <span className="block text-sm break-words text-secondary">{detail}</span>
      </span>
    </li>
  );
}

function TxLink({ chain, hash }: { chain: Chain; hash: Hex }) {
  const url = explorerLink(chain, "tx", hash);
  return url === null ? (
    <Mono>{hash}</Mono>
  ) : (
    <Link href={url} className="font-mono text-sm break-all">
      {hash}
    </Link>
  );
}

/** A reason in the contract's own words, shown apart and labelled as unverified text. */
function ReportedReason({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <span className="mt-2 block">
      <span className="block text-sm text-secondary">
        Reason reported by the wallet or node, not checked by this site:
      </span>
      <span className="mt-1 block rounded-sm bg-surface px-2 py-1 font-mono text-xs [overflow-wrap:anywhere] text-primary">
        {text}
      </span>
    </span>
  );
}

/** Where the transaction is, in words. The result of a publication is stated here and nowhere else. */
function TransactionStatus({
  state,
  chain,
  onRecheck,
  onNewSalt,
}: {
  state: TxState<PublishResult>;
  chain: Chain;
  onRecheck: () => void;
  onNewSalt: () => void;
}) {
  switch (state.status) {
    case "idle":
    case "confirmed":
      return null;
    case "awaiting_signature":
      return (
        <Callout tone="info" role="status" title="Confirm the transaction in your wallet.">
          Nothing has been sent. The wallet shows the same call: createIndex on the registry.
        </Callout>
      );
    case "rejected":
      return (
        <Callout role="status" title="You declined the request in the wallet.">
          Nothing was sent and the draft is unchanged. You can publish whenever you are ready.
        </Callout>
      );
    case "failed": {
      const text = publishFailureText(state.failure);
      return (
        <Callout tone="negative" role="alert" title={text.title}>
          <span className="[overflow-wrap:anywhere]">{text.body}</span>
          <ReportedReason text={text.reported} />
          {text.offersNewSalt ? (
            <span className="mt-2 block">
              <Button onClick={onNewSalt}>Use a new salt</Button>
            </span>
          ) : null}
        </Callout>
      );
    }
    case "submitted":
      return (
        <Callout tone="info" role="status" title="Transaction submitted. Waiting for it to be mined.">
          {state.repriced ? "The wallet resent it with another fee. " : ""}
          Nothing is published until it is mined and read back. <TxLink chain={chain} hash={state.hash} />
        </Callout>
      );
    case "verifying":
      return (
        <Callout tone="info" role="status" title="Mined. Reading the version back from the registry.">
          The events of the receipt and the stored version are being compared with what was sent.{" "}
          <TxLink chain={chain} hash={state.hash} />
        </Callout>
      );
    case "unverified":
      return (
        <Callout tone="negative" role="alert" title="The transaction was mined, but the result is not confirmed.">
          <span className="[overflow-wrap:anywhere]">{state.reason}</span> Do not treat the index as published until
          this check passes. <TxLink chain={chain} hash={state.hash} />
          <span className="mt-2 block">
            <Button onClick={onRecheck}>Check the registry again</Button>
          </span>
        </Callout>
      );
    case "reverted":
      return (
        <Callout tone="negative" role="alert" title="The transaction was mined and reverted.">
          Nothing was published. The network fee was paid. The checks above are being run again.{" "}
          <TxLink chain={chain} hash={state.hash} />
        </Callout>
      );
    case "replaced":
      return (
        <Callout tone="warning" role="alert" title="Another transaction took the place of this one.">
          {state.reason === "cancelled" ? "It was cancelled in the wallet." : "The wallet sent a different one."}{" "}
          Nothing was published by this request. <TxLink chain={chain} hash={state.replacement} />
        </Callout>
      );
    case "dropped":
      return (
        <Callout tone="warning" role="alert" title="No receipt was found for the transaction.">
          It may still be mined later. Publishing again targets the same index id, so it cannot create a second index.{" "}
          <TxLink chain={chain} hash={state.hash} />
        </Callout>
      );
  }
}

/**
 * The publish step: everything `createIndex` will send, the preconditions with their real state, and the one
 * button that sends. The wallet is asked for a signature only from the click on that button.
 */
export function Review({ snapshot, chain, policy, presence, onBack, onNewSalt, onNewDraft }: ReviewProps) {
  const { valid, assets } = snapshot;
  const { salt } = snapshot.draft;
  const config = useConfig();
  const { address, chainId: walletChainId } = useConnection();
  const switchChain = useSwitchChain();
  const tx = useTransaction<PublishResult>();
  const [connecting, setConnecting] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState<Acknowledgement>(null);
  const account = address ?? null;
  const registry = policy.status === "available" ? policy.deployment.registry : null;

  const plan = useMemo(
    () =>
      account === null || registry === null
        ? null
        : buildPublishPlan({ valid, chainId: chain.id, registry, creator: account, salt }),
    [valid, chain.id, registry, account, salt],
  );
  const settled = ["verifying", "confirmed", "unverified"].includes(tx.state.status);
  const onChain = account !== null && walletChainId === chain.id;
  const preflight = usePreflight(plan, onChain && presence === "deployed" && !isTxInFlight(tx.state) && !settled);
  const { refetch } = preflight;
  // A transaction that left the mempool without publishing may have changed the state the checks were made on.
  const ended = tx.state.status === "reverted" || tx.state.status === "replaced" || tx.state.status === "dropped";
  useEffect(() => {
    if (ended) refetch();
  }, [ended, refetch]);

  const checklist = publishChecklist({
    valid,
    issueCount: 0,
    networkName: chain.name,
    chainId: chain.id,
    policy,
    presence,
    account,
    walletChainId: walletChainId ?? null,
    preflight: preflight.state,
  });
  // An attempt that ended without publishing withdraws the acknowledgement: the next attempt is a new decision.
  const withdrawn = acknowledgementEnds(tx.state);
  useEffect(() => {
    if (withdrawn) setAcknowledgement(null);
  }, [withdrawn]);
  // An acknowledgement holds for the plan it was given for only, so it lapses when the plan changes.
  const acknowledged = plan !== null && acknowledgement?.planKey === publishPlanKey(plan);
  const decision = buildPublishRequest({
    plan,
    policy,
    acknowledgement,
    walletChainId: walletChainId ?? null,
    checklist,
    busy: isTxInFlight(tx.state) || settled,
  });
  const simulation =
    typeof preflight.state === "object" && preflight.state?.status === "simulation_failed"
      ? preflight.state.failure
      : null;
  const identifier =
    typeof preflight.state === "object" && preflight.state !== null && "identifier" in preflight.state
      ? preflight.state.identifier
      : null;
  const unavailable = policy.status === "not_deployed" || presence === "no_code";

  /** Sends exactly the request `buildPublishRequest` returned. It is reachable only when that decision is `ok`. */
  function publish(request: PublishWriteRequest, sent: PublishPlan) {
    void tx.execute({
      chainId: request.chainId,
      abi: request.abi,
      send: () => writeContract(config, { ...request }),
      verify: (receipt) => verifyPublication(sent, receipt, registryChain(config, sent.chainId, sent.registry)),
    });
  }

  if (tx.state.status === "confirmed") {
    const { result, hash } = tx.state;
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-medium">
            <CheckIcon className="shrink-0" />
            Version {result.plan.version} is published and verified
          </h2>
          <p className="mt-2 max-w-measure text-md text-secondary">
            The transaction was mined, its events match what was sent, and the version read back from the registry
            passes every conformance check. It is permanent.
          </p>
        </div>
        <dl className="border-y text-base">
          <Fact term="Identifier">
            <Mono>{result.identifier}</Mono>
          </Fact>
          <Fact term="Index id">
            <Mono>{result.plan.indexId}</Mono>
          </Fact>
          <Fact term="Spec hash">
            <Mono>{result.plan.specHash}</Mono>
          </Fact>
          <Fact term="Network">
            {chain.name}, block <span className="num">{formatCount(result.blockNumber)}</span>
          </Fact>
          <Fact term="Transaction">
            <TxLink chain={chain} hash={hash} />
          </Fact>
        </dl>
        <ul aria-label="Conformance checks" className="flex flex-col gap-1">
          {result.report.checks.map(({ id, title, status }) => (
            <li key={id} className="flex items-start gap-2">
              <CheckIcon className="mt-0.5 shrink-0" />
              <span>
                <span className="font-medium">{id}</span> {title}: {status}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="lg" onClick={onNewDraft}>
            Start a new draft
          </Button>
          <Button size="lg" onClick={() => exportSpec(valid)}>
            <DownloadIcon />
            Export spec JSON
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        {isTxInFlight(tx.state) ? null : (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-sm text-accent hover:underline"
          >
            <ArrowLeftIcon />
            Back to the editor
          </button>
        )}
        <h2 className="mt-3 text-xl font-medium">Review and publish</h2>
        <p className="mt-2 max-w-measure text-md text-secondary">
          This is exactly what will be sent to the registry. Nothing is sent until you press the publish button and
          confirm in your wallet.
        </p>
      </div>

      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-7">
          <section aria-labelledby="review-call">
            <h3 id="review-call" className="text-lg font-medium">
              The call
            </h3>
            <dl className="mt-3 border-y text-base">
              <Fact term="Network">
                {chain.name} <span className="num text-secondary">(chain id {chain.id})</span>
              </Fact>
              <Fact term="Registry">
                {registry === null ? "Not deployed on this network" : <Mono>{registry}</Mono>}
              </Fact>
              <Fact term="Function">
                <Mono>createIndex(salt, spec, tokens, weightsBps)</Mono>
              </Fact>
              <Fact term="From">
                {account === null ? "Connect a wallet to set the creator" : <Mono>{account}</Mono>}
              </Fact>
              <Fact term="Salt">
                <Mono>{salt}</Mono>
              </Fact>
              <Fact term="Index id">
                {plan === null ? (
                  "Derived from the creator and the salt"
                ) : (
                  <>
                    <Mono>{plan.indexId}</Mono>
                    <span className="block text-sm text-secondary">
                      keccak256(abi.encode(creator, salt)), computed here
                    </span>
                  </>
                )}
              </Fact>
              <Fact term="Identifier">
                {identifier === null ? "Known once the registry has been read" : <Mono>{identifier}</Mono>}
              </Fact>
              <Fact term="Version">1</Fact>
              <Fact term="Spec hash">
                <Mono>{valid.specHash}</Mono>
              </Fact>
              <Fact term="Spec size">
                <span className="num">{formatCount(BigInt(valid.specBytes.length))} bytes</span>
              </Fact>
            </dl>
          </section>

          <section aria-label="Constituents sent to the registry" className="flex flex-col gap-3">
            <Table label="tokens and weightsBps" dense>
              <TableCaption>
                <span>tokens and weightsBps</span>
                <span className="text-sm font-normal text-secondary">in the order they are sent</span>
              </TableCaption>
              <TableHead>
                <TableRow>
                  <TableHeader>Asset</TableHeader>
                  <TableHeader numeric>Weight (bps)</TableHeader>
                  <TableHeader numeric>Weight</TableHeader>
                  <TableHeader>Token</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {valid.constituents.map(({ token, weightBps }) => (
                  <TableRow key={token}>
                    <TableRowHeader className="font-mono text-sm">
                      {assets.find(({ address }) => address === token)?.symbol ?? "Unknown"}
                    </TableRowHeader>
                    <TableCell numeric>{formatCount(BigInt(weightBps))}</TableCell>
                    <TableCell numeric>{formatPercent(BigInt(weightBps))}</TableCell>
                    <TableCell className="font-mono text-sm">{token}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ul className="flex flex-col gap-1 text-primary">
              {methodologyText(valid.spec, valid.constituents).map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="review-spec">
            <h3 id="review-spec" className="text-lg font-medium">
              spec: the bytes that are sent
            </h3>
            <p className="mt-1 mb-3 max-w-measure text-secondary">
              The canonical JSON below, as UTF-8, is the spec argument. The registry stores these bytes and hashes them
              itself.
            </p>
            <CanonicalJson text={plan?.canonicalText ?? new TextDecoder().decode(valid.specBytes)} />
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
          <section aria-labelledby="review-checks">
            <h3 id="review-checks" className="text-lg font-medium">
              Before publishing
            </h3>
            <ul className="mt-3 border-y" aria-label="Preconditions">
              {checklist.map((item) => (
                <ChecklistRow key={item.id} item={item} />
              ))}
            </ul>
            {onChain && presence === "deployed" && !settled && !isTxInFlight(tx.state) ? (
              <p className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-secondary">
                {preflight.checkedAt > 0 ? (
                  <span>Checked at {new Date(preflight.checkedAt).toISOString().slice(11, 19)} UTC.</span>
                ) : null}
                <button type="button" className="rounded-sm text-accent hover:underline" onClick={refetch}>
                  Check again
                </button>
              </p>
            ) : null}
          </section>

          {simulation !== null && tx.state.status !== "failed" ? (
            <Callout tone="negative" role="alert" title={publishFailureText(simulation).title}>
              <span className="[overflow-wrap:anywhere]">{publishFailureText(simulation).body}</span>
              <ReportedReason text={publishFailureText(simulation).reported} />
              {publishFailureText(simulation).offersNewSalt ? (
                <span className="mt-2 block">
                  <Button onClick={onNewSalt}>Use a new salt</Button>
                </span>
              ) : null}
            </Callout>
          ) : null}

          {unavailable ? (
            <Callout title={`Publishing is not available on ${chain.name}.`}>
              {policy.status === "not_deployed"
                ? "The registry is not deployed on this network."
                : "There is no contract at the registry address on this network."}{" "}
              The spec is valid and you can export it as a file.
              <span className="mt-2 block">
                <Button onClick={() => exportSpec(valid)}>
                  <DownloadIcon />
                  Export spec JSON
                </Button>
              </span>
            </Callout>
          ) : (
            <>
              <div className="flex flex-col gap-1 text-sm text-secondary">
                <p>Version 1 will be permanent. It cannot be edited or removed, and nothing published can be undone.</p>
                <p>You are publishing a methodology. You are not managing anyone's assets.</p>
              </div>
              {policy.status === "available" && policy.requiresAcknowledgement ? (
                <Checkbox
                  checked={acknowledged}
                  disabled={plan === null}
                  onChange={(event) =>
                    setAcknowledgement(event.target.checked && plan !== null ? { planKey: publishPlanKey(plan) } : null)
                  }
                  label={`I understand that this is a real transaction on ${chain.name} that costs gas and cannot be undone.`}
                />
              ) : null}
              {account === null ? (
                <Button variant="primary" size="lg" onClick={() => setConnecting(true)}>
                  Connect wallet to publish
                </Button>
              ) : !onChain ? (
                <Button
                  variant="primary"
                  size="lg"
                  loading={switchChain.isPending}
                  loadingLabel="Waiting for the wallet"
                  onClick={() => switchChain.mutate({ chainId: chain.id })}
                >
                  Switch wallet to {chain.name}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  disabled={!decision.ok}
                  loading={isTxInFlight(tx.state)}
                  loadingLabel={
                    tx.state.status === "awaiting_signature" ? "Waiting for the wallet" : "Publishing version 1"
                  }
                  onClick={decision.ok ? () => publish(decision.request, decision.plan) : undefined}
                >
                  Publish version 1
                  {policy.status === "available" && policy.requiresAcknowledgement ? ` on ${chain.name}` : ""}
                </Button>
              )}
              {switchChain.isError ? (
                <p role="alert" className="text-sm text-negative">
                  The wallet is still on another network. Select {chain.name} in the wallet itself.
                </p>
              ) : null}
            </>
          )}
          <TransactionStatus state={tx.state} chain={chain} onRecheck={() => void tx.recheck()} onNewSalt={onNewSalt} />
        </div>
      </div>
      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
    </div>
  );
}
