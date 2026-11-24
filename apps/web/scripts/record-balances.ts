/**
 * Records the balance read of one account on Base mainnet, in the format of `test/fixtures/market/onchain.json`:
 * the block and every Multicall3 call with its answer. The tests of the balance read replay it.
 *
 *   bun run record:balances <account> <file>
 *
 * It reads USDC and the tokens of the recorded asset list through `BASE_RPC_URL`, or the public endpoint.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  createPublicClient,
  custom,
  decodeFunctionData,
  decodeFunctionResult,
  type Hex,
  http,
  isAddress,
} from "viem";
import { multicall3Abi } from "../src/server/market/abis";
import { readBalances, USDC_ADDRESS } from "../src/server/market/balances";
import { resolveBaseRpcUrl } from "../src/server/market/config";

interface RecordedCall {
  readonly target: Address;
  readonly callData: Hex;
  readonly success: boolean;
  readonly returnData: Hex;
}

export async function recordBalances(account: Address, tokens: readonly Address[]) {
  const upstream = http(resolveBaseRpcUrl())({ retryCount: 2 });
  const calls: RecordedCall[] = [];
  let block: { number: Hex; timestamp: Hex } | undefined;
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const result: unknown = await upstream.request({ method, params });
      if (method === "eth_getBlockByNumber") block = result as { number: Hex; timestamp: Hex };
      if (method === "eth_call") {
        const [request] = params as [{ data: Hex }];
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: request.data });
        if (decoded.functionName !== "aggregate3") throw new Error(`unexpected call ${decoded.functionName}`);
        const answers = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: result as Hex });
        decoded.args[0].forEach(({ target, callData }, index) => {
          const answer = answers[index];
          if (answer) calls.push({ target, callData, success: answer.success, returnData: answer.returnData });
        });
      }
      return result;
    },
  });
  const read = await readBalances(createPublicClient({ transport }), account, tokens);
  if (block === undefined) throw new Error("no block was read");
  return {
    source: `balanceOf(${account}) of USDC and the recorded asset list on Base mainnet, recorded with scripts/record-balances.ts.`,
    blockNumber: read.blockNumber.toString(),
    blockTimestamp: read.blockTimestamp,
    calls,
  };
}

if (import.meta.main) {
  const [account, file] = process.argv.slice(2);
  try {
    if (account === undefined || file === undefined || !isAddress(account)) {
      throw new Error("usage: record-balances <account> <file>");
    }
    const list = JSON.parse(readFileSync(new URL("../test/fixtures/market/asset-list.json", import.meta.url), "utf8"));
    const listed: Address[] = list.pages.flatMap((page: { tokens: { contract_address: string }[] }) =>
      page.tokens.map(({ contract_address }) => contract_address.toLowerCase()),
    );
    const recording = await recordBalances(account.toLowerCase() as Address, [USDC_ADDRESS, ...listed]);
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
    console.log(`recorded block ${recording.blockNumber} to ${file}`);
  } catch (error) {
    console.error(`record-balances: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
