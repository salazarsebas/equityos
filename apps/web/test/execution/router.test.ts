import { describe, expect, test } from "bun:test";
import { type Address, encodeFunctionData, type Hex, parseAbi, toFunctionSelector } from "viem";
import type { ProviderQuote, QuoteRequest } from "../../src/server/execution/provider";
import {
  ALLOWED_SELECTORS,
  KYBERSWAP_ROUTER,
  kyberswapRouterAbi,
  minimumAmountOut,
  verifyQuote,
} from "../../src/server/execution/router";
import { kyberswapFixture, type RecordedLeg, swapCalldata } from "./support";

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

describe("router allowlist", () => {
  test("is the router the live API returned for Base in every recorded answer", () => {
    for (const leg of kyberswapFixture.legs) {
      expect(leg.build.body.data.routerAddress.toLowerCase()).toBe(KYBERSWAP_ROUTER);
    }
    expect(KYBERSWAP_ROUTER).toBe("0x6131b5fae19ea4f9d964eac0408e4408b66337b5");
  });

  test("allows exactly the three swap functions of the verified router", () => {
    expect([...ALLOWED_SELECTORS].sort()).toEqual(["0x59e50fed", "0x8af033fb", "0xe21fd0e9"]);
    expect(
      toFunctionSelector(
        "function swap((address,address,bytes,(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes),bytes))",
      ),
    ).toBe("0xe21fd0e9");
  });
});

describe("verifyQuote on recorded calldata", () => {
  test("accepts every recorded build and takes the minimum from the calldata", () => {
    for (const leg of kyberswapFixture.legs) {
      const { request, quote } = recorded(leg);
      const verified = verifyQuote(request, quote);
      if (verified.status !== "ok") throw new Error(`${leg.name}: ${verified.reason} ${verified.detail}`);
      expect(verified.quote.functionName).toBe("swap");
      expect(verified.quote.minAmountOut).toBe(minimumAmountOut(quote.quotedAmountOut, 50));
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

  test("refuses a function of the router that is not a swap, and a selector it does not have", () => {
    const { request, quote } = recorded(buy);
    const owner = parseAbi([
      "function transferOwnership(address newOwner)",
      "function rescueFunds(address token, uint256 amount)",
    ]);
    const calls: Hex[] = [
      encodeFunctionData({ abi: owner, functionName: "transferOwnership", args: [request.account] }),
      encodeFunctionData({ abi: owner, functionName: "rescueFunds", args: [request.tokenIn, 1n] }),
      `0xdeadbeef${quote.calldata.slice(10)}`,
    ];
    for (const calldata of calls) {
      const verified = verifyQuote(request, { ...quote, calldata });
      expect(verified.status === "failed" && verified.reason).toBe("unknown_selector");
    }
    const truncated = verifyQuote(request, { ...quote, calldata: quote.calldata.slice(0, 200) as Hex });
    expect(truncated).toEqual({ status: "failed", reason: "calldata_mismatch", detail: "undecodable" });
  });

  test("refuses a quote whose amount, tokens or receiver differ from the request", () => {
    const { request, quote } = recorded(sell);
    const mismatch = (changed: QuoteRequest) => {
      const verified = verifyQuote(changed, quote);
      return verified.status === "failed" ? verified.detail : "accepted";
    };
    expect(mismatch({ ...request, amountIn: request.amountIn + 1n })).toBe("amountIn,amount,srcAmounts");
    expect(mismatch({ ...request, account: "0x000000000000000000000000000000000000dead" })).toBe("dstReceiver");
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

  test("refuses fees, a permit, a partial fill, extra ETH and source amounts that do not sum to the input", () => {
    const { request, quote } = recorded(buy);
    const minimum = minimumAmountOut(quote.quotedAmountOut, 50);
    const variant = (desc: Record<string, unknown>) =>
      verifyQuote(request, { ...quote, calldata: swapCalldata(request, minimum, desc) });
    expect(variant({})).toMatchObject({ status: "ok" });
    expect(variant({ feeReceivers: [request.account], feeAmounts: [1n] })).toMatchObject({ detail: "fee" });
    expect(variant({ permit: "0x01" })).toMatchObject({ detail: "permit" });
    expect(variant({ flags: 1n })).toMatchObject({ detail: "flags" });
    expect(variant({ flags: 2n })).toMatchObject({ detail: "flags" });
    expect(variant({ flags: 512n })).toMatchObject({ status: "ok" });
    expect(variant({ srcAmounts: [request.amountIn + 1n] })).toMatchObject({ detail: "srcAmounts" });
    expect(variant({ minReturnAmount: 0n })).toMatchObject({ detail: "minReturnAmount" });
  });

  test("reads the description of swapSimpleMode from its second argument", () => {
    const { request, quote } = recorded(buy);
    const minimum = minimumAmountOut(quote.quotedAmountOut, 50);
    const calldata = encodeFunctionData({
      abi: kyberswapRouterAbi,
      functionName: "swapSimpleMode",
      args: [
        request.account,
        {
          srcToken: request.tokenIn,
          dstToken: request.tokenOut,
          srcReceivers: [request.account],
          srcAmounts: [request.amountIn],
          feeReceivers: [],
          feeAmounts: [],
          dstReceiver: "0x000000000000000000000000000000000000dead",
          amount: request.amountIn,
          minReturnAmount: minimum,
          flags: 0n,
          permit: "0x",
        },
        "0x01",
        "0x",
      ],
    });
    expect(verifyQuote(request, { ...quote, calldata })).toMatchObject({ detail: "dstReceiver" });
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
