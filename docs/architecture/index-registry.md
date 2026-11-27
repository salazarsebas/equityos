# Index registry

Two contracts publish index methodologies onchain and let an account declare that it follows one:

- `IndexRegistry` (`contracts/src/IndexRegistry.sol`): an append-only store of versioned index specifications.
- `RebalanceLog` (`contracts/src/RebalanceLog.sol`): a stateless contract that emits one event per declared
  rebalance.

Both are immutable and ownerless. They hold no funds and have no admin, no pause, no upgrade path and no fee. The
registry makes no external call. The log makes one static call, to the registry. Third-party contracts integrate
through the interfaces in `contracts/src/interfaces`.

These contracts have not been audited. See [the security page](../security/index-registry.md).

## Data model

### Index

An index is identified by a `bytes32` id:

```solidity
indexId = keccak256(abi.encode(creator, salt))
```

- `creator` is the `msg.sender` of `createIndex`. It never changes: there is no transfer function. A creator
  that needs key rotation publishes from a multisig or a smart account.
- `salt` is chosen by the creator. Any value is accepted.
- The id does not include the chain id or the registry address, so the same creator and salt give the same id on
  every chain. A complete reference to a version is the tuple `(chainId, registry, indexId, version)`.
- Because the id is derived from the caller, nobody can create an id in another creator's namespace, and the id
  can be computed before the transaction is sent (`computeIndexId`).

The registry stores no name. A name, if any, lives inside the spec bytes.

> **The index id is not a global identity.** The full identity of a version is
> `(chainId, registry, indexId, version)`. The same `indexId` on two chains means the same creator address and
> salt, not the same party: an address can be controlled by different parties on different chains, for example a
> smart account whose address is derived counterfactually and deployed with other owners elsewhere. Never infer
> from equal ids on two chains that the indexes share a creator or a methodology. Compare the spec bytes or the
> `specHash` on each chain instead.

### Version

A version is identified by `(indexId, version)`. Versions are `uint32`, start at 1 and are strictly sequential.
`createIndex` writes version 1 in the same call, so an index without a version cannot exist. A version stores:

| Field            | Type            | Meaning                                                            |
| ---------------- | --------------- | ------------------------------------------------------------------ |
| `spec`           | `bytes`         | The specification bytes, exactly as submitted                      |
| `specHash`       | `bytes32`       | `keccak256(spec)`, computed by the registry, never supplied        |
| `publishedAt`    | `uint64`        | `block.timestamp` of publication, in seconds                       |
| `publishedBlock` | `uint64`        | `block.number` of publication                                      |
| `composition`    | `Composition`   | What the structured mirror below contains                          |
| `constituents`   | `Constituent[]` | Structured mirror: `(address token, uint16 weightBps)` per element |

Nothing about a published version can change. No function writes to an existing version.

### Composition

The structured mirror makes the static part of an index readable by another contract without parsing the spec.
`Composition` states how much of the index is static, and is derived from the lengths of the arguments:

| `tokens` | `weightsBps` | Composition      | Stored constituents                                        |
| -------- | ------------ | ---------------- | ---------------------------------------------------------- |
| empty    | empty        | `RuleBased`      | None. The universe is defined by a rule in the spec        |
| `n > 0`  | empty        | `DynamicWeights` | `n` tokens, every `weightBps` is 0                         |
| `n > 0`  | `n` weights  | `Static`         | `n` tokens with weights in basis points that sum to 10,000 |

Any other combination of lengths reverts with `LengthMismatch`. Weights are in basis points: 1 bps is 0.01% and
10,000 bps is 100%. For `DynamicWeights` the weights are not known at publication, so the registry stores zero
instead of a number that would only be true on the day of publication.

## Lifecycle

| State      | Condition                                 | Allowed transitions           |
| ---------- | ----------------------------------------- | ----------------------------- |
| Active     | `latestVersion >= 1`, `deprecatedAt == 0` | `publishVersion`, `deprecate` |
| Deprecated | `deprecatedAt != 0`                       | None. Deprecation is terminal |

- `createIndex(salt, spec, tokens, weightsBps)` creates the index and its version 1. It reverts with
  `IndexAlreadyExists` if the caller already used the salt.
- `publishVersion(indexId, expectedVersion, spec, tokens, weightsBps)` appends a version. Only the creator can
  call it. `expectedVersion` must equal `latestVersion + 1`, so a duplicate or stale submission reverts with
  `UnexpectedVersion` instead of publishing twice.
- `deprecate(indexId)` marks the index as deprecated. Only the creator can call it, once. It blocks new versions.
  It deletes nothing: every version stays readable, and `RebalanceLog` still accepts it.

