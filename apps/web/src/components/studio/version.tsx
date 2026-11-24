"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { type Address, type Hex, isAddressEqual } from "viem";
import { useConfig } from "wagmi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/lib/format";
import { chainName } from "@/lib/indexes/chains";
import { CHECK_MEANINGS } from "@/lib/indexes/checks";
import { randomSalt } from "@/lib/studio/draft";
import { networkPolicy } from "@/lib/studio/publish";
import {
  type IndexHead,
  indexesOf,
  type ListedIndex,
  loadTarget,
  parseIndexPage,
  parseIndexResponse,
  parseVersionResponse,
  type StoredVersion,
  type TargetLoad,
} from "@/lib/studio/version";
import { resolveNetworks } from "@/lib/wallet/chains";
import { registryChain } from "./chain";

type Loaded = TargetLoad | { readonly status: "not_found" } | { readonly status: "registry_not_deployed" };

async function getJson(url: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  // The API answers with a ten second cache. The base of a new version must be the version of now.
  const response = await fetch(url, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Loads the latest version of an index for editing. The API resolves the identifier. The index and its latest
 * version are then read from the registry itself where this browser can read the chain the index is on, and
 * from the API otherwise. Either way the bytes are verified here, by `loadTarget`, before anything uses them.
 */
export function useTargetLoad(identifier: string) {
  const config = useConfig();
  // Once known, the index id is what is loaded again: a version with another slug changes the identifier.
  const resolved = useRef<Hex | null>(null);
  const query = useQuery({
    queryKey: ["studio", "target", identifier],
    queryFn: async ({ signal }): Promise<Loaded> => {
      const path = `/api/v1/indexes/${encodeURIComponent(resolved.current ?? identifier)}`;
      const index = await getJson(path, signal);
      if (index.status === 400 || index.status === 404) return { status: "not_found" };
      if (index.status === 409) return { status: "registry_not_deployed" };
      const listed = index.status === 200 ? parseIndexResponse(index.body) : null;
      if (listed === null) throw new Error(`GET ${path} answered ${index.status}`);
      resolved.current = listed.indexId;
      const policy = networkPolicy(listed.chainId);
      const readable =
        resolveNetworks().some(({ chain }) => chain.id === listed.chainId) &&
        policy.status === "available" &&
        isAddressEqual(policy.deployment.registry, listed.registry);
      let head: IndexHead = listed;
      let stored: StoredVersion | null;
      if (readable) {
        const reads = registryChain(config, listed.chainId, listed.registry);
        head = { ...listed, ...(await reads.index(listed.indexId)) };
        const onchain = await reads.version(head.indexId, head.latestVersion);
        const { spec: specHex, specHash, constituents } = onchain;
        stored = { version: head.latestVersion, specHex, specHash, constituents };
      } else {
        const version = await getJson(`/api/v1/indexes/${listed.indexId}/versions/${listed.latestVersion}`, signal);
        stored = version.status === 200 ? parseVersionResponse(version.body) : null;
        if (stored?.version !== listed.latestVersion) throw new Error(`the latest version answered ${version.status}`);
      }
      return loadTarget(head, stored, randomSalt());
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnReconnect: false,
  });
  return query;
}

/** What the Studio shows when an index cannot be edited, or while it loads. `null` when it is ready. */
export function TargetState({ identifier, query }: { identifier: string; query: ReturnType<typeof useTargetLoad> }) {
  const profile = (text: string) => <Link href={`/indexes/${identifier}`}>{text}</Link>;
  if (query.isError) {
    return (
      <Callout tone="negative" role="alert" title={`The index ${identifier} could not be loaded.`}>
        Nothing was changed.{" "}
        <button type="button" className="font-medium text-accent underline" onClick={() => void query.refetch()}>
          Load it again
        </button>
      </Callout>
    );
  }
  if (!query.isSuccess) {
    return (
      <div aria-busy="true" className="flex flex-col gap-4">
        <p className="text-secondary" role="status">
          Loading the latest version of {identifier} and verifying it in this browser.
        </p>
        <Skeleton className="h-64" />
      </div>
    );
  }
  const loaded = query.data;
  const start = <Link href="/studio">Start a new index instead</Link>;
  switch (loaded.status) {
    case "ready":
      return null;
    case "not_found":
      return (
        <Callout tone="negative" role="alert" title={`No index has the identifier ${identifier}.`}>
          The site reads the registry again every ten seconds, so an index created just now appears shortly.{" "}
          <button type="button" className="font-medium text-accent underline" onClick={() => void query.refetch()}>
            Look again
          </button>{" "}
          or <Link href="/studio">start a new index instead</Link>.
        </Callout>
      );
    case "registry_not_deployed":
      return (
        <Callout role="alert" title="The index registry is not deployed on the network this site reads.">
          There is no published index to edit. {start}.
        </Callout>
      );
    case "deprecated":
      return (
        <Callout tone="warning" role="alert" title="This index is deprecated. No new version can be published.">
          Its creator deprecated it, which cannot be undone. Every published version stays readable:{" "}
          {profile("open the index page")}.
        </Callout>
      );
    case "not_conformant": {
      const { check, head } = loaded;
      return (
        <Callout
          tone="negative"
          role="alert"
          title={`Version ${head.latestVersion} fails check ${check.id}, ${CHECK_MEANINGS[check.id].name.toLowerCase()}, so it cannot be edited.`}
        >
          The verifier reports: {check.reason}. Nothing may be computed from a version that fails verification, and a
          draft prefilled from it would be. {profile("See the full report on the index page")}.
        </Callout>
      );
    }
    case "not_editable":
      return (
        <Callout role="alert" title={`Version ${loaded.head.latestVersion} cannot be opened in the Studio.`}>
          {loaded.reason} Editing it here would change it without showing that. {profile("Open the index page")}.
        </Callout>
      );
  }
}

/** Pages of the index list read to find the indexes of an account: 1,000 indexes at 50 per page. */
const MAX_PAGES = 20;

/** The indexes the connected account created, from the list of the API, each opening a new version. */
export function OwnIndexes({ account }: { account: Address }) {
  const query = useQuery({
    queryKey: ["studio", "own-indexes", account.toLowerCase()],
    queryFn: async ({ signal }) => {
      const found: ListedIndex[] = [];
      let offset: number | null = 0;
      let chainId = 0;
      for (let page = 0; page < MAX_PAGES && offset !== null; page += 1) {
        const response = await getJson(`/api/v1/indexes?offset=${offset}&limit=50`, signal);
        if (response.status === 409) return null;
        const parsed = response.status === 200 ? parseIndexPage(response.body) : null;
        if (parsed === null) throw new Error(`GET /api/v1/indexes answered ${response.status}`);
        found.push(...indexesOf(parsed.indexes, account));
        ({ nextOffset: offset, chainId } = parsed);
      }
      return { indexes: found, chainId, complete: offset === null };
    },
    retry: false,
    staleTime: 10_000,
  });
  if (query.isPending || query.data === null) return null;
  if (query.isError) {
    return (
      <p className="text-sm text-secondary" role="status">
        The indexes of this account could not be listed.{" "}
        <button type="button" className="text-accent underline" onClick={() => void query.refetch()}>
          List them again
        </button>
      </p>
    );
  }
  const { indexes, chainId, complete } = query.data;
  return (
    <section aria-labelledby="own-indexes" className="border-b pb-6">
      <h2 id="own-indexes" className="text-lg font-medium">
        Your indexes on {chainName(chainId)}
      </h2>
      {indexes.length === 0 ? (
        <p className="mt-1 text-secondary">The connected account has not created an index in this registry.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {indexes.map(({ identifier, name, latestVersion, deprecated }) => (
            <li key={identifier} className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-medium">{name ?? "Unverified index"}</span>
              <span className="font-mono text-sm text-secondary">{identifier}</span>
              <span className="num text-sm text-secondary">v{formatCount(BigInt(latestVersion))}</span>
              {deprecated ? (
                <span className="text-sm text-secondary">Deprecated, no new version possible</span>
              ) : (
                <Link href={`/studio?index=${identifier}`} className="text-sm">
                  Publish a new version of {name ?? identifier}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      {complete ? null : (
        <p className="mt-2 text-sm text-secondary">
          Only the first {formatCount(BigInt(MAX_PAGES * 50))} indexes of the registry were searched.
        </p>
      )}
    </section>
  );
}

export function ReloadButton({ onReload, loading }: { onReload: () => void; loading: boolean }) {
  return (
    <Button onClick={onReload} loading={loading} loadingLabel="Loading the latest version">
      Load the latest version
    </Button>
  );
}
