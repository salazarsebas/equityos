import { marketPhaseAt } from "@equityos/core";
import type { Metadata } from "next";
import { oldestUpdate } from "@/app/assets/assets-table";
import { Container } from "@/components/shell/container";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, Input } from "@/components/ui/field";
import { SourceLine } from "@/components/ui/source-line";
import { formatCount, formatUtcDateTime } from "@/lib/format";
import { parseAddressLookup } from "@/lib/wallet/address";
import { getMarketData, listAssets, marketDataMode } from "@/server/market";
import { WalletSlot } from "./wallet-slot";
import type { WalletAsset } from "./wallet-view";

const description =
  "Balances of USDC and the index-eligible tokenized stocks held by an address on Base, valued at reference prices. Any address can be looked up without connecting a wallet.";

/** The page of one looked-up address is not a document of the site: it is kept out of search indexes. */
export async function generateMetadata({ searchParams }: PageProps<"/wallet">): Promise<Metadata> {
  const lookup = parseAddressLookup((await searchParams).address);
  return {
    title: "Wallet",
    description,
    alternates: { canonical: "/wallet" },
    ...(lookup.status === "none" ? {} : { robots: { index: false, follow: false } }),
  };
}

/** Rendered on every request, like the assets page: the reference prices are only as current as the read. */
export const revalidate = 0;

export default async function WalletPage({ searchParams }: PageProps<"/wallet">) {
  const lookup = parseAddressLookup((await searchParams).address);
  const snapshot = await getMarketData().getSnapshot();
  const eligible = listAssets(snapshot, true);
  const assets = eligible.map(
    ({ asset, referencePrice }): WalletAsset => ({
      address: asset.address,
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      priceE8: referencePrice !== null && referencePrice.status !== "unavailable" ? referencePrice.priceE8 : null,
    }),
  );
  const { onchain } = snapshot;

  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Wallet</h1>
      <p className="mt-2 max-w-measure text-md text-secondary">
        What an address holds on Base in USDC and the index-eligible assets, valued at reference prices. This page only
        reads: connect a wallet to see your own, or look up any address without connecting.
      </p>

      <form action="/wallet" method="get" className="mt-6 flex max-w-xl items-start gap-2">
        <Field
          label="Look up an address"
          className="min-w-0 flex-1"
          {...(lookup.status === "invalid"
            ? { error: "Not an address. Expected 0x followed by 40 hexadecimal characters, with a valid checksum." }
            : { hint: "Read-only. No wallet is needed." })}
        >
          {(control) => (
            <Input
              {...control}
              name="address"
              defaultValue={lookup.status === "ok" ? lookup.address : lookup.status === "invalid" ? lookup.input : ""}
              placeholder="0x"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          )}
        </Field>
        <Button type="submit" className="mt-6">
          Look up
        </Button>
      </form>

      <div className="mt-6 flex flex-col gap-3">
        {marketDataMode() === "replay" ? (
          <Callout tone="warning" title="This server shows recorded reference prices, not current ones.">
            The prices below were read at Base mainnet block {formatCount(onchain.blockNumber)} on{" "}
            {formatUtcDateTime(BigInt(onchain.blockTimestamp))} and are replayed for testing.
          </Callout>
        ) : null}
        {lookup.status === "invalid" ? null : (
          <WalletSlot
            lookup={lookup.status === "ok" ? lookup.address : null}
            assets={assets}
            marketClosed={marketPhaseAt(snapshot.observedAt) === "closed"}
            delayed={eligible.some(({ referencePrice }) => referencePrice?.status === "delayed")}
          />
        )}
        <SourceLine
          label="Reference prices"
          source={`Chainlink feeds, Base mainnet block ${formatCount(onchain.blockNumber)}`}
          asOfUnixSeconds={BigInt(oldestUpdate(eligible) ?? onchain.blockTimestamp)}
          note="oldest value shown"
          {...(onchain.servedStale ? { stale: "source not answering" } : {})}
        />
      </div>
    </Container>
  );
}