Following an index always means following one `(indexId, version)`. A new version does not replace an older one,
and nothing onchain moves an account from one version to the next.

## What is validated onchain

| Check                                                    | Error                        |
| -------------------------------------------------------- | ---------------------------- |
| Spec is not empty                                        | `EmptySpec`                  |
| Spec is at most `MAX_SPEC_BYTES` (8,192) bytes           | `SpecTooLarge`               |
| At most `MAX_CONSTITUENTS` (64) tokens                   | `TooManyConstituents`        |
| `weightsBps` is empty or has the same length as `tokens` | `LengthMismatch`             |
| Tokens are strictly ascending by address                 | `TokensNotStrictlyAscending` |
| Static composition: every weight is greater than zero    | `ZeroWeight`                 |
| Static composition: weights sum to exactly 10,000        | `InvalidWeightSum`           |
| Only the creator publishes or deprecates                 | `NotCreator`                 |
| No version is published on a deprecated index            | `IndexIsDeprecated`          |
| `expectedVersion` is `latestVersion + 1`                 | `UnexpectedVersion`          |

Strictly ascending order implies that tokens are unique and that none is the zero address. It also gives every
reader the same canonical order and allows a binary search.

## What is not validated onchain

- **The content of the spec.** The registry does not parse it. It can be any bytes: not valid JSON, not valid
  UTF-8, not canonical. The type is `bytes`, not `string`, so that a consumer decodes it explicitly and handles
  failure.
- **That the mirror matches the spec.** A creator can publish a spec that describes one composition and a mirror
  that states another. Comparing them requires parsing the spec, which is an offchain check.
- **The tokens.** A constituent can be any non-zero address: not a contract, not a token, or a malicious token.
  The registry has no allowlist and calls no token.
- **Names and identity.** Nothing prevents two creators from publishing identical or similar specs.

A contract that reads the mirror therefore trusts the creator of the index it reads, and should pin the creator
or the exact `(indexId, version)` it accepts.

## Reading an index from another contract

Import the interface, check the composition, then read the constituents:

```solidity
import {IIndexRegistry} from "./interfaces/IIndexRegistry.sol";

function staticConstituents(
    IIndexRegistry registry,
    bytes32 indexId,
    uint32 version
)
    view
    returns (IIndexRegistry.Constituent[] memory)
{
    // Reverts with VersionNotFound if the version does not exist.
    IIndexRegistry.VersionInfo memory info = registry.getVersion(indexId, version);
    // Weights are zero for DynamicWeights and absent for RuleBased: check before using them.
    require(info.composition == IIndexRegistry.Composition.Static, "not static");
    // At most 64 entries, tokens strictly ascending, weights positive and summing to 10,000.
    return registry.constituentsOf(indexId, version);
}
```

The composition check is not optional. For a `DynamicWeights` version every stored `weightBps` is 0, which means
"not known onchain", not "zero weight". A consumer that needs weights must revert, or return the composition to
its caller, when the version is not `Static`. It must never use the stored zeros as weights. Membership (is this
token a constituent) can be read from the mirror for `Static` and `DynamicWeights`, and cannot be decided from
the mirror for `RuleBased`, which stores no constituents.

`contracts/test/examples/IndexConsumer.sol` is a complete contract used by the test suite that follows this
pattern: `targetAllocation` and `staticWeightOf` revert with `NotStatic` on any other composition, and
`isConstituent` answers membership with a binary search without touching the weights. `contracts/test/examples/IndexSliceSender.sol`
acts on the constituents: it sends a share of every constituent the caller holds to a recipient. Both are
described in [Consuming an index from a contract](../development/consuming-an-index.md).

Read functions:

| Function                           | Returns                                                 | Unknown input         |
| ---------------------------------- | ------------------------------------------------------- | --------------------- |
| `computeIndexId(creator, salt)`    | The id, whether or not the index exists                 | Never reverts         |
| `exists(indexId)`                  | Whether the index exists                                | Returns `false`       |
| `versionExists(indexId, version)`  | Whether `1 <= version <= latestVersion`                 | Returns `false`       |
| `getIndex(indexId)`                | `creator`, `latestVersion`, `createdAt`, `deprecatedAt` | `IndexNotFound`       |
| `getVersion(indexId, version)`     | Hash, timestamps, composition, sizes                    | `VersionNotFound`     |
| `specOf(indexId, version)`         | The spec bytes                                          | `VersionNotFound`     |
| `constituentsOf(indexId, version)` | The structured mirror                                   | `VersionNotFound`     |
| `indexCount()`                     | Number of indexes ever created                          | Never reverts         |
| `indexIdAt(position)`              | Id at a position in creation order                      | `PositionOutOfBounds` |

