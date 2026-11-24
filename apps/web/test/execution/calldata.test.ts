import { describe, expect, test } from "bun:test";
import { type Address, decodeFunctionData, encodeFunctionData, type Hex, parseAbi, toFunctionSelector } from "viem";
import {
  ALLOWED_FLAGS,
  isExactApproval,
  EXECUTOR_DATA_HEADER,
  KYBERSWAP_EXECUTOR,
  KYBERSWAP_ROUTER,
  kyberswapRouterAbi,
  minimumAmountOut,
  type ProviderQuote,
  type QuoteRequest,
  SWAP_SELECTOR,
  verifyQuote,
} from "../../src/lib/execution/calldata";
import { executorData, kyberswapFixture, type RecordedLeg, swapCalldata } from "./support";

/** The request a recorded leg was built for, and the provider quote its build answer stands for. */
function recorded(leg: RecordedLeg): { request: QuoteRequest; quote: ProviderQuote } {
  const request: QuoteRequest = {
    tokenIn: leg.request.tokenIn,
    tokenOut: leg.request.tokenOut,
    amountIn: BigInt(leg.request.amountIn),
    account: kyberswapFixture.account,
    slippageBps: kyberswapFixture.slippageBps,
    deadline: kyberswapFixture.deadline,
  };
  const data = leg.build.body.data;
  const quote: ProviderQuote = {
    provider: "kyberswap",
    quotedAmountOut: BigInt(data.amountOut),
    amountIn: request.amountIn,
    router: data.routerAddress.toLowerCase() as Address,
    calldata: data.data,
    value: 0n,
    gasEstimate: 600_000n,
    routeId: leg.name,
  };
  return { request, quote };
}

const [buy, sell] = kyberswapFixture.legs;
if (buy === undefined || sell === undefined) throw new Error("the fixture holds three legs");

/** The decoded `swap` arguments of a recorded leg. */
function execution(leg: RecordedLeg) {
  const decoded = decodeFunctionData({ abi: kyberswapRouterAbi, data: leg.build.body.data.data });
  return decoded.args[0];
}

describe("allowlists, against every recorded answer", () => {
  test("the router, the function, the executor, the approval target and the flags are the recorded ones", () => {
    expect(KYBERSWAP_ROUTER).toBe("0x6131b5fae19ea4f9d964eac0408e4408b66337b5");
    expect(KYBERSWAP_EXECUTOR).toBe("0x8f10b468b06c6fd214b65f87778827f7d113f996");
    expect(SWAP_SELECTOR).toBe(
      toFunctionSelector(
        "function swap((address,address,bytes,(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes),bytes))",
      ),
    );
    expect([...ALLOWED_FLAGS]).toEqual([0x200n]);
    for (const leg of kyberswapFixture.legs) {
      expect(leg.build.body.data.routerAddress.toLowerCase()).toBe(KYBERSWAP_ROUTER);
      expect(leg.build.body.data.data.slice(0, 10)).toBe(SWAP_SELECTOR);
      const { callTarget, approveTarget, desc, targetData } = execution(leg);
      expect(callTarget.toLowerCase()).toBe(KYBERSWAP_EXECUTOR);
      expect(approveTarget).toBe("0x0000000000000000000000000000000000000000");
      expect(desc.srcReceivers.map((receiver) => receiver.toLowerCase())).toEqual([KYBERSWAP_EXECUTOR]);
      expect(ALLOWED_FLAGS.has(desc.flags)).toBe(true);
      expect(targetData.toLowerCase().startsWith(EXECUTOR_DATA_HEADER)).toBe(true);
    }
  });
});

