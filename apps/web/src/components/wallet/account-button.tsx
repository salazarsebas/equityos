import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, WarningIcon } from "@/components/ui/icons";
import { shortenAddress } from "@/lib/format";

type AccountButtonProps = Omit<ComponentProps<typeof Button>, "children" | "variant" | "size"> & {
  /** The connected account, or `null` to offer the connection. */
  account: string | null;
  /** The wallet is on a network the app does not use. */
  wrongNetwork?: boolean;
};

/**
 * The button of the account control in the top bar: "Connect wallet", or the shortened account. It is shared by
 * the control and by its stand-in, so that the two are the same pixels and the swap between them is not visible.
 */
export function AccountButton({ account, wrongNetwork = false, ...rest }: AccountButtonProps) {
  if (account === null) return <Button {...rest}>Connect wallet</Button>;
  return (
    <Button {...rest} aria-label={`Account ${account}${wrongNetwork ? ", unsupported network" : ""}`}>
      {wrongNetwork ? <WarningIcon className="shrink-0 text-warning" /> : null}
      <span className="num font-mono text-sm">{shortenAddress(account)}</span>
      <ChevronDownIcon className="shrink-0 text-secondary" />
    </Button>
  );
}
