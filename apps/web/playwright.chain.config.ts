import { defineConfig, devices } from "@playwright/test";

/** Ports of this suite, apart from the ones of local development and of the other suites. */
export const ANVIL_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8576);
export const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const port = 3110;

/**
 * The publish flow against a real local chain: `e2e-chain/setup.ts` starts Anvil and runs the deployment
 * script, and the tests drive the Studio in a browser. It needs Foundry, so it runs in the `integration` job
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
    env: { MARKET_REPLAY_DIR: "test/fixtures/market", NEXT_PUBLIC_ANVIL_RPC_URL: ANVIL_RPC_URL },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
