/**
 * Sample data for the component reference page only. The index, the issuers, the prices and the addresses are
 * invented and do not describe any real asset. Shapes follow the units used across the product: weights and
 * changes in basis points, USD with 6 decimals, token quantities with 18 decimals, time in Unix seconds.
 */

export type SampleConstituent = {
  ticker: string;
  name: string;
  targetWeightBps: bigint;
  actualWeightBps: bigint;
  referencePriceUsd6: bigint;
  change24hBps: bigint;
  tokenAddress: string;
};

export const sampleIndex = {
  name: "Sample Compute Infrastructure 6",
  symbol: "SCI6",
  levelE2: 108_427n,
  return30dBps: 342n,
  maxWeightBps: 2_500n,
  trackedValueUsd6: 1_248_033_120_000n,
  walletQuantityE18: 4_203_100_000_000_000_000n,
  asOfUnixSeconds: 1_795_208_400n,
  priceSource: "Sample feed",
} as const;

export const sampleConstituents: readonly SampleConstituent[] = [
  {
    ticker: "NRTH",
    name: "Northfield Semiconductor",
    targetWeightBps: 2_500n,
    actualWeightBps: 2_821n,
    referencePriceUsd6: 184_270_000n,
    change24hBps: 142n,
    tokenAddress: "0x4f1a9c0d27b35e86a1c94d02f7e6b8a35d10c2e7",
  },
  {
    ticker: "HLIO",
    name: "Helio Cloud Systems",
    targetWeightBps: 2_000n,
    actualWeightBps: 1_962n,
    referencePriceUsd6: 412_050_000n,
    change24hBps: -38n,
    tokenAddress: "0x9b27e4a1c05d83f6b2e7190ac4d5f38e61b0a7d3",
  },
  {
    ticker: "CDRW",
    name: "Cedarwood Software",
    targetWeightBps: 1_800n,
    actualWeightBps: 1_733n,
    referencePriceUsd6: 1_208_900_000n,
    change24hBps: 0n,
    tokenAddress: "0x2c80d5f7a94b16e3c0d72f58b1a6e94d07c3f5a1",
  },
  {
    ticker: "BRWD",
    name: "Brightwater Devices",
    targetWeightBps: 1_500n,
    actualWeightBps: 1_402n,
    referencePriceUsd6: 67_420_000n,
    change24hBps: 305n,
    tokenAddress: "0x71e3b9a05c4d28f6e1a07b93d5c2f84a60e9d1b8",
  },
  {
    ticker: "ALTN",
    name: "Altona Data",
    targetWeightBps: 1_200n,
    actualWeightBps: 1_150n,
    referencePriceUsd6: 23_180_000n,
    change24hBps: -211n,
    tokenAddress: "0xe05a7c3d91b64f28a0c5e7d13b9f6a482d07c1e9",
  },
  {
    ticker: "KSTL",
    name: "Kestrel Robotics",
    targetWeightBps: 1_000n,
    actualWeightBps: 932n,
    referencePriceUsd6: 912_400n,
    change24hBps: 64n,
    tokenAddress: "0x3d96f0b2e7a15c48d3b0a6e92c7f1d5480b3e6a2",
  },
];
