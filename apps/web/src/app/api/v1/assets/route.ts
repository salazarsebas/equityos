import { assetsHandler } from "@/server/api/assets";
import { getMarketData } from "@/server/market";

export { preflight as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const GET = assetsHandler(getMarketData);
