# Registry reader

The registry reader is the server-side, read-only view of the [index registry](index-registry.md). It lives in
`apps/web/src/server/registry` and is guarded by `import "server-only"`. It reads `IndexRegistry` and
`RebalanceLog` with `eth_call` and `eth_getLogs`, verifies every version with `@equityos/core`, and returns typed
values. It never sends a transaction, never holds a key and has no database: its state is an in-process cache.

The reader has no HTTP surface of its own. Routes and pages call it.

## Packages involved

| Piece               | Location                          | Role                                                               |
| ------------------- | --------------------------------- | ------------------------------------------------------------------ |
| ABIs and addresses  | `packages/contracts-abi`          | Typed ABIs of both contracts and the deployment map, no dependency |
| Verification        | `packages/core` (`verifyVersion`) | Checks C1 to C5 on the stored bytes, pure                          |
| Reader              | `apps/web/src/server/registry`    | Chain reads, caching, identifier resolution, event scan            |
| Shared cache        | `apps/web/src/server/cache.ts`    | TTL cache used by the reader and by the market data layer          |
| Seed for local work | `apps/web/scripts/seed-local.ts`  | Publishes example indexes to a local chain                         |

### `@equityos/contracts-abi`

The ABIs are TypeScript `as const` literals, generated from the Foundry artifacts by
`bun run --filter @equityos/contracts-abi generate`. A JSON import would lose the literal types that typed
contract calls are inferred from. The package has no dependency and no network or filesystem access at run time,
so the web app and the SDK can both import it. `@equityos/core` is not the place for it: core is the methodology
engine and knows nothing about a deployment.

Two tests keep the package honest:

- `test/abi.test.ts` compares each ABI module with the artifact in `contracts/out`. It needs `forge build`, so it
  is skipped where the artifacts are absent and enforced in the `integration` CI job, which builds the contracts
  and sets `CONTRACT_ARTIFACTS=required`.
- `test/deployments.test.ts` compares the addresses and chain ids with the constants in
  `contracts/script/Deploy.s.sol`. It reads the Solidity source, so it runs everywhere.

After a change to a contract interface, regenerate the modules and commit them.

## Chain selection and the not-deployed state

`EQUITYOS_CHAIN_ID` selects the chain: `8453` (Base mainnet, the default), `84532` (Base Sepolia) or `31337` (a
local Anvil node). Any other value is a `missing_configuration` error.

The deployment map in `@equityos/contracts-abi` gives, per chain, the two addresses and the deploy block. The
addresses are deterministic and identical on every chain, so an address says nothing about whether the contracts
exist there. Two facts decide it:

| Condition                                      | Result of every read                             | Requests made                |
| ---------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| The map has `deployBlock: null` for the chain  | `registry_not_deployed`, reason `not_configured` | None                         |
| A deploy block is set, the address has no code | `registry_not_deployed`, reason `no_code`        | `eth_chainId`, `eth_getCode` |
| A deploy block is set, the address has code    | The data                                         | As described below           |

**Neither contract is deployed on Base mainnet or Base Sepolia.** Both entries carry `deployBlock: null`, so on
those chains the reader answers `registry_not_deployed` without contacting an RPC endpoint, and needs none to be
configured. `registry_not_deployed` is a result, not an error and not an empty list: a caller renders "the
registry is not deployed on this chain", which is a different statement from "the registry holds no index". A
deployed registry without indexes answers `{ status: "ok", total: 0, indexes: [] }`.

The local chain has `deployBlock: 0`, because a local node starts empty on every run. Whether the contracts are
there is established by `eth_getCode`. A negative answer is asked again after ten seconds. A positive answer is
final: code at an address does not go away.

Before the first read the reader compares `eth_chainId` with the configured chain and fails with
`missing_configuration` when they differ, so a local node is never read as Base or the reverse.

`apps/web/test/registry/live.test.ts` (`LIVE_TESTS=1`) checks the map against Base mainnet and Base Sepolia with
`eth_getCode`. It fails in both directions: code where the map says there is none, or no code where the map has
a deploy block.

### RPC endpoint

| Chain | Variable           | When unset                                                                |
| ----- | ------------------ | ------------------------------------------------------------------------- |
| 8453  | `BASE_RPC_URL`     | Public endpoint outside production, `missing_configuration` in production |
| 84532 | `EQUITYOS_RPC_URL` | Public endpoint outside production, `missing_configuration` in production |
| 31337 | `EQUITYOS_RPC_URL` | `http://127.0.0.1:8545`                                                   |

The endpoint is resolved when the first request is about to be made. Market data is always read from Base
mainnet through `BASE_RPC_URL`, whatever `EQUITYOS_CHAIN_ID` is.

## Data flow

```
listIndexes / getIndex / getVersion / listVersions
  1. presence      deployBlock in the map, then eth_chainId and eth_getCode
  2. directory     indexCount, then indexIdAt for the positions not read yet
  3. heads         getIndex for the indexes of the page
  4. versions      getVersion, specOf, constituentsOf for the versions not cached
  5. verification  verifyVersion (C1 to C5) on the stored bytes
  6. view          onchain facts + report + spec only if conformant
```

