import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEPLOYMENTS, LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import { OPEN_MARKET_TIME } from "../e2e/execution-plans";
import { TEST_ACCOUNT } from "../e2e/wallet-support";
import { ANVIL_PORT, ANVIL_RPC_URL } from "../playwright.chain.config";
import { installExecutionMocks } from "./execution-chain";

const contracts = fileURLToPath(new URL("../../../contracts", import.meta.url));
const web = fileURLToPath(new URL("..", import.meta.url));

/**
 * Starts a local Anvil node, deploys the contracts to it with the deployment script, seeds the example indexes
 * and installs the execution mocks, from the node's first unlocked development account. No key is read or
 * created. Returns the teardown that stops the node.
 */
export default async function setup(): Promise<() => void> {
  // The chain starts in an open session of the US market, so the reference feeds the browser reads are live.
  const node = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent", "--timestamp", String(OPEN_MARKET_TIME)], {
    stdio: "ignore",
  });
  const stop = () => void node.kill();
  try {
    const client = createPublicClient({ chain: anvil, transport: http(ANVIL_RPC_URL) });
    let chainId: number | null = null;
    for (let attempt = 0; attempt < 100 && chainId === null; attempt += 1) {
      chainId = await client.getChainId().catch(() => null);
      if (chainId === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (chainId !== LOCAL_CHAIN_ID) throw new Error(`no local chain on ${ANVIL_RPC_URL}: chain id ${chainId}`);
    const arguments_ = ["script", "script/Deploy.s.sol", "--rpc-url", ANVIL_RPC_URL, "--broadcast", "--unlocked"];
    const deploy = spawnSync("forge", [...arguments_, "--sender", TEST_ACCOUNT], {
      cwd: contracts,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (deploy.status !== 0) throw new Error("the deployment script failed");
    const code = await client.getCode({ address: DEPLOYMENTS[LOCAL_CHAIN_ID].registry });
    if (code === undefined || code === "0x") throw new Error("the registry was not deployed");
    // The example indexes, as the recorded registry of the other suites holds them, then the execution mocks.
    const seed = spawnSync("bun", ["--conditions=react-server", "scripts/seed-local.ts"], {
      cwd: web,
      env: { ...process.env, EQUITYOS_RPC_URL: ANVIL_RPC_URL },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (seed.status !== 0) throw new Error("the seed failed");
    await installExecutionMocks(ANVIL_RPC_URL);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
