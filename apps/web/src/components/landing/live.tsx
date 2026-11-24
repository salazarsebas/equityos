import { BASE_MAINNET_CHAIN_ID, INDEX_REGISTRY_ADDRESS } from "@equityos/contracts-abi";
import type { MarketPhase } from "@equityos/core";
import { Callout } from "@/components/ui/callout";
import { Link } from "@/components/ui/link";
import { SourceLine } from "@/components/ui/source-line";
import { Stat, StatGrid } from "@/components/ui/stat";
import { formatCount, formatUtcDate, formatUtcDateTime } from "@/lib/format";
import { chainName } from "@/lib/indexes/chains";
import { verificationCommands } from "@/lib/indexes/commands";
import { site } from "@/lib/site";
import type { Registry, Universe } from "@/server/landing";
import { Code, Section, Step } from "./parts";
import { METHODOLOGY_SPEC_URL } from "./sections";

const PHASES: Record<MarketPhase | "unknown", string> = {
  regular: "Open",
  extended: "Extended hours",
  closed: "Closed",
  unknown: "Not covered",
};

/** The version the verification commands are written for, or why there is none. */
function commandTarget(registry: Registry) {
  if (registry.status === "deployed" && registry.newest !== null) {
    const { newest } = registry;
    return {
      chainId: registry.chainId,
      registry: newest.latest.registry,
      indexId: newest.latest.indexId,
      version: newest.latest.version,
      name: newest.latest.spec?.name ?? null,
      identifier: newest.identifier,
    };
  }
  return null;
}

export function Verify({ registry }: { registry: Registry }) {
  const target = commandTarget(registry);
  const [read, hash, api] = verificationCommands({
    chainId: target?.chainId ?? (registry.status === "unavailable" ? BASE_MAINNET_CHAIN_ID : registry.chainId),
    registry: target?.registry ?? INDEX_REGISTRY_ADDRESS,
    indexId: target?.indexId ?? "$INDEX_ID",
    version: target?.version ?? "$VERSION",
    siteUrl: site.url,
  });
  return (
    <Section
      id="verify"
      title="Verify it yourself"
      lead="You do not have to trust this site. Three commands check a published version against the chain."
    >
      <p className="max-w-measure text-base text-secondary">
        {target === null ? (
          <>
            No index is published on the network this site reads yet, so there is no index id to fill in. Once there is,
            set <code className="font-mono text-sm">INDEX_ID</code> and{" "}
            <code className="font-mono text-sm">VERSION</code> and run the commands as they are.
          </>
        ) : (
          <>
            Written for version {target.version} of{" "}
            <Link href={`/indexes/${target.identifier}`}>{target.name ?? "the newest index"}</Link>, the newest index in
            the registry this site reads ({chainName(target.chainId)}, chain id {target.chainId}).{" "}
            <code className="font-mono text-sm">cast</code> is the command line client of Foundry.
          </>
        )}
      </p>
      <ol className="mt-6 flex flex-col gap-6">
        {read ? (
          <Step number={1} title="Read the bytes from the registry">
            <p>Prints the spec exactly as the registry stores it, as hexadecimal.</p>
            <Code>{read.command}</Code>
          </Step>
        ) : null}
        {hash ? (
          <Step number={2} title="Hash them">
            <p>Prints the keccak256 of those bytes.</p>
            <Code>{hash.command}</Code>
          </Step>
        ) : null}
        {api ? (
          <Step number={3} title="Compare">
            <p>The hash must equal the spec hash the registry recorded, shown on the index page and returned here:</p>
            <Code>{api.command}</Code>
          </Step>
        ) : null}
      </ol>
      <p className="mt-6 max-w-measure text-base text-secondary">
        The weights are not taken on trust either. The calculator in @equityos/core is open source and has no network,
        clock or randomness: given the spec, it returns the weights the registry must store.{" "}
        <Link href={METHODOLOGY_SPEC_URL}>How a version is verified</Link>
      </p>
    </Section>
  );
}

