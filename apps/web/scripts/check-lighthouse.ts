/**
 * Runs Lighthouse (mobile emulation, simulated throttling) against the production build and fails when a route
 * misses a budget of `lighthouse-budgets.ts`. Run `bun run build` first, then from the repository root:
 *
 *   bun run test:lighthouse
 *
 * It starts the production server itself, with the recorded market data and registry of the smoke tests, so no
 * request leaves the machine and every run sees the same data. Each route is measured `LIGHTHOUSE_RUNS` times (3
 * by default) and the run with the median performance score is checked. Chrome comes from `CHROME_PATH`, or else
 * from the Chrome Headless Shell that `playwright install --only-shell chromium` downloads.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CATEGORIES,
  formatSummary,
  LIGHTHOUSE_ROUTES,
  layoutShiftCulprits,
  type LighthouseResult,
  medianRun,
  type RouteSummary,
  summarize,
} from "./lighthouse-budgets";

const WEB = join(import.meta.dir, "..");
const PORT = Number(process.env.LIGHTHOUSE_PORT ?? 3150);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RUNS = Number(process.env.LIGHTHOUSE_RUNS ?? 3);

/** The Chrome Headless Shell of the Playwright cache, the newest one when several are installed. */
function playwrightHeadlessShell(): string | null {
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ].filter((path): path is string => path !== undefined && existsSync(path));
  for (const cache of caches) {
    const shells = readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse();
    for (const shell of shells) {
      for (const platform of readdirSync(join(cache, shell))) {
        // The binary is `chrome-headless-shell` in recent Playwright releases and `headless_shell` before.
        for (const name of ["chrome-headless-shell", "headless_shell"]) {
          const binary = join(cache, shell, platform, name);
          if (existsSync(binary)) return binary;
        }
      }
    }
  }
  return null;
}

async function waitForServer(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the server exited with code ${server.exitCode}`);
    try {
      if ((await fetch(`${ORIGIN}/api/v1/status`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`the server did not answer on ${ORIGIN} within 60 seconds`);
}

async function lighthouse(chrome: string, route: string): Promise<LighthouseResult> {
  const run = Bun.spawn(
    [
      join(WEB, "node_modules", ".bin", "lighthouse"),
      new URL(route, ORIGIN).toString(),
      "--quiet",
      "--output=json",
      "--output-path=stdout",
      `--only-categories=${CATEGORIES.join(",")}`,
      "--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage",
    ],
    { cwd: WEB, env: { ...process.env, CHROME_PATH: chrome }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  if (code !== 0) throw new Error(`lighthouse exited with code ${code} on ${route}:\n${stderr}`);
  return JSON.parse(stdout) as LighthouseResult;
}

async function main(): Promise<number> {
  const chrome = process.env.CHROME_PATH ?? playwrightHeadlessShell();
  if (chrome === null) {
    console.error("No Chrome found: set CHROME_PATH or run `bunx playwright install --only-shell chromium`.");
    return 1;
  }
  const server = Bun.spawn([join(WEB, "node_modules", ".bin", "next"), "start", "--port", String(PORT)], {
    cwd: WEB,
    env: {
      ...process.env,
      MARKET_REPLAY_DIR: "test/fixtures/market",
      REGISTRY_REPLAY_DIR: "test/fixtures/registry",
      EQUITYOS_REPLAY_FOR_TESTS: "1",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    await waitForServer(server);
    const summaries: RouteSummary[] = [];
    for (const route of LIGHTHOUSE_ROUTES) {
      const runs: LighthouseResult[] = [];
      for (let i = 0; i < RUNS; i++) runs.push(await lighthouse(chrome, route));
      const median = medianRun(runs);
      const summary = summarize(route, median);
      console.log(formatSummary(summary));
      if (summary.failures.length > 0) {
        for (const culprit of layoutShiftCulprits(median)) console.log(`  layout shift ${culprit}`);
      }
      summaries.push(summary);
    }
    const failed = summaries.filter(({ failures }) => failures.length > 0).length;
    console.log(failed === 0 ? "Every route meets its Lighthouse budget." : `${failed} route(s) over budget.`);
    return failed === 0 ? 0 : 1;
  } finally {
    server.kill();
    await server.exited;
  }
}

if (import.meta.main) process.exit(await main());
