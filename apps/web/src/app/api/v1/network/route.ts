import { networkHandler } from "@/server/api/network";
import { getNetworkService } from "@/server/network";
import { registryMode } from "@/server/registry";

export { preflight as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const GET = networkHandler({ network: getNetworkService, mode: registryMode });
