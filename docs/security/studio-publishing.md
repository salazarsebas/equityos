# Publishing from the Studio

The Studio sends two transactions, both on `IndexRegistry`: `createIndex`, which creates an index with its
version 1, and `publishVersion`, which appends a version to an index the connected account created. This page
describes that write path and what protects each step. The user-facing behavior is in
[Index Studio](../product/index-studio.md), the contract in [Index registry](../architecture/index-registry.md).

## What is at stake

The registry holds no funds and takes no approval, so a publication cannot move assets. What can go wrong is
narrower and still matters:

- publishing bytes other than the ones the creator reviewed, permanently and under their address;
- publishing a version on top of another version than the one the creator was shown, or twice;
- publishing to a network or a contract the creator did not intend;
- telling the creator that an index is published when it is not, or the reverse;
- spending gas on a transaction that was bound to revert.

## The write path

| Step | What happens                                                                                   | Safeguard                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1    | The draft is validated and canonicalized by `@equityos/core`                                   | No rule is reimplemented in the app. An invalid draft cannot reach the review                               |
| 2    | The review opens on a snapshot of the draft, the asset list and the spec                       | A refetch of the asset list cannot change what is shown or sent, nor close the review                       |
| 3    | One plan object is built: salt, index id, bytes, hash, tokens, weights, arguments              | The review displays the plan and the transaction is built from the same plan, so they cannot differ         |
| 4    | The network is checked against the deployment map                                              | A chain without a recorded deployment is never offered a publish button                                     |
| 5    | The code at the registry address is read                                                       | The address is the same on every chain, so the map alone proves nothing. No code, no button                 |
| 6    | `computeIndexId(creator, salt)` is read with `eth_call` and compared with the local prediction | A contract at that address that derives another id is not the registry the app expects. Nothing is sent     |
| 7    | The call is simulated from the creator                                                         | A call that would revert is never sent. The custom error is decoded with the registry ABI and explained     |
| 8    | Gas, execution fee, L1 data fee and balance are read                                           | The button stays disabled unless the balance covers twice the estimated fee                                 |
| 9    | On Base mainnet, the acknowledgement is ticked                                                 | Bound to the exact plan, and cleared by every attempt that ends without publishing                          |
| 10   | The user clicks "Publish version 1"                                                            | `buildPublishRequest` returns the `writeContract` arguments, or the reason it refuses; the click needs both |
| 11   | The wallet asks, the user confirms                                                             | The app holds no key. A rejection is a state of its own, not an error                                       |
| 12   | The receipt is awaited                                                                         | Only `status: success` moves on. A reverted, replaced or missing receipt is reported as such                |
| 13   | The events of the receipt are compared with the plan                                           | One `IndexCreated` and one `VersionPublished` from the registry, with the index id, version 1 and the hash  |
| 14   | The version is read back with `eth_call` and verified                                          | Creator, stored bytes and hash must equal the plan, and checks C1 to C5 of core must pass on the chain data |
| 15   | Success is shown                                                                               | Only after step 14. A transaction hash alone is never presented as a publication                            |

## A new version

`publishVersion` follows the same path, with these differences:

| Step | What happens                                                                          | Safeguard                                                                                                          |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | The latest version is read and verified with C1 to C5 of core in the browser          | A version that fails a check, a spec the editor cannot write unchanged and a deprecated index are not opened       |
| 2    | The draft is compared with the latest version, byte for byte                          | Identical bytes cannot be reviewed, and `buildPublishRequest` refuses them (`unchanged`)                           |
| 3    | The plan sets `expectedVersion` to the loaded version plus one                        | The registry reverts with `UnexpectedVersion` on any other version, so a version is never published twice          |
| 6    | `getIndex` is read, and the hash of the loaded version is read back with `getVersion` | A draft not based on what the registry holds (`base_mismatch`) is blocked before the simulation                    |
| 7    | The call is simulated from the connected account                                      | `NotCreator`, `IndexIsDeprecated` and `UnexpectedVersion` are decoded and explained                                |
| 10   | The click reads `getIndex` again and decides again with it (`decideAtClick`)          | Refuses `not_creator`, `deprecated` and `version_moved` as of the click, and any read that fails. Nothing sent     |
| 13   | The events of the receipt are compared with the plan                                  | Exactly one `VersionPublished` from the registry with the index id, version, hash and publisher. No `IndexCreated` |
| 14   | The version is read back and verified                                                 | As for version 1: creator, stored bytes and hash equal the plan, and C1 to C5 pass                                 |

The creator check is made three times: in the editor, which says when the connected account is not the creator;
in the decision, from `getIndex`; and by the registry, which is the one that enforces it.

