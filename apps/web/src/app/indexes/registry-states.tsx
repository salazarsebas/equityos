import { Callout } from "@/components/ui/callout";
import { Link } from "@/components/ui/link";
import { EmptyState } from "@/components/ui/state";
import { formatCount, formatUtcDateTime } from "@/lib/format";
import { chainName } from "@/lib/indexes/chains";
import { site } from "@/lib/site";
import { getRegistryReplay, LOCAL_CHAIN_ID, type RegistryNotDeployed } from "@/server/registry";

const METHODOLOGY_DOCUMENT = `${site.repositoryUrl}/blob/main/docs/architecture/methodology-spec.md`;

/**
 * The registry has no code on the configured network. This is a normal state of the service, not a failure
 * and not an empty registry, and the page says so plainly.
 */
export function RegistryNotDeployedState({ chainId, registry, reason }: RegistryNotDeployed) {
  const chain = chainName(chainId);
  return (
    <EmptyState
      title={`The index registry is not deployed on ${chain} yet`}
      action={
        <span className="flex flex-wrap gap-x-6 gap-y-1">
          <Link href={METHODOLOGY_DOCUMENT}>Read the methodology specification</Link>
          <Link href="/assets">Browse the asset universe</Link>
        </span>
      }
    >
      <p>
        Indexes are published to a registry contract. On this network ({chain}, chain id {chainId}) that contract{" "}
        {reason === "no_code" ? "has no code at its address" : "has not been deployed"}, so there is no index to list or
        to verify here. This is different from a registry that is deployed and holds no index.
      </p>
      <p className="mt-2">
        The address the registry will have is{" "}
        <span className="font-mono text-sm break-all text-primary">{registry}</span>. The format of a methodology and
        the checks that verify a published version are already specified and public.
      </p>
    </EmptyState>
  );
}

/**
 * States where the indexes on the page come from when it is not a live network: a recording replayed for
 * testing, or a local development chain. Nothing is rendered for a live network.
 */
export function RegistryNotice({ chainId }: { chainId: number }) {
  const replay = getRegistryReplay();
  if (replay !== null) {
    return (
      <Callout
        tone="warning"
        title={`Recorded example data, not a live network: a local chain (chain id ${chainId}) at block ${formatCount(replay.blockNumber)}, ${formatUtcDateTime(BigInt(replay.blockTimestamp))}, replayed for testing.`}
      />
    );
  }
  if (chainId !== LOCAL_CHAIN_ID) return null;
  return (
    <Callout
      title={`Example data from a local development chain (chain id ${chainId}), published by the seed script. It exists on no public network.`}
    />
  );
}
