import { indexesHandler } from "@/server/api/indexes";
import { getRegistryReader, registryMode } from "@/server/registry";

export { preflight as OPTIONS } from "@/server/api/http";

export const dynamic = "force-dynamic";

export const GET = indexesHandler({ registry: getRegistryReader, mode: registryMode });