Each step reads at one block: the block number is read first and every call of the step is pinned to it. Steps
2 to 4 are batched through Multicall3 `aggregate3`. A fresh local chain has no Multicall3, so there the same
batch runs as a deployless call (the Multicall3 bytecode is executed inside `eth_call` without being deployed).

Calls are made only for positions below `indexCount` and versions from 1 to `latestVersion`, which exist by
construction. A revert is therefore as unexpected as a transport error and both surface as `upstream_failure`:
the reader never mistakes a failed request for "not found".

### Methods

| Method                           | Returns                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `listIndexes({ offset, limit })` | `total`, and a page of indexes in creation order, each with its latest version |
| `getIndex(identifier)`           | One index, or `invalid_identifier`, or `index_not_found`                       |
| `getVersion(indexId, version)`   | One version, or `index_not_found`, or `version_not_found`                      |
| `listVersions(indexId, page)`    | `total`, and a page of versions in ascending order                             |
| `getEvents()`                    | The events found so far and how far the scan has got                           |

`limit` is 1 to 50 and defaults to 20. An invalid page is a `RangeError`. Every method can also return
`registry_not_deployed`.

The index ids are read in full, once per process, and then only the new positions: positions are stable and
entries are only appended. Heads and versions are read for the requested page only. Reading all ids is what
makes identifier resolution possible without a database; it costs one request per 455 indexes on first use.

### Units

Timestamps and block numbers are `bigint` (`uint64` onchain). Version numbers, weights in basis points and
counts are `number`: they are `uint32` and `uint16` onchain and fit a JavaScript number exactly. Addresses and
hashes are lowercase.

## Verification states

Every version is returned as an `IndexVersionView`:

- **Onchain facts**, always present: chain id, registry, index id, version, creator, spec hash, publication
  timestamp and block, composition, the stored constituents and the stored spec bytes.
