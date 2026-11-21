import { json, publicCache } from "@/server/api/http";
import { openApiDocument } from "@/server/api/openapi";

export { preflight as OPTIONS } from "@/server/api/http";

/** The document changes only with a deployment, so any cache may keep it for an hour. */
export function GET(): Response {
  return json(200, openApiDocument, { "Cache-Control": publicCache(3600) });
}
