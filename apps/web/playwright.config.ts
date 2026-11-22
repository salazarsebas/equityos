import { defineConfig, devices } from "@playwright/test";

/** First of three consecutive ports. Set `E2E_PORT` when the default ones are taken. */
const port = Number(process.env.E2E_PORT ?? 3100);
const MARKET_REPLAY_DIR = "test/fixtures/market";

function server(serverPort: number, env: Record<string, string>) {
  return {
    command: `bun run start --port ${serverPort}`,
    url: `http://127.0.0.1:${serverPort}`,
    env: { ...env, MARKET_REPLAY_DIR },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  };
}

/**
 * Smoke tests against the production build. Run `bun run build` first. No server makes network access, and
 * each one sees the same values on every run:
 *
 * - The main server replays the recorded market data of `test/fixtures/market`, with the clock fixed at the
 *   recorded block, and the recorded registry of `test/fixtures/registry`: a local chain after the seed.
 * - The second server has no registry: it reads Base mainnet, where the registry is not deployed.
 * - The third server replays a registry that is deployed and holds no index.
 *
 * `e2e/servers.ts` gives the tests the address of the second and the third.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  timeout: 20_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices["Desktop Chrome"],
  },
  webServer: [
    server(port, { REGISTRY_REPLAY_DIR: "test/fixtures/registry" }),
    server(port + 1, {}),
    server(port + 2, { REGISTRY_REPLAY_DIR: "test/fixtures/registry-empty" }),
  ],
});
