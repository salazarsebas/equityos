import "server-only";
import type { Address } from "viem";
import { RegistryConfigurationError } from "../registry";

/** An account whose activity is never counted in a headline figure: a team, test or operator account. */
export interface ExcludedAccount {
  /** Lowercase. */
  readonly address: Address;
  /** Who the account belongs to and why it is excluded, as shown on the page. */
  readonly label: string;
}

export const EXCLUDED_ACCOUNTS_VARIABLE = "EQUITYOS_EXCLUDED_ACCOUNTS";

const ENTRY = /^(0x[0-9a-fA-F]{40})=([^=]{1,80})$/;

/**
 * Parses `EQUITYOS_EXCLUDED_ACCOUNTS`: comma-separated entries of an address, `=` and a label, such as
 * `0xabc...=EquityOS test account`. Unset or blank means no exclusion. A label cannot contain a comma.
 *
 * @throws {RegistryConfigurationError} if an entry is malformed or an address is listed twice: a list that is
 *   silently cut short would let excluded activity into the headline figures.
 */
export function parseExcludedAccounts(raw: string | undefined): ExcludedAccount[] {
  const text = raw?.trim() ?? "";
  if (text === "") return [];
  const accounts: ExcludedAccount[] = [];
  for (const entry of text.split(",")) {
    const match = ENTRY.exec(entry.trim());
    const hex = match?.[1];
    const label = match?.[2]?.trim();
    if (hex === undefined || label === undefined || label === "") {
      throw new RegistryConfigurationError(EXCLUDED_ACCOUNTS_VARIABLE, "has an entry that is not <address>=<label>");
    }
    const address: Address = `0x${hex.slice(2).toLowerCase()}`;
    if (accounts.some((account) => account.address === address)) {
      throw new RegistryConfigurationError(EXCLUDED_ACCOUNTS_VARIABLE, "lists an address twice");
    }
    accounts.push({ address, label });
  }
  return accounts;
}
