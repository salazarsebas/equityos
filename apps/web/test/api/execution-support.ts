import { type Address, decodeFunctionResult, encodeFunctionResult, type Hex, isAddress } from "viem";
import { executionPlanHandler } from "../../src/server/api/execution";
import { createExecutionLimits, type ExecutionLimits } from "../../src/server/execution/limits";
import type { QuoteProvider } from "../../src/server/execution/provider";
import type { ExecutionClient } from "../../src/server/execution/simulate";
import { aggregatorAbi } from "../../src/server/market/abis";
import { USDC_ADDRESS } from "../../src/server/market/balances";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";
import { constructedProvider, FakeExecutionChain, OPEN_AT } from "../execution/support";
import { callKey, onchainFixture } from "../market/support";
import { CONSTRUCTED_BALANCES, fixtureService, RECORDED_AT, recordedRegistry } from "./support";

export const INDEX = "diversified-equity-d622e2a5";
/** Constructed account of `test/fixtures/market/balances.json`, above the drift threshold. */
export const ABOVE: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const recorded = new Map(onchainFixture.calls.map((call) => [callKey(call.target, call.callData), call]));
const proxies = new Set([...REFERENCE_FEEDS.values()].map(({ proxy }) => proxy.toLowerCase()));

/**
 * Serves the recorded rounds of every reference feed with `updatedAt` moved to `at`, so that the recorded
 * prices read as live at a time the market is open. The answers are the recorded ones.
 */
function publishedAt(at: number) {
  return (call: { target: Address; callData: Hex }) => {
    if (!proxies.has(call.target.toLowerCase())) return undefined;
    const answer = recorded.get(callKey(call.target, call.callData));
    if (answer === undefined || !answer.success) return undefined;
    try {
      const [roundId, price, startedAt, , answeredInRound] = decodeFunctionResult({
        abi: aggregatorAbi,
        functionName: "latestRoundData",
        data: answer.returnData,
      });
      const result = [roundId, price, startedAt, BigInt(at), answeredInRound] as const;
      return {
        success: true,
        returnData: encodeFunctionResult({ abi: aggregatorAbi, functionName: "latestRoundData", result }),
      };
    } catch {
      return undefined;
    }
  };
}

function address(value: string): Address {
  if (!isAddress(value)) throw new Error(`${value} is not an address`);
  return value;
}

/** The execution chain holds the constructed balances of the account, without any allowance. */
function chainOf(account: string): FakeExecutionChain {
  const chain = new FakeExecutionChain();
  const tokens = CONSTRUCTED_BALANCES[account]?.tokens ?? {};
  chain.usdc.balance = BigInt(tokens[USDC_ADDRESS] ?? "0");
  for (const [token, balance] of Object.entries(tokens)) {
    if (token !== USDC_ADDRESS) chain.token(address(token), { balance: BigInt(balance) });
  }
  for (const token of ["0xb2000000000000000000002d0ba3164cc74f58b7", "0xb200000000000000000000d9192b6b456483c2e8"]) {
    if (!(token in tokens)) chain.token(address(token));
  }
  return chain;
}

export interface Setup {
  readonly at?: number;
  readonly chain?: FakeExecutionChain;
  readonly client?: ExecutionClient;
  readonly marketMode?: "live" | "replay";
  readonly nodeEnv?: string;
  readonly limits?: ExecutionLimits;
  readonly deadlineMs?: number;
  /** Replaces the provider; it receives the provider the default setup would use. */
  readonly provider?: (base: QuoteProvider) => QuoteProvider;
}

export async function setup(options: Setup = {}) {
  const at = options.at ?? OPEN_AT;
  const service = fixtureService(at, { override: publishedAt(at - 60) });
  const snapshot = await service.marketData().getSnapshot();
  const prices = [...snapshot.assets].flatMap(([token, entry]) =>
    entry.referencePrice !== null && entry.referencePrice.status !== "unavailable"
      ? [{ token, decimals: entry.asset.decimals, priceE8: entry.referencePrice.priceE8 }]
      : [],
  );
  const chain = options.chain ?? chainOf(ABOVE);
  const base = constructedProvider(prices).provider;
  const provider = options.provider?.(base) ?? base;
  return executionPlanHandler({
    registry: () => recordedRegistry(),
    mode: () => "replay",
    marketData: service.marketData,
    marketMode: () => options.marketMode ?? "live",
    now: () => at,
    provider: () => provider,
    executionClient: () => options.client ?? chain.client(),
    env: { NODE_ENV: options.nodeEnv ?? "production" },
    limits: options.limits ?? createExecutionLimits(),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });
}

let requests = 0;

/**
 * A POST of the execution plan. Each request comes from its own address unless `headers` names one, so that the
 * per-address limit applies only where a test is about it.
 */
export function post(payload: unknown, headers: Record<string, string> = { "x-vercel-ip-country": "DE" }): Request {
  requests += 1;
  return new Request("https://equityos.test/api/v1/portfolio/execution-plan", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `198.51.100.${requests % 250}`, ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

export const READY_BODY = { address: ABOVE, index: INDEX, mode: "rebalance" };

/** Responses of every documented state, for the OpenAPI test. */
export async function executionResponses(): Promise<Response[]> {
  const handler = await setup();
  const unreachable: ExecutionClient = {
    ...new FakeExecutionChain().client(),
    request: async () => {
      throw new Error("down");
    },
    getBlock: async () => {
      throw new Error("down");
    },
  };
  return [
    await handler(post(READY_BODY), undefined),
    await handler(post(READY_BODY, { "x-vercel-ip-country": "US" }), undefined),
    await (await setup({ at: RECORDED_AT }))(post(READY_BODY), undefined),
    await handler(post({ ...READY_BODY, slippageBps: 201 }), undefined),
    await handler(post({ ...READY_BODY, index: `0x${"1".repeat(64)}` }), undefined),
    await (await setup({ marketMode: "replay" }))(post(READY_BODY), undefined),
    await (await setup({ client: unreachable }))(post(READY_BODY), undefined),
  ];
}
