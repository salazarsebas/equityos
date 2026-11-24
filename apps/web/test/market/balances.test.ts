import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Address, createPublicClient, encodeAbiParameters } from "viem";
import { readBalances, USDC_ADDRESS } from "../../src/server/market/balances";
import { MissingConfigurationError, UpstreamError } from "../../src/server/market/errors";
import { MULTICALL3_ADDRESS } from "../../src/server/market/onchain";
import { loadReplay } from "../../src/server/market/replay";
import { FIXTURE_TOKENS, type FixtureTransportOptions, fixtureTransport, type OnchainFixture, TOKENS } from "./support";

/** `balanceOf` of a Base mainnet contract that holds USDC and tokenized stocks, recorded at one block. */
const recording: OnchainFixture = JSON.parse(
  readFileSync(new URL("../fixtures/market/balances-recorded.json", import.meta.url), "utf8"),
);
const HOLDER: Address = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const TOKENS_READ: readonly Address[] = [USDC_ADDRESS, ...FIXTURE_TOKENS];

function read(options: FixtureTransportOptions = {}, account: Address = HOLDER) {
  const { transport, requests } = fixtureTransport(recording, options);
  return { result: readBalances(createPublicClient({ transport }), account, TOKENS_READ), requests };
}

describe("readBalances with a recorded Base mainnet read", () => {
  test("reads every balance at one block in one multicall", async () => {
    const { result, requests } = read();
    const balances = await result;
    expect(requests).toEqual(["eth_getBlockByNumber", "eth_call"]);
    expect(balances.blockNumber).toBe(61_076_193n);
    expect(balances.blockTimestamp).toBe(1_795_405_614);
    expect([...balances.balances.keys()]).toEqual([...TOKENS_READ]);
    expect(balances.balances.get(USDC_ADDRESS)).toBe(12_639_698_456_435n);
    expect(balances.balances.get(TOKENS.NVDA)).toBe(269_349_536_804n);
    expect(balances.balances.get(TOKENS.RKT)).toBe(0n);
  });

  test("a call that reverts or answers something else is null, never zero", async () => {
    const reverted = (call: { target: Address }) =>
      call.target.toLowerCase() === TOKENS.NVDA ? { success: false, returnData: "0x" as const } : undefined;
    const balances = await read({ override: reverted }).result;
    expect(balances.balances.get(TOKENS.NVDA)).toBeNull();
    const short = (call: { target: Address }) =>
      call.target.toLowerCase() === TOKENS.SNDK ? { success: true, returnData: "0x01" as const } : undefined;
    expect((await read({ override: short }).result).balances.get(TOKENS.SNDK)).toBeNull();
  });

  test("an endpoint that is not Base mainnet is a misconfiguration, a transport failure is upstream", async () => {
    const otherChain = (call: { target: Address }) =>
      call.target === MULTICALL3_ADDRESS
        ? { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [1n]) }
        : undefined;
    await expect(read({ override: otherChain }).result).rejects.toBeInstanceOf(MissingConfigurationError);
    await expect(read({ failEthCall: () => true }).result).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("constructed balances of the replay", () => {
  const directory = new URL("../fixtures/market", import.meta.url).pathname;

  test("answer the accounts they list, at the recorded block, with zero for tokens they do not list", async () => {
    const { client } = await loadReplay(directory);
    const balances = await readBalances(client, "0x0000000000000000000000000000000000001004", TOKENS_READ);
    expect(balances.blockNumber).toBe(60_489_401n);
    expect(balances.balances.get(USDC_ADDRESS)).toBe(1_000_000_000n);
    expect(balances.balances.get(TOKENS.NVDA)).toBe(0n);
  });

  test("an account they do not list fails like an endpoint that does not answer", async () => {
    const { client } = await loadReplay(directory);
    await expect(readBalances(client, `0x${"9".repeat(40)}`, TOKENS_READ)).rejects.toBeInstanceOf(UpstreamError);
  });
});
