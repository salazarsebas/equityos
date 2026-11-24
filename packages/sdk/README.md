# @equityos/sdk

TypeScript SDK for EquityOS, open index infrastructure for tokenized stocks on Base. It does three things:

- **A typed client of the public API v1** of any EquityOS deployment, with amounts decoded to `bigint`.
- **`verifyIndexVersion`**: reads a published index version from the `IndexRegistry` contract and checks it,
  without calling the EquityOS API at all.
- **The methodology functions** of `@equityos/core` (`canonicalize`, `specHash`, `validateSpec`,
  `computeConstituents`, `verifyVersion`), so that one package reproduces weights and hashes.

ESM only, no runtime dependency outside EquityOS, no Ethereum library required. Node.js 18 or later, Bun, Deno and
browsers.

## Install

The package is not published to a registry yet. In the EquityOS repository it is the workspace package
`packages/sdk`:

```sh
git clone https://github.com/salazarsebas/equityos.git && cd equityos
bun install
bun run --filter @equityos/sdk build
```

## Quickstart

```ts
import { createClient } from "@equityos/sdk";

const client = createClient({ baseUrl: "http://localhost:3000" });
const { data, meta } = await client.getAsset("0xb20000000000000000000078ee7ce2fe4908108c");
data.referencePrice.priceE8; //       bigint: USD per token scaled by 1e8, or null when there is no usable price
data.referencePrice.status; //        "live", "delayed", "last_close" or "unavailable"
meta.datasets.onchain.blockNumber; // bigint: the Base mainnet block every value was read at
```

The API needs no key. `baseUrl` is the origin of a deployment; `/api/v1` is appended.

## Verify without trusting the website

```ts
import { INDEX_REGISTRY_ADDRESS, verifyIndexVersion } from "@equityos/sdk";

const result = await verifyIndexVersion({
  chainId: 31337,
  registry: INDEX_REGISTRY_ADDRESS,
  indexId: "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
  version: 2,
  rpcUrl: "http://127.0.0.1:8545",
});
result.conformant; // true only if checks C1 to C5 all pass
result.checks; //     each with status pass, fail or skipped, a stable code and a reason
result.spec; //       the methodology, present only when conformant
```

The function reads the spec bytes, the spec hash and the constituents with `eth_call` from the RPC endpoint you
choose, all at one block, and runs the checks of the methodology spec on them. It refuses an endpoint that reports
another chain than `chainId`. Pass `publicClient` instead of `rpcUrl` to use a viem `PublicClient`, or any object
with `getChainId`, `getBlockNumber`, `getCode` and `call`.

The registry is deployed on a local development chain only today. The example above runs against a local Anvil
node after `bun run contracts:deploy:local` and `bun run seed:local`. On Base mainnet the function throws
`RegistryReadError` with the code `registry_not_deployed`.

## The client

| Method                                            | Endpoint                                         |
| ------------------------------------------------- | ------------------------------------------------ |
| `listAssets({ eligible? })`                       | `GET /assets`                                    |
| `getAsset(address)`                               | `GET /assets/{address}`                          |
| `listIndexes({ offset?, limit? })`                | `GET /indexes`                                   |
| `iterateIndexes({ offset?, limit? })`             | `GET /indexes`, every page, as an async iterator |
| `getIndex(identifier)`                            | `GET /indexes/{identifier}`                      |
| `getIndexVersion(identifier, version)`            | `GET /indexes/{identifier}/versions/{version}`   |
| `getIndexComposition(identifier, { version? })`   | `GET /indexes/{identifier}/composition`          |
| `getPortfolio({ address, index, version? })`      | `GET /portfolio`                                 |
| `getPortfolioPlan({ address, index, mode, ... })` | `GET /portfolio/plan`                            |
| `getStatus()`                                     | `GET /status`                                    |
| `getOpenApiDocument()`                            | `GET /openapi.json`                              |

Each method returns `{ data, meta }` as the API sends them, with the same field names:

- Amounts, prices, block numbers and round ids are `bigint`. The scale stays in the field name: `priceE8` is USD
  scaled by 1e8, `valueUsdE8` likewise, `multiplierWad` is scaled by 1e18, and a token `balance` is in base units
  of the `decimals` next to it.
- Counts, decimals, versions, chain ids and weights in basis points are `number`.
- A value that does not exist is `null`, never zero.
- A field the SDK does not know is ignored, and an enumeration value it does not know is returned as it is, as
  the versioning rules of API v1 require.

A reference price is an indication of value from an oracle feed, not an executable price, and a plan is
arithmetic at reference prices, not an instruction to trade.

## Errors

| Class                      | When                                                                           |
| -------------------------- | ------------------------------------------------------------------------------ |
| `ApiError`                 | The API answered with an error: `status`, the stable `code`, `details`         |
| `RegistryNotDeployedError` | `registry_not_deployed`: the deployment's chain has no registry. Not a failure |
| `TransportError`           | The request did not complete                                                   |
| `ResponseShapeError`       | The response is not what the API documents, with the `path` of the mismatch    |
| `RegistryReadError`        | `verifyIndexVersion` could not read the version: `code` says why               |

```ts
import { RegistryNotDeployedError } from "@equityos/sdk";

try {
  await client.listIndexes();
} catch (error) {
  if (error instanceof RegistryNotDeployedError) console.log(error.chainId, error.reason);
  else throw error;
}
```

## Documentation

- [SDK reference](https://github.com/salazarsebas/equityos/blob/main/docs/api/sdk.md): design, types and how they
  are kept equal to the OpenAPI document.
- [Public API](https://github.com/salazarsebas/equityos/blob/main/docs/api/README.md): conventions and endpoints.
- [Methodology spec](https://github.com/salazarsebas/equityos/blob/main/docs/architecture/methodology-spec.md): the
  document, its canonical form, its hash and checks C1 to C5.

EquityOS is not affiliated with the issuers of the tokens, the operators of Base or the providers of the reference
feeds. Nothing the SDK returns is investment advice.

## License

[MIT](./LICENSE)
