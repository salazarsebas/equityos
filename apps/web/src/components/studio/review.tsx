"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { clickRefusalText, type FailureText, publishFailureText } from "@/lib/studio/messages";
import { describeMethodology } from "@/lib/indexes/methodology";
import { type ChecklistItem, publishChecklist, type RegistryPresence } from "@/lib/studio/preflight";
import {
  buildPublishPlan,
  buildVersionPlan,
  type NetworkPolicy,
  type PublishResult,
  type StudioPlan,
  verifyPublication,
} from "@/lib/studio/publish";
import {
  type Acknowledgement,
  acknowledgementEnds,
  buildPublishRequest,
  decideAtClick,
  type PublishDecisionInput,
  type PublishRefusal,
  type PublishWriteRequest,
  publishPlanKey,
} from "@/lib/studio/request";
import type { ReviewSnapshot } from "@/lib/studio/snapshot";
import { identifierAfter } from "@/lib/studio/version";
import { isTxInFlight, type TxState } from "@/lib/tx/machine";
import { useTransaction } from "@/lib/tx/use-transaction";
import { registryChain, usePreflight } from "./chain";
import { CanonicalJson, Changes, exportSpec } from "./preview";
import { ReloadButton } from "./version";

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
  /** A new version: back to the editor with the latest version loaded again as the base of the draft. */
  onReload: () => void;
};

/** The profile page of an index on this site. */
function indexPage(identifier: string): string {
  return `/indexes/${identifier}`;
}

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

/** A refusal in words, with the one way forward it offers: a new salt, or the latest version. */
function Failure({ text, onNewSalt, onReload }: { text: FailureText; onNewSalt: () => void; onReload: () => void }) {
  return (
    <Callout tone="negative" role="alert" title={text.title}>
      <span className="[overflow-wrap:anywhere]">{text.body}</span>
      <ReportedReason text={text.reported} />
      {text.offersNewSalt ? (
        <span className="mt-2 block">
          <Button onClick={onNewSalt}>Use a new salt</Button>
        </span>
      ) : null}
      {text.offersReload ? (
        <span className="mt-2 block">
          <ReloadButton onReload={onReload} loading={false} />
        </span>
      ) : null}
    </Callout>
  );
}

/** Where the transaction is, in words. The result of a publication is stated here and nowhere else. */
function TransactionStatus({
  state,
  chain,
  call,
  onRecheck,
  onNewSalt,
  onReload,
}: {
  state: TxState<PublishResult>;
  chain: Chain;
  /** `createIndex` or `publishVersion`. */
  call: string;
  onRecheck: () => void;
  onNewSalt: () => void;
  onReload: () => void;
}) {
  switch (state.status) {
    case "idle":
    case "confirmed":
      return null;
    case "awaiting_signature":
      return (
        <Callout tone="info" role="status" title="Confirm the transaction in your wallet.">
          Nothing has been sent. The wallet shows the same call: {call} on the registry.
        </Callout>
      );
    case "rejected":
      return (
        <Callout role="status" title="You declined the request in the wallet.">
          Nothing was sent and the draft is unchanged. You can publish whenever you are ready.
        </Callout>
      );
    case "failed":
      return <Failure text={publishFailureText(state.failure)} onNewSalt={onNewSalt} onReload={onReload} />;
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
          It may still be mined later.{" "}
          {call === "createIndex"
            ? "Publishing again targets the same index id, so it cannot create a second index."
            : "Publishing again sends the same expected version, so it cannot publish twice."}{" "}
          <TxLink chain={chain} hash={state.hash} />
        </Callout>
      );
  }
}

/**
 * The publish step: everything `createIndex` will send, the preconditions with their real state, and the one
 * button that sends. The wallet is asked for a signature only from the click on that button.
 */
