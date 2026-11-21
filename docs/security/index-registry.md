# Index registry security

Security properties of `IndexRegistry` and `RebalanceLog`. The design is described in
[the architecture page](../architecture/index-registry.md).

## Not audited

**These contracts have not been audited.** No external party has reviewed them. The safety case is their small
size, the absence of funds and privileges, and the tests described below. Read the source before relying on
them: `contracts/src/IndexRegistry.sol` and `contracts/src/RebalanceLog.sol` are under 300 lines together.

## Trust assumptions

What the contracts guarantee, without trusting anyone:

- A published version never changes. Its spec bytes, hash, timestamps, composition and constituents are written
  once.
- `specHash` is the keccak256 of the stored spec bytes. It is computed by the registry, not supplied.
- Only the creator of an index can append a version to it or deprecate it.
- The structured mirror is well formed: at most 64 tokens, strictly ascending, and for a static composition
  positive weights that sum to exactly 10,000 basis points.
- Neither contract can hold or move tokens, and neither accepts ETH through any function.
- Nobody, including the deployer, has any privilege. There is no owner, admin, pause, fee or upgrade path.

What a user or integrator still has to trust:

- **The creator of an index**, for everything about its content: that the spec means what it claims, that the
  mirror matches the spec, that the tokens are the intended ones, and that later versions are honest.
- **The creator's key management.** Whoever controls the creator address can append versions and deprecate the
  index. They cannot alter a version that is already published.
- **The compiler and the chain.** The bytecode is produced by solc 0.8.39 and runs on Base.
- **Offchain consumers**, for any interpretation of `RebalanceRecorded` events. The event is an unverified claim.

## Threat model

| Asset                            | Actor                            | Attack                                                   | Mitigation                                                                                                        |
| -------------------------------- | -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Integrity of a published version | Anyone, including the creator    | Change the spec, weights or hash after publication       | No function writes to an existing version. Invariant I2                                                           |
| Authorship of an index           | Third party                      | Publish a version on, or deprecate, someone else's index | `NotCreator`. Invariant I12                                                                                       |
| Index id                         | Observer of pending transactions | Create the id before its creator does                    | The id is derived from `msg.sender`: a different sender gets a different id                                       |
| Followers of an index            | Creator, or thief of its key     | Publish a malicious new version                          | Versions are append-only and referenced by number. Nothing onchain moves a follower to a new version              |
| Contracts that read the mirror   | Creator                          | Mirror that contradicts the spec, or a malicious token   | Not prevented onchain. A consumer must pin the creator or the exact version it accepts                            |
| Publisher                        | Its own client                   | Submit the same version twice, or from stale state       | `expectedVersion` must equal `latestVersion + 1`                                                                  |
| Registry liveness                | Spammer                          | Fill the registry with junk                              | Each publish pays for its own storage. Size caps. No function iterates over all indexes, so nobody else pays more |
| Readers                          | Publisher                        | Oversized spec or constituent list that makes reads fail | `MAX_SPEC_BYTES` and `MAX_CONSTITUENTS` bound every read                                                          |
| Indexers and frontends           | Publisher                        | Invalid UTF-8, hostile JSON, markup in the spec          | Not prevented onchain. The type is `bytes`; consumers must decode defensively and render as text                  |
| User funds                       | Anyone                           | Steal through these contracts                            | Neither contract calls a token, holds a balance or takes an approval. No `payable`, `receive` or `fallback`       |
| Rebalance events                 | Anyone                           | Emit events without trading                              | Reverts for versions that do not exist. Beyond that, not prevented: consumers must match events to token flows    |
| Rebalance events                 | Intermediate contract            | Attribute an event to another account                    | `account` is always `msg.sender`, never calldata or `tx.origin`                                                   |
| Deployment                       | Front-runner                     | Deploy first at the deterministic address                | Same bytecode, no owner, no initializer: the result is identical. The script checks the code hash                 |
| Deployment                       | Operator mistake                 | Different bytecode on two chains                         | Pinned build settings, expected addresses and code hashes committed, checked by the script and by a test          |
| Deployment                       | Operator mistake                 | Send the deployment to Base mainnet unintentionally      | The script reverts on chain 8453 unless `DEPLOY_MAINNET=true` is set                                              |
| Deployment                       | Anyone                           | Send ETH to the address before deployment to block it    | The script reports a balance but does not reject it                                                               |
| Contract balance                 | Anyone                           | Force ETH in without a call                              | The ETH is stuck. Nothing reads the balance                                                                       |
| Time fields                      | Sequencer                        | Skew `block.timestamp`                                   | Timestamps are informational. No logic depends on time                                                            |

