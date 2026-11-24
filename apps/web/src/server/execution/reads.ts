import "server-only";
import { type Address, decodeFunctionResult, encodeFunctionData, type Hex, keccak256, parseAbi, toHex } from "viem";
import { MissingConfigurationError, UpstreamError, USDC_ADDRESS } from "@/server/market";
import { b20AssetAbi, PAUSABLE_FEATURE_TRANSFER } from "@/server/market/abis";
import { aggregate, type Call, decode, type MarketClient, readAtLatestBlock } from "@/server/market/onchain";
import type { Authorization } from "./checks";

/** B20 policy registry precompile, as in the base-std `StdPrecompiles` constants. */
export const POLICY_REGISTRY_ADDRESS: Address = "0x8453000000000000000000000000000000000002";

/**
 * Policy scopes of the B20 interface. Each is the keccak256 of its name, which is what
 * `TRANSFER_SENDER_POLICY()` and the two others return on Base mainnet. Pinned rather than read so that the
 * policy ids can be read in the same request; a test recomputes them and the live test reads them back.
 */
export const POLICY_SCOPES = {
  sender: keccak256(toHex("TRANSFER_SENDER_POLICY")),
  receiver: keccak256(toHex("TRANSFER_RECEIVER_POLICY")),
  executor: keccak256(toHex("TRANSFER_EXECUTOR_POLICY")),
} as const;

export const preTradeAbi = parseAbi([
  "function policyId(bytes32 policyScope) view returns (uint64)",
  "function isAuthorized(uint64 policyId, address account) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function paused() view returns (bool)",
  "function isBlacklisted(address account) view returns (bool)",
]);

/** What the checks need to know about one token, for one account and the router, at one block. */
export interface TokenPreTradeRead {
  readonly paused: boolean | null;
  readonly authorization: Authorization;
  readonly balance: bigint | null;
  /** Allowance of the account toward the router. */
  readonly allowance: bigint | null;
  /** B20 only: recorded effective time of the latest multiplier update, `0` when none. `null` if unread. */
  readonly multiplierEffectiveAt: number | null;
}

export interface PreTradeRead {
  readonly blockNumber: bigint;
  readonly blockTimestamp: number;
  /** Keyed by lowercase token address. USDC is always present. */
  readonly tokens: ReadonlyMap<Address, TokenPreTradeRead>;
}

const uintResult = parseAbi(["function read() view returns (uint256)"]);
const boolResult = parseAbi(["function read() view returns (bool)"]);

/** A uint256 answer, or `null` when the call reverted or did not answer one. */
function uintOf(data: Hex | null | undefined): bigint | null {
  return decode(data, (value) => decodeFunctionResult({ abi: uintResult, functionName: "read", data: value }));
}

/** A bool answer, or `null` when the call reverted or did not answer one. */
function boolOf(data: Hex | null | undefined): boolean | null {
  return decode(data, (value) => decodeFunctionResult({ abi: boolResult, functionName: "read", data: value }));
}

const not = (value: boolean | null): boolean | null => (value === null ? null : !value);

