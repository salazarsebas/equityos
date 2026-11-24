# Network metrics

The page `/network` and the endpoint [`GET /api/v1/network`](../api/network.md) report the activity of the
[index registry and the rebalance log](../architecture/index-registry.md) on the chain the server reads. Every
figure is computed from chain data only:

- the `IndexCreated`, `VersionPublished`, `IndexDeprecated` and `RebalanceRecorded` logs, scanned by the
  [registry reader](../architecture/registry-reader.md#events);
- the receipt of each attestation's transaction, and the ERC-20 `Transfer` logs in it;
- reads at the block of a transaction: the attested version's constituents (registry state), the token
  `decimals` and `balanceOf`, and the Chainlink reference feed of each constituent.

The app's own analytics, connected wallets, page views and API requests are never counted. There is no
database: the figures are recomputed by any server from the same chain and give the same rows.

The code is in `apps/web/src/server/network`: `definitions.ts` (ids, texts, thresholds), `classify.ts` and
`aggregate.ts` (pure functions), `evidence.ts` and `service.ts` (chain reads, caching).

## Every metric carries its provenance

Each metric is an object with its value, its definition id, the chain id, the first and the last block it
covers, and the time it was computed. Registry metrics cover the deploy block up to the last scanned block.
Usage metrics cover up to the last block whose attestations are all classified, which is the same block once
classification has caught up.

## Definitions

| Id                                | Title                                     | Definition                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry.indexes_published`      | Published indexes                         | `IndexCreated` events. Version 1 is written in the same call, so every index has a published version.                                                                                                                                   |
| `registry.versions_published`     | Index versions                            | `VersionPublished` events, version 1 included.                                                                                                                                                                                          |
| `registry.distinct_creators`      | Distinct creators                         | Distinct `creator` of `IndexCreated` events.                                                                                                                                                                                            |
| `registry.indexes_deprecated`     | Deprecated indexes                        | `IndexDeprecated` events. Deprecation is final, so an index counts once at most.                                                                                                                                                        |
| `registry.versions_per_day`       | Versions published per day                | `VersionPublished` events per UTC day of their block time. Days without one are absent.                                                                                                                                                 |
| `usage.attestations`              | Attestations recorded                     | `RebalanceRecorded` events of every tier.                                                                                                                                                                                               |
| `usage.attestations_tier_a`       | Attestations with matching flows (tier A) | See [Tiers](#tiers).                                                                                                                                                                                                                    |
| `usage.attestations_tier_b`       | Linked attestations (tier B)              | See [Tiers](#tiers). Never in a headline figure.                                                                                                                                                                                        |
| `usage.attestations_unmatched`    | Unmatched attestations                    | Neither tier A nor tier B. Never in a headline figure.                                                                                                                                                                                  |
| `usage.accounts_tier_a`           | Distinct accounts (tier A)                | Distinct attesting accounts with at least one tier A attestation.                                                                                                                                                                       |
| `usage.accounts_within_tolerance` | Accounts within tolerance                 | Distinct accounts with a tier A attestation after which, at the end of its block, the largest drift of their holdings from the target weights was at most the version's `driftThresholdBps` plus 200. See [Tolerance](#tolerance).      |
| `usage.tier_a_per_day`            | Tier A attestations per day               | Tier A attestations per UTC day of their block time. Days without one are absent.                                                                                                                                                       |
| `usage.by_index`                  | Attestations by index                     | Per attested index: attestations of each tier, and distinct accounts with a tier A attestation. Ordered by distinct accounts, then tier A attestations, then index id.                                                                  |
| `volume.tier_a_reference_value`   | Reference value moved (tier A)            | Sum over tier A attestations of every constituent transfer to or from the attesting account in the same transaction, each valued at the reference price of that block, rounded down. Purchases and sales both count. USD scaled by 1e8. |
| `exclusions.activity`             | Excluded activity                         | Indexes and versions created by excluded accounts, and attestations they recorded, by tier. Counted here and in no other figure.                                                                                                        |

Every metric except `exclusions.activity` leaves out the [excluded accounts](#excluded-accounts): their
attestations, and the indexes they created with the versions and deprecations of those indexes.

The texts the page and the API show are the ones in `definitions.ts`. A unit test fails when a metric has no
definition, and the browser test fails when a definition is not rendered on the page.

## Tiers

An attestation `E = (account, indexId, version)` is a `RebalanceRecorded` event in transaction `T` at block
`B`. Its constituents are the tokens the registry stores for that version (`constituentsOf`). A rule-based
version stores none, so its attestations are never tier A.

A **flow** is a `Transfer` log in a transaction, emitted by a constituent, in which `account` is the sender or
the recipient but not both. Mints and burns count. A transfer to itself does not. The **value** of the flows is
the sum of `amount * priceE8 / 10^decimals` over the flows, each rounded down, whatever their direction.

| Tier      | Rule                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A         | `T` has flows for `account` worth at least 1.00 USD (`MIN_NOTIONAL_USD_E8`), at the reference prices of `B`.                                                                                                                                               |
| B         | Not A. `T` was sent by `account` itself (`from` of the transaction), and an earlier transaction also sent by `account`, at most 900 seconds before `B` (`TIER_B_WINDOW_SECONDS`, the edge included), has flows that meet the tier A rule at its own block. |
| Unmatched | Neither. The reason is kept: `no_constituent_flows`, `below_minimum_notional` or `price_unavailable`.                                                                                                                                                      |

- `account` is `msg.sender` of `recordRebalance`. For a smart account it is the account, while `T` is sent by a
  bundler, so tier A never requires `from == account`. Filtering flows by `account` is what keeps the
  operations of other users in the same bundle out.
- For tier B the window is scanned backwards from `B` in ranges of `EQUITYOS_LOG_CHUNK_BLOCKS` blocks, with
  `Transfer` logs of the constituents filtered by `account` as sender and as recipient, until a range starts
  before the window, at the deploy block, or after 10 ranges. The latest qualifying transaction links. A
  transaction links one attestation at most, in the order the attestations were recorded.
- A flow of a token without a usable reference price makes the value unknown: the attestation is unmatched with
  `price_unavailable`. No zero is substituted.

### Reference price

The reference price of a token at a block is the latest answer of its Chainlink feed (the market data
[feed map](../architecture/market-data.md)), read with `latestRoundData` at that block on the chain of the
attestation. It must have the recorded `decimals` and `description`, a valid round, and a staleness class other
than `unavailable` at the block's time. The token decimals are read at the same block.

It is a reference valuation of token movements: not traded value, not what the account paid or received, and
not a price any trade executed at. On a chain where the feeds do not exist the prices are unavailable and no
attestation reaches tier A.

### Tolerance

After a tier A attestation, the balances of the constituents held by `account` at the end of block `B` are
valued at the reference prices of `B`, and compared with the target weights by `computeDrift` of
`@equityos/core`. The tolerance is the version's `rebalance.driftThresholdBps` plus 200 basis points
(`TOLERANCE_MARGIN_BPS`); a largest drift equal to it is within. A version is assessed only when it is verified
(the threshold comes from its spec) and static (the registry stores its weights). Holdings that cannot all be
valued, or that are worth nothing, are `not_assessed`.

## Excluded accounts

`EQUITYOS_EXCLUDED_ACCOUNTS` lists team, test and operator accounts: comma-separated entries of an address, `=`
and a label, for example `0x5eed00000000000000000000000000000000000e=Local seed test account`. It is empty by
default. A malformed entry or a repeated address is a configuration error, never a shorter list. The page and
the API show every excluded account with its label and its activity apart.

## What can and cannot be gamed

- Recording attestations without moving tokens inflates nothing: they are unmatched.
- Moving dust inflates nothing: flows below 1.00 USD are unmatched.
- Real transfers made only to be counted pass every rule: tokens moved between two accounts of one owner, or
  wash trades by many funded accounts. They cost gas, fees and capital. Distinct accounts are addresses, not
  people.
- An excluded account that is not listed is counted. The list is public in the deployment configuration.

## States of the page

| State                                         | What the page shows                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Registry not deployed on the chain            | A plain statement and the definitions. No figure, not a row of zeros                  |
| Deployed, no attestation                      | Registry figures (zero is then the true count) and a statement that there is no usage |
| Scan or classification behind the head        | A warning with the blocks covered so far                                              |
| Fewer than 7 days of activity                 | A sentence with the count and the days in place of a daily series                     |
| The chain endpoint fails                      | An error state, no figure                                                             |
| Replay of a recording (`REGISTRY_REPLAY_DIR`) | The replay notice, and the source lines dated at the recorded block                   |

There are no count-up animations and no decoration. A daily series is a bar chart of one series on one axis,
with the same numbers in a table for assistive technology.

## Caching

The service keeps every classified attestation in memory with the registry reader's event scan, and reuses a
result while no block was scanned and no attestation classified since. A read is reused for 10 seconds. At most
100 attestations are classified per read; the rest are classified by the next reads, and the usage figures say
which blocks they cover meanwhile. Everything is lost on restart.

## Local example data

`bun run seed:local` also runs `apps/web/scripts/seed/usage.ts`, which installs the mocks of
`contracts/test/mocks/UsageMocks.sol` with `anvil_setCode` on chain 31337: a token at every feed-covered token
address, a reference feed at every feed proxy (every one answers 100.00 USD), and a minimal smart account. It
then records one attestation of each kind. See [Local chain](../development/local-chain.md#example-usage).
