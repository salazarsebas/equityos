import "server-only";
import { hexToBytes } from "viem";
import { constituentStatus, joinComposition, loadIndexProfile } from "@/server/indexes";
import type { MarketData } from "@/server/market";
import {
  DEFAULT_PAGE_SIZE,
  HEADS_CACHE,
  type IndexSummary,
  type IndexVersionView,
  MAX_PAGE_SIZE,
  type RegistryMode,
  type RegistryNotDeployed,
  type RegistryReader,
} from "@/server/registry";
import { snapshotCache, snapshotMeta, toApiReferencePrice } from "./assets";
import { ApiError } from "./errors";
import { isoTimestamp, ok, publicCache, route } from "./http";
import { integerParameter, parseQuery } from "./params";

export interface IndexApiOptions {
  readonly registry: () => RegistryReader;
  readonly mode: () => RegistryMode;
  /** Clock in Unix seconds. */
  readonly now?: () => number;
}

type IdentifierContext = { params: Promise<{ identifier: string }> };
type VersionContext = { params: Promise<{ identifier: string; version: string }> };

const systemClock = () => Math.floor(Date.now() / 1000);

/** Everything the registry holds can change within the TTL of its head cache, and nothing is served past it. */
const REGISTRY_CACHE = publicCache(HEADS_CACHE.ttlSeconds);

/**
 * The registry is not deployed on the configured chain. It is answered as 409: the request is valid and the
 * state of the service does not allow an answer. It is not a 200, because a client that reads `data` would
 * see a list without indexes, not a 404, which says that one identifier is unknown, and not a 5xx, because
 * nothing failed and retrying does not help.
 */
function notDeployed({ chainId, registry, reason }: RegistryNotDeployed): ApiError {
  return new ApiError(409, "registry_not_deployed", "The index registry is not deployed on the configured chain.", {
    chainId,
    registry: registry.toLowerCase(),
    reason,
  });
}

const NOT_FOUND = {
  invalid_identifier: new ApiError(
    400,
    "invalid_identifier",
    "The identifier is neither a 32-byte index id nor a slug followed by an index id prefix.",
    { parameter: "identifier" },
  ),
  index_not_found: new ApiError(404, "index_not_found", "The registry holds no index with this identifier."),
  version_not_found: new ApiError(404, "version_not_found", "The index has no version with this number."),
} as const;

/** The registry facts every index response carries in `meta`. */
export function registryMeta({ registry, mode, now = systemClock }: IndexApiOptions) {
  const reader = registry();
  return {
    asOf: isoTimestamp(now()),
    registry: { chainId: reader.chainId, address: reader.registry, mode: mode() },
  };
}

function timestamp(unixSeconds: bigint): string {
  return isoTimestamp(Number(unixSeconds));
}

/** Whether a version passes every check, and the check that failed when it does not. */
function verificationSummary({ conformant, verification }: IndexVersionView) {
  const failed = verification.checks.find(({ status }) => status === "fail");
  return { conformant, failedCheck: failed === undefined ? null : { id: failed.id, code: failed.code } };
}

/** A version as listed. The name, slug and weighting come from the spec and are `null` unless it is verified. */
function versionSummary(view: IndexVersionView) {
  return {
    version: view.version,
    name: view.spec?.name ?? null,
    slug: view.spec?.slug ?? null,
    weighting: view.spec?.weighting.type ?? null,
    composition: view.composition,
    constituentCount: view.constituents.length,
    specHash: view.specHash,
    publishedAt: timestamp(view.publishedAt),
    publishedBlock: view.publishedBlock,
    verification: verificationSummary(view),
  };
}

function indexSummary({ identifier, position, head, latest }: IndexSummary) {
  return {
    indexId: head.indexId,
    identifier,
    position,
    creator: head.creator,
    createdAt: timestamp(head.createdAt),
    latestVersion: head.latestVersion,
    deprecated: head.deprecatedAt !== null,
    deprecatedAt: head.deprecatedAt === null ? null : timestamp(head.deprecatedAt),
    latest: versionSummary(latest),
  };
}

/** The stored bytes as text, or `null` when they are not well-formed UTF-8. */
function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function versionDetail(index: IndexSummary, view: IndexVersionView) {
  const bytes = hexToBytes(view.specBytes);
  const { head, identifier } = index;
  return {
    indexId: head.indexId,
    identifier,
    version: view.version,
    latestVersion: head.latestVersion,
    isLatest: view.version === head.latestVersion,
    creator: view.creator,
    chainId: view.chainId,
    registry: view.registry,
    specHash: view.specHash,
    publishedAt: timestamp(view.publishedAt),
    publishedBlock: view.publishedBlock,
    composition: view.composition,
    specSize: bytes.length,
    specBytes: view.specBytes,
    specText: utf8(bytes),
    spec: view.spec,
    constituents: view.constituents,
    verification: {
      conformant: view.conformant,
      checks: view.verification.checks,
      specErrors: view.verification.specErrors,
    },
  };
}