describe("verifyQuote on recorded calldata", () => {
  test("accepts every recorded build, takes the minimum from the calldata and decodes the deadline", () => {
    for (const leg of kyberswapFixture.legs) {
      const { request, quote } = recorded(leg);
      const verified = verifyQuote(request, quote);
      if (verified.status !== "ok") throw new Error(`${leg.name}: ${verified.reason} ${verified.detail}`);
      expect(verified.quote.functionName).toBe("swap");
      expect(verified.quote.minAmountOut).toBe(minimumAmountOut(quote.quotedAmountOut, 50));
      expect(verified.quote.deadline).toBe(kyberswapFixture.deadline);
    }
  });

  test("refuses calldata addressed to any other contract, the other router of the provider included", () => {
    const { request, quote } = recorded(buy);
    for (const router of ["0x6868d319c8c9a78f7d39dc3602c5c917315132d7", "0x1111111254eeb25477b68fb85ed929f73a960582"]) {
      expect(verifyQuote(request, { ...quote, router: router as Address })).toEqual({
        status: "failed",
        reason: "router_not_allowed",
        detail: router,
      });
    }
  });

  test("refuses every function other than swap, the router's two other swap functions included", () => {
    const { request, quote } = recorded(buy);
    const others = parseAbi([
      "function transferOwnership(address newOwner)",
      "function rescueFunds(address token, uint256 amount)",
    ]);
    const calls: Hex[] = [
      encodeFunctionData({ abi: others, functionName: "transferOwnership", args: [request.account] }),
      encodeFunctionData({ abi: others, functionName: "rescueFunds", args: [request.tokenIn, 1n] }),
      `0x59e50fed${quote.calldata.slice(10)}`,
      `0x8af033fb${quote.calldata.slice(10)}`,
      `0xdeadbeef${quote.calldata.slice(10)}`,
    ];
    for (const calldata of calls) {
      const verified = verifyQuote(request, { ...quote, calldata });
      expect(verified.status === "failed" && verified.reason).toBe("unknown_selector");
    }
  });

  test("refuses trailing bytes and truncated calldata", () => {
    const { request, quote } = recorded(buy);
    expect(verifyQuote(request, { ...quote, calldata: `${quote.calldata}00` })).toEqual({
      status: "failed",
      reason: "calldata_mismatch",
      detail: "encoding",
    });
    expect(verifyQuote(request, { ...quote, calldata: `${quote.calldata}${"00".repeat(32)}` })).toMatchObject({
      detail: "encoding",
    });
    const truncated = verifyQuote(request, { ...quote, calldata: quote.calldata.slice(0, 200) as Hex });
    expect(truncated).toEqual({ status: "failed", reason: "calldata_mismatch", detail: "undecodable" });
  });

  test("refuses another executor, an approval target, or source receivers other than the executor", () => {
    const { request, quote } = recorded(buy);
    const minimum = minimumAmountOut(quote.quotedAmountOut, 50);
    const variant = (desc: Record<string, unknown>, change: Record<string, unknown>) =>
      verifyQuote(request, { ...quote, calldata: swapCalldata(request, minimum, desc, change) });
    expect(variant({}, {})).toMatchObject({ status: "ok" });
    const other = "0x000000000000000000000000000000000000beef";
    expect(variant({}, { callTarget: other })).toMatchObject({ reason: "executor_not_allowed" });
    expect(variant({}, { approveTarget: other })).toMatchObject({ reason: "executor_not_allowed" });
    expect(variant({ srcReceivers: [other] }, {})).toMatchObject({ reason: "executor_not_allowed" });
    expect(
      variant({ srcReceivers: [KYBERSWAP_EXECUTOR, KYBERSWAP_EXECUTOR], srcAmounts: [request.amountIn, 0n] }, {}),
    ).toMatchObject({ reason: "executor_not_allowed" });
  });

  test("accepts only the recorded flags value", () => {
    const { request, quote } = recorded(buy);
    const minimum = minimumAmountOut(quote.quotedAmountOut, 50);
    const withFlags = (flags: bigint) =>
      verifyQuote(request, { ...quote, calldata: swapCalldata(request, minimum, { flags }) });
    expect(withFlags(0x200n)).toMatchObject({ status: "ok" });
    for (const flags of [0n, 0x01n, 0x02n, 0x20n, 0x40n, 0x201n, 0x220n]) {
      expect(withFlags(flags)).toEqual({ status: "failed", reason: "flags_not_allowed", detail: flags.toString() });
    }
  });

  test("reads the recipient and the deadline of the executor data, and refuses another layout", () => {
    const { request, quote } = recorded(buy);
    const minimum = minimumAmountOut(quote.quotedAmountOut, 50);
    const withData = (targetData: Hex) =>
      verifyQuote(request, { ...quote, calldata: swapCalldata(request, minimum, {}, { targetData }) });
    expect(withData(executorData(request.account, 1_800_000_000))).toMatchObject({
      status: "ok",
      quote: { deadline: 1_800_000_000 },
    });
    expect(withData(executorData("0x000000000000000000000000000000000000dead", request.deadline))).toMatchObject({
      reason: "calldata_mismatch",
      detail: "executorRecipient",
    });
    const unrecognized = { status: "failed", reason: "executor_data_unrecognized", detail: "layout" } as const;
    expect(withData(executorData(request.account, request.deadline, 16))).toEqual(unrecognized);
    expect(withData(`0xd7a5c6b5${executorData(request.account, request.deadline).slice(10 + 32)}`)).toEqual(
      unrecognized,
    );
    expect(withData(`0x00${executorData(request.account, request.deadline).slice(4)}`)).toEqual(unrecognized);
    expect(withData(executorData(request.account, Number.MAX_SAFE_INTEGER))).toMatchObject({ status: "ok" });
    expect(withData(executorData(request.account, 2n ** 60n))).toEqual(unrecognized);
  });

  test("refuses a quote whose amount, tokens or receiver differ from the request", () => {
    const { request, quote } = recorded(sell);
    const mismatch = (changed: QuoteRequest) => {
      const verified = verifyQuote(changed, quote);
      return verified.status === "failed" ? verified.detail : "accepted";
    };
    expect(mismatch({ ...request, amountIn: request.amountIn + 1n })).toBe("amountIn,amount,srcAmounts");
    expect(mismatch({ ...request, account: "0x000000000000000000000000000000000000dead" })).toBe(
      "dstReceiver,executorRecipient",
    );
    expect(mismatch({ ...request, tokenOut: request.tokenIn, tokenIn: request.tokenOut })).toBe("srcToken,dstToken");
    expect(verifyQuote(request, { ...quote, value: 1n })).toMatchObject({ detail: "value" });
  });

  test("recomputes the minimum: a quote whose calldata allows less than the requested tolerance is refused", () => {
    const { request, quote } = recorded(buy);
    // The recorded minimum is 50 bps under the quote; asked for 10 bps, it allows more loss than requested.
    expect(verifyQuote({ ...request, slippageBps: 10 }, quote)).toMatchObject({ detail: "minReturnAmount" });
    // An inflated quoted amount makes the recorded minimum fall short of 50 bps under it.
    expect(verifyQuote(request, { ...quote, quotedAmountOut: quote.quotedAmountOut * 2n })).toMatchObject({
      reason: "calldata_mismatch",
      detail: "minReturnAmount",
    });
  });

  test("refuses fees, a permit, a zero minimum and source amounts that do not sum to the input", () => {
    const { request, quote } = recorded(buy);
    const minimum = minimumAmountOut(quote.quotedAmountOut, 50);
    const variant = (desc: Record<string, unknown>) =>
      verifyQuote(request, { ...quote, calldata: swapCalldata(request, minimum, desc) });
    expect(variant({})).toMatchObject({ status: "ok" });
    expect(variant({ feeReceivers: [request.account], feeAmounts: [1n] })).toMatchObject({ detail: "fee" });
    expect(variant({ permit: "0x01" })).toMatchObject({ detail: "permit" });
    expect(variant({ srcAmounts: [request.amountIn + 1n] })).toMatchObject({ detail: "srcAmounts" });
    expect(variant({ minReturnAmount: 0n })).toMatchObject({ detail: "minReturnAmount" });
  });
});

