import { portfolioHandler } from "@/server/api/portfolio";
import { getMarketData, marketDataMode } from "@/server/market";
import { getRegistryReader, registryMode } from "@/server/registry";

export { preflight as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const GET = portfolioHandler({
  registry: getRegistryReader,
  mode: registryMode,
  marketData: getMarketData,
  marketMode: marketDataMode,
});
