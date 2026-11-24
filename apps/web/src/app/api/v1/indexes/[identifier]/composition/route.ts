import { indexCompositionHandler } from "@/server/api/indexes";
import { getMarketData, marketDataMode } from "@/server/market";
import { getRegistryReader, registryMode } from "@/server/registry";

export { preflight as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const GET = indexCompositionHandler({
  registry: getRegistryReader,
  mode: registryMode,
  marketData: getMarketData,
  marketMode: marketDataMode,
});
