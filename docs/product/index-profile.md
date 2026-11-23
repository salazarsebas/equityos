# Index profile and verification

What the index pages of the web app show, and what each verification check means for someone reading them. The
pages are `/indexes` (the explorer), `/indexes/{identifier}` (the latest version of one index) and
`/indexes/{identifier}/versions/{n}` (one version). The data behind them is described in the
[Indexes API](../api/indexes.md).

## What an index is

An index is a published methodology: a fixed list of tokens, a target weight for each and a rebalance rule. It
is not a fund. It holds no assets, and it does nothing by itself. A published version never changes. A change is
a new version with its own hash, and earlier versions stay readable.

## The explorer

A table of the indexes in the registry, newest first, with a link to sort oldest first. The order is in the URL
(`?sort=oldest`) and rendered by the server.

The page distinguishes these states:

| State                                       | What the page shows                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| The registry is not deployed on the network | A statement of that, with the address the registry will have. Not an error |
| The registry is deployed and holds no index | "No index has been published yet"                                          |
| The registry cannot be read                 | An error with a retry. Never an empty table                                |
| An index fails verification                 | Its row, with "Fails C5" and without name, weighting or weights            |
| Recorded or local data                      | A notice above the table saying so                                         |

The registry is not deployed on Base mainnet or Base Sepolia, so on those networks the first state is what a
visitor sees. Indexes exist only on a [local chain](../development/local-chain.md).

## The profile

One version of one index, in a fixed order:

1. **Header.** Name, version, whether it is the latest, deprecation, description, creator, publication time and
   spec hash. A verified version links to "Compare a wallet with this index", the
   [portfolio page](portfolio.md) with the index, and the version when it is not the latest, filled in.
2. **Key facts.** Number of constituents, largest weight, rebalance rule, date of the last publication.
3. **Composition.** Every constituent with its target weight, its reference price and its status now.
4. **Verification.** The panel described below.
5. **Methodology.** The rules of the spec in plain language.
6. **Version history.** Every recent version with what it changed.
7. **Performance.** A statement that none is shown.

The name, the description, the composition and the methodology come from the spec, and are shown only when the
version passes every check. For a version that fails one, the page shows the failed check first and nothing
computed from the spec: the title is "Unverified index" followed by the first digits of the index id.

A request by index id, or in another letter case, is redirected to the canonical URL. An identifier whose slug
is not the one of the index is a 404, never a redirect, so a link cannot show one name and open another index.

### Target weights, reference prices and status now

- A **target weight** is a published rule. It is the same on every visit.
- A **reference price** is the latest value of the oracle feed of the token. It is an indication of value and
  not an executable price: no trade is guaranteed at it. Its status says how recent it is, as on the assets
  page.
- **Status now** says whether the token is still index-eligible, whether its issuer paused transfers and
  whether it has a usable price. A token can stop being eligible after a version is published. The row then
  says so. It is never removed.

Nothing on the page is advice.

## The verification panel

The panel answers one question: is the methodology shown on this page the one that was published? It does so in
a way a reader can repeat without trusting the page.

### Stored onchain

The facts the registry holds for the version: the spec hash, the index id, the registry address, the chain, the
block and time of publication and the size of the spec. None of them can change after publication.

### The five checks

