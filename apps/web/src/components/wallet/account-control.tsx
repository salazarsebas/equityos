"use client";

import NextLink from "next/link";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { useConnection, useDisconnect, useSwitchChain } from "wagmi";
import { Button } from "@/components/ui/button";
import { CheckIcon, CopyIcon, DisconnectIcon, ExternalLinkIcon, WalletIcon } from "@/components/ui/icons";
import { addressExplorer, HOME_CHAIN } from "@/lib/wallet/chains";
import { walletErrorMessage } from "@/lib/wallet/errors";
import { AccountButton } from "./account-button";
import { handoff } from "./boot";
import { ConnectDialog } from "./connect-dialog";
import { ExecutionNote } from "./execution-note";
import { WalletRuntime } from "./runtime";

const item =
  "-mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-left text-base text-primary transition-colors duration-[120ms] hover:bg-subtle pointer-coarse:h-11";

function CopyAddress({ address, ref }: { address: string; ref: Ref<HTMLButtonElement> }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (result === null) return;
    const timer = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  return (
    <button
      ref={ref}
      type="button"
      className={item}
      onClick={() => {
        navigator.clipboard.writeText(address).then(
          () => setResult("copied"),
          () => setResult("failed"),
        );
      }}
    >
      {result === "copied" ? <CheckIcon className="shrink-0" /> : <CopyIcon className="shrink-0" />}
      <span aria-live="polite">
        {result === null ? "Copy address" : result === "copied" ? "Address copied" : "Not copied: select it above"}
      </span>
    </button>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-secondary">{term}</dt>
      <dd className="min-w-0 truncate text-primary">{children}</dd>
    </>
  );
}

/** The account control of the top bar: offers the connection, then shows the account with its menu. */
function Control() {
  const { address, chain, chainId, connector } = useConnection();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const wrongNetwork = address !== undefined && chain === undefined;
  const showMenu = menuOpen && address !== undefined;

  // Picks up from the stand-in that was rendered while this code loaded.
  useEffect(() => {
    if (handoff.focus) trigger.current?.focus();
    if (handoff.open) trigger.current?.click();
    handoff.focus = false;
    handoff.open = false;
  }, []);

  // The menu closes on Escape, which returns focus to its button, and when a click or focus lands outside it.
  useEffect(() => {
    if (!showMenu) return;
    firstItem.current?.focus();
    function onOutside(event: Event) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showMenu]);

  function switchToBase() {
    switchChain.mutate({ chainId: HOME_CHAIN.id }, { onError: () => setMenuOpen(true) });
  }

  const switchButton = (
    <Button onClick={switchToBase} loading={switchChain.isPending} loadingLabel="Waiting for the wallet">
      Switch to Base
    </Button>
  );

  return (
    <div ref={root} className="relative flex items-center gap-2">
      {wrongNetwork ? <span className="max-md:hidden">{switchButton}</span> : null}
      <AccountButton
        ref={trigger}
        account={address ?? null}
        wrongNetwork={wrongNetwork}
        {...(address ? { "aria-haspopup": "dialog", "aria-expanded": showMenu, "aria-controls": menuId } : {})}
        onClick={() => (address ? setMenuOpen((value) => !value) : setDialogOpen(true))}
      />
      {showMenu ? (
        <div
          id={menuId}
          role="dialog"
          aria-label="Wallet account"
          className="absolute top-full right-0 z-30 mt-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border border-overlay bg-surface p-4 shadow-overlay"
        >
          <p className="font-mono text-sm break-all text-primary">{address}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <Fact term="Wallet">{connector?.name ?? "Unknown"}</Fact>
            <Fact term="Network">{chain?.name ?? `Unsupported (chain ${chainId})`}</Fact>
          </dl>
          {wrongNetwork ? (
            <div className="flex flex-col items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-primary">
              <p>This site reads Base. Your wallet is on a network it does not use.</p>
              {switchButton}
              {switchChain.isError ? <p role="alert">{walletErrorMessage(switchChain.error, "switch")}</p> : null}
            </div>
          ) : null}
          <div className="flex flex-col border-t pt-2">
            <CopyAddress ref={firstItem} address={address} />
            <a href={addressExplorer(chain, address).url} rel="noreferrer" className={item}>
              <ExternalLinkIcon className="shrink-0" />
              View on {addressExplorer(chain, address).name}
            </a>
            <NextLink href="/wallet" className={item} onClick={() => setMenuOpen(false)}>
              <WalletIcon className="shrink-0" />
              Open wallet page
            </NextLink>
            <button
              type="button"
              className={item}
              onClick={() => {
                setMenuOpen(false);
                trigger.current?.focus();
                disconnect.mutate();
              }}
            >
              <DisconnectIcon className="shrink-0" />
              Disconnect
            </button>
          </div>
          <ExecutionNote enabled />
        </div>
      ) : null}
      <ConnectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

/** Loaded on its own, in the browser only, by `AccountSlot`. */
export function AccountControl() {
  return (
    <WalletRuntime>
      <Control />
    </WalletRuntime>
  );
}
