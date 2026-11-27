// @ts-check
/**
 * Mutation testing of `packages/core/src`. Run from the repository root, on Linux or macOS, with Bun 1.4 or later:
 *
 *   bun run test:mutation
 *
 * `incremental.json` holds the results of the last run. A run re-tests only the mutants whose code or covering
 * tests changed since, and fails below a mutation score of 80%. Commit the updated file with a change to
 * `packages/core`.
 */
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  coverageAnalysis: "perTest",
  mutate: ["src/**/*.ts"],
  incremental: true,
  incrementalFile: "../../tools/mutation/incremental.json",
  reporters: ["clear-text", "progress-append-only"],
  clearTextReporter: { allowEmojis: false, logTests: false },
  thresholds: { high: 90, low: 80, break: 80 },
  // The property tests run thousands of cases each, and are slower under per-test coverage.
  bun: { timeout: 300_000, bunArgs: ["--timeout", "120000"] },
  cleanTempDir: "always",
};
