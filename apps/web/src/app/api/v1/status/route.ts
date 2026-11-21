import { statusHandler } from "@/server/api/status";
import { getMarketData, marketDataMode } from "@/server/market";

export { preflight as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const GET = statusHandler({ marketData: getMarketData, mode: marketDataMode });
