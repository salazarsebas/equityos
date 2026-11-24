# Local chain

How to run the contracts on a local Anvil node, publish example indexes and point the web app at them.

The registry is not deployed on Base mainnet or Base Sepolia, so a local chain is the only place where the
registry reader returns indexes. See [Registry reader](../architecture/registry-reader.md) for what the app
reports on a chain without the registry.

## Prerequisites

Foundry 1.5.1 (`anvil`, `forge`), Bun and the submodules, as in [Getting started](getting-started.md).

## The loop

Four steps, each in the repository root.

### 1. Start Anvil

```sh
anvil
```

Anvil listens on `http://127.0.0.1:8545` with chain id 31337. It includes the deterministic deployment proxy and
exposes unlocked development accounts. The chain is in memory: stopping Anvil discards it.

### 2. Deploy the contracts

```sh
bun run contracts:deploy:local
```

This runs `contracts/script/Deploy.s.sol` against the local node from the first Anvil account. The contracts land
at the same addresses as on any other chain. A second run sends nothing.

### 3. Seed example indexes

```sh
bun run seed:local
```

`apps/web/scripts/seed-local.ts` publishes five indexes built with `@equityos/core`, in this order, and prints
the index id, the canonical identifier and the spec hash of each version:

| Index                         | What it shows                                                      | Versions |
| ----------------------------- | ------------------------------------------------------------------ | -------- |
| Mismatched Weights Example    | Published with other weights than its spec implies: fails check C5 | 1        |
| Single Asset Example          | One constituent at full weight. Deprecated after publication       | 1        |
| Large Technology Equal Weight | Equal, five constituents                                           | 1        |
| Semiconductors Fixed Weight   | Fixed, with a minimum and a maximum weight                         | 1        |
| Diversified Equity            | Equal in version 1, fixed in version 2                             | 2        |

The first two exist so that the states an index page must handle can be seen locally: a version that fails
verification, whose name is never displayed, and a deprecated index.

Properties of the seed:

- It sends transactions only when the endpoint reports chain id 31337. On any other chain it stops before
  touching an account.
- Anvil signs for its first unlocked account. No private key is read, stored or created.
- It can be run again. An index, a version or a deprecation that is already there is skipped.
- The constituents are the Base mainnet addresses of tokens that have a reference feed in the market data
  layer, and the feeds are their Base mainnet proxies. The registry stores addresses and calls no token, so
  they are publishable on a chain where those tokens do not exist.
- Each spec declares `chainId: 31337`, because verification rejects a spec read from a chain other than the one
  it names. The hashes therefore differ from what the same methodology would have on Base.

### Example usage

After the indexes, the seed records example usage for the [network metrics](../product/network-metrics.md). It
needs the mock contracts built: `bun run contracts:build`. With `anvil_setCode` it installs the mocks of
`contracts/test/mocks/UsageMocks.sol`: a token at the address of every feed-covered token, a reference feed at
every feed proxy (each answers 100.00 USD, dated at the block it is read in), and a minimal smart account at
four `0x5eed...` addresses. Then it sends:

| Account                         | Transactions                                                             | Result                          |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| `0x5eed...000a` (smart account) | Mints 1,000.00 USD of Semiconductors at its weights and attests, at once | Tier A, within tolerance        |
| `0x5eed...000b` (smart account) | Mints two of the five Large Technology constituents and attests          | Tier A, outside tolerance       |
| Anvil account 1                 | Mints one constituent, then attests in a second transaction              | Tier B                          |
| `0x5eed...000d` (smart account) | Mints 0.50 USD of a constituent and attests                              | Unmatched, below 1.00 USD       |
| Anvil account 2                 | Attests without moving any token                                         | Unmatched, no constituent flows |
| `0x5eed...000e` (smart account) | As `000a`. Meant to be listed in `EQUITYOS_EXCLUDED_ACCOUNTS`            | Tier A, shown apart when listed |

The smart account calls run in a transaction Anvil account 0 sends, as a bundler would. Nothing of it exists on
a public network. A second run sends nothing.

To seed a node on another port, set `EQUITYOS_RPC_URL`:

```sh
EQUITYOS_RPC_URL=http://127.0.0.1:9000 bun run seed:local
```

### 4. Run the app against the local chain

In `apps/web/.env.local`:

```sh
EQUITYOS_CHAIN_ID=31337
```

Then:

```sh
bun run dev
```

The registry reader now reads the local node, and `/indexes` lists the seeded indexes with a notice that they are
examples on a local chain. `EQUITYOS_RPC_URL` is needed only when Anvil is not on
`http://127.0.0.1:8545`. Market data is still read from Base mainnet through `BASE_RPC_URL`: the seeded
constituents are real Base mainnet tokens, so their reference prices apply.

Without `EQUITYOS_CHAIN_ID` the app reads Base mainnet, where the registry is not deployed.

## Recording the replay of the browser tests

The browser tests replay `apps/web/test/fixtures/registry` (after the seed) and
`apps/web/test/fixtures/registry-empty` (after the deployment only). `record:registry` writes every registry
read call at the latest block and every request the network metrics make there. With a fixed clock the
recordings are the same on every run:

```sh
anvil --timestamp 1794837605 &   # 1794837604 for registry-empty
cast rpc anvil_setBlockTimestampInterval 0
bun run contracts:build && bun run contracts:deploy:local
bun run seed:local               # skipped for registry-empty
bun run --filter @equityos/web record:registry test/fixtures/registry
```

## Integration test

```sh
bun run test:integration
```

This builds the contracts, checks the committed ABI modules against the build artifacts, then starts its own
Anvil on port 8565 (override with `ANVIL_PORT`), runs the deployment script and the seed, and reads everything
back through the registry reader, asserting hashes, identifiers, verification reports and events. It then
runs the usage seed and checks the tier of every attestation with the network metrics service. It does not
use a node you started yourself. CI runs it in the `integration` job.

It then runs the browser test of the publish flow (`apps/web/e2e-chain`), which starts another Anvil on port
8576 (override with `E2E_ANVIL_PORT`), deploys the contracts, starts the app in development mode on port 3110 (override with `E2E_PORT`) and
publishes an index from the [Studio](../product/index-studio.md). It needs a Playwright browser:
`bunx playwright install chromium` in `apps/web`. To run it alone: `bun run --filter @equityos/web test:e2e:chain`.

## After changing a contract interface

```sh
bun run contracts:build
bun run --filter @equityos/contracts-abi generate
```

Commit the regenerated modules in `packages/contracts-abi/src`. `bun run test:integration` fails while they
differ from the build artifacts.