They are computed by `verifyVersion` in `@equityos/core` from the stored bytes, the stored hash, the stored
constituents and the chain id, and from nothing else. Their result is the same forever. They are specified in
the [methodology spec](../architecture/methodology-spec.md#verifying-a-published-version).

| Check | On the page          | If it passes                                                            | If it fails                                                                       |
| ----- | -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1    | Hash matches         | The document shown is the one whose hash the registry recorded          | The bytes and the hash do not belong together                                     |
| C2    | Well-formed document | The bytes are text, and one JSON document with no repeated property     | The bytes are not a document. Nothing can be read from them                       |
| C3    | Canonical form       | The document has its one canonical spelling, so it has exactly one hash | The same rules could be published again under another hash                        |
| C4    | Valid methodology    | The document follows the schema and every rule, and names this chain    | The document is not a methodology this version of EquityOS can read               |
| C5    | Composition matches  | The tokens and weights the registry stores are the ones the rules imply | A contract reading the registry would see other weights than a reader of the spec |

Each row shows its result and the reason the verifier gave, for example the hash it computed. A check is "Not
evaluated" when an earlier one failed: C3 needs C2, C4 needs C3 and C5 needs C4. "Not evaluated" is never a
pass.

A version is conformant only when all five pass. The registry accepts any bytes, so a version that fails is a
normal thing to find, not a malfunction. It says nothing about intent.

What the checks do not say:

- They do not say the index is good, suitable or likely to gain value. They say the published document is well
  formed and consistent with what the chain stores.
- They do not say the tokens exist, trade or can be held by a given wallet.

### Status of the assets now

Below the checks, and deliberately apart from them: whether every constituent is index-eligible, transferable
and priced at the latest block read. This can change at any block, so it is not part of conformance and never
changes the result above.

### Verify it yourself

The disclosure shows the exact spec the registry stores, as one line of text, the spec hash, and three commands
built from the real address, index id and version. `cast` is the command line client of Foundry.

For version 2 of the seeded index `diversified-equity-d622e2a5` on a local chain:

```sh
cast call 0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c "specOf(bytes32,uint32)(bytes)" 0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610 2 --rpc-url http://127.0.0.1:8545
```

This prints the stored spec as hexadecimal, 969 bytes starting with `0x7b2263616c63223a`. They are the bytes of
the text shown on the page.

```sh
cast call 0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c "specOf(bytes32,uint32)(bytes)" 0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610 2 --rpc-url http://127.0.0.1:8545 | cast keccak
```

This prints `0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6`, the spec hash on the page.
That is check C1, done by the reader.

```sh
curl -s http://localhost:3000/api/v1/indexes/0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610/versions/2
```

This returns the same hash, bytes, text, constituents and checks as JSON.

The first two commands talk to the chain only. The RPC endpoint in them is the public one of the chain, never
the endpoint the server is configured with. The origin in the third is `NEXT_PUBLIC_SITE_URL` of the deployment.

## The methodology section

Every line is generated from one field of the spec by a fixed template in
`apps/web/src/lib/indexes/methodology.ts`. No text is written by a language model, and the same spec always
produces the same text. The rules are, in order: universe, weighting, weight bounds, rebalance trigger, minimum
interval and pricing source, followed by four fixed sentences on what an index does not do.

## Version history

Each row compares a version with the one before it. The comparison is computed from the two specs by
`diffSpecs` in `apps/web/src/lib/indexes/diff.ts`: constituents added and removed, weights changed, and each
rule that changed. A version is not compared when it, or the one before it, fails verification. The table lists
the 50 most recent versions.

## Performance

No performance is shown. An index level is not calculated yet, so there is no history, and none is estimated or
back-calculated to fill the section. The page says so in one paragraph instead of leaving the section out, so
that the absence of a chart is not read as a loading failure or an omission.

## Recorded data in tests

The browser tests run the pages against a recording, so that they need no chain:

- `REGISTRY_REPLAY_DIR` names a directory with `registry.json`, the read calls of the registry of a local chain
  at one block, written by `bun run --filter @equityos/web record:registry <directory>` from a running Anvil
  node. The reader serves it through the same code as a live chain.
- `apps/web/test/fixtures/registry` is the local chain after the deployment script and the seed, and
  `apps/web/test/fixtures/registry-empty` is the chain after the deployment script alone.
- While a recording is served, every index page shows a warning that says so, the API reports
  `meta.registry.mode: "replay"`, and `GET /api/v1/status` reports `registry.mode: "replay"`.

Never set the variable on a deployment.
