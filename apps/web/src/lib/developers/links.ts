import { site } from "@/lib/site";

/** Origin of this deployment, without a trailing slash, for the commands the developer pages print. */
export function apiOrigin(): string {
  return site.url.replace(/\/+$/, "");
}

/** Documents of the repository the developer pages link to. */
export const REPOSITORY_DOCS = {
  sdk: `${site.repositoryUrl}/blob/main/docs/api/sdk.md`,
  api: `${site.repositoryUrl}/blob/main/docs/api/README.md`,
  methodology: `${site.repositoryUrl}/blob/main/docs/architecture/methodology-spec.md`,
  jsonSchema: `${site.repositoryUrl}/blob/main/packages/core/src/schema/equityos.index-1.schema.json`,
  vectors: `${site.repositoryUrl}/tree/main/packages/core/vectors`,
} as const;
