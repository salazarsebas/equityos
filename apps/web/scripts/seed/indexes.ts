import { type Address, computeConstituents, type Hex, type IndexSpec, specHash, validateSpec } from "@equityos/core";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";

/** One version to publish: the spec, its canonical bytes and the composition mirror the registry stores. */
export interface SeedVersion {
  readonly spec: IndexSpec;
  readonly specBytes: Uint8Array;
  /** keccak256 of `specBytes`, which the registry must compute as well. */
  readonly specHash: Hex;
  readonly tokens: readonly Address[];
  readonly weightsBps: readonly number[];
}

export interface SeedIndex {
  /** Salt passed to `createIndex`. With the creator it determines the index id. */
  readonly salt: Hex;
  readonly versions: readonly SeedVersion[];
}

interface Holding {
  /** Ticker in the description of the reference feed, used only to pick the token from the feed map. */
  readonly ticker: string;
  /** Fixed weight in basis points. Omitted for equal weighting. */
  readonly weightBps?: number;
}

interface VersionDraft {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly holdings: readonly Holding[];
  readonly constraints?: IndexSpec["constraints"];
}

/** The token and feed proxy of a feed-covered asset, lowercase, looked up by the ticker in the feed description. */
function feedCoveredAsset(ticker: string): { token: Address; feed: Address } {
  for (const [token, feed] of REFERENCE_FEEDS) {
    if (feed.description === `Coinbase ${ticker}` || feed.description === `Coinbase ${ticker} / USD`) {
      return { token, feed: `0x${feed.proxy.slice(2).toLowerCase()}` };
    }
  }
  throw new Error(`no reference feed is mapped for ${ticker}`);
}

function buildVersion(chainId: number, draft: VersionDraft): SeedVersion {
  // A spec lists its tokens in ascending order, with the feeds and weights at the same positions.
  const assets = draft.holdings
    .map((holding) => ({ ...holding, ...feedCoveredAsset(holding.ticker) }))
    .sort((a, b) => (a.token < b.token ? -1 : 1));
  const weightsBps = assets.flatMap(({ weightBps }) => weightBps ?? []);
  const fixed = weightsBps.length === assets.length;
  if (!fixed && weightsBps.length > 0) throw new Error(`${draft.slug}: every holding needs a weight, or none`);
  const validation = validateSpec({
    schema: "equityos.index/1",
    calc: "equityos.calc/1",
    chainId,
    name: draft.name,
    slug: draft.slug,
    description: draft.description,
    universe: { type: "static", tokens: assets.map(({ token }) => token) },
    weighting: fixed ? { type: "fixed", weightsBps } : { type: "equal" },
    ...(draft.constraints === undefined ? {} : { constraints: draft.constraints }),
    pricing: { source: "chainlink-aggregator-v3", feeds: assets.map(({ feed }) => feed) },
    rebalance: { trigger: "drift", driftThresholdBps: 500, minIntervalSeconds: 604_800 },
  });
  if (!validation.ok) {
    throw new Error(`${draft.slug}: ${validation.errors.map(({ path, message }) => `${path} ${message}`).join("; ")}`);
  }
  const { spec, specBytes } = validation;
  const constituents = computeConstituents(spec);
  return {
    spec,
    specBytes,
    specHash: specHash(specBytes),
    tokens: constituents.map(({ token }) => token),
    weightsBps: constituents.map(({ weightBps }) => weightBps),
  };
}

/** UTF-8 text right-padded with zero bytes to 32 bytes. */
function salt(text: string): Hex {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) throw new Error(`salt text is longer than 32 bytes: ${text}`);
  return `0x${Buffer.from(bytes).toString("hex").padEnd(64, "0")}`;
}

/**
 * The example indexes of a local chain: one equal-weight index, one with fixed weights and weight bounds,
 * and one with two versions.
 *
 * The constituents are the Base mainnet addresses of tokens that have a reference feed in the market data
 * layer, and the feeds are their Base mainnet proxies. The registry stores addresses and calls none of them,
 * so they are publishable on a chain where those tokens do not exist. Each spec declares `chainId`, the chain
 * it is published on, because verification rejects a spec read from any other chain.
 */
export function buildSeedIndexes(chainId: number): SeedIndex[] {
  return [
    {
      salt: salt("equityos.seed.large-technology"),
      versions: [
        buildVersion(chainId, {
          name: "Large Technology Equal Weight",
          slug: "large-technology-equal",
          description: "Five large technology companies, each at the same weight.",
          holdings: [
            { ticker: "AAPL" },
            { ticker: "AMZN" },
            { ticker: "GOOGL" },
            { ticker: "META" },
            { ticker: "MSFT" },
          ],
        }),
      ],
    },
    {
      salt: salt("equityos.seed.semiconductors"),
      versions: [
        buildVersion(chainId, {
          name: "Semiconductors Fixed Weight",
          slug: "semiconductors-fixed",
          description: "Three semiconductor companies at fixed weights, each between 10% and 50%.",
          holdings: [
            { ticker: "NVDA", weightBps: 5_000 },
            { ticker: "INTC", weightBps: 3_000 },
            { ticker: "SNDK", weightBps: 2_000 },
          ],
          constraints: { maxWeightBps: 5_000, minWeightBps: 1_000 },
        }),
      ],
    },
    {
      salt: salt("equityos.seed.diversified"),
      versions: [
        buildVersion(chainId, {
          name: "Diversified Equity",
          slug: "diversified-equity",
          description: "Four companies from different industries, each at the same weight.",
          holdings: [{ ticker: "AAPL" }, { ticker: "MSTR" }, { ticker: "NVDA" }, { ticker: "TSLA" }],
        }),
        buildVersion(chainId, {
          name: "Diversified Equity",
          slug: "diversified-equity",
          description: "Five companies from different industries at fixed weights. Version 2 adds a fifth company.",
          holdings: [
            { ticker: "AAPL", weightBps: 2_500 },
            { ticker: "AMZN", weightBps: 1_500 },
            { ticker: "MSTR", weightBps: 1_000 },
            { ticker: "NVDA", weightBps: 2_500 },
            { ticker: "TSLA", weightBps: 2_500 },
          ],
          constraints: { maxWeightBps: 2_500 },
        }),
      ],
    },
  ];
}
