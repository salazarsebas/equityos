"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAddressEqual } from "viem";
import { useConnection } from "wagmi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Link } from "@/components/ui/link";
import { WalletRuntime } from "@/components/wallet/runtime";
import { chainName } from "@/lib/indexes/chains";
import { parseAssetsResponse } from "@/lib/studio/assets";
import { type Draft, newDraft, randomSalt } from "@/lib/studio/draft";
import { evaluateDraft } from "@/lib/studio/evaluate";
import { networkPolicy } from "@/lib/studio/publish";
import { type ReviewSnapshot, takeReviewSnapshot, withSalt } from "@/lib/studio/snapshot";
import { type DraftStorage, discardDraft, loadDraft, saveDraft } from "@/lib/studio/storage";
import { draftFromSpec, identifierAfter, isUnchanged, type VersionTarget } from "@/lib/studio/version";
import { resolveNetworks } from "@/lib/wallet/chains";
import { useRegistryPresence } from "./chain";
import { type AssetsState, Editor } from "./editor";
import { Preview } from "./preview";
import { Review } from "./review";
import { OwnIndexes, ReloadButton, TargetState, useTargetLoad } from "./version";

/** `localStorage`, or `null` in a browser that refuses access to it. */
function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A new version of an existing index: the index, the draft it was loaded as, and the way to load it again. */
interface VersionMode {
  readonly target: VersionTarget;
  /** The draft the latest version describes. Read once, when the editor opens: a reload keeps the edits. */
  readonly initial: Draft;
  readonly onReload: () => void;
  readonly reloading: boolean;
  readonly reloadFailed: boolean;
}

/** The draft the latest version of a target describes, for "Discard changes". */
function latestDraft(target: VersionTarget, fallback: Draft): Draft {
  const loaded = draftFromSpec(target.base.spec, fallback.salt);
  return loaded.ok ? loaded.draft : fallback;
}