function UniverseStats({ universe }: { universe: Universe }) {
  if (universe.status === "unavailable") {
    return (
      <Callout tone="warning" title="The asset universe cannot be read right now.">
        The asset list or Base mainnet did not answer, so no count is shown.{" "}
        <Link href="/assets">Try the assets page</Link>
      </Callout>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <StatGrid columns={4}>
        <Stat label="Tokenized stocks listed" value={formatCount(BigInt(universe.listed))} />
        <Stat label="Minted onchain" value={formatCount(BigInt(universe.minted))} />
        <Stat label="Index-eligible" value={formatCount(BigInt(universe.eligible))} />
        <Stat label="US equity market" value={PHASES[universe.phase]} />
      </StatGrid>
      <SourceLine
        label="Listing and token state"
        source={`Coinbase tokenized stocks API and Base mainnet block ${formatCount(universe.blockNumber)}; eligibility also needs a Chainlink reference feed`}
        asOfUnixSeconds={BigInt(universe.blockTimestamp)}
        {...(universe.servedStale ? { stale: "source not answering" } : {})}
      />
      <SourceLine
        label="Market phase"
        source="US market calendar of @equityos/core"
        asOfUnixSeconds={BigInt(universe.observedAt)}
      />
    </div>
  );
}

function RegistryState({ registry }: { registry: Registry }) {
  if (registry.status === "unavailable") {
    return (
      <Callout tone="warning" title="The index registry cannot be read right now.">
        Its state is not shown rather than guessed. <Link href="/indexes">Try the index explorer</Link>
      </Callout>
    );
  }
  const chain = chainName(registry.chainId);
  if (registry.status === "not_deployed") {
    return (
      <div className="flex flex-col gap-3">
        <p className="border-t pt-3 text-md">
          The index registry is not deployed on {chain} yet, so no index is published there.
        </p>
        <p className="text-base text-secondary">
          Its address will be <span className="font-mono text-sm break-all text-primary">{registry.address}</span>.
        </p>
        <SourceLine
          label="Registry"
          source={
            registry.reason === "no_code"
              ? `code at the address on ${chain} (chain id ${registry.chainId})`
              : `deployment map of @equityos/contracts-abi for ${chain} (chain id ${registry.chainId})`
          }
          asOfUnixSeconds={BigInt(registry.readAt)}
        />
      </div>
    );
  }
  const { newest } = registry;
  return (
    <div className="flex flex-col gap-3">
      <StatGrid columns={4}>
        <Stat label="Published indexes" value={formatCount(BigInt(registry.total))} />
        <Stat
          label="Newest index"
          value={newest === null ? "None yet" : (newest.latest.spec?.name ?? "Fails verification")}
        />
        <Stat
          label="Newest publication"
          value={newest === null ? "None yet" : formatUtcDate(newest.latest.publishedAt)}
        />
        <Stat label="Chain id" value={String(registry.chainId)} />
      </StatGrid>
      <SourceLine
        label="Registry"
        source={`IndexRegistry ${registry.address} on ${chain} (chain id ${registry.chainId})`}
        asOfUnixSeconds={BigInt(registry.readAt)}
      />
      <p className="text-base">
        <Link href="/indexes">Explore indexes</Link>
      </p>
    </div>
  );
}

export function LiveData({ universe, registry }: { universe: Universe; registry: Registry }) {
  const replay =
    (universe.status === "ok" && universe.replay) || (registry.status === "deployed" && registry.replay !== null);
  return (
    <Section
      id="live"
      title="Current state, with its sources"
      lead="Counted when this page is rendered. Each figure names where it was read and when."
    >
      <div className="flex flex-col gap-10">
        {replay ? (
          <Callout tone="warning" title="This server shows recorded data, not current data.">
            {universe.status === "ok" && universe.replay
              ? `The asset universe was read at Base mainnet block ${formatCount(universe.blockNumber)} on ${formatUtcDateTime(BigInt(universe.blockTimestamp))} and is replayed for testing. `
              : ""}
            {registry.status === "deployed" && registry.replay !== null
              ? `The registry is a local development chain at block ${formatCount(registry.replay.blockNumber)}, replayed for testing.`
              : ""}
          </Callout>
        ) : null}
        <div>
          <h3 className="mb-3 text-md font-medium">Asset universe on Base</h3>
          <UniverseStats universe={universe} />
        </div>
        <div>
          <h3 className="mb-3 text-md font-medium">Index registry</h3>
          <RegistryState registry={registry} />
        </div>
      </div>
    </Section>
  );
}