- **Verification report**, always present: checks C1 to C5 of the
  [methodology spec](methodology-spec.md#conformance-checks) with status, code and reason, and the schema
  violations found by C4.
- **Spec**, present only when the version is conformant.

| `conformant` | `spec`   | Meaning                                                                           |
| ------------ | -------- | --------------------------------------------------------------------------------- |
| `true`       | The spec | C1 to C5 pass. The spec can be displayed as the methodology and computed from     |
| `false`      | `null`   | A check failed or was skipped. Only the onchain facts and the report can be shown |

A non-conformant version is never dropped from a list and never trusted. `verifyVersion` returns the parsed
document as soon as it is schema-valid, which is earlier than conformance: a spec written for another chain, or
one whose stored composition differs from what it implies, still parses. The view withholds it in those cases, so
no caller can read a name, a slug or a weight from a document that did not pass every check.

The registry accepts any bytes, so non-conformant versions are a normal input, not an exceptional one.

## Identifier rule

The registry stores no name and enforces no uniqueness. The slug lives inside the spec, which the creator
writes, and any number of indexes can carry the same slug. The canonical URL identifier of an index is:

```
<slug>-<prefix>
```

- `slug` is the slug of the **latest version** of the index, and only when that version is conformant.
- `prefix` is the shortest run of leading hexadecimal digits of the index id, **at least 8**, that no index
  **created earlier** shares.

Resolution of `<slug>-<prefix>`:

1. The prefix selects at most one index: the one whose canonical prefix is exactly that string. A longer or a
   shorter run of the same digits is a miss.
2. The slug must equal the slug of that index's latest conformant version. Otherwise the result is
   `index_not_found`. There is no fallback and no redirect to "the index the prefix points at".

The full index id (`0x` and 64 hexadecimal digits, any letter case) is always accepted. It is the canonical
identifier while the latest version is not conformant, because an unverified spec provides no slug to trust.

Properties:

- **Not squattable.** The prefix of an index depends only on the indexes created before it, and the registry is
  append-only, so the prefix is fixed at creation. Someone who grinds a salt until a new index id starts with
  the same 8 digits, and publishes the same slug, gets a longer prefix (`alpha-a1b2c3d4e6` next to
  `alpha-a1b2c3d4`). The existing identifier keeps resolving to the existing index, and only to it.
- **Not confusable.** Both parts must match, so a link cannot display one name and open another index: taking a
  known prefix and attaching a different slug resolves to nothing.
- **Deterministic.** Any reader that enumerates the registry in order computes the same identifiers.

The slug part follows the latest version. A creator who publishes a version with another slug changes the
canonical identifier, and the old one stops resolving. The index id is the permanent identifier.

Alternatives considered:

| Alternative                               | Why not                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Slug alone, first to publish wins         | Squattable: anyone can take a well-known name first, and a later version can take it |
| Slug alone, with a curated allowlist      | Adds an operator who decides names, which the registry deliberately does not have    |
| Index id alone                            | Correct and always accepted, but unreadable as the only form of a link               |
| Slug and creator address                  | Twice as long, and one creator can still publish the same slug twice                 |
| Fixed 8-digit prefix                      | A ground collision makes two indexes share an identifier                             |
| Prefix alone resolves, slug is decoration | A link can then show any name for any index                                          |
| Slug of version 1, never changing         | Stable, but the link keeps a name the current methodology no longer carries          |

## Caching

All state is in process memory and is lost on restart.

| Data                             | Key                                     | Lifetime                               |
| -------------------------------- | --------------------------------------- | -------------------------------------- |
| A verified version               | `(chainId, registry, indexId, version)` | No expiry, at most 5,000 entries       |
| Index head (`getIndex`)          | `(chainId, registry, indexId)`          | 10 seconds                             |
| Index count and the id directory | Per reader                              | Count 10 seconds, ids never read twice |
| Registry presence                | Per reader                              | Absent: 10 seconds. Present: final     |
| Scanned events                   | Per reader                              | Kept, with the last scanned block      |

A published version cannot change, so it is cached without expiry together with its verification report. The
key starts with the chain id and the registry address: the index id alone is the same on every chain for the
same creator and salt, and a cache keyed by it would serve one chain with the spec of another. Past 5,000
entries the version loaded longest ago is dropped and read again when asked for.

Everything that can change has a ten second TTL: a new index, a new version or a deprecation is visible within
ten seconds. Nothing is served past its TTL. When the RPC endpoint fails, the read fails with `upstream_failure`
instead of presenting an old head as current. A failed load is not cached.

Concurrent callers of the same key share one load, and the keys of one call that need loading are read in one
batch. The cache is `createKeyedCache` in `apps/web/src/server/cache.ts`; the single-value `createCache` of the
market data layer is the same implementation with one key.

## Events

`getEvents()` scans `IndexCreated`, `VersionPublished`, `IndexDeprecated` and `RebalanceRecorded` with
`eth_getLogs`, from the deploy block.

- **Bounded ranges.** Each request covers at most `EQUITYOS_LOG_CHUNK_BLOCKS` blocks (default 2,000). Ranges are
  inclusive, contiguous and never overlap. An endpoint with a lower limit needs a lower value.
- **Incremental.** The scanner keeps the events found and the last block scanned. A later call requests only
  newer blocks. A range that failed is requested again; the ranges before it are kept.
- **Bounded work per call.** One call makes at most 50 `eth_getLogs` requests. The result says how far the scan
  got (`scannedToBlock`, `targetBlock`) and whether it is `complete`. While it is not, `events` is a prefix of
  the history and must not be presented as all of it.
- **Confirmations.** On a live chain the scan stays 12 blocks behind the head, because a scanned range is never
  read again. A local chain uses zero.
- **Emitter check.** A registry event is accepted only from the registry address and `RebalanceRecorded` only
  from the log address.
- **Timestamps.** Each event carries its block timestamp, from the log when the node provides it and from
  `eth_getBlockByNumber` otherwise.

Events are decoded into a typed union (`index_created`, `version_published`, `index_deprecated`,
`rebalance_recorded`). `RebalanceRecorded` is a claim by an account and proves no trade, as described in the
[index registry](index-registry.md#rebalancelog) page.

Two pure helpers aggregate a list of events: `countPerDay(events, type)` counts one event type per UTC day, and
`distinctCreators(events)` lists the accounts that created an index.

The scan starts from the deploy block on every process start. That is acceptable for a registry with a short
history and is the first thing to replace with a persistent index when the history grows.

## Errors

Failures of the read itself are thrown as `RegistryError` subclasses. The codes are the ones the market data
layer uses for the same conditions.

| Code                    | Class                            | When                                                         |
| ----------------------- | -------------------------------- | ------------------------------------------------------------ |
| `upstream_failure`      | `RegistryUpstreamError`          | The RPC endpoint failed, timed out or reverted unexpectedly  |
| `malformed_response`    | `MalformedRegistryResponseError` | The chain returned something the registry cannot have stored |
| `missing_configuration` | `RegistryConfigurationError`     | A variable is unusable or the endpoint is another chain      |

States a caller renders are results, not errors: `registry_not_deployed`, `invalid_identifier`,
`index_not_found`, `version_not_found`, and a version with `conformant: false`.

## Tests

- `apps/web/test/registry/*.test.ts`: unit tests against an in-memory chain served over a viem transport
  (`support.ts`). No network access.
- `apps/web/test/registry/integration.test.ts`: starts Anvil, runs the deployment script and the seed, and reads
  everything back through the reader. Run with `bun run test:integration`; it needs Foundry. CI runs it in the
  `integration` job.
- `apps/web/test/registry/live.test.ts`: the deployment map against the live chains, with `LIVE_TESTS=1`.

The local workflow is described in [Local chain](../development/local-chain.md).