/**
 * A version number from a path or a query string: decimal digits, 1 to 2^32 - 1, the range of the registry.
 *
 * @throws {ApiError} 400 `invalid_parameter`
 */
export function parseVersion(raw: string): number {
  const version = /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(version <= 0xffff_ffff)) {
    throw new ApiError(400, "invalid_parameter", "The version is not an integer from 1 to 4294967295.", {
      parameter: "version",
    });
  }
  return version;
}

/** Loads an index with one of its versions, or throws the API error of the reason there is none. */
export async function requireProfile(options: IndexApiOptions, identifier: string, version?: number) {
  const profile = await loadIndexProfile(options.registry(), identifier, version);
  if (profile.status === "ok") return profile;
  throw profile.status === "registry_not_deployed" ? notDeployed(profile) : NOT_FOUND[profile.status];
}

/**
 * Refuses a version that fails verification: there is no composition to compute anything from.
 *
 * @throws {ApiError} 409 `version_not_conformant`
 */
export function requireConformant(
  view: IndexVersionView,
  what: string,
): asserts view is Extract<IndexVersionView, { conformant: true }> {
  if (view.conformant) return;
  const { failedCheck } = verificationSummary(view);
  throw new ApiError(409, "version_not_conformant", `The version fails verification, so it has no ${what}.`, {
    version: view.version,
    failedCheck: failedCheck?.id ?? null,
    code: failedCheck?.code ?? null,
  });
}

/**
 * `GET /api/v1/indexes`: a page of indexes in creation order.
 *
 * Pagination is by position. The registry is append-only and an index keeps its position forever, so an
 * offset is already a stable cursor: a page never shifts, repeats or skips an index while indexes are created.
 */
export function indexesHandler(options: IndexApiOptions) {
  return route(async (request: Request) => {
    const query = parseQuery(request, ["offset", "limit"]);
    const offset = integerParameter(query, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const limit = integerParameter(query, "limit", 1, MAX_PAGE_SIZE) ?? DEFAULT_PAGE_SIZE;
    const page = await options.registry().listIndexes({ offset, limit });
    if (page.status !== "ok") throw notDeployed(page);
    const end = offset + page.indexes.length;
    const meta = {
      ...registryMeta(options),
      total: page.total,
      offset,
      limit,
      count: page.indexes.length,
      nextOffset: end < page.total ? end : null,
    };
    return ok(page.indexes.map(indexSummary), meta, REGISTRY_CACHE);
  });
}

/** `GET /api/v1/indexes/{identifier}`: one index with its most recent versions, newest first. */
export function indexHandler(options: IndexApiOptions) {
  return route(async (request: Request, context: IdentifierContext) => {
    parseQuery(request, []);
    const { index, history } = await requireProfile(options, (await context.params).identifier);
    const versions = history
      .map(({ version, publishedAt, publishedBlock, specHash, conformant }) => ({
        version,
        publishedAt: timestamp(publishedAt),
        publishedBlock,
        specHash,
        conformant,
      }))
      .reverse();
    return ok({ ...indexSummary(index), versions }, registryMeta(options), REGISTRY_CACHE);
  });
}

/** `GET /api/v1/indexes/{identifier}/versions/{version}`: everything the registry stores for one version. */
export function indexVersionHandler(options: IndexApiOptions) {
  return route(async (request: Request, context: VersionContext) => {
    parseQuery(request, []);
    const { identifier, version } = await context.params;
    const profile = await requireProfile(options, identifier, parseVersion(version));
    return ok(versionDetail(profile.index, profile.version), registryMeta(options), REGISTRY_CACHE);
  });
}

/**
 * `GET /api/v1/indexes/{identifier}/composition`: the constituents of a verified version joined with the asset
 * universe as it is now. A version that fails verification has no composition to compute from: 409.
 */
export function indexCompositionHandler(options: IndexApiOptions & { readonly marketData: () => MarketData }) {
  return route(async (request: Request, context: IdentifierContext) => {
    const requested = parseQuery(request, ["version"]).get("version");
    const { index, version: view } = await requireProfile(
      options,
      (await context.params).identifier,
      requested === null ? undefined : parseVersion(requested),
    );
    requireConformant(view, "composition");
    const snapshot = await options.marketData().getSnapshot();
    const constituents = joinComposition(view.constituents, snapshot).map((row) => {
      const { eligible, ineligibleReasons, transfersPaused } = constituentStatus(row);
      return {
        token: row.token,
        symbol: row.market?.asset.symbol ?? null,
        name: row.market?.asset.name ?? null,
        targetWeightBps: row.weightBps,
        eligibility: { eligible, reasons: ineligibleReasons },
        transfersPaused,
        referencePrice: toApiReferencePrice(row.token, row.market?.referencePrice ?? null),
      };
    });
    const data = {
      indexId: index.head.indexId,
      identifier: index.identifier,
      version: view.version,
      isLatest: view.version === index.head.latestVersion,
      constituents,
    };
    const { registry } = registryMeta(options);
    return ok(data, { ...snapshotMeta(snapshot), registry }, snapshotCache(snapshot));
  });
}