export function Review({ snapshot, chain, policy, presence, onBack, onNewSalt, onNewDraft, onReload }: ReviewProps) {
  const { valid, assets, target } = snapshot;
  const { salt } = snapshot.draft;
  const config = useConfig();
  const { address, chainId: walletChainId } = useConnection();
  const switchChain = useSwitchChain();
  const tx = useTransaction<PublishResult>();
  const [connecting, setConnecting] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState<Acknowledgement>(null);
  /** A refusal of the decision made at the click, after the registry was read again. */
  const [refusal, setRefusal] = useState<PublishRefusal | null>(null);
  /** True from the click until the decision made at the click is known: a second click must not send. */
  const [deciding, setDeciding] = useState(false);
  const decidingNow = useRef(false);
  const account = address ?? null;
  const registry = policy.status === "available" ? policy.deployment.registry : null;

  const plan = useMemo((): StudioPlan | null => {
    if (account === null || registry === null) return null;
    return target === null
      ? buildPublishPlan({ valid, chainId: chain.id, registry, creator: account, salt })
      : buildVersionPlan({ valid, target, creator: account });
  }, [valid, chain.id, registry, account, salt, target]);
  const newVersion = target === null ? 1 : target.base.version + 1;
  const call = target === null ? "createIndex" : "publishVersion";
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
    newVersion: target === null ? null : newVersion,
  });
  // An attempt that ended without publishing withdraws the acknowledgement: the next attempt is a new decision.
  const withdrawn = acknowledgementEnds(tx.state);
  useEffect(() => {
    if (withdrawn) setAcknowledgement(null);
  }, [withdrawn]);
  // An acknowledgement holds for the plan it was given for only, so it lapses when the plan changes.
  const acknowledged = plan !== null && acknowledgement?.planKey === publishPlanKey(plan);
  const live = typeof preflight.state === "object" ? preflight.state : null;
  const decisionInput: PublishDecisionInput = {
    plan,
    policy,
    acknowledgement,
    walletChainId: walletChainId ?? null,
    checklist,
    busy: isTxInFlight(tx.state) || settled || deciding,
    index:
      live !== null &&
      (live.status === "ready" || live.status === "simulation_failed" || live.status === "base_mismatch")
        ? live.index
        : null,
  };
  const decision = buildPublishRequest(decisionInput);
  const simulation = live?.status === "simulation_failed" ? live.failure : null;
  const refused = refusal === null ? null : clickRefusalText(refusal);
  const identifier =
    typeof preflight.state === "object" && preflight.state !== null && "identifier" in preflight.state
      ? preflight.state.identifier
      : null;
  const unavailable = policy.status === "not_deployed" || presence === "no_code";

  /**
   * Decides again at the click, with the index read from the registry again for a new version, and sends
   * exactly the request that decision returned. It is reachable only when the decision of the review is `ok`.
   */
  async function publish() {
    if (decidingNow.current) return;
    decidingNow.current = true;
    setDeciding(true);
    setRefusal(null);
    try {
      const decided = await decideAtClick(decisionInput, (read) =>
        registryChain(config, read.chainId, read.registry).index(read.indexId),
      );
      if (!decided.ok) {
        setRefusal(decided.refusal);
        refetch();
        return;
      }
      send(decided.request, decided.plan);
    } finally {
      decidingNow.current = false;
      setDeciding(false);
    }
  }

  function send(request: PublishWriteRequest, sent: StudioPlan) {
    void tx.execute({
      chainId: request.chainId,
      abi: request.abi,
      send: () =>
        request.functionName === "createIndex"
          ? writeContract(config, { ...request })
          : writeContract(config, { ...request }),
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
            <Link href={indexPage(result.identifier)} className="font-mono text-sm break-all">
              {result.identifier}
            </Link>
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
        <p className="max-w-measure text-secondary">
          <Link href={indexPage(result.identifier)}>Open the index page</Link>.{" "}
          {target === null ? "The explorer lists the index" : `The index page shows version ${result.plan.version}`}{" "}
          once it has read the registry again, within ten seconds, when this site reads {chain.name}.
        </p>
        <div className="flex flex-wrap gap-2">
          {target === null ? (
            <Button size="lg" onClick={onNewDraft}>
              Start a new draft
            </Button>
          ) : (
            <Button size="lg" onClick={onReload}>
              Edit the next version
            </Button>
          )}
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
                <Mono>
                  {target === null
                    ? "createIndex(salt, spec, tokens, weightsBps)"
                    : "publishVersion(indexId, expectedVersion, spec, tokens, weightsBps)"}
                </Mono>
              </Fact>
              <Fact term="From">
                {account === null ? (
                  `Connect a wallet to set the ${target === null ? "creator" : "publisher"}`
                ) : (
                  <Mono>{account}</Mono>
                )}
              </Fact>
              {target === null ? (
                <Fact term="Salt">
                  <Mono>{salt}</Mono>
                </Fact>
              ) : (
                <Fact term="Creator">
                  <Mono>{target.creator}</Mono>
                  <span className="block text-sm text-secondary">
                    The only account the registry accepts this call from
                  </span>
                </Fact>
              )}
              <Fact term="Index id">
                {target !== null ? (
                  <Mono>{target.indexId}</Mono>
                ) : plan === null ? (
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
                {target !== null ? (
                  <>
                    <Mono>{identifier ?? identifierAfter(target, valid.spec.slug)}</Mono>
                    {valid.spec.slug === target.base.spec.slug ? null : (
                      <span className="block text-sm text-secondary">
                        The slug changes, so the canonical identifier changes from {target.identifier}
                      </span>
                    )}
                  </>
                ) : identifier === null ? (
                  "Known once the registry has been read"
                ) : (
                  <Mono>{identifier}</Mono>
                )}
              </Fact>
              <Fact term="Version">
                {target === null ? (
                  "1"
                ) : (
                  <>
                    <span className="num">{newVersion}</span>
                    <span className="block text-sm text-secondary">
                      expectedVersion: the registry is at version {target.base.version}, read again at the click
                    </span>
                  </>
                )}
              </Fact>
              <Fact term="Spec hash">
                <Mono>{valid.specHash}</Mono>
              </Fact>
              <Fact term="Spec size">
                <span className="num">{formatCount(BigInt(valid.specBytes.length))} bytes</span>
              </Fact>
            </dl>
          </section>

          {target === null ? null : (
            <section aria-labelledby="review-changes">
              <h3 id="review-changes" className="text-lg font-medium">
                Changes from version {target.base.version}
              </h3>
              <div className="mt-3">
                <Changes valid={valid} base={target.base} />
              </div>
            </section>
          )}

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
              {describeMethodology(valid.spec).map(({ rule, reading }) => (
                <li key={rule}>{reading}</li>
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

          {simulation !== null && tx.state.status !== "failed" && refused === null ? (
            <Failure text={publishFailureText(simulation)} onNewSalt={onNewSalt} onReload={onReload} />
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
                <p>
                  Version {newVersion} will be permanent. It cannot be edited or removed, and nothing published can be
                  undone.{target === null ? "" : " Earlier versions stay published and readable."}
                </p>
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
                  loading={isTxInFlight(tx.state) || deciding}
                  loadingLabel={
                    deciding
                      ? "Reading the registry again"
                      : tx.state.status === "awaiting_signature"
                        ? "Waiting for the wallet"
                        : `Publishing version ${newVersion}`
                  }
                  onClick={decision.ok ? () => void publish() : undefined}
                >
                  Publish version {newVersion}
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
          {refused === null ? null : <Failure text={refused} onNewSalt={onNewSalt} onReload={onReload} />}
          <TransactionStatus
            state={tx.state}
            chain={chain}
            call={call}
            onRecheck={() => void tx.recheck()}
            onNewSalt={onNewSalt}
            onReload={onReload}
          />
        </div>
      </div>
      <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
    </div>
  );
}
