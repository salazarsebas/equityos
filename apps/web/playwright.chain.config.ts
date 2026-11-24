import { LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import { defineConfig, devices } from "@playwright/test";

/** Ports of this suite, apart from the ones of local development and of the other suites. */
export const ANVIL_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8576);
export const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const port = Number(process.env.E2E_PORT ?? 3110);
/** The Builder Code of this suite's server, so that the tests see the ERC-8021 suffix on what is sent. */
export const BUILDER_CODE = "bc_e2etest";

/**
 * The publish and execute flows against a real local chain: `e2e-chain/setup.ts` starts Anvil, runs the
 * deployment script, seeds the example indexes and installs the execution mocks, and the tests drive the
 * Studio and the portfolio page in a browser. It needs Foundry, so it runs in the `integration` job
 * and not with the smoke tests. Run it with `bun run test:e2e:chain`.
 *
 * The app runs in development mode because the local chain exists in development builds only. The market data
 * is the recording of `test/fixtures/market`, so nothing but the local node is reached.
 */
export default defineConfig({
  testDir: "e2e-chain",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e-chain/setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${port}`,
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `bun run dev --port ${port}`,
    url: `http://localhost:${port}/studio`,
    env: {
      MARKET_REPLAY_DIR: "test/fixtures/market",
      NEXT_PUBLIC_ANVIL_RPC_URL: ANVIL_RPC_URL,
      // The server reads the same local registry, so the link to the new index resolves.
      EQUITYOS_CHAIN_ID: String(LOCAL_CHAIN_ID),
      EQUITYOS_RPC_URL: ANVIL_RPC_URL,
      NEXT_PUBLIC_BUILDER_CODE: BUILDER_CODE,
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