function StudioBody({ version }: { version: VersionMode | null }) {
  const [resolved] = useState(resolveNetworks);
  const [home, ...others] = resolved;
  const networks = useMemo(() => resolved.map(({ chain }) => chain), [resolved]);
  const [storage] = useState(browserStorage);
  const [{ draft, restored }, setState] = useState(() => {
    if (version !== null) return { draft: version.initial, restored: false };
    const chainIds = [home.chain.id, ...others.map(({ chain }) => chain.id)] as const;
    const stored = storage === null ? null : loadDraft(storage, chainIds, randomSalt);
    return { draft: stored?.draft ?? newDraft(home.chain.id, randomSalt()), restored: stored !== null };
  });
  const target = version?.target ?? null;
  /** The version the draft was first loaded from. A later base is a rebase, and the page says so. */
  const [loadedFrom] = useState(target?.base.version ?? null);
  const { address } = useConnection();
  const account = address ?? null;
  const [saved, setSaved] = useState<{ ok: boolean; at: number } | null>(null);
  /** Taken when the review opens. While it is set, the review shows it and nothing else of the draft. */
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const update = (change: (current: Draft) => Draft) =>
    setState((current) => ({ ...current, draft: change(current.draft) }));

  // The draft of a new index is written on every change. It never leaves the browser. A new version is not
  // stored: it starts from the latest version each time, and it must not replace the draft of a new index.
  useEffect(() => {
    if (target !== null) return;
    const at = Date.now();
    setSaved({ ok: storage !== null && saveDraft(storage, draft, at), at });
  }, [draft, storage, target]);

  const query = useQuery({
    queryKey: ["api", "v1", "assets"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/v1/assets", { signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`GET /api/v1/assets answered ${response.status}`);
      const parsed = parseAssetsResponse(await response.json());
      if (parsed === null) throw new Error("GET /api/v1/assets answered an unexpected body");
      return parsed;
    },
    staleTime: 60_000,
  });
  const assets: AssetsState = query.isSuccess
    ? { status: "ready", data: query.data }
    : query.isError
      ? { status: "error", retry: () => void query.refetch() }
      : { status: "loading" };
  const listed = query.data?.assets;

  // Constituents are validated against the feeds of the asset list, so a draft that has some waits for it.
  const evaluation = useMemo(
    () => (listed !== undefined || draft.tokens.length === 0 ? evaluateDraft(draft, listed ?? []) : null),
    [draft, listed],
  );
  // A new version goes to the chain of its index, never to another one: without a connection to it, there is
  // no chain to publish on.
  const found = networks.find(({ id }) => id === draft.chainId);
  const chain = found ?? home.chain;
  const unreachable = target !== null && found === undefined;
  const policy = unreachable ? ({ status: "not_deployed" } as const) : networkPolicy(chain.id);
  const presence = useRegistryPresence(chain.id, policy);
  // While reviewing, only the salt of the draft can change, so its chain is the chain of the snapshot.
  const review = snapshot === null ? null : { snapshot, chain, policy };
  const unchanged =
    target !== null && evaluation !== null && evaluation.valid !== null && isUnchanged(evaluation.valid, target.base);

  function toTop() {
    top.current?.scrollIntoView({ block: "start" });
  }

  function openReview() {
    if (listed === undefined && draft.tokens.length > 0) return;
    setSnapshot(takeReviewSnapshot(draft, listed ?? [], target));
    toTop();
  }

  /** Back to the editor, and the latest version loaded again as the base of the draft, which is kept. */
  function reload() {
    setSnapshot(null);
    version?.onReload();
    toTop();
  }

  function closeReview() {
    setSnapshot(null);
    toTop();
  }

  /** A new salt on an explicit click: stored with the draft, and applied to the snapshot under review. */
  function newSalt() {
    const salt = randomSalt();
    update((current) => ({ ...current, salt }));
    setSnapshot((current) => (current === null ? null : withSalt(current, salt)));
  }

  function startOver() {
    if (target !== null) {
      setState({ draft: latestDraft(target, draft), restored: false });
      setDiscarding(false);
      closeReview();
      return;
    }
    if (storage !== null) discardDraft(storage);
    setState({ draft: newDraft(chain.id, randomSalt()), restored: false });
    setDiscarding(false);
    closeReview();
  }

  const issues = evaluation?.issues ?? [];
  const wrong = issues.filter(({ incomplete }) => !incomplete).length;
  const blocker =
    evaluation === null
      ? "Waiting for the asset list"
      : wrong > 0
        ? `Fix ${wrong} ${wrong === 1 ? "issue" : "issues"}`
        : issues.length > 0
          ? `${issues.length} ${issues.length === 1 ? "step" : "steps"} to do`
          : unchanged
            ? `No change from version ${target.base.version}`
            : unreachable
              ? "Publishing is not available"
              : null;
  const notCreator = target !== null && account !== null && !isAddressEqual(account, target.creator);

  return (
    <div ref={top} className="scroll-mt-4">
      {review !== null ? (
        <Review
          snapshot={review.snapshot}
          chain={review.chain}
          policy={review.policy}
          presence={presence}
          onBack={closeReview}
          onNewSalt={newSalt}
          onNewDraft={startOver}
          onReload={reload}
        />
      ) : (
        <>
          {target === null ? (
            account === null ? null : (
              <div className="mb-8">
                <OwnIndexes account={account} />
              </div>
            )
          ) : (
            <div className="mb-8 flex flex-col gap-3">
              <p className="max-w-measure text-md">
                A new version of <Link href={`/indexes/${target.identifier}`}>{target.base.spec.name}</Link>, based on
                version {target.base.version}, its latest, verified in this browser. Earlier versions stay published.{" "}
                <Link href="/studio">Start a new index instead</Link>
              </p>
              {loadedFrom !== null && loadedFrom !== target.base.version ? (
                <Callout tone="info" role="status" title={`The draft is now based on version ${target.base.version}.`}>
                  It was loaded from version {loadedFrom}. Your edits are kept, and the changes are shown against
                  version {target.base.version}, the latest.
                </Callout>
              ) : null}
              {version?.reloading ? (
                <p role="status" className="text-sm text-secondary">
                  Loading the latest version.
                </p>
              ) : version?.reloadFailed ? (
                <Callout tone="negative" role="alert" title="The latest version could not be loaded.">
                  The draft and its base are unchanged.
                  <span className="mt-2 block">
                    <ReloadButton onReload={version.onReload} loading={false} />
                  </span>
                </Callout>
              ) : null}
              {notCreator ? (
                <Callout tone="warning" title="The connected account did not create this index.">
                  Only its creator, <span className="font-mono text-sm break-all">{target.creator}</span>, can publish a
                  new version, and the registry refuses any other account. You can still edit and export the spec.
                </Callout>
              ) : null}
            </div>
          )}
          <div className="grid gap-x-12 gap-y-8 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <Editor
                draft={draft}
                update={update}
                issues={issues}
                assets={assets}
                networks={networks.map(({ id, name }) => ({ chainId: id, name }))}
                version={
                  target === null
                    ? null
                    : {
                        network: chainName(target.chainId),
                        identifier: target.identifier,
                        identifierAfter: identifierAfter(target, draft.slug),
                      }
                }
              />
            </div>
            <aside aria-label="Preview" className="min-w-0 border-t pt-6 lg:col-span-5 lg:border-t-0 lg:pt-0">
              <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:pr-1">
                {unreachable ? (
                  <Callout title={`Publishing is not available on ${chainName(draft.chainId)}.`}>
                    This index is on chain {draft.chainId}, and this site has no connection to it. You can edit, compare
                    and export the spec.
                  </Callout>
                ) : policy.status === "not_deployed" || presence === "no_code" ? (
                  <Callout title={`Publishing is not available on ${chain.name}.`}>
                    {policy.status === "not_deployed"
                      ? "The registry is not deployed on this network."
                      : "There is no contract at the registry address on this network."}{" "}
                    You can draft, validate and export the spec.
                  </Callout>
                ) : null}
                <Preview
                  evaluation={evaluation}
                  assets={listed ?? []}
                  assetsFailed={query.isError}
                  base={target?.base ?? null}
                />
              </div>
            </aside>
          </div>

          <div className="sticky bottom-0 z-20 mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t bg-page py-3">
            <p className="text-sm text-secondary" role="status">
              {target !== null ? (
                `Edits to version ${target.base.version + 1} stay in this page. Reloading starts again from the latest version.`
              ) : saved === null ? (
                "Draft"
              ) : saved.ok ? (
                <>
                  {restored ? "Draft restored and saved" : "Draft saved"} in this browser
                  <span className="num max-sm:hidden"> at {new Date(saved.at).toISOString().slice(11, 19)} UTC</span>
                </>
              ) : (
                "This browser did not store the draft. It is lost when the page closes."
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => setDiscarding(true)}>
                {target === null ? "Discard draft" : "Discard changes"}
              </Button>
              <Button variant="primary" size="lg" disabled={blocker !== null} onClick={openReview}>
                {blocker ?? "Review and publish"}
              </Button>
            </div>
          </div>
        </>
      )}

      <Dialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        title={target === null ? "Discard this draft?" : "Discard your changes?"}
        footer={
          <>
            <Button onClick={() => setDiscarding(false)}>Keep the draft</Button>
            <Button variant="destructive" onClick={startOver}>
              {target === null ? "Discard draft" : "Discard changes"}
            </Button>
          </>
        }
      >
        <p>
          {target === null
            ? "The draft is removed from this browser and a new, empty one starts with a new salt."
            : `The editor goes back to version ${target.base.version} as published.`}{" "}
          Nothing that was published is affected.
        </p>
      </Dialog>
    </div>
  );
}

/** A new version of the index `identifier`: loaded, verified, then edited. Refused with the reason otherwise. */
function VersionStudio({ identifier }: { identifier: string }) {
  const query = useTargetLoad(identifier);
  // A failed reload keeps the last version that loaded, and with it the editor and the draft.
  const ready = query.data?.status === "ready" ? query.data : null;
  if (ready === null) return <TargetState identifier={identifier} query={query} />;
  return (
    <StudioBody
      version={{
        target: ready.target,
        initial: ready.draft,
        onReload: () => void query.refetch(),
        reloading: query.isFetching,
        reloadFailed: query.isError,
      }}
    />
  );
}

/**
 * The Studio region. It uses the wallet libraries and browser storage, so it is loaded in the browser only.
 * With `index`, the identifier of an existing index, it publishes a new version of that index.
 */
export function Studio({ index }: { index: string | null }) {
  return (
    <WalletRuntime>
      {index === null ? <StudioBody version={null} /> : <VersionStudio identifier={index} />}
    </WalletRuntime>
  );
}
