/** What a wallet error says about itself: the numeric codes and the error names along its chain of causes. */
export interface WalletErrorSignature {
  readonly codes: ReadonlySet<number>;
  readonly names: ReadonlySet<string>;
}

/** Libraries wrap the error a wallet returned, so the code that matters can sit several causes deep. */
export function walletErrorSignature(error: unknown): WalletErrorSignature {
  const codes = new Set<number>();
  const names = new Set<string>();
  let cause = error;
  for (let depth = 0; typeof cause === "object" && cause !== null && depth < 8; depth += 1) {
    if ("code" in cause && typeof cause.code === "number") codes.add(cause.code);
    if ("name" in cause && typeof cause.name === "string") names.add(cause.name);
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return { codes, names };
}

/** EIP-1193 `4200` unsupported method and JSON-RPC `-32601` method not found. */
export function isMethodUnsupported({ codes }: WalletErrorSignature): boolean {
  return codes.has(4200) || codes.has(-32601);
}

const OUTCOME = {
  connect: "No wallet was connected.",
  switch: "The network was not changed.",
} as const;

/**
 * A sentence a person can act on for a failed connection or network switch. It states what happened and what
 * state things are in. The raw error text of a wallet is never shown: it is written for developers.
 */
export function walletErrorMessage(error: unknown, action: keyof typeof OUTCOME): string {
  const signature = walletErrorSignature(error);
  const { codes, names } = signature;
  if (codes.has(4001) || names.has("UserRejectedRequestError")) {
    return `The request was declined in the wallet. ${OUTCOME[action]}`;
  }
  if (codes.has(-32002)) {
    return `The wallet already has a request waiting. Open the wallet and answer it. ${OUTCOME[action]}`;
  }
  if (action === "switch") {
    // 4902: the wallet does not know the chain and could not add it.
    return isMethodUnsupported(signature) || codes.has(4902) || names.has("SwitchChainNotSupportedError")
      ? "This wallet cannot change network from here. Select Base in the wallet itself."
      : "The wallet did not change network. Select Base in the wallet itself.";
  }
  if (names.has("ProviderNotFoundError")) return "This wallet was not found in the browser. Choose another one.";
  return "The wallet did not connect. Try again or choose another wallet.";
}
