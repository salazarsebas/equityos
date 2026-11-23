import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);

/**
 * Smoke tests against the production build. Run `bun run build` first. The server replays the recorded market
 * data of `test/fixtures/market` with the clock fixed at the recorded block, so the tests make no network access
 * and see the same values on every run.
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
  webServer: {
    command: `bun run start --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    env: { MARKET_REPLAY_DIR: "test/fixtures/market" },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
