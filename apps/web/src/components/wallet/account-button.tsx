import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, WarningIcon } from "@/components/ui/icons";
import { shortenAddress } from "@/lib/format";

type AccountButtonProps = Omit<ComponentProps<typeof Button>, "children" | "variant" | "size" | "className"> & {
  /** The connected account, or `null` to offer the connection. */
  account: string | null;
  /** The wallet is on a network the app does not use. */
  wrongNetwork?: boolean;
};

/** Width of the account control in the top bar, whatever it shows, so that nothing next to it ever moves. */
export const ACCOUNT_SLOT = "relative w-36 sm:w-44";

/**
 * The button of the account control: "Connect wallet", or the shortened account. It fills `ACCOUNT_SLOT`. Its name
 * contains the shortened account it shows, so that it can be named by what is on screen; the menu it opens shows
 * the full one.
 */
export function AccountButton({ account, wrongNetwork = false, ...rest }: AccountButtonProps) {
  if (account === null) {
    return (
      <Button {...rest} className="w-full max-sm:px-2">
        Connect wallet
      </Button>
    );
  }
  return (
    <Button
      {...rest}
      className="w-full justify-between max-sm:px-2"
      aria-label={`Account ${shortenAddress(account)}${wrongNetwork ? ", unsupported network" : ""}`}
    >
      {wrongNetwork ? <WarningIcon className="shrink-0 text-warning" /> : null}
      <span className="num font-mono text-sm">{shortenAddress(account)}</span>
      <ChevronDownIcon className="shrink-0 text-secondary" />
    </Button>
  );
}
