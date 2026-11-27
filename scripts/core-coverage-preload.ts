/**
 * Preload for `bun test` in `packages/core` that measures statement and branch coverage, which Bun's own
 * coverage does not report. Every file of `packages/core/src` is instrumented with Istanbul as it is loaded, and
 * after the last test the counters are written as an Istanbul coverage map to the file named by
 * `CORE_COVERAGE_FILE`. `scripts/check-core-coverage.ts` reads that file.
 *
 *   bun run test:coverage:core
 */
import { afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { plugin } from "bun";
import { createInstrumenter } from "istanbul-lib-instrument";

const output = process.env.CORE_COVERAGE_FILE;
if (output === undefined || output === "") throw new Error("CORE_COVERAGE_FILE is not set");

const instrumenter = createInstrumenter({ esModules: true, produceSourceMap: false, parserPlugins: ["typescript"] });

plugin({
  name: "core-coverage",
  setup(build) {
    // A path separator is matched by any character: the filter syntax has no portable way to name both.
    build.onLoad({ filter: /packages.core.src.[a-z-]+\.ts$/ }, async ({ path }) => ({
      contents: instrumenter.instrumentSync(await Bun.file(path).text(), path),
      loader: "ts",
    }));
  },
});

afterAll(() => {
  const { __coverage__: coverage } = globalThis as { __coverage__?: unknown };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(coverage ?? {}));
});