describe("minimumAmountOut", () => {
  test("rounds down and is exact at the bounds", () => {
    expect(minimumAmountOut(3_061_375n, 50)).toBe(3_046_068n);
    expect(minimumAmountOut(1_000n, 0)).toBe(1_000n);
    expect(minimumAmountOut(199n, 50)).toBe(198n);
    expect(minimumAmountOut(1n, 200)).toBe(0n);
  });
});

describe("isExactApproval", () => {
  const token: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const expected = { token, spender: KYBERSWAP_ROUTER, amount: 5_000_000n };
  const abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
  const data = encodeFunctionData({ abi, functionName: "approve", args: [KYBERSWAP_ROUTER, 5_000_000n] });

  test("accepts exactly the approval of the amount to the router on the token", () => {
    expect(isExactApproval({ to: token, value: 0n, data }, expected)).toBe(true);
  });

  test("refuses another amount, spender, token, a value or appended bytes", () => {
    const unlimited = encodeFunctionData({ abi, functionName: "approve", args: [KYBERSWAP_ROUTER, 2n ** 256n - 1n] });
    const other = encodeFunctionData({ abi, functionName: "approve", args: [KYBERSWAP_EXECUTOR, 5_000_000n] });
    expect(isExactApproval({ to: token, value: 0n, data: unlimited }, expected)).toBe(false);
    expect(isExactApproval({ to: token, value: 0n, data: other }, expected)).toBe(false);
    expect(isExactApproval({ to: KYBERSWAP_ROUTER, value: 0n, data }, expected)).toBe(false);
    expect(isExactApproval({ to: token, value: 1n, data }, expected)).toBe(false);
    expect(isExactApproval({ to: token, value: 0n, data: `${data}00` }, expected)).toBe(false);
  });
});
