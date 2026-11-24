import { executionPlanHandler } from "@/server/api/execution";
import { getExecutionClient, getQuoteProvider } from "@/server/execution";
import { getMarketData, marketDataMode } from "@/server/market";
import { getRegistryReader, registryMode } from "@/server/registry";

export { preflightPost as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const POST = executionPlanHandler({
  registry: getRegistryReader,
  mode: registryMode,
  marketData: getMarketData,
  marketMode: marketDataMode,
  provider: getQuoteProvider,
  executionClient: getExecutionClient,
});
