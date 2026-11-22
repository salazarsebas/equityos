import { type Address, getAddress, isAddress } from "viem";

/**
 * The address of a read-only lookup, from the `address` query parameter.
 * - `none`: no parameter, or an empty one.
 * - `invalid`: not 20 bytes of hex, or mixed case with a wrong EIP-55 checksum, which signals a typing error.
 * - `ok`: the address in checksum form.
 */
export type AddressLookup =
  | { readonly status: "none" }
  | { readonly status: "invalid"; readonly input: string }
  | { readonly status: "ok"; readonly address: Address };

export function parseAddressLookup(parameter: string | readonly string[] | undefined): AddressLookup {
  const input = (typeof parameter === "string" ? parameter : (parameter?.[0] ?? "")).trim();
  if (input === "") return { status: "none" };
  return isAddress(input) ? { status: "ok", address: getAddress(input) } : { status: "invalid", input };
}

/**
 * The account a stored connection state points at, for the first server render. The state comes from a cookie,
 * so nothing about its shape is trusted. `null` when it holds no well-formed current account.
 */
export function storedAccount(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("current" in state) || !("connections" in state)) return null;
  const { current, connections } = state;
  if (typeof current !== "string" || !(connections instanceof Map)) return null;
  const connection: unknown = connections.get(current);
  if (typeof connection !== "object" || connection === null || !("accounts" in connection)) return null;
  const account: unknown = Array.isArray(connection.accounts) ? connection.accounts[0] : undefined;
  return typeof account === "string" && /^0x[0-9a-fA-F]{40}$/.test(account) ? account : null;
}
