/** The fields of a wagmi connector that the connect dialog reads. */
export interface ConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly icon?: string | undefined;
}

/** One entry of the connect dialog. */
export interface WalletOption<connector extends ConnectorSummary> {
  readonly connector: connector;
  readonly name: string;
  /** The wallet's own icon as an image data URI, when it announced one through EIP-6963. */
  readonly icon: string | null;
  /** One line under the name: where the option comes from or what choosing it opens. */
  readonly detail: string;
}

const DETECTED = "Detected in this browser";

const DETAILS: Record<string, string> = {
  baseAccount: "Opens in a separate window",
  walletConnect: "Shows a QR code for a mobile wallet",
};

/** EIP-6963 requires the icon to be a data URI. Anything else is dropped, so no remote image is ever requested. */
function safeIcon(icon: string | undefined): string | null {
  return icon !== undefined && /^data:image\/(png|svg\+xml|webp|jpeg|gif)[;,]/i.test(icon) ? icon : null;
}

/**
 * The options of the connect dialog, in display order: wallets discovered in the browser through EIP-6963, each
 * under its own name and icon, then the other connectors. The generic `injected` connector is listed, as
 * "Browser wallet", only when a legacy `window.ethereum` provider exists and no wallet announced itself, so that
 * a wallet never appears twice and an option never leads to a missing provider.
 */
export function listWalletOptions<connector extends ConnectorSummary>(
  connectors: readonly connector[],
  hasLegacyProvider: boolean,
): WalletOption<connector>[] {
  const isGeneric = ({ type, id }: ConnectorSummary) => type === "injected" && id === "injected";
  const discovered = connectors.filter((connector) => connector.type === "injected" && !isGeneric(connector));
  const others = connectors.filter((connector) => connector.type !== "injected");
  const generic = discovered.length === 0 && hasLegacyProvider ? connectors.filter(isGeneric) : [];
  return [
    ...discovered.map((connector) => ({
      connector,
      name: connector.name,
      icon: safeIcon(connector.icon),
      detail: DETECTED,
    })),
    ...generic.map((connector) => ({ connector, name: "Browser wallet", icon: null, detail: DETECTED })),
    ...others.map((connector) => ({
      connector,
      name: connector.name,
      icon: null,
      detail: DETAILS[connector.type] ?? "",
    })),
  ];
}
