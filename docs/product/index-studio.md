# Index Studio

The Studio is the page at `/studio` where an index is defined and published. It produces one thing: a valid
`equityos.index/1` document, described in [Methodology spec](../architecture/methodology-spec.md), and it can send
that document to the [index registry](../architecture/index-registry.md) as version 1 of a new index.

The Studio creates indexes. Publishing a new version of an existing index and deprecating an index are not
implemented in it.

## What the Studio produces

| Part of the editor | Fields of the spec                                                                      |
| ------------------ | --------------------------------------------------------------------------------------- |
| Identity           | `name`, `slug`, `description`, `chainId`                                                |
| Universe           | `universe.tokens` and, from the asset list, the feed of each token in `pricing.feeds`   |
| Weighting          | `weighting.type`, `weighting.weightsBps`, `constraints.maxWeightBps` and `minWeightBps` |
| Rebalance rule     | `rebalance.driftThresholdBps`, `rebalance.minIntervalSeconds`                           |

Fixed by the Studio: `schema`, `calc`, `universe.type` (`static`), `pricing.source` and `rebalance.trigger`
(`drift`). A `parent` reference is never written.

Details:

- The slug follows the name until it is typed. A cleared slug follows the name again.
- The description is normalized to Unicode NFC as it is typed, the only form the spec accepts.
- The network is part of the draft because `chainId` is part of the spec: the same methodology has a different
  hash on another chain.
- Constituents are picked from `GET /api/v1/assets`. An asset that is not index-eligible is listed with the
  reason and cannot be selected. At most 64 can be selected. Tokens are written in ascending address order, with
  feeds and weights at the same positions.
- The minimum interval is typed in days or hours and stored in seconds.

### Weights

Weights are typed in percent with at most two decimals and stored in basis points, so the two map onto each other
exactly: `12.50` is 1,250 bps. The text is parsed digit by digit and never becomes a floating-point number
(`percentTextToBps` in `apps/web/src/lib/studio/weights.ts`).

With fixed weights the editor shows a running total. When it is not 100.00% it states the difference and offers
one button:

- **Distribute remaining**: the missing basis points are split equally between all constituents, rounded down,
  and what is still missing goes one each to the lowest token addresses. This is the rule `equityos.calc/1` uses
  for equal weights: applied to empty weights it gives exactly `computeEqualWeights`.
- **Remove excess**: the excess is taken in equal parts from every constituent above 0.01%, lowest token
  addresses first for what does not divide. No weight goes under 0.01%.

Switching from equal to fixed starts from the equal split. Bounds are checks: a weight is never moved to satisfy
one.

## What is validated where

Every rule is checked by `validateSpec` of `@equityos/core`. The Studio builds the document the draft describes,
hands it to core and shows the result. It has no validation rule of its own.

| Step                                               | Where                                                    |
| -------------------------------------------------- | -------------------------------------------------------- |
| Text to integers (percent to bps, days to seconds) | `apps/web/src/lib/studio`, exact, no rounding            |
| Every rule of the spec                             | `validateSpec` in `@equityos/core`                       |
| Canonical bytes, spec hash, constituent weights    | `@equityos/core`, in the browser                         |
| Which field an error belongs to and its wording    | `evaluateDraft` in `apps/web/src/lib/studio/evaluate.ts` |
| Size, order, weight sum of the published version   | `IndexRegistry`, again, onchain                          |

Text that is not a number is passed to core as text, so the rejection still comes from core. Each error is
attached to one field by its JSON Pointer. A field that is simply empty is shown as a step to do; a field with a
wrong value is shown as an issue. Clicking an entry of the list in the preview moves focus to the field.

The preview recomputes on every edit: the composition with target weights, the methodology in plain sentences
built from fixed templates, the spec hash, the size against the 8,192 byte limit and the canonical JSON.
"Export spec JSON" saves a file that holds exactly the canonical bytes.

## Drafts

One draft is stored in the browser, in `localStorage` under `equityos.studio.draft.v1`. It is written on every
change and never sent to a server. Reading it trusts nothing: each field is checked on its own and falls back to
its default, so corrupt data cannot break the page and a draft saved by an older build still opens. "Discard
draft" removes it after a confirmation. A browser that refuses storage still runs the Studio and says that the
draft is not saved.

The draft holds a random 32-byte salt, generated in the browser. The index id is derived from the creator and
the salt, so publishing the same draft again targets the same id.

Everything up to the publish button works without a wallet.

## Where publishing is available

| Network       | Publishing                                                                               |
| ------------- | ---------------------------------------------------------------------------------------- |
| Base          | Only when the deployment map records a deployment, and with one explicit acknowledgement |
| Base Sepolia  | When the deployment map records a deployment                                             |
| Local (Anvil) | In development builds, when the contracts are deployed on the node                       |