`indexCount` and `indexIdAt` make the whole registry reconstructible from state with `eth_call` alone, without
scanning logs. Positions are stable: entries are only appended.

## Limits

| Limit              | Value       | Why                                                       |
| ------------------ | ----------- | --------------------------------------------------------- |
| `MAX_SPEC_BYTES`   | 8,192 bytes | Bounds the gas and storage of a publish and of every read |
| `MAX_CONSTITUENTS` | 64          | Bounds every loop, for the publisher and for every reader |
| Versions per index | `2**32 - 1` | Width of the version number                               |

The limits are constants. They cannot be changed: a different limit requires a new registry at a new address.

### Gas

Measured by `contracts/test/IndexRegistry.gas.t.sol`. The values are committed in `contracts/snapshots` and CI
fails if they drift.

Publishing:

| Call                                                   | Execution gas | Transaction gas |
| ------------------------------------------------------ | ------------- | --------------- |
| `createIndex`, 600-byte spec, 10 static constituents   | 822,264       | 859,404         |
| `createIndex`, 8,192-byte spec, 64 static constituents | 7,363,405     | 7,548,613       |

Transaction gas adds the 21,000 base cost and the calldata cost to the execution gas. It does not include the L1
data fee that Base charges separately. The largest possible publish uses about 45% of the per-transaction gas cap
on Base (16,777,216) and about 19% of a 40,000,000 gas block. The publisher pays for all the storage it creates,
and no function iterates over all indexes, so the size of the registry does not change the cost of any call.

Reading from another contract, with cold storage (the first read of that version in the transaction):

| Call                                    | Execution gas |
| --------------------------------------- | ------------- |
| `getVersion`                            | 12,157        |
| `constituentsOf`, 10 constituents       | 29,991        |
| `constituentsOf`, 64 constituents (max) | 163,681       |
| `specOf`, 600-byte spec                 | 46,732        |
| `specOf`, 8,192-byte spec (max)         | 558,939       |

These are the gas of the call into the registry. The caller also pays 2,600 once per transaction for the first
access to the registry address, plus its own memory and decoding costs. A consumer that only needs the
composition should call `getVersion` and `constituentsOf` and leave `specOf` to offchain readers.

## Events

`IndexRegistry`:

| Event              | Parameters                                                                                               | When                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `IndexCreated`     | `indexId` (indexed), `creator` (indexed), `salt`                                                         | Once per index, before its first version    |
| `VersionPublished` | `indexId`, `version`, `specHash` (all indexed), `creator`, `composition`, `specSize`, `constituentCount` | For every version, including version 1      |
| `IndexDeprecated`  | `indexId` (indexed), `creator` (indexed)                                                                 | Once, when the creator deprecates the index |

No event carries the spec bytes or the constituents. Contract state is the single store. An indexer reads each
version once with `eth_call` (`getVersion`, `specOf`, `constituentsOf`) when it sees `VersionPublished`, and can
cache the result forever, because a published version never changes. The sizes in the event are informational:
read the state.

`RebalanceLog`:

| Event               | Parameters                                    | When                                  |
| ------------------- | --------------------------------------------- | ------------------------------------- |
| `RebalanceRecorded` | `account`, `indexId`, `version` (all indexed) | On every successful `recordRebalance` |

## RebalanceLog

`recordRebalance(indexId, version)` emits `RebalanceRecorded(msg.sender, indexId, version)` and reverts with
`UnknownIndexVersion` if the version does not exist in the registry. It writes no storage and moves no tokens.

The event is a claim by the caller and nothing more. It carries no amounts. Anyone can call it without trading,
so a consumer of these events must derive amounts from the token `Transfer` logs of the same transaction and must
not count an event that has no matching token flows for the same account.

The log is separate from the registry so that the registry never has to change if the event schema does. The
registry address is fixed in the log bytecode at construction.

## Deployment

Both contracts are deployed with CREATE2 through the deterministic deployment proxy at
`0x4e59b44847b379578588920cA78FbF26c0B4956C`, so the addresses are the same on Base mainnet and Base Sepolia for
the same bytecode. `contracts/script/Deploy.s.sol` holds the salts, the expected addresses and the expected
runtime code hashes, and refuses to continue if any of them does not match. The addresses depend on the exact
bytecode, compiler metadata included, so they are tied to a commit.

There is no proxy pattern. Neither contract has an owner or an initializer, so the identity of the deployer does
not matter: anyone who deploys the same bytecode gets the same contract at the same address.

Neither contract is deployed on a live network yet. Commands for a local deployment are in
[contracts/README.md](../../contracts/README.md).
