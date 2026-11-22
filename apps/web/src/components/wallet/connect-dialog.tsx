"use client";

import { useConnect, useConnectors } from "wagmi";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { WalletIcon } from "@/components/ui/icons";
import { walletErrorMessage } from "@/lib/wallet/errors";
import { listWalletOptions } from "@/lib/wallet/options";
import { ExecutionNote } from "./execution-note";

/** The wallet's own icon when it announced one, else the generic glyph. Decorative: the name is next to it. */
function OptionIcon({ icon }: { icon: string | null }) {
  return icon === null ? (
    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-subtle text-secondary">
      <WalletIcon />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="size-6 shrink-0 rounded-md bg-contain bg-center bg-no-repeat"
      style={{ backgroundImage: `url("${icon}")` }}
    />
  );
}

/**
 * Lists the wallets that can be connected: those the browser announces through EIP-6963, Base Account, and
 * WalletConnect when it is configured. Connecting asks the wallet for its public address and nothing else.
 */
export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connect = useConnect();
  const options = listWalletOptions(useConnectors(), "ethereum" in window);
  const pending = connect.isPending ? connect.variables.connector : null;

  function close() {
    connect.reset();
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} title="Connect a wallet" footer={<Button onClick={close}>Close</Button>}>
      <div className="flex flex-col gap-3">
        <p>
          Connecting shares your public address with this site so it can read your balances. It does not sign or send
          anything.
        </p>
        <ul className="flex flex-col gap-2">
          {options.map(({ connector, name, icon, detail }) => (
            <li key={connector.uid}>
              <button
                type="button"
                aria-disabled={pending !== null || undefined}
                aria-busy={pending === connector || undefined}
                onClick={() => {
                  if (pending !== null) return;
                  // WalletConnect draws its own QR code modal, which must not sit under this one.
                  if (connector.type === "walletConnect") onClose();
                  connect.mutate({ connector }, { onSuccess: close });
                }}
                className={cx(
                  "flex min-h-12 w-full items-center gap-3 rounded-md border border-strong bg-surface px-3 py-2 text-left transition-colors duration-[120ms]",
                  pending === null ? "hover:bg-subtle" : "cursor-not-allowed",
                  pending !== null && pending !== connector && "border-default text-disabled",
                )}
              >
                <OptionIcon icon={icon} />
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cx(
                      "truncate font-medium",
                      (pending === null || pending === connector) && "text-primary",
                    )}
                  >
                    {name}
                  </span>
                  <span className="text-xs">{pending === connector ? "Waiting for the wallet" : detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {connect.isError ? (
          <p role="alert" className="text-sm text-negative">
            {walletErrorMessage(connect.error, "connect")}
          </p>
        ) : null}
        <ExecutionNote enabled={open} />
      </div>
    </Dialog>
  );
}