function safeSeconds(value: bigint | null): number | null {
  return value !== null && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

/**
 * Reads, for `account` and `router`, everything the pre-trade checks need about USDC and each B20 token, at
 * one block: one Multicall3 request at the latest block (pause, policy ids, balance, allowance, multiplier
 * schedule; for USDC its pause and blacklist), then one at the same block for `isAuthorized` of the policy ids
 * it returned. Read-only.
 *
 * @throws {UpstreamError} if the endpoint fails.
 * @throws {MissingConfigurationError} if the endpoint is not Base mainnet.
 */
export async function readPreTrade(
  client: MarketClient,
  account: Address,
  router: Address,
  tokens: readonly Address[],
): Promise<PreTradeRead> {
  const b20 = tokens.filter((token) => token !== USDC_ADDRESS);
  const usdcCalls: Call[] = [
    encodeFunctionData({ abi: preTradeAbi, functionName: "paused" }),
    encodeFunctionData({ abi: preTradeAbi, functionName: "isBlacklisted", args: [account] }),
    encodeFunctionData({ abi: preTradeAbi, functionName: "isBlacklisted", args: [router] }),
    encodeFunctionData({ abi: preTradeAbi, functionName: "balanceOf", args: [account] }),
    encodeFunctionData({ abi: preTradeAbi, functionName: "allowance", args: [account, router] }),
  ].map((callData) => ({ target: USDC_ADDRESS, callData }));
  const tokenCalls = (token: Address): Call[] =>
    [
      encodeFunctionData({ abi: b20AssetAbi, functionName: "isPaused", args: [PAUSABLE_FEATURE_TRANSFER] }),
      encodeFunctionData({ abi: b20AssetAbi, functionName: "effectiveAt" }),
      ...[POLICY_SCOPES.sender, POLICY_SCOPES.receiver, POLICY_SCOPES.executor].map((scope) =>
        encodeFunctionData({ abi: preTradeAbi, functionName: "policyId", args: [scope] }),
      ),
      encodeFunctionData({ abi: preTradeAbi, functionName: "balanceOf", args: [account] }),
      encodeFunctionData({ abi: preTradeAbi, functionName: "allowance", args: [account, router] }),
    ].map((callData) => ({ target: token, callData }));
  const first = await readAtLatestBlock(client, [...usdcCalls, ...b20.flatMap(tokenCalls)]);
  const at = (index: number) => first.results[index];
  const policies = b20.map((_, i) => {
    const base = usdcCalls.length + i * 7;
    // A policy id is a uint64: a wider answer is not one.
    return [2, 3, 4].map((offset) => {
      const id = uintOf(at(base + offset));
      return id !== null && id < 2n ** 64n ? id : null;
    });
  });
  const authorizationCalls: Call[] = [];
  b20.forEach((_, i) => {
    const holders = [account, account, router];
    policies[i]?.forEach((id, scope) => {
      const holder = holders[scope] ?? account;
      // A policy id that was not read is still asked about with id 0, and the answer is discarded below.
      authorizationCalls.push({
        target: POLICY_REGISTRY_ADDRESS,
        callData: encodeFunctionData({ abi: preTradeAbi, functionName: "isAuthorized", args: [id ?? 0n, holder] }),
      });
    });
  });
  let second: readonly (Hex | null)[] = [];
  if (authorizationCalls.length > 0) {
    try {
      second = await aggregate(client, authorizationCalls, first.blockNumber);
    } catch (cause) {
      if (cause instanceof UpstreamError || cause instanceof MissingConfigurationError) throw cause;
      throw new UpstreamError("base_rpc", "authorization read failed", { cause });
    }
  }
  const reads = new Map<Address, TokenPreTradeRead>();
  reads.set(USDC_ADDRESS, {
    paused: boolOf(at(0)),
    authorization: {
      sender: not(boolOf(at(1))),
      receiver: not(boolOf(at(1))),
      executor: not(boolOf(at(2))),
    },
    balance: uintOf(at(3)),
    allowance: uintOf(at(4)),
    multiplierEffectiveAt: 0,
  });
  b20.forEach((token, i) => {
    const base = usdcCalls.length + i * 7;
    const authorized = (scope: number): boolean | null =>
      policies[i]?.[scope] === null ? null : boolOf(second[i * 3 + scope]);
    reads.set(token, {
      paused: boolOf(at(base)),
      authorization: { sender: authorized(0), receiver: authorized(1), executor: authorized(2) },
      balance: uintOf(at(base + 5)),
      allowance: uintOf(at(base + 6)),
      multiplierEffectiveAt: safeSeconds(uintOf(at(base + 1))),
    });
  });
  return { blockNumber: first.blockNumber, blockTimestamp: first.blockTimestamp, tokens: reads };
}
