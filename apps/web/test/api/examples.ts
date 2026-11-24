import { onchainFixture } from "../market/support";
import { FIXTURE_ORIGIN, type FixtureRegistry, fixtureServer } from "./fixture-server";

/** One request whose response is recorded as an example of the API. */
interface ExampleRequest {
  /** Unique name of the example. */
  readonly name: string;
  /** `operationId` of the endpoint in the OpenAPI document. */
  readonly operationId: string;
  /** What the example shows, in one sentence. */
  readonly title: string;
  /** Path and query, from `/api/v1`. */
  readonly path: string;
  readonly registry: FixtureRegistry;
  /** The JSON body of a POST. A request without one is a GET. */
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface RecordedExample extends Omit<ExampleRequest, "body"> {
  /** The JSON body of a POST request. */
  readonly requestBody?: Readonly<Record<string, unknown>>;
  readonly status: number;
  readonly body: unknown;
}

export interface RecordedExamples {
  readonly description: string;
  readonly examples: readonly RecordedExample[];
}

const DIVERSIFIED = "diversified-equity-d622e2a5";
const MISMATCHED = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";
const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const EMPTY_ACCOUNT = "0x0000000000000000000000000000000000001003";

const REQUESTS: readonly ExampleRequest[] = [
  {
    name: "listAssets",
    operationId: "listAssets",
    title: "The index-eligible assets",
    path: "/api/v1/assets?eligible=true",
    registry: "recorded",
  },
  {
    name: "getAsset",
    operationId: "getAsset",
    title: "One asset",
    path: "/api/v1/assets/0xb20000000000000000000078ee7ce2fe4908108c",
    registry: "recorded",
  },
  {
    name: "getAsset.invalidAddress",
    operationId: "getAsset",
    title: "A malformed address",
    path: "/api/v1/assets/0x1234",
    registry: "recorded",
  },
  {
    name: "listIndexes",
    operationId: "listIndexes",
    title: "The first page of two indexes",
    path: "/api/v1/indexes?limit=2",
    registry: "recorded",
  },
  {
    name: "listIndexes.registryNotDeployed",
    operationId: "listIndexes",
    title: "A deployment whose chain has no registry",
    path: "/api/v1/indexes",
    registry: "not_deployed",
  },
  {
    name: "getIndex",
    operationId: "getIndex",
    title: "One index and its versions",
    path: `/api/v1/indexes/${DIVERSIFIED}`,
    registry: "recorded",
  },
  {
    name: "getIndex.notFound",
    operationId: "getIndex",
    title: "A known prefix with another slug",
    path: "/api/v1/indexes/another-name-d622e2a5",
    registry: "recorded",
  },
  {
    name: "getIndexVersion",
    operationId: "getIndexVersion",
    title: "A verified version",
    path: `/api/v1/indexes/${DIVERSIFIED}/versions/2`,
    registry: "recorded",
  },
  {
    name: "getIndexVersion.notConformant",
    operationId: "getIndexVersion",
    title: "A version that fails check C5",
    path: `/api/v1/indexes/${MISMATCHED}/versions/1`,
    registry: "recorded",
  },
  {
    name: "getIndexComposition",
    operationId: "getIndexComposition",
    title: "The composition of the latest version",
    path: `/api/v1/indexes/${DIVERSIFIED}/composition`,
    registry: "recorded",
  },
  {
    name: "getIndexComposition.notConformant",
    operationId: "getIndexComposition",
    title: "A version that fails verification has no composition",
    path: `/api/v1/indexes/${MISMATCHED}/composition`,
    registry: "recorded",
  },
  {
    name: "getPortfolio",
    operationId: "getPortfolio",
    title: "An address compared with an index",
    path: `/api/v1/portfolio?address=${ACCOUNT}&index=${DIVERSIFIED}`,
    registry: "recorded",
  },
  {
    name: "getPortfolioPlan",
    operationId: "getPortfolioPlan",
    title: "A ready plan in rebalance mode",
    path: `/api/v1/portfolio/plan?address=${ACCOUNT}&index=${DIVERSIFIED}&mode=rebalance`,
    registry: "recorded",
  },
  {
    name: "getPortfolioPlan.blocked",
    operationId: "getPortfolioPlan",
    title: "A blocked plan: a deposit too small to buy every constituent",
    path: `/api/v1/portfolio/plan?address=${EMPTY_ACCOUNT}&index=${DIVERSIFIED}&mode=buy_only&depositUsdE8=200000000`,
    registry: "recorded",
  },
  {
    name: "executionPlan.replay",
    operationId: "executionPlan",
    title: "A deployment that serves replayed market data builds no execution plan",
    path: "/api/v1/portfolio/execution-plan",
    registry: "recorded",
    body: { address: ACCOUNT, index: DIVERSIFIED, mode: "rebalance" },
  },
  {
    name: "getStatus",
    operationId: "getStatus",
    title: "The status of the API and its data",
    path: "/api/v1/status",
    registry: "recorded",
  },
];

export const EXAMPLES_FILE = new URL("../../src/server/api/examples.json", import.meta.url);

/**
 * Records the response of every example request from the fixture server. The result is committed as
 * `src/server/api/examples.json`, which the developer pages show and the SDK tests decode; a test fails when it
 * differs from what the handlers produce now.
 */
export async function recordApiExamples(): Promise<RecordedExamples> {
  const servers = { recorded: fixtureServer("recorded"), not_deployed: fixtureServer("not_deployed") };
  const examples: RecordedExample[] = [];
  for (const { body, ...request } of REQUESTS) {
    const init =
      body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = await servers[request.registry](new Request(`${FIXTURE_ORIGIN}${request.path}`, init));
    examples.push({
      ...request,
      ...(body === undefined ? {} : { requestBody: body }),
      status: response.status,
      body: JSON.parse(await response.text()),
    });
  }
  const recordedAt = new Date(onchainFixture.blockTimestamp * 1000).toISOString().replace(".000Z", "Z");
  return {
    description: `Responses of API v1 recorded from the test fixtures, not from a live network: market data of Base mainnet block ${onchainFixture.blockNumber} (${recordedAt}), constructed balances, and an index registry on a local development chain (chain id 31337) after the seed.`,
    examples,
  };
}
