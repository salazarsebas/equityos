/**
 * Smoke checks of a deployed EquityOS web app, against real chain data. Read-only: it sends GET requests only.
 *
 *   bun scripts/smoke-deployment.ts https://<deployment>
 *   bun scripts/smoke-deployment.ts https://<deployment> --chain 84532
 *
 * It checks that the API serves live data (`meta.mode` is `live`), that the registry is reported deployed on the
 * expected chain and holds at least one index, that every reference price names its feed and its publication
 * time, that the network metrics answer, that the key pages answer 200 and that the security headers are set.
 * It prints one line per check and exits with 1 when any check fails.
 *
 * A Vercel deployment behind Deployment Protection is reached with the automation bypass secret, read from
 * `VERCEL_AUTOMATION_BYPASS_SECRET` and sent as the `x-vercel-protection-bypass` header. It is never printed.
 */

/** Base mainnet, where a production deployment reads the registry. */
const DEFAULT_CHAIN_ID = 8453;

/** Pages that must answer 200 with HTML. */
export const KEY_PAGES = [
  "/",
  "/assets",
  "/indexes",
  "/network",
  "/studio",
  "/portfolio",
  "/wallet",
  "/developers",
  "/developers/api",
  "/developers/spec",
] as const;

/** Other documents that must answer 200. */
export const KEY_DOCUMENTS = ["/api/v1/openapi.json", "/robots.txt", "/sitemap.xml"] as const;

