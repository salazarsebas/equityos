# TypeScript SDK

`@equityos/sdk` (`packages/sdk`) is the TypeScript package for reading and verifying EquityOS indexes. It has three
parts:

| Part                   | What it does                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `createClient`         | A typed client of the [public API](./README.md) v1 of one deployment                        |
| `verifyIndexVersion`   | Reads one version from the `IndexRegistry` contract and runs checks C1 to C5 on it          |
| Methodology re-exports | `canonicalize`, `specHash`, `validateSpec`, `computeConstituents`, `verifyVersion` and more |

The package README (`packages/sdk/README.md`) is the quickstart. This page states the design and how the package
stays true to the API.

## Status

The package is built and tested in this repository and is not published to a registry. Its manifest is complete
for publication (`exports`, types, `sideEffects: false`, `files`, license, repository), and `npm pack --dry-run`
lists the LICENSE, the README, `package.json` and `dist` only. It depends on `@equityos/core` and
`@equityos/contracts-abi` with `workspace:*`, which `bun publish` replaces with their exact versions, so those two
packages must be published first.

## Dependencies

| Dependency                | Kind    | Why                                                                                  |
| ------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `@equityos/core`          | runtime | Spec validation, canonical form, hash, weights and checks C1 to C5                   |
| `@equityos/contracts-abi` | runtime | `INDEX_REGISTRY_ADDRESS` and `DEPLOYMENTS`, re-exported for callers                  |
| `viem`                    | dev     | Tests only: the ABI layouts are checked against it, and a `PublicClient` is accepted |

No Ethereum library is a runtime or peer dependency. `verifyIndexVersion` makes five read calls whose layouts are
fixed by the ABI, and encodes and decodes them itself (`src/abi.ts`, under 200 lines). `test/abi.test.ts` checks
every selector, every call data and every return layout against `indexRegistryAbi` with viem, and checks that
malformed return data is refused. A viem `PublicClient` is accepted because it has the four methods the function
uses, so a caller who has viem passes its client and a caller who does not passes an RPC URL.

The package uses only the global `fetch`, typed structurally (`src/fetch.ts`), so it needs neither the DOM library
nor Node.js types and runs on Node.js 18 and later, Bun, Deno and browsers.

## The client

`createClient({ baseUrl, fetch?, headers? })` returns one method per operation of the OpenAPI document, named by
its `operationId`, plus `iterateIndexes`, an async iterator over every index that follows `meta.nextOffset`.
Every method makes one request to `<baseUrl>/api/v1/...`, a GET except `executionPlan`, which POSTs its request
as JSON, and returns `{ data, meta }`. `executionPlan` returns calls to show: a client that sends them verifies
them again and refuses to send after `expiresAt` (see [Execution plan](./execution.md)).

### Decoding

Each response is decoded at run time by the decoders of `src/schemas.ts`, which are written once and give both
the TypeScript types (`Infer<typeof asset>`) and the checks. The rules:

| JSON in the API                             | TypeScript in the SDK                                      |
| ------------------------------------------- | ---------------------------------------------------------- |
| Integer in a decimal string (`UintString`)  | `bigint`. The field name keeps the scale                   |
| JSON integer: count, decimals, version, bps | `number`                                                   |
| Address, hash, bytes                        | `` `0x${string}` ``                                        |
| Timestamp                                   | ISO 8601 string, as sent                                   |
| String enumeration                          | `OpenEnum<"a" \| "b">`: the known values or any string     |
| `null`                                      | `null`                                                     |
| A published spec (`IndexSpec`)              | `IndexSpec` of `@equityos/core`, checked by `validateSpec` |

