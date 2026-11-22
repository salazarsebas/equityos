"use client";

import { type ReactNode, useState } from "react";
import type { Address } from "viem";
import { useConnection } from "wagmi";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Link } from "@/components/ui/link";
import { EmptyState, ErrorState } from "@/components/ui/state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFoot,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@/components/ui/table";
import { StatusTag } from "@/components/ui/tag";
import { ConnectDialog } from "@/components/wallet/connect-dialog";
import { useTokenBalances, useWalletCapabilities } from "@/components/wallet/hooks";
import { WalletRuntime } from "@/components/wallet/runtime";
import { formatCount, formatPrice, formatTokenQuantity, formatUsd, formatUtcDateTime, MISSING } from "@/lib/format";
import {
  isUsdc,
  summarizeBalances,
  type TokenRef,
  USD_E8_DECIMALS,
  type USDC,
  type ValuedBalance,
} from "@/lib/wallet/balances";
import { describeBatching } from "@/lib/wallet/capabilities";
import { addressExplorer, HOME_CHAIN } from "@/lib/wallet/chains";

/** An index-eligible asset as the server read it: what the table needs to list and value a balance of it. */
export interface WalletAsset extends TokenRef {
  readonly name: string;
  /** Reference price in USD per whole token, scaled by 1e8. `null` when the asset has no usable one. */
  readonly priceE8: bigint | null;
}

type Tracked = WalletAsset | typeof USDC;

function Missing() {
  return <span className="text-tertiary">{MISSING}</span>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-1 border-t py-3 first:border-t-0 sm:grid-cols-[10rem_1fr]">
      <dt className="text-secondary">{term}</dt>
      <dd className="min-w-0 text-primary">{children}</dd>
    </div>
  );
}

/** The connected wallet, or the address of a read-only lookup. */
function AccountFacts({ account, lookup }: { account: Address; lookup: boolean }) {
  const { chain, chainId, connector } = useConnection();
  const batching = describeBatching(useWalletCapabilities());
  const explorer = addressExplorer(lookup ? HOME_CHAIN : chain, account);
  return (
    <dl className="border-y text-base">
      <Fact term="Address">
        <span className="font-mono text-sm break-all">{account}</span>{" "}
        <Link href={explorer.url} className="text-sm whitespace-nowrap">
          View on {explorer.name}
        </Link>
      </Fact>
      {lookup ? (
        <Fact term="Access">
          Read-only lookup. This page reads public balances of the address and is not connected to it.{" "}
          <Link href="/wallet">Clear the lookup</Link>
        </Fact>
      ) : (
        <>
          <Fact term="Wallet">{connector?.name ?? "Unknown"}</Fact>
          <Fact term="Network">
            {chain?.name ?? `Unsupported (chain ${chainId}). Use the account control in the top bar to switch to Base.`}
          </Fact>
          <Fact term="Confirmations">
            <span className="font-medium">{batching.label}</span>
            <span className="mt-1 block max-w-measure text-secondary">{batching.meaning}</span>
          </Fact>
        </>
      )}
    </dl>
  );
}

function BalanceRow({ row, muted = false }: { row: ValuedBalance<Tracked>; muted?: boolean }) {
  const { token, balance, priceE8, valueE8 } = row;
  return (
    <TableRow className={muted ? "text-secondary" : undefined}>
      <TableRowHeader className="font-mono text-sm">{token.symbol}</TableRowHeader>
      <TableCell className="max-w-36 truncate text-secondary md:max-w-none" title={token.name}>
        {token.name}
      </TableCell>
      <TableCell numeric>{balance === null ? <Missing /> : formatTokenQuantity(balance, token.decimals)}</TableCell>
      <TableCell numeric>
        {isUsdc(token) ? <span className="mr-2 text-xs text-secondary">assumed</span> : null}
        {priceE8 === null ? <Missing /> : formatPrice(priceE8, USD_E8_DECIMALS)}
      </TableCell>
      <TableCell numeric>{valueE8 === null ? <Missing /> : formatUsd(valueE8, USD_E8_DECIMALS)}</TableCell>
    </TableRow>
  );
}

type BalancesProps = {
  account: Address;
  assets: readonly WalletAsset[];
  marketClosed: boolean;
  delayed: boolean;
};