A version published by someone else between the review and the click, such as the same creator in another tab,
is the case the read at the click exists for. Without it the transaction would be sent and revert with
`UnexpectedVersion`, at the cost of its fee. With it nothing is sent, and the page offers to load the latest
version with the draft kept.

Steps 4 to 8 are reads through the endpoint configured for the chain of the draft. They do not go through the
wallet, and they run only when the review opens, when the plan changes or when the user asks.

## Properties

- **Bytes sent are bytes shown.** `buildPublishPlan` derives the hex argument, the displayed text and the hash
  from one `Uint8Array`. A unit test decodes the calldata and compares it with the displayed text; the browser
  test reads the mined transaction from the node and compares its input with what the page showed.
- **One decision, one request.** `buildPublishRequest` (`apps/web/src/lib/studio/request.ts`) is the only place
  that decides whether a click may send, for both functions. It refuses without a plan, where the registry is
  not deployed, for a plan addressed to another registry, while a transaction is in flight or after one was
  mined, when the wallet reports another chain than the plan, for a new version that is unchanged, comes from
  an account that is not the creator, targets a deprecated index or is not the next version, while any check is
  not done, and on mainnet without the acknowledgement of that exact plan. Otherwise it returns the complete
  `writeContract` arguments, `chainId` included, for the function the plan names and no other. The component
  passes them through unchanged, and the click handler exists only when the decision allows it. At the click,
  `decideAtClick` makes the same decision again, after reading the index from the registry for a new version.
- **The chain is checked again at the moment of sending.** With `chainId` in the request, wagmi asks the wallet
  for its chain before sending and refuses on a mismatch. A wallet that changed network after the review was
  drawn is refused, the page says why, and nothing is sent. The browser test does exactly this.
- **No transaction without a click.** `writeContract` is called from one place, the click handler of a button
  whose label says what is sent. Connecting, switching network, simulating and estimating never send. The
  browser test asserts that the account nonce does not change before the click, nor after a rejection.
- **No double submission.** The state machine accepts a new request only from states in which nothing is with
  the wallet or the chain, and never after a successful receipt. The button is busy from the click until the
  decision made at the click is known. For a new version, `expectedVersion` makes a second submission of the
  same version revert with `UnexpectedVersion`. The salt is stored with the draft, so a retry
  after a lost receipt targets the same index id, where a second `createIndex` reverts with
  `IndexAlreadyExists` instead of creating a duplicate. The salt changes only on an explicit click.
- **No trust in the receipt alone.** Events are accepted only from the registry address. Events of any other
  contract in the same transaction are ignored.
- **No raw error text.** Errors of wallets and nodes are classified by code and by decoded revert data. Their
  message text is never rendered. A plain revert reason is the one exception: it is text the contract chose,
  so it is shown only as quoted text, apart from the app's sentences, labelled as reported by the wallet or
  node, stripped of control and direction characters and capped at 200 characters.
- **Mainnet is gated twice.** By the deployment map, which today records no deployment on Base, and by the
  acknowledgement.

## Reusable parts

`apps/web/src/lib/tx` is independent of the Studio:

- `machine.ts`: the transaction state machine as a pure reducer.
- `run.ts`: the sequence send, wait, check receipt, verify, with its dependencies injected.
- `errors.ts`: classification of failures and decoding of custom errors against an ABI.
- `use-transaction.ts`: the hook that wires the above to wagmi.

## What is not protected against

- **A compromised browser or wallet.** The page that shows the bytes is the page that sends them. The wallet's
  own confirmation screen is the independent check, and it shows the same call.
- **A dishonest RPC endpoint.** The checks and the read-back trust the endpoint configured for the chain. An
  endpoint that lies can make a publication look confirmed. The transaction itself is signed by the wallet and
  is not affected.
- **Reorganizations.** Success is shown after one confirmation. A version that is reorganized out is no longer
  in the registry; the index page of an explorer is the place to confirm later.
- **Fee movements.** The fee is an estimate made before signing. The margin of twice the estimate covers
  ordinary movement, not a fee spike; the wallet shows the final fee before signing.
- **Content.** The Studio only publishes valid specs, but the registry accepts any bytes from any client. See
  [Index registry security](index-registry.md).

The contracts have not been audited, and this path has not been reviewed by an external party.

## Tests

`apps/web/test/tx`, `apps/web/test/studio/publish.test.ts`, `request.test.ts`, `preflight.test.ts` and
`version.test.ts` cover every safeguard above without a wallet. `apps/web/e2e-chain/new-version.e2e.ts` publishes
a version as the creator, is refused as another account, and is refused at the click after another tab
published first. `apps/web/e2e-chain/publish.e2e.ts` runs the path in a browser against a local Anvil node,
where a test provider forwards `eth_sendTransaction` to the node's unlocked development account. That provider
exists only in the test support code, holds no key and signs nothing itself.
