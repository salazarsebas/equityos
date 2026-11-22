"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { WalletRuntime } from "@/components/wallet/runtime";
import { parseAssetsResponse } from "@/lib/studio/assets";
import { type Draft, newDraft, randomSalt } from "@/lib/studio/draft";
import { evaluateDraft } from "@/lib/studio/evaluate";
import { networkPolicy } from "@/lib/studio/publish";
import { type DraftStorage, discardDraft, loadDraft, saveDraft } from "@/lib/studio/storage";
import { resolveNetworks } from "@/lib/wallet/chains";
import { useRegistryPresence } from "./chain";
import { type AssetsState, Editor } from "./editor";
import { Preview } from "./preview";
import { Review } from "./review";

/** `localStorage`, or `null` in a browser that refuses access to it. */
function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function StudioBody() {
  const [resolved] = useState(resolveNetworks);
  const [home, ...others] = resolved;
  const networks = useMemo(() => resolved.map(({ chain }) => chain), [resolved]);
  const [storage] = useState(browserStorage);
  const [{ draft, restored }, setState] = useState(() => {
    const chainIds = [home.chain.id, ...others.map(({ chain }) => chain.id)] as const;
    const stored = storage === null ? null : loadDraft(storage, chainIds, randomSalt);
    return { draft: stored?.draft ?? newDraft(home.chain.id, randomSalt()), restored: stored !== null };
  });
  const [saved, setSaved] = useState<{ ok: boolean; at: number } | null>(null);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [discarding, setDiscarding] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const update = (change: (current: Draft) => Draft) =>
    setState((current) => ({ ...current, draft: change(current.draft) }));

  // The draft is written on every change. It never leaves the browser.
  useEffect(() => {
    const at = Date.now();
    setSaved({ ok: storage !== null && saveDraft(storage, draft, at), at });
  }, [draft, storage]);

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
  const chain = networks.find(({ id }) => id === draft.chainId) ?? home.chain;
  const policy = networkPolicy(chain.id);
  const presence = useRegistryPresence(chain.id, policy);
  const valid = evaluation?.valid ?? null;
  const reviewing = step === "review" && valid !== null;

  function go(next: "edit" | "review") {
    setStep(next);
    top.current?.scrollIntoView({ block: "start" });
  }

  function startOver() {
    if (storage !== null) discardDraft(storage);
    setState({ draft: newDraft(chain.id, randomSalt()), restored: false });
    setDiscarding(false);
    go("edit");
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
          : null;

  return (
    <div ref={top} className="scroll-mt-4">
      {reviewing ? (
        <Review
          valid={valid}
          salt={draft.salt}
          chain={chain}
          policy={policy}
          presence={presence}
          assets={listed ?? []}
          onBack={() => go("edit")}
          onNewSalt={() => update((current) => ({ ...current, salt: randomSalt() }))}
          onNewDraft={startOver}
        />
      ) : (
        <>
          <div className="grid gap-x-12 gap-y-8 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <Editor
                draft={draft}
                update={update}
                issues={issues}
                assets={assets}
                networks={networks.map(({ id, name }) => ({ chainId: id, name }))}
              />
            </div>
            <aside aria-label="Preview" className="min-w-0 border-t pt-6 lg:col-span-5 lg:border-t-0 lg:pt-0">
              <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:pr-1">
                {policy.status === "not_deployed" || presence === "no_code" ? (
                  <Callout title={`Publishing is not available on ${chain.name}.`}>
                    {policy.status === "not_deployed"
                      ? "The registry is not deployed on this network."
                      : "There is no contract at the registry address on this network."}{" "}
                    You can draft, validate and export the spec.
                  </Callout>
                ) : null}
                <Preview evaluation={evaluation} assets={listed ?? []} assetsFailed={query.isError} />
              </div>
            </aside>
          </div>

          <div className="sticky bottom-0 z-20 mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t bg-page py-3">
            <p className="text-sm text-secondary" role="status">
              {saved === null ? (
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
                Discard draft
              </Button>
              <Button variant="primary" size="lg" disabled={blocker !== null} onClick={() => go("review")}>
                {blocker ?? "Review and publish"}
              </Button>
            </div>
          </div>
        </>
      )}

      <Dialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        title="Discard this draft?"
        footer={
          <>
            <Button onClick={() => setDiscarding(false)}>Keep the draft</Button>
            <Button variant="destructive" onClick={startOver}>
              Discard draft
            </Button>
          </>
        }
      >
        <p>
          The draft is removed from this browser and a new, empty one starts with a new salt. Nothing that was published
          is affected.
        </p>
      </Dialog>
    </div>
  );
}

/** The Studio region. It uses the wallet libraries and browser storage, so it is loaded in the browser only. */
export function Studio() {
  return (
    <WalletRuntime>
      <StudioBody />
    </WalletRuntime>
  );
}
