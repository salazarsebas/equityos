import "server-only";
import { MissingConfigurationError } from "./errors";

/** Chain id of Base mainnet, the only chain this layer reads. */
export const BASE_CHAIN_ID = 8453;

/**
 * Public Base mainnet endpoint. It is rate limited and best effort, so it is a fallback for local development
 * and tests run by hand only. It is never used when `NODE_ENV` is "production".
 */
const DEVELOPMENT_RPC_URL = "https://mainnet.base.org";

export interface MarketEnvironment {
  readonly BASE_RPC_URL?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

/**
 * Resolves the Base mainnet RPC URL from `BASE_RPC_URL`.
 *
 * @throws {MissingConfigurationError} if the variable is not an http(s) URL, or is unset in production.
 */
export function resolveBaseRpcUrl(env: MarketEnvironment = process.env): string {
  const configured = env.BASE_RPC_URL?.trim() ?? "";
  if (configured === "") {
    if (env.NODE_ENV === "production") throw new MissingConfigurationError("BASE_RPC_URL", "is not set");
    return DEVELOPMENT_RPC_URL;
  }
  if (!URL.canParse(configured) || !/^https?:$/.test(new URL(configured).protocol)) {
    throw new MissingConfigurationError("BASE_RPC_URL", "is not an http or https URL");
  }
  return configured;
}