## Invariants

Checked by `contracts/test/IndexRegistry.invariant.t.sol` with a handler that creates, publishes, deprecates and
attacks from four actors, and by the unit and fuzz tests.

| Id  | Invariant                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Every existing index has `latestVersion >= 1`, and it never decreases                                                                           |
| I2  | For every version that has existed, `specOf`, `getVersion` and `constituentsOf` return the same values forever                                  |
| I3  | `specHash == keccak256(specOf)` and `specSize == specOf.length`                                                                                 |
| I4  | The creator of an index never changes, and `computeIndexId(creator, salt) == indexId`                                                           |
| I5  | `versionExists(id, v)` is true exactly for `1 <= v <= latestVersion`                                                                            |
| I6  | `0 < specSize <= MAX_SPEC_BYTES` and `constituentCount <= MAX_CONSTITUENTS` for every version                                                   |
| I7  | Constituent tokens are strictly ascending for every version                                                                                     |
| I8  | `Static`: every weight is positive and the sum is 10,000. `DynamicWeights`: at least one token, every weight is 0. `RuleBased`: no constituents |
| I9  | `deprecatedAt` goes from 0 to non-zero at most once, and `latestVersion` never changes afterwards                                               |
| I10 | `indexCount()` equals the number of successful `createIndex` calls, and `indexIdAt(i)` never changes                                            |
| I11 | Neither contract holds ETH under any sequence of calls                                                                                          |
| I12 | A call by anyone other than the creator leaves an index unchanged                                                                               |
| I13 | `RebalanceLog` writes no storage and emits exactly one event, with `account == msg.sender`, on success                                          |

Structural checks on the compiled bytecode (`contracts/test/Bytecode.t.sol`):

- `IndexRegistry` contains no `CALL`, `CALLCODE`, `DELEGATECALL`, `STATICCALL`, `CREATE`, `CREATE2` or
  `SELFDESTRUCT` instruction.
- `RebalanceLog` contains exactly one `STATICCALL`, and no `CALL`, `CALLCODE`, `DELEGATECALL`, `CREATE`,
  `CREATE2`, `SELFDESTRUCT`, `SSTORE` or `TSTORE` instruction.

Line and branch coverage of both contracts is 100%.

## What is not protected against

- **A dishonest creator.** The registry stores what it is given. It does not check that the spec is well formed,
  that the mirror matches the spec, or that the tokens are legitimate.
- **A compromised creator key.** The holder can append a version and deprecate the index. Published versions
  stay intact.
- **Permanent content.** Anything published stays readable forever. There is no takedown and no way to delete a
  spec, including offensive or unlawful content. Filtering is the job of whatever displays the registry.
- **Impersonation.** Anyone can publish a spec that copies the content or name of another index. The only
  identity the registry provides is the creator address.
- **Cross-chain identity.** The index id contains no chain id. The same creator address can belong to a
  different party on another chain (for example a counterfactual smart account deployed with other owners), so
  an equal `indexId` on two chains does not imply the same creator. The full identity is
  `(chainId, registry, indexId, version)`.
- **Meaningless rebalance events.** Anyone can call `recordRebalance` for any existing version at the cost of
  gas. The event proves that the caller named a version, not that it traded.
- **Wrong constants.** `MAX_SPEC_BYTES` and `MAX_CONSTITUENTS` cannot be changed. A different value requires a
  new registry at a new address, and existing indexes do not move.
- **Version exhaustion.** An index accepts at most `2**32 - 1` versions. Reaching it costs the creator more than
  four billion transactions on its own index.
- **Lost creator access.** There is no recovery and no ownership transfer. An index whose creator key is lost
  can never receive a version or be deprecated.
- **Forced ETH.** ETH sent with `SELFDESTRUCT`, or to the address before deployment, cannot be withdrawn.
- **Compiler or chain bugs.**
