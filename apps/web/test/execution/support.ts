import { readFileSync } from "node:fs";
import {
  type Address,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  type Hex,
  parseAbi,
} from "viem";
import type { ExecutionLeg } from "../../src/server/execution/plan";
import type { ProviderQuote, QuoteProvider, QuoteRequest } from "../../src/server/execution/provider";
import { POLICY_SCOPES, preTradeAbi } from "../../src/server/execution/reads";
import { KYBERSWAP_ROUTER, kyberswapRouterAbi, minimumAmountOut } from "../../src/server/execution/router";
import type { ExecutionClient } from "../../src/server/execution/simulate";
import { b20AssetAbi } from "../../src/server/market/abis";
import { USDC_ADDRESS } from "../../src/server/market/balances";
import { MULTICALL3_ADDRESS } from "../../src/server/market/onchain";
import { decodeAggregate3, encodeAggregate3Result } from "../market/support";

/** The recorded KyberSwap answers of `test/fixtures/execution/kyberswap.json`. */
export interface RecordedLeg {
  readonly name: string;
  readonly request: { readonly tokenIn: Address; readonly tokenOut: Address; readonly amountIn: string };
  readonly route: { readonly status: number; readonly body: Record<string, unknown> };
  readonly build: {
    readonly status: number;
    readonly body: {
      readonly data: { readonly data: Hex; readonly amountOut: string; readonly routerAddress: string };
    };
  };
}

// The fixture is written by the recorder in the shape of this interface.
export const kyberswapFixture = JSON.parse(
  readFileSync(new URL("../fixtures/execution/kyberswap.json", import.meta.url), "utf8"),
) as {
  readonly recordedAt: string;
  readonly account: Address;
  readonly slippageBps: number;
  readonly deadline: number;
  readonly legs: readonly RecordedLeg[];
  readonly routeNotFound: { readonly status: number; readonly body: unknown };
};

export const NVDA: Address = "0xb20000000000000000000078ee7ce2fe4908108c";
export const TSLA: Address = "0xb2000000000000000000001e800a7f5189430cd0";
export const ACCOUNT: Address = "0x00000000000000000000000000000000000a11ce";
/** Executor named in constructed calldata. Any address: the router allowlist does not cover it. */
const EXECUTOR: Address = "0x8f10b468b06c6fd214b65f87778827f7d113f996";

/** Tuesday 2026-11-24 15:00:00 UTC, 10:00 in New York: the regular session is open. */
export const OPEN_AT = 1_795_532_400;

export function sellLeg(overrides: Partial<ExecutionLeg> = {}): ExecutionLeg {
  // 0.03 NVDAc at 160.00 USD is 4.80 USDC at the reference price.
  return {
    side: "sell",
    token: NVDA,
    decimals: 8,
    tokenQuantity: 3_000_000n,
    quoteAmount: 4_800_000n,
    priceE8: 16_000_000_000n,
    priceStatus: "live",
    ...overrides,
  };
}

export function buyLeg(overrides: Partial<ExecutionLeg> = {}): ExecutionLeg {
  // 5.00 USDC of TSLAc at 400.00 USD is 0.0125 TSLAc at the reference price.
  return {
    side: "buy",
    token: TSLA,
    decimals: 8,
    tokenQuantity: 1_250_000n,
    quoteAmount: 5_000_000n,
    priceE8: 40_000_000_000n,
    priceStatus: "live",
    ...overrides,
  };
}

export interface ConstructedQuoteOptions {
  /** Executable price against the reference, in bps: +25 is 0.25% above. Defaults to 0. */
  readonly deviationBps?: bigint;
  /** Changes the answer before it is returned. */
  readonly tamper?: (quote: ProviderQuote, request: QuoteRequest) => ProviderQuote;
}

