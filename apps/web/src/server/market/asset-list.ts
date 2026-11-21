import "server-only";
import type { Address } from "viem";
import { MalformedResponseError, UpstreamError } from "./errors";

/** Coinbase tokenized stocks API: the issuer's list of tokens on Base mainnet. Public and keyless. */
export const ASSET_LIST_URL = "https://api.coinbase.com/v1/tokenized-stocks";

/** Largest page the API serves. The whole list currently fits in one page; pagination is followed regardless. */
const PAGE_SIZE = 500;
/** Upper bound on pages followed, so that a misbehaving upstream cannot keep the loop alive. */
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;
/** Attempts per page, including the first. Only transport errors, timeouts, 429 and 5xx are retried. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const MAX_TOKEN_DECIMALS = 36;

/**
 * A token of the issuer's list. Only identity fields are kept. The API also reports supply, multiplier and a
 * NAV price as JSON numbers: they are validated but not exposed, because the chain is the source for supply and
 * multiplier, the reference feed is the source for price, and none of them may pass through a floating-point
 * number.
 */
export interface ListedAsset {
  /** Token address on Base mainnet, lowercase. The only stable identifier of a token. */
  readonly address: Address;
  /** Display symbol. Mutable onchain: never use it as a key. */
  readonly symbol: string;
  readonly name: string;
  /** Decimals as reported by the API. Checked against the chain before use. */
  readonly decimals: number;
  readonly isin: string | null;
  readonly iconUrl: string | null;
}

/** The asset list, keyed by lowercase token address. */
export type AssetList = ReadonlyMap<Address, ListedAsset>;

export interface AssetListOptions {
  readonly fetch?: typeof fetch;
  /** Waits between retries. Injected by tests. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const OPTIONAL_STRING_FIELDS = ["isin", "icon_url", "description", "first_mint_date", "adgm_isin"] as const;
const OPTIONAL_NUMBER_FIELDS = ["total_supply", "multiplier", "nav_price"] as const;

function malformed(path: string, problem: string): MalformedResponseError {
  return new MalformedResponseError("coinbase_api", path, problem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw malformed(`${path}.${key}`, "is not a non-empty string");
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | null {
  return record[key] === undefined ? null : requireString(record, key, path);
}

function parseToken(value: unknown, path: string): ListedAsset {
  if (!isRecord(value)) throw malformed(path, "is not an object");
  const contractAddress = requireString(value, "contract_address", path);
  if (!ADDRESS_PATTERN.test(contractAddress)) throw malformed(`${path}.contract_address`, "is not a 20-byte address");
  const decimals = value.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw malformed(`${path}.decimals`, `is not an integer between 0 and ${MAX_TOKEN_DECIMALS}`);
  }
  // Fields that are not exposed are still checked: a type change in any of them means the contract of the API
  // changed and the rest of the payload cannot be trusted either.
  for (const key of OPTIONAL_STRING_FIELDS) optionalString(value, key, path);
  for (const key of OPTIONAL_NUMBER_FIELDS) {
    const field = value[key];
    if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field) || field < 0)) {
      throw malformed(`${path}.${key}`, "is not a non-negative finite number");
    }
  }
  if ((value.nav_price === undefined) !== (value.nav_price_updated_at === undefined)) {
    throw malformed(`${path}.nav_price`, "and nav_price_updated_at are not both present or both absent");
  }
  if (value.nav_price_updated_at !== undefined) requireString(value, "nav_price_updated_at", path);
  return {
    address: `0x${contractAddress.slice(2).toLowerCase()}`,
    symbol: requireString(value, "symbol", path),
    name: requireString(value, "name", path),
    decimals,
    isin: optionalString(value, "isin", path),
    iconUrl: optionalString(value, "icon_url", path),
  };
}

interface AssetListPage {
  readonly tokens: readonly ListedAsset[];
  readonly nextPageToken: string | null;
}

/**
 * Parses one page of the API response. Any deviation from the expected shape throws: a missing required field,
 * a field of the wrong type, or a token list that is not an array. Unknown additional fields are ignored, since
 * the API adds fields without notice and omits fields that hold a default value.
 *
 * @throws {MalformedResponseError}
 */
export function parseAssetListPage(payload: unknown): AssetListPage {
  if (!isRecord(payload)) throw malformed("$", "is not an object");
  if (!Array.isArray(payload.tokens)) throw malformed("$.tokens", "is not an array");
  return {
    tokens: payload.tokens.map((token, index) => parseToken(token, `$.tokens[${index}]`)),
    nextPageToken: optionalString(payload, "next_page_token", "$"),
  };
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false;
  return error.status === null || error.status === 429 || error.status >= 500;
}

async function requestPage(fetcher: typeof fetch, pageToken: string | null): Promise<AssetListPage> {
  const url = new URL(ASSET_LIST_URL);
  url.searchParams.set("page_size", String(PAGE_SIZE));
  if (pageToken !== null) url.searchParams.set("page_token", pageToken);
  let response: Response;
  let body: string;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (cause) {
    throw new UpstreamError("coinbase_api", "request failed or timed out", { cause });
  }
  if (!response.ok) {
    throw new UpstreamError("coinbase_api", `responded with HTTP ${response.status}`, { status: response.status });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw malformed("$", "is not valid JSON");
  }
  return parseAssetListPage(payload);
}

async function requestPageWithRetry(
  fetcher: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  pageToken: string | null,
): Promise<AssetListPage> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await requestPage(fetcher, pageToken);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Fetches every page of the asset list.
 *
 * @throws {UpstreamError} if a page cannot be fetched after the bounded retries.
 * @throws {MalformedResponseError} if a page does not have the expected shape, a token appears twice, or the
 *   pagination does not terminate.
 */
export async function fetchAssetList(options: AssetListOptions = {}): Promise<AssetList> {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const assets = new Map<Address, ListedAsset>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { tokens, nextPageToken } = await requestPageWithRetry(fetcher, sleep, pageToken);
    for (const token of tokens) {
      if (assets.has(token.address)) throw malformed("$.tokens", `lists ${token.address} more than once`);
      assets.set(token.address, token);
    }
    if (nextPageToken === null) {
      if (assets.size === 0) throw malformed("$.tokens", "is empty");
      return assets;
    }
    if (seenPageTokens.has(nextPageToken)) throw malformed("$.next_page_token", "repeats an earlier page token");
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  throw malformed("$.next_page_token", `is still present after ${MAX_PAGES} pages`);
}
