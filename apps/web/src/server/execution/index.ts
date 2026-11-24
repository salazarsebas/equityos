import "server-only";
import { createPublicClient, http } from "viem";
import { resolveBaseRpcUrl } from "@/server/market/config";
import { createKyberSwapProvider, resolveClientId } from "./kyberswap";
import type { QuoteProvider } from "./provider";
import type { ExecutionClient } from "./simulate";

let provider: QuoteProvider | undefined;
let client: ExecutionClient | undefined;

/** The process-wide quote provider: KyberSwap, with the client id of `KYBERSWAP_CLIENT_ID`. */
export function getQuoteProvider(): QuoteProvider {
  provider ??= createKyberSwapProvider({ clientId: resolveClientId() });
  return provider;
}

/** The process-wide read-only Base mainnet client of the pre-trade checks, from `BASE_RPC_URL`. */
export function getExecutionClient(): ExecutionClient {
  client ??= createPublicClient({ transport: http(resolveBaseRpcUrl(), { timeout: 10_000, retryCount: 1 }) });
  return client;
}

export * from "./checks";
export * from "./plan";
export * from "./provider";
export { KYBERSWAP_EXECUTOR, KYBERSWAP_ROUTER } from "@/lib/execution/calldata";
export { createExecutionLimits, type ExecutionLimits } from "./limits";
export type { ExecutionClient, PlannedCall } from "./simulate";