/** Router calldata for a request, in the shape the real router takes. Constructed, not a provider answer. */
export function swapCalldata(request: QuoteRequest, minReturnAmount: bigint, desc: Record<string, unknown> = {}): Hex {
  return encodeFunctionData({
    abi: kyberswapRouterAbi,
    functionName: "swap",
    args: [
      {
        callTarget: EXECUTOR,
        approveTarget: "0x0000000000000000000000000000000000000000",
        targetData: "0x01",
        desc: {
          srcToken: request.tokenIn,
          dstToken: request.tokenOut,
          srcReceivers: [EXECUTOR],
          srcAmounts: [request.amountIn],
          feeReceivers: [],
          feeAmounts: [],
          dstReceiver: request.account,
          amount: request.amountIn,
          minReturnAmount,
          flags: 0n,
          permit: "0x",
          ...desc,
        },
        clientData: "0x",
      },
    ],
  });
}

/**
 * A provider that quotes every leg at the reference price of `legs` moved by `deviationBps`, with calldata
 * built here. It stands in for the network in plan tests; the KyberSwap client is tested on recorded answers.
 */
export function constructedProvider(
  legs: readonly Pick<ExecutionLeg, "token" | "decimals" | "priceE8">[],
  options: ConstructedQuoteOptions = {},
) {
  const requests: QuoteRequest[] = [];
  const provider: QuoteProvider = {
    name: "kyberswap",
    async quote(request) {
      requests.push(request);
      const buy = request.tokenIn === USDC_ADDRESS;
      const leg = legs.find(({ token }) => token === (buy ? request.tokenOut : request.tokenIn));
      if (leg === undefined) return { status: "failed", reason: "no_route", detail: "4008" };
      const unit = 10n ** BigInt(leg.decimals);
      const factor = 10_000n + (options.deviationBps ?? 0n);
      const quoted = buy
        ? (request.amountIn * 100n * unit * 10_000n) / (leg.priceE8 * factor)
        : (request.amountIn * leg.priceE8 * factor) / (unit * 100n * 10_000n);
      const quote: ProviderQuote = {
        provider: "kyberswap",
        quotedAmountOut: quoted,
        amountIn: request.amountIn,
        router: KYBERSWAP_ROUTER,
        calldata: swapCalldata(request, minimumAmountOut(quoted, request.slippageBps)),
        value: 0n,
        gasEstimate: 300_000n,
        routeId: `constructed-${buy ? "buy" : "sell"}`,
      };
      return { status: "ok", quote: options.tamper?.(quote, request) ?? quote };
    },
  };
  return { provider, requests };
}

interface FakeToken {
  paused: boolean;
  balance: bigint;
  allowance: bigint;
  effectiveAt: bigint;
  /** Policy id of each scope. */
  policies: { sender: bigint; receiver: bigint; executor: bigint };
}

const boolAbi = parseAbi(["function read() view returns (bool)"]);
const tokenAbi = [...preTradeAbi, ...b20AssetAbi];
const swapResultAbi = parseAbi(["function swap() returns (uint256 returnAmount, uint256 gasUsed)"]);
const SELECTOR = (data: Hex) => data.slice(0, 10);
const lower = (address: Address): Address => `0x${address.slice(2).toLowerCase()}`;

/**
 * A Base mainnet node in memory for the pre-trade reads and the simulation. It answers the block, Multicall3,
 * `eth_simulateV1` and `eth_call`, from state the test sets. Every other request is an error.
 */
export class FakeExecutionChain {
  blockNumber = 61_000_000n;
  blockTimestamp = OPEN_AT - 2;
  readonly tokens = new Map<Address, FakeToken>();
  usdc = { paused: false, balance: 10_000_000n, allowance: 0n, blacklisted: new Set<Address>() };
  /** Accounts denied by a policy id. Policy 5 is the blocklist the issuer configures today. */
  readonly denied = new Map<bigint, Set<Address>>();
  simulation: "supported" | "unsupported" = "supported";
  /** Index of a call that reverts in the simulation, with the error data. */
  revert: { index: number; data: Hex } | null = null;
  readonly requests: string[] = [];

  token(address: Address, state: Partial<FakeToken> = {}): this {
    this.tokens.set(address, {
      paused: false,
      balance: 0n,
      allowance: 0n,
      effectiveAt: 0n,
      policies: { sender: 5n, receiver: 5n, executor: 5n },
      ...state,
    });
    return this;
  }

  deny(policyId: bigint, account: Address): this {
    this.denied.set(policyId, new Set([...(this.denied.get(policyId) ?? []), lower(account)]));
    return this;
  }

