import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import { type Address, createPublicClient, createTestClient, createWalletClient, type Hex, http, parseAbi } from "viem";
import { anvil } from "viem/chains";
import { KYBERSWAP_EXECUTOR, KYBERSWAP_ROUTER } from "../src/lib/execution/calldata";
import { AAPL, AMZN, MSTR, NVDA, TSLA, USDC } from "../e2e/execution-plans";
import { TEST_ACCOUNT } from "../e2e/wallet-support";

/**
 * Installs the execution mocks of `contracts/test/e2e/ExecutionMocks.sol` on the local node, at the Base mainnet
 * addresses the client verification pins: a token at USDC and at each constituent of the seeded index, the
 * router at the KyberSwap router address and the executor at its executor address. The app's allowlist is not
 * widened: the local chain uses the very same router, executor and USDC addresses as Base mainnet. Only
 * `anvil_setCode`, which a live network does not have, puts them there, and the script refuses any chain but
 * 31337.
 *
 * Balances: the test account gets what `test/fixtures/market/balances.json` records for it, so the chain agrees
 * with the replayed comparison; the executor gets the tokens it pays out.
 */
const outDir = fileURLToPath(new URL("../../../contracts/out/ExecutionMocks.sol", import.meta.url));

function runtimeCode(contract: string): Hex {
  const artifact = JSON.parse(readFileSync(`${outDir}/${contract}.json`, "utf8")) as {
    deployedBytecode: { object: Hex };
  };
  return artifact.deployedBytecode.object;
}

const tokenAbi = parseAbi([
  "function initialize(string symbol, uint8 decimals)",
  "function mint(address to, uint256 amount)",
]);

/** Balances of the test account in the replayed comparison, base units. */
export const ACCOUNT_BALANCES: Readonly<Record<string, bigint>> = {
  [USDC]: 250_500_000n,
  [TSLA]: 456_555_856n,
  [AMZN]: 478_318_233n,
  [NVDA]: 2_464_860_328n,
  [AAPL]: 463_368_280n,
  [MSTR]: 503_968_753n,
};

const TOKENS: readonly (readonly [Address, string, number])[] = [
  [USDC, "USDC", 6],
  [TSLA, "TSLAc", 8],
  [AMZN, "AMZNc", 8],
  [NVDA, "NVDAc", 8],
  [AAPL, "AAPLc", 8],
  [MSTR, "MSTRc", 8],
];

export async function installExecutionMocks(rpcUrl: string): Promise<void> {
  const transport = http(rpcUrl);
  const client = createPublicClient({ chain: anvil, transport });
  const chainId = await client.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) throw new Error(`refusing to install mocks on chain ${chainId}`);
  const wallet = createWalletClient({ chain: anvil, transport, account: TEST_ACCOUNT });
  const node = createTestClient({ chain: anvil, mode: "anvil", transport });
  const setCode = (address: Address, bytecode: Hex) => node.setCode({ address, bytecode });

  const token = runtimeCode("MockToken");
  for (const [address] of TOKENS) await setCode(address, token);
  await setCode(KYBERSWAP_ROUTER, runtimeCode("MockRouter"));
  await setCode(KYBERSWAP_EXECUTOR, runtimeCode("MockExecutor"));

  const confirm = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`setup transaction ${hash} reverted`);
  };
  for (const [address, symbol, decimals] of TOKENS) {
    await confirm(
      await wallet.writeContract({ address, abi: tokenAbi, functionName: "initialize", args: [symbol, decimals] }),
    );
    const balance = ACCOUNT_BALANCES[address] ?? 0n;
    await confirm(
      await wallet.writeContract({ address, abi: tokenAbi, functionName: "mint", args: [TEST_ACCOUNT, balance] }),
    );
    const reserve = 10n ** BigInt(decimals + 9);
    await confirm(
      await wallet.writeContract({ address, abi: tokenAbi, functionName: "mint", args: [KYBERSWAP_EXECUTOR, reserve] }),
    );
  }
}
