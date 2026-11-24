import { assetHandler, assetsHandler } from "../../src/server/api/assets";
import {
  indexCompositionHandler,
  indexesHandler,
  indexHandler,
  indexVersionHandler,
} from "../../src/server/api/indexes";
import { portfolioHandler, portfolioPlanHandler } from "../../src/server/api/portfolio";
import { statusHandler } from "../../src/server/api/status";
import { GET as openApiDocumentRoute } from "../../src/app/api/v1/openapi.json/route";
import { resolveRegistryConfig } from "../../src/server/registry/config";
import { createRegistryReader, type RegistryReader } from "../../src/server/registry/reader";
import { fixtureService, RECORDED_AT, recordedRegistry } from "./support";

export const FIXTURE_ORIGIN = "https://equityos.test";

/**
 * Which registry the server reads: the recording of the local chain after the seed, or Base mainnet, where the
 * registry is not deployed and nothing is requested.
 */
export type FixtureRegistry = "recorded" | "not_deployed";

/** Answers a request, given the decoded path parameters in the order of the path. */
type Handler = (request: Request, params: readonly string[]) => Promise<Response> | Response;

/**
 * Every route of API v1, served from the recorded fixtures with the clock fixed at the recorded block: the
 * market data of `test/fixtures/market`, the constructed balances, and the registry of `test/fixtures/registry`.
 * No network access is made, and the same request always gets the same response.
 */
export function fixtureServer(registry: FixtureRegistry = "recorded"): (request: Request) => Promise<Response> {
  const service = fixtureService();
  const reader: RegistryReader =
    registry === "recorded" ? recordedRegistry() : createRegistryReader({ config: resolveRegistryConfig({}) });
  const now = () => RECORDED_AT;
  const options = {
    registry: () => reader,
    mode: () => (registry === "recorded" ? ("replay" as const) : ("live" as const)),
    marketData: service.marketData,
    marketMode: () => "replay" as const,
    now,
  };
  const context = <T>(params: T) => ({ params: Promise.resolve(params) });
  const routes: readonly (readonly [RegExp, Handler])[] = [
    [/^\/assets$/, (request) => assetsHandler(service.marketData)(request, undefined)],
    [
      /^\/assets\/([^/]+)$/,
      (request, [address = ""]) => assetHandler(service.marketData)(request, context({ address })),
    ],
    [/^\/indexes$/, (request) => indexesHandler(options)(request, undefined)],
    [/^\/indexes\/([^/]+)$/, (request, [identifier = ""]) => indexHandler(options)(request, context({ identifier }))],
    [
      /^\/indexes\/([^/]+)\/versions\/([^/]+)$/,
      (request, [identifier = "", version = ""]) =>
        indexVersionHandler(options)(request, context({ identifier, version })),
    ],
    [
      /^\/indexes\/([^/]+)\/composition$/,
      (request, [identifier = ""]) => indexCompositionHandler(options)(request, context({ identifier })),
    ],
    [/^\/portfolio$/, (request) => portfolioHandler(options)(request, undefined)],
    [/^\/portfolio\/plan$/, (request) => portfolioPlanHandler(options)(request, undefined)],
    [
      /^\/status$/,
      (request) =>
        statusHandler({
          marketData: service.marketData,
          mode: () => "replay",
          registry: () => reader,
          registryMode: options.mode,
          now,
        })(request, undefined),
    ],
    [/^\/openapi\.json$/, () => openApiDocumentRoute()],
  ];
  return async (request) => {
    const path = new URL(request.url).pathname.replace(/^\/api\/v1/, "");
    for (const [pattern, handler] of routes) {
      const match = pattern.exec(path);
      if (match !== null) return handler(request, match.slice(1).map(decodeURIComponent));
    }
    throw new Error(`no route for ${path}`);
  };
}
