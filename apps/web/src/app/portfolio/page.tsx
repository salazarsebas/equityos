import type { Metadata } from "next";
import { Container } from "@/components/shell/container";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, Input, Select } from "@/components/ui/field";
import { Link } from "@/components/ui/link";
import { EmptyState } from "@/components/ui/state";
import { formatCount, formatUtcDateTime } from "@/lib/format";
import { parseAddressLookup } from "@/lib/wallet/address";
import { getMarketData, marketDataMode } from "@/server/market";
import { getRegistryReader, MAX_PAGE_SIZE } from "@/server/registry";
import { RegistryNotDeployedState, RegistryNotice } from "../indexes/registry-states";
import { PortfolioSlot } from "./portfolio-slot";

const description =
  "Compare the holdings of any address on Base with a published index version: current and target weights, drift in percentage points and a reference-price plan. Nothing is stored.";

/** A comparison of one address is not a document of the site: it is kept out of search indexes. */
export async function generateMetadata({ searchParams }: PageProps<"/portfolio">): Promise<Metadata> {
  const { address } = await searchParams;
  return {
    title: "Portfolio",
    description,
    alternates: { canonical: "/portfolio" },
    ...(address === undefined ? {} : { robots: { index: false, follow: false } }),
  };
}

/** Rendered on request: the list of indexes comes from the registry, behind its ten second cache. */
export const revalidate = 0;

function single(value: string | string[] | undefined): string {
  return (typeof value === "string" ? value : (value?.[0] ?? "")).trim();
}

/** The published indexes that can be compared with: the newest page, verified latest versions only. */
async function comparableIndexes() {
  const reader = getRegistryReader();
  const count = await reader.listIndexes({ limit: 1 });
  if (count.status !== "ok") return count;
  const offset = Math.max(0, count.total - MAX_PAGE_SIZE);
  const page = count.total === 0 ? count : await reader.listIndexes({ offset, limit: MAX_PAGE_SIZE });
  if (page.status !== "ok") return page;
  const options = page.indexes
    .flatMap(({ identifier, latest, head }) =>
      latest.conformant && head.deprecatedAt === null ? [{ identifier, name: latest.spec.name }] : [],
    )
    .reverse();
  return { status: "ok" as const, chainId: reader.chainId, options };
}

/** States that the balances and prices on the page are a recording and constructed test data. */
async function ReplayNotice() {
  if (marketDataMode() !== "replay") return null;
  const { onchain } = await getMarketData().getSnapshot();
  return (
    <Callout tone="warning" title="Balances on this server are constructed test data, valued at recorded prices.">
      The balances are not read from any chain. The reference prices were read at Base mainnet block{" "}
      {formatCount(onchain.blockNumber)} on {formatUtcDateTime(BigInt(onchain.blockTimestamp))} and are replayed for
      testing.
    </Callout>
  );
}

export default async function PortfolioPage({ searchParams }: PageProps<"/portfolio">) {
  const query = await searchParams;
  const lookup = parseAddressLookup(single(query.address));
  const index = single(query.index);
  const versionText = single(query.version);
  const version = /^[1-9][0-9]{0,9}$/.test(versionText) ? Number(versionText) : null;
  const indexes = await comparableIndexes();

  return (
    <Container className="flex flex-col gap-6 py-8 md:py-12">
      <header>
        <h1 className="text-xl font-medium">Portfolio</h1>
        <p className="mt-2 max-w-measure text-md text-secondary">
          How the holdings of an address on Base compare with a published index, weight by weight. Nothing is stored:
          the comparison is computed from the chain each time, and the address stays in the link.
        </p>
      </header>

      {indexes.status === "registry_not_deployed" ? (
        <RegistryNotDeployedState {...indexes} />
      ) : (
        <>
          <div className="flex flex-col gap-3 empty:hidden">
            <RegistryNotice chainId={indexes.chainId} />
            <ReplayNotice />
          </div>
          {indexes.options.length === 0 && index === "" ? (
            <EmptyState
              title="No index can be compared with yet"
              action={<Link href="/indexes">Open the explorer</Link>}
            >
              A comparison needs a published index whose latest version passes verification. None is published on this
              registry.
            </EmptyState>
          ) : (
            <form action="/portfolio" method="get" className="grid max-w-3xl gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <Field
                label="Index"
                hint={
                  <>
                    Verified latest versions. <Link href="/indexes">Browse every index</Link>
                  </>
                }
              >
                {(control) => (
                  <Select {...control} name="index" defaultValue={index} required>
                    <option value="" disabled>
                      Choose an index
                    </option>
                    {index !== "" && !indexes.options.some(({ identifier }) => identifier === index) ? (
                      <option value={index}>{index}</option>
                    ) : null}
                    {indexes.options.map(({ identifier, name }) => (
                      <option key={identifier} value={identifier}>
                        {name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label="Address"
                {...(lookup.status === "invalid"
                  ? { error: "Not an address: 0x followed by 40 hexadecimal characters, with a valid checksum." }
                  : { hint: "Any address on Base. Leave empty to use a connected wallet." })}
              >
                {(control) => (
                  <Input
                    {...control}
                    name="address"
                    defaultValue={
                      lookup.status === "ok" ? lookup.address : lookup.status === "invalid" ? lookup.input : ""
                    }
                    placeholder="0x"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                )}
              </Field>
              <Button type="submit" className="sm:mt-6">
                Compare
              </Button>
            </form>
          )}
          {lookup.status === "invalid" ? null : (
            <PortfolioSlot address={lookup.status === "ok" ? lookup.address : null} index={index} version={version} />
          )}
          <noscript>
            <Callout title="The comparison needs JavaScript.">
              The form above works without it. The same comparison is available as JSON from the public API:{" "}
              <Link
                href={
                  lookup.status === "ok" && index !== ""
                    ? `/api/v1/portfolio?${new URLSearchParams({ address: lookup.address, index })}`
                    : "/api/v1/openapi.json"
                }
              >
                GET /api/v1/portfolio
              </Link>
              .
            </Callout>
          </noscript>
        </>
      )}
    </Container>
  );
}