export interface SmokeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SmokeOptions {
  /** Chain the registry is expected on. */
  readonly chainId?: number;
  readonly fetch?: typeof fetch;
  /** Value of the `x-vercel-protection-bypass` header, if the deployment is protected. */
  readonly bypassSecret?: string | undefined;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at `path` inside `value`, or `undefined`. */
function at(value: Json | undefined, ...path: (string | number)[]): Json | undefined {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") current = Array.isArray(current) ? current[key] : undefined;
    else current = isObject(current) ? current[key] : undefined;
  }
  return current;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isTimestamp(value: Json | undefined): boolean {
  return typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Why a reference price object is not acceptable, or `null`. A usable price must carry its value, its feed and
 * its publication time; an unavailable one must say why, and still name its feed.
 */
export function referencePriceProblem(price: Json | undefined): string | null {
  if (!isObject(price)) return "has no reference price object";
  if (typeof price.feedProxy !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(price.feedProxy)) return "names no feed";
  if (price.status === "unavailable") {
    return typeof price.unavailableReason === "string" ? null : "is unavailable without a reason";
  }
  if (!["live", "delayed", "last_close"].includes(String(price.status))) return `has status ${String(price.status)}`;
  if (typeof price.priceE8 !== "string" || !/^[1-9][0-9]*$/.test(price.priceE8)) return "has no positive price";
  if (!isTimestamp(price.updatedAt)) return "has no publication time";
  return null;
}

/**
 * Runs every check against `baseUrl` and returns one result per check, in order. Never throws for an answer of
 * the deployment: a network failure or an unexpected body is a failed check.
 */
export async function runSmokeChecks(baseUrl: string, options: SmokeOptions = {}): Promise<SmokeResult[]> {
  const fetcher = options.fetch ?? fetch;
  const chainId = options.chainId ?? DEFAULT_CHAIN_ID;
  const origin = new URL(baseUrl).origin;
  const headers: Record<string, string> = { Accept: "application/json, text/html" };
  if (options.bypassSecret !== undefined && options.bypassSecret !== "") {
    headers["x-vercel-protection-bypass"] = options.bypassSecret;
  }
  const results: SmokeResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  async function get(path: string): Promise<{ status: number; headers: Headers; json: Json | undefined } | string> {
    try {
      const response = await fetcher(`${origin}${path}`, { headers, redirect: "manual" });
      const type = response.headers.get("content-type") ?? "";
      const json = type.includes("application/json") ? ((await response.json()) as Json) : undefined;
      if (json === undefined) await response.arrayBuffer();
      return { status: response.status, headers: response.headers, json };
    } catch (error) {
      return `request failed (${error instanceof Error ? error.name : "unknown"})`;
    }
  }

  async function api(name: string, path: string): Promise<Json | undefined> {
    const answer = await get(path);
    if (typeof answer === "string") {
      check(name, false, answer);
      return undefined;
    }
    const code = at(answer.json, "error", "code");
    if (answer.status !== 200) {
      check(name, false, `HTTP ${answer.status}${typeof code === "string" ? ` ${code}` : ""}`);
      return undefined;
    }
    const mode = at(answer.json, "meta", "mode");
    if (mode !== "live") {
      check(name, false, `meta.mode is ${JSON.stringify(mode ?? null)}, not "live"`);
      return undefined;
    }
    return answer.json;
  }

  const status = await api("status", "/api/v1/status");
  if (status !== undefined) {
    const registry = at(status, "data", "registry");
    const problems: string[] = [];
    if (at(registry, "deployed") !== true)
      problems.push(`registry deployed is ${JSON.stringify(at(registry, "deployed") ?? null)}`);
    if (at(registry, "chainId") !== chainId)
      problems.push(`registry chain is ${String(at(registry, "chainId"))}, expected ${chainId}`);
    if (at(registry, "mode") !== "live") problems.push("registry mode is not live");
    if (at(status, "data", "marketData", "available") !== true) problems.push("market data is not available");
    if (at(status, "data", "marketData", "mode") !== "live") problems.push("market data mode is not live");
    const block = at(status, "data", "marketData", "datasets", "onchain", "blockNumber");
    const fetchedAt = at(status, "data", "marketData", "datasets", "onchain", "fetchedAt");
    if (typeof block !== "string" || !isTimestamp(fetchedAt)) problems.push("the onchain dataset has no block or time");
    check(
      "status",
      problems.length === 0,
      problems.length === 0
        ? `live, registry deployed on chain ${chainId} with ${String(at(registry, "indexCount"))} indexes, market block ${String(block)}`
        : problems.join("; "),
    );
  }

  const assets = await api("assets", "/api/v1/assets?eligible=true");
  if (assets !== undefined) {
    const list = at(assets, "data");
    const problems: string[] = [];
    let usable = 0;
    if (!Array.isArray(list) || list.length === 0) problems.push("no index-eligible asset");
    for (const asset of Array.isArray(list) ? list : []) {
      const problem = referencePriceProblem(at(asset, "referencePrice"));
      if (problem !== null) problems.push(`${String(at(asset, "symbol"))} ${problem}`);
      else if (at(asset, "referencePrice", "status") !== "unavailable") usable += 1;
    }
    if (Array.isArray(list) && list.length > 0 && usable === 0) problems.push("no asset has a usable reference price");
    if (at(assets, "meta", "referencePriceSource") !== "chainlink") problems.push("the price source is not stated");
    if (!isTimestamp(at(assets, "meta", "datasets", "onchain", "blockTimestamp"))) {
      problems.push("the onchain dataset has no block time");
    }
    const count = Array.isArray(list) ? list.length : 0;
    check(
      "assets",
      problems.length === 0,
      problems.length === 0 ? `${count} eligible, ${usable} with a usable reference price` : problems.join("; "),
    );
  }

  const indexes = await api("indexes", "/api/v1/indexes");
  let firstIdentifier: string | null = null;
  if (indexes !== undefined) {
    const total = at(indexes, "meta", "total");
    const registryChain = at(indexes, "meta", "registry", "chainId");
    const identifier = at(indexes, "data", 0, "identifier");
    firstIdentifier = typeof identifier === "string" ? identifier : null;
    const problems: string[] = [];
    if (typeof total !== "number" || total < 1) problems.push(`the registry holds ${String(total)} indexes`);
    if (registryChain !== chainId) problems.push(`read from chain ${String(registryChain)}, expected ${chainId}`);
    check("indexes", problems.length === 0, problems.length === 0 ? `${String(total)} indexes` : problems.join("; "));
  }

  const network = await api("network", "/api/v1/network");
  if (network !== undefined) {
    const problems: string[] = [];
    if (at(network, "data", "chainId") !== chainId) problems.push(`chain ${String(at(network, "data", "chainId"))}`);
    const published = at(network, "data", "metrics", "indexesPublished", "value");
    if (typeof published !== "number") problems.push("no indexesPublished metric");
    const scanned = at(network, "data", "scan", "scannedToBlock");
    check(
      "network",
      problems.length === 0,
      problems.length === 0
        ? `${String(published)} indexes published, scanned to block ${String(scanned)}`
        : problems.join("; "),
    );
  }

  const pages = [...KEY_PAGES, ...(firstIdentifier === null ? [] : [`/indexes/${firstIdentifier}`]), ...KEY_DOCUMENTS];
  const failedPages: string[] = [];
  let securityHeaders: string | null = "not checked: / did not answer 200";
  for (const path of pages) {
    const answer = await get(path);
    if (typeof answer === "string") failedPages.push(`${path} ${answer}`);
    else if (answer.status !== 200) failedPages.push(`${path} HTTP ${answer.status}`);
    else if (path === "/") {
      const missing = ["content-security-policy", "strict-transport-security", "x-content-type-options"].filter(
        (name) => answer.headers.get(name) === null,
      );
      const policy = answer.headers.get("content-security-policy") ?? "";
      if (!policy.includes("frame-ancestors 'none'")) missing.push("frame-ancestors");
      securityHeaders = missing.length === 0 ? null : `missing ${missing.join(", ")}`;
    }
  }
  check(
    "pages",
    failedPages.length === 0,
    failedPages.length === 0 ? `${pages.length} answered 200` : failedPages.join("; "),
  );
  check("security headers", securityHeaders === null, securityHeaders ?? "set on /");
  return results;
}

/** The report: one line per check, then a summary line. */
export function formatSmokeReport(baseUrl: string, results: readonly SmokeResult[]): string {
  const failed = results.filter(({ ok }) => !ok).length;
  return [
    `smoke checks of ${new URL(baseUrl).origin}`,
    ...results.map(({ name, ok, detail }) => `  ${ok ? "ok  " : "FAIL"} ${name.padEnd(16)} ${detail}`),
    failed === 0 ? "all checks passed" : `${failed} of ${results.length} checks failed`,
  ].join("\n");
}

/** Parses `<url> [--chain <id>]`. */
export function parseArguments(argv: readonly string[]): { url: string; chainId: number } {
  const [url, ...rest] = argv;
  if (url === undefined || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new Error("usage: bun scripts/smoke-deployment.ts <https://deployment> [--chain 8453|84532]");
  }
  let chainId = DEFAULT_CHAIN_ID;
  if (rest.length > 0) {
    if (rest[0] !== "--chain" || rest.length !== 2 || !["8453", "84532"].includes(rest[1] ?? "")) {
      throw new Error("--chain takes 8453 or 84532");
    }
    chainId = Number(rest[1]);
  }
  return { url, chainId };
}

if (import.meta.main) {
  try {
    const { url, chainId } = parseArguments(process.argv.slice(2));
    const results = await runSmokeChecks(url, { chainId, bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET });
    console.log(formatSmokeReport(url, results));
    if (results.some(({ ok }) => !ok)) process.exitCode = 1;
  } catch (error) {
    console.error(`smoke-deployment: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