The registry is not deployed on Base or Base Sepolia, so today the Studio says "Publishing is not available" on
both, in the editor and in the review, and offers the export. Drafting is not affected.

Publishing an index is not trading, and the execution gate of the wallet layer does not apply to it.

## The publish checks

The review lists nine preconditions with their real state. The publish button sends only when all nine are
established.

| Check          | Established by                                                                      |
| -------------- | ----------------------------------------------------------------------------------- |
| Valid spec     | `validateSpec` on the draft                                                         |
| Spec hash      | keccak256 of the canonical bytes                                                    |
| Wallet         | A connected account, which becomes the creator                                      |
| Wallet network | The wallet reports the chain of the draft                                           |
| Registry       | A deployment in the map, and code at the address read with `eth_getCode`            |
| Index id       | `computeIndexId(creator, salt)` by `eth_call` equals the id computed in the browser |
| Simulation     | `simulateContract` of `createIndex` from the creator succeeds                       |
| Gas and fee    | `estimateContractGas` times the current maximum fee per gas, plus the L1 data fee   |
| ETH balance    | The balance of the creator is at least twice that fee                               |

The checks run when the review opens, when the plan changes and when "Check again" is pressed. They never run on
a timer and they send nothing. A simulation that reverts shows the custom error of the registry decoded from its
ABI, with its arguments. A plain revert reason, which is text the contract chose, is shown apart, in monospace,
labelled as reported by the wallet or node, with control and direction characters removed and at most 200
characters.

The fee is the upper bound of the execution fee plus, on Base and Base Sepolia, the L1 data fee read with one
`eth_call` to the `GasPriceOracle` predeploy (`getL1Fee` of the serialized transaction). A local node charges no
L1 data fee and the line says so. Fees move between the estimate and inclusion, so the balance must cover twice
the estimate before the check passes.

## The review is a snapshot

Opening the review takes a snapshot of the draft, of the asset list it was validated against and of the
resulting spec. The review displays the snapshot and the transaction is built from it. A refetch of the asset
list, which happens when the browser comes back online, does not reach the review: it can neither close it nor
change a byte of what is shown or sent. The salt is the only part that can change while reviewing, on the click
on "Use a new salt". Back in the editor, the draft is validated against the list as it is then.

## What the user is shown before signing

The review is a full step of the page, not a dialog. It shows exactly what `createIndex` will receive:

- the network and its chain id, the registry address and the function;
- the creator, the salt, the index id computed from them and the canonical identifier the index will get;
- the spec hash and size;
- `tokens` and `weightsBps` in the order they are sent, with the weight in basis points and in percent;
- the canonical JSON, which is the `spec` argument byte for byte;
- that version 1 is permanent, and that publishing a methodology is not managing anyone's assets.

On Base mainnet one more line has to be ticked: that this is a real transaction that costs gas and cannot be
undone. The acknowledgement holds for the exact plan it was given for (chain, registry, creator, salt and spec
hash), so a new salt or another account clears it, and every attempt that ends without publishing (declined,
refused, reverted, replaced or not found) clears it too.

## After signing

| State              | What is shown                                                                    |
| ------------------ | -------------------------------------------------------------------------------- |
| Awaiting signature | That the wallet is asking, and that nothing has been sent                        |
| Declined           | A neutral note. Nothing was sent, the draft is unchanged                         |
| Refused            | The reason in words, with the decoded contract error when there is one           |
| Submitted          | The transaction hash, with an explorer link where the chain has an explorer      |
| Reverted           | That the fee was paid and nothing was published                                  |
| Replaced           | That another transaction took the nonce and this request published nothing       |
| Not found          | That no receipt was found in two minutes and the transaction may still be mined  |
| Not confirmed      | Mined, but a check on the result failed. The reason, and a button to check again |
| Published          | Only after the events match and the version read back passes verification        |

Success is never shown from the transaction hash alone. The write path and its safeguards are described in
[Publishing from the Studio](../security/studio-publishing.md).

An index that already exists under the salt of the draft (`IndexAlreadyExists`) is explained, and "Use a new
salt" replaces the salt on that click. The salt is never changed silently.

The published state shows the canonical identifier, the index id, the spec hash, the block and the transaction.
It does not link to an index page, because the app has none yet.

## Tests

- `apps/web/test/studio` and `apps/web/test/tx`: unit tests of all pure logic, without a wallet.
- `apps/web/e2e/studio.e2e.ts`: the editor in a browser against the production build, with no chain.
- `apps/web/e2e-chain/publish.e2e.ts`: the publish flow against a local Anvil node. Run with
  `bun run test:integration`, or alone with `bun run --filter @equityos/web test:e2e:chain`.