/** Balances of the account on Base mainnet, valued at reference prices. Zero balances are behind a control. */
function Balances({ account, assets, marketClosed, delayed }: BalancesProps) {
  const state = useTokenBalances({ account, tokens: assets });
  const [showEmpty, setShowEmpty] = useState(false);

  if (state.status === "idle" || state.status === "loading") {
    return (
      <p aria-busy="true" className="rounded-lg border bg-surface px-4 py-6 text-secondary">
        Reading balances from Base mainnet
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <ErrorState title="The balances could not be read" action={<Button onClick={state.refetch}>Try again</Button>}>
        The Base mainnet endpoint did not answer. This page only reads, so the address and its assets are not affected.
        Try again in a moment.
      </ErrorState>
    );
  }

  const { held, empty, totalE8, unvalued } = summarizeBalances(state.balances, (token) =>
    "priceE8" in token ? token.priceE8 : null,
  );
  const readAt = formatUtcDateTime(BigInt(state.readAt));
  return (
    <>
      {state.refreshFailed ? (
        <Callout tone="warning" role="status" title="The balances could not be refreshed.">
          These are the balances read at {readAt}. Newer ones may exist that this page does not show.
        </Callout>
      ) : null}
      <Table label="Balances on Base">
        <TableCaption>
          <span>Balances on Base</span>
          <StatusTag status="Reference" />
          {marketClosed ? <StatusTag status="Market closed" /> : null}
          {delayed ? <StatusTag status="Delayed" /> : null}
        </TableCaption>
        <TableHead>
          <TableRow>
            <TableHeader>Asset</TableHeader>
            <TableHeader>Name</TableHeader>
            <TableHeader numeric>Balance (tokens)</TableHeader>
            <TableHeader numeric>Reference price (USD)</TableHeader>
            <TableHeader numeric>Value (USD)</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {held.map((row) => (
            <BalanceRow key={row.token.address} row={row} />
          ))}
          {held.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-secondary">
                This address holds no USDC and none of the index-eligible assets.
              </TableCell>
            </TableRow>
          ) : null}
          {showEmpty ? empty.map((row) => <BalanceRow key={row.token.address} row={row} muted />) : null}
        </TableBody>
        {totalE8 === null ? null : (
          <TableFoot>
            <TableRow>
              <TableRowHeader>Total</TableRowHeader>
              <TableCell colSpan={3} className="font-normal text-secondary">
                USDC at an assumed 1.00 USD, the rest at reference prices
                {unvalued > 0 ? `. ${formatCount(BigInt(unvalued))} without a value left out` : null}
              </TableCell>
              <TableCell numeric>{formatUsd(totalE8, USD_E8_DECIMALS)}</TableCell>
            </TableRow>
          </TableFoot>
        )}
      </Table>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={state.refetch} loading={state.refreshing} loadingLabel="Reading balances">
          Refresh balances
        </Button>
        {empty.length > 0 ? (
          <Button variant="ghost" aria-expanded={showEmpty} onClick={() => setShowEmpty((value) => !value)}>
            {showEmpty ? "Hide" : "Show"} {formatCount(BigInt(empty.length))} zero balances
          </Button>
        ) : null}
      </div>
      <p className="max-w-measure text-xs text-secondary">
        Reference price, not executable. A value is the balance at the reference price, rounded down: it is not what a
        trade would return. USDC is valued at an assumed 1.00 USD per unit, not at a reference feed price. Balances read
        from Base mainnet at <span className="num">{readAt}</span>.
      </p>
    </>
  );
}

type WalletViewProps = Omit<BalancesProps, "account"> & {
  /** The address of a read-only lookup, which takes precedence over the connected wallet. */
  lookup: Address | null;
};

function View({ lookup, ...table }: WalletViewProps) {
  const { address } = useConnection();
  const [connecting, setConnecting] = useState(false);
  const account = lookup ?? address;
  if (account === undefined) {
    return (
      <>
        <EmptyState
          title="No wallet is connected"
          action={
            <Button variant="primary" onClick={() => setConnecting(true)}>
              Connect wallet
            </Button>
          }
        >
          Connect a wallet to see its balances here. Connecting shares your public address only. To read any address
          without connecting, use the lookup above.
        </EmptyState>
        <ConnectDialog open={connecting} onClose={() => setConnecting(false)} />
      </>
    );
  }
  return (
    <>
      <AccountFacts account={account} lookup={lookup !== null} />
      <Balances account={account} {...table} />
    </>
  );
}

/** Loaded on its own, in the browser only, by `WalletSlot`. */
export function WalletView(props: WalletViewProps) {
  return (
    <WalletRuntime>
      <div className="flex flex-col gap-3">
        <View {...props} />
      </div>
    </WalletRuntime>
  );
}