  private answer(target: Address, callData: Hex): { success: boolean; returnData: Hex } {
    const ok = (returnData: Hex) => ({ success: true, returnData });
    const bool = (value: boolean) => ok(encodeAbiParameters([{ type: "bool" }], [value]));
    const uint = (value: bigint) => ok(encodeAbiParameters([{ type: "uint256" }], [value]));
    if (target === MULTICALL3_ADDRESS.toLowerCase()) return uint(8453n);
    const token = this.tokens.get(target);
    const decoded = decodeFunctionData({ abi: tokenAbi, data: callData });
    switch (decoded.functionName) {
      case "isAuthorized": {
        const [id, account] = decoded.args;
        return bool(!(this.denied.get(id)?.has(lower(account)) ?? false));
      }
      case "paused":
        return bool(this.usdc.paused);
      case "isBlacklisted":
        return bool(this.usdc.blacklisted.has(lower(decoded.args[0])));
      case "balanceOf":
        return uint(target === USDC_ADDRESS ? this.usdc.balance : (token?.balance ?? 0n));
      case "allowance":
        return uint(target === USDC_ADDRESS ? this.usdc.allowance : (token?.allowance ?? 0n));
      case "isPaused":
        return token === undefined ? { success: false, returnData: "0x" } : bool(token.paused);
      case "effectiveAt":
        return token === undefined ? { success: false, returnData: "0x" } : uint(token.effectiveAt);
      case "policyId": {
        if (token === undefined) return { success: false, returnData: "0x" };
        const [scope] = decoded.args;
        const key =
          scope === POLICY_SCOPES.sender ? "sender" : scope === POLICY_SCOPES.receiver ? "receiver" : "executor";
        return uint(token.policies[key]);
      }
      default:
        throw new Error(`unexpected call ${decoded.functionName}`);
    }
  }

  /** The answer of one call of the plan: an approval returns true, a swap returns its minimum amount out. */
  private callResult(data: Hex): Hex {
    if (SELECTOR(data) === "0x095ea7b3")
      return encodeFunctionResult({ abi: boolAbi, functionName: "read", result: true });
    const decoded = decodeFunctionData({ abi: kyberswapRouterAbi, data });
    const desc = decoded.functionName === "swapSimpleMode" ? decoded.args[1] : decoded.args[0].desc;
    return encodeFunctionResult({
      abi: swapResultAbi,
      functionName: "swap",
      result: [desc.minReturnAmount, 120_000n],
    });
  }

  client(): ExecutionClient {
    const blockHex = `0x${this.blockNumber.toString(16)}`;
    const transport = custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
          this.requests.push(method);
          const list = Array.isArray(params) ? params : [];
          if (method === "eth_getBlockByNumber") {
            return { number: blockHex, timestamp: `0x${this.blockTimestamp.toString(16)}`, transactions: [] };
          }
          if (method === "eth_simulateV1") {
            if (this.simulation === "unsupported") throw Object.assign(new Error("method not found"), { code: -32601 });
            if (list[1] !== blockHex) throw new Error("simulation is not pinned to the read block");
            const calls =
              (list[0] as { blockStateCalls: { calls: { data: Hex }[] }[] }).blockStateCalls[0]?.calls ?? [];
            return [
              {
                calls: calls.map((call, index) =>
                  this.revert?.index === index
                    ? { status: "0x0", returnData: this.revert.data, error: { code: 3, data: this.revert.data } }
                    : { status: "0x1", returnData: this.callResult(call.data) },
                ),
              },
            ];
          }
          if (method !== "eth_call") throw new Error(`unexpected RPC method ${method}`);
          const [request, block] = list as [{ to: Address; data: Hex }, string];
          if (block !== blockHex) throw new Error(`call is not pinned to the read block: ${block}`);
          if (request.to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
            return encodeAggregate3Result(
              decodeAggregate3(request.data).map((call) => this.answer(lower(call.target), call.callData)),
            );
          }
          return this.callResult(request.data);
        },
      },
      { retryCount: 0 },
    );
    return createPublicClient({ transport });
  }
}