- A property the SDK does not declare is dropped, and an enumeration value it does not know is returned as it is.
  Both follow the [versioning rules](./README.md#versioning): additive changes within v1 never break a client.
- A missing property, a wrong type or an amount that is not a decimal integer fails with `ResponseShapeError`,
  whose `path` names the value, such as `data.referencePrice.priceE8`. A float never becomes an amount.

### Errors

| Class                      | When                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `ApiError`                 | The error envelope of the API: `status`, `code`, `message`, `details`, `retryAfterSeconds` |
| `RegistryNotDeployedError` | Subclass for `registry_not_deployed`, with `chainId`, `registry` and `reason`              |
| `TransportError`           | `fetch` rejected: nothing was received                                                     |
| `ResponseShapeError`       | A response that is not JSON or not the documented shape                                    |

`API_ERROR_CODES` lists the codes. `code` is typed `OpenEnum<ApiErrorCode>`, so a code added later arrives as is.

## Keeping the SDK equal to the OpenAPI document

The OpenAPI document (`apps/web/src/server/api/openapi.ts`) is the contract of the API. The SDK cannot import it,
because it lives in the web app and is server-only, so the types are written in the SDK and a test compares them
with the document. `apps/web/test/api/sdk.test.ts`:

1. **Operations.** `OPERATIONS` of the SDK and the operations of the document have the same `operationId`s, with
   the same method and path, and the client has a method for each.
2. **Shapes.** Every decoder carries a description of the JSON it accepts. The test walks it next to the schema
   of the 200 response of the operation and fails on any difference: a property added, removed or made optional,
   a nullability, an enumeration value, a constant, or a `UintString` that is not decoded to `bigint`.
3. **Error codes.** `API_ERROR_CODES` of the SDK equals the enumeration of the API.
4. **Real responses.** The recorded examples (below) validate against the document with Ajv and decode with the
   client, which is pointed at the handlers through its `fetch` option. Errors decode to the documented classes.

Adding an endpoint therefore fails the web tests until the SDK has a method for it. The procedure is in the
[API overview](./README.md#the-openapi-document-is-the-contract).

### Recorded examples

`apps/web/src/server/api/examples.json` holds real responses of the handlers, one or more per operation, success
and errors, served from the recorded test fixtures (a Base mainnet block, constructed balances and a registry on
a local development chain). They are example data, not current data, and say so in the file. The developer
pages show them, the SDK tests decode them, and `test/api/sdk.test.ts` fails when they differ from what the
handlers produce now. Regenerate them with:

```sh
bun run --filter @equityos/web record:api-examples
```

## Verification from the contract

`verifyIndexVersion({ chainId, registry, indexId, version, rpcUrl | publicClient })` is the path that does not
trust the website. It calls no EquityOS server:

| Step | Read                                                 | Outcome when it does not hold           |
| ---- | ---------------------------------------------------- | --------------------------------------- |
| 1    | `eth_chainId` equals `chainId`                       | `chain_mismatch`                        |
| 2    | `eth_blockNumber`: every later read is at this block | -                                       |
| 3    | `eth_getCode(registry)` is not empty                 | `registry_not_deployed`                 |
| 4    | `exists(indexId)`                                    | `index_not_found`                       |
| 5    | `getIndex(indexId)`: `version <= latestVersion`      | `version_not_found`                     |
| 6    | `getVersion`, `specOf`, `constituentsOf`             | `malformed_response` on a size mismatch |
| 7    | `verifyVersion` of `@equityos/core`: C1 to C5        | `conformant: false`, not an error       |

The outcomes in the last column are `RegistryReadError` codes, plus `rpc_failure` for an endpoint that fails.
Step 1 matters because check C4 compares the chain id of the spec with the chain the version was read from: an
endpoint on another chain would otherwise make a spec for that chain pass.

The result carries the onchain facts (creator, latest version, deprecation, spec hash, publication block and
time, composition, spec bytes, constituents), the block they were read at, the five checks and the spec errors.
`spec` is the validated methodology only when every check passes, as in the
[registry reader](../architecture/registry-reader.md#verification-states): nothing is read from a version that
fails a check.

### Tests

- `packages/sdk/test/verify.test.ts` runs the function on the recorded registry of the local chain
  (`apps/web/test/fixtures/registry`), through a chain client, through the JSON-RPC path and through a viem
  `PublicClient`, and checks that its report equals the one the API returns for the same versions.
- `apps/web/test/registry/integration.test.ts`, in the `integration` CI job, deploys the contracts on Anvil,
  runs the seed and verifies every seeded version from the contract alone, with an RPC URL and with a viem
  client: the mismatched index fails C5 with `weight_mismatch`, every other version passes, and an index whose
  bytes are not a spec fails C2.
