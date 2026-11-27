# Consuming an index from a contract

Any contract on the same chain can read an index from `IndexRegistry` with the interface alone, and act on its
constituents. Two example contracts in `contracts/test/examples` show how, and their tests run in the `contracts`
CI job. They are test fixtures that show the pattern: neither is deployed, and neither is a supported contract.

| Contract               | What it does with a version                                                           | Tests                                   |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| `IndexConsumer.sol`    | Reads it: splits an amount by static weight, looks up membership and a weight         | `contracts/test/IndexConsumer.t.sol`    |
| `IndexSliceSender.sol` | Acts on it: sends the same share of every constituent the caller holds to a recipient | `contracts/test/IndexSliceSender.t.sol` |

## The read pattern

1. Import `contracts/src/interfaces/IIndexRegistry.sol` and take the registry address as a constructor argument.
   The deployed addresses are in `packages/contracts-abi` ([Deployment](deployment.md)).
2. Pin the exact `(indexId, version)` the contract accepts. A version never changes once published, so a pinned
   version always reads the same. `latestVersion` changes whenever the creator publishes.
3. Read `getVersion(indexId, version).composition` before the constituents. `Static` stores tokens and weights;
   `DynamicWeights` stores tokens and a weight of 0 for each, which means "not known onchain", never "zero
   weight"; `RuleBased` stores no constituent at all.
4. Read `constituentsOf(indexId, version)`: at most 64 entries, tokens strictly ascending, so a binary search
   finds a token.
5. Decide what a deprecated index means for the contract. `getIndex(indexId).deprecatedAt` is non-zero once the
   creator deprecates it; its versions stay readable.

An unknown index or version makes the registry revert with `IndexNotFound` or `VersionNotFound`, and the
consumer reverts with it. The interface and its guarantees are described in
[Index registry](../architecture/index-registry.md#reading-an-index-from-another-contract).

## Acting on the constituents: `IndexSliceSender`

`sendSlice(indexId, version, to, shareBps)` sends `shareBps` of the caller's balance of every constituent to `to`,
so the recipient receives a slice of the caller's replication in the caller's own proportions. `sliceOf` returns
the same amounts without moving anything.

- **Per constituent**, the amount is `balanceOf(caller) * shareBps / 10_000`, rounded down. A constituent that
  rounds to zero is skipped, so it needs no allowance.
- **Compositions.** It uses the tokens and ignores the stored weights, so `Static` and `DynamicWeights` versions
  both work. A `RuleBased` version reverts with `NoConstituents`, and a deprecated index with `Deprecated`.
- **No custody.** Every token goes from the caller to the recipient with `transferFrom`. The contract holds
  nothing, stores nothing and has no owner. The caller approves it for each constituent first.
- **All or nothing.** A transfer that reverts or returns `false` reverts the whole slice with `TransferFailed`.
  A token that returns nothing on success is accepted, as many ERC-20 tokens do. A constituent without code
  reverts when its balance is read, before anything moves.
- **No price.** Keeping the caller's proportions needs no price. Moving toward the target weights would need a
  reference price per constituent and the calculation of `equityos.calc/1`, which runs offchain
  ([Calculation](../architecture/calculation.md)).

The tests cover each of these: a static and a dynamic version, a pinned version after a new one, rounding, the
three return styles of a token, a missing allowance, a constituent without code, every revert, and a fuzz test
that every balance is conserved.

## What a consumer has to trust

- **The creator of the index.** The registry validates the shape of the mirror, not the tokens: a constituent can
  be any address the creator chose, including a malicious contract, and a consumer that calls it runs its code.
  The registry also does not check that the mirror matches the spec; the calculator does that offchain. Accept
  only the creators or the exact versions you trust.
- **The tokens' own rules.** Tokenized stocks on Base check a policy for the sender, the receiver and the caller
  of a transfer ([Execution](../architecture/execution.md#policy)). A transfer a policy forbids reverts, and with
  it the whole slice.

## Running the tests

```sh
forge test --root contracts --match-contract "IndexConsumerTest|IndexSliceSenderTest"
```

`FOUNDRY_PROFILE=ci` runs the fuzz test 10,000 times, as CI does.
