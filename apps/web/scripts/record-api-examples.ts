/**
 * Writes `src/server/api/examples.json`: the response of each example request of `test/api/examples.ts`, served
 * from the recorded fixtures, formatted with Biome. Run it after a change to a handler or to the fixtures:
 *
 *   bun run --filter @equityos/web record:api-examples
 *
 * It makes no network access. `test/api/sdk.test.ts` fails while the committed file differs from the output.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXAMPLES_FILE, recordApiExamples } from "../test/api/examples";

const path = fileURLToPath(EXAMPLES_FILE);
writeFileSync(path, JSON.stringify(await recordApiExamples()));
const format = Bun.spawnSync(["bunx", "biome", "format", "--write", path], { stdout: "ignore", stderr: "inherit" });
if (format.exitCode !== 0) throw new Error("biome could not format the examples");
console.log(`wrote ${path}`);
