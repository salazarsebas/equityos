import { assetHandler } from "@/server/api/assets";
import { getMarketData, marketDataMode } from "@/server/market";

export { preflight as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const GET = assetHandler({ marketData: getMarketData, mode: marketDataMode });
