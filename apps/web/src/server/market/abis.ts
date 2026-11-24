import "server-only";
import { parseAbi } from "viem";

/** Value of `PausableFeature.TRANSFER` in the B20 interface: `enum PausableFeature { TRANSFER, MINT, BURN, SEIZE }`. */
export const PAUSABLE_FEATURE_TRANSFER = 0;

/** The B20 asset functions this layer reads. Signatures as published in the B20 interfaces. */
export const b20AssetAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function isPaused(uint8 feature) view returns (bool)",
  "function multiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
]);

export const b20FactoryAbi = parseAbi(["function isB20Initialized(address token) view returns (bool)"]);

/** Chainlink AggregatorV3Interface, read through the feed proxy. */
export const aggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/**
 * Multicall3. `aggregate3` is payable onchain; it is declared `view` here because this layer only ever runs it
 * through `eth_call` and never sends a transaction.
 */
export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
  "function getChainId() view returns (uint256 chainid)",
]);

/** The one ERC-20 function read for an account. B20 tokens and USDC both implement it. */
export const erc20BalanceAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
