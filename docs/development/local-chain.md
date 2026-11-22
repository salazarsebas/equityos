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

`apps/web/scripts/seed-local.ts` publishes three indexes built with `@equityos/core` and prints the index id,
the canonical identifier and the spec hash of each version:

| Index                         | Weighting                                  | Versions |
| ----------------------------- | ------------------------------------------ | -------- |
| Large Technology Equal Weight | Equal, five constituents                   | 1        |
| Semiconductors Fixed Weight   | Fixed, with a minimum and a maximum weight | 1        |
| Diversified Equity            | Equal in version 1, fixed in version 2     | 2        |

Properties of the seed:

- It sends transactions only when the endpoint reports chain id 31337. On any other chain it stops before
  touching an account.
- Anvil signs for its first unlocked account. No private key is read, stored or created.
- It can be run again. An index or a version that is already published is skipped.
- The constituents are the Base mainnet addresses of tokens that have a reference feed in the market data
  layer, and the feeds are their Base mainnet proxies. The registry stores addresses and calls no token, so
  they are publishable on a chain where those tokens do not exist.
- Each spec declares `chainId: 31337`, because verification rejects a spec read from a chain other than the one
  it names. The hashes therefore differ from what the same methodology would have on Base.

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

The registry reader now reads the local node. `EQUITYOS_RPC_URL` is needed only when Anvil is not on
`http://127.0.0.1:8545`. Market data is still read from Base mainnet through `BASE_RPC_URL`: the seeded
constituents are real Base mainnet tokens, so their reference prices apply.

Without `EQUITYOS_CHAIN_ID` the app reads Base mainnet, where the registry is not deployed.

## Integration test

```sh
bun run test:integration
```

This builds the contracts, checks the committed ABI modules against the build artifacts, then starts its own
Anvil on port 8565 (override with `ANVIL_PORT`), runs the deployment script and the seed, and reads everything
back through the registry reader, asserting hashes, identifiers, verification reports and events. It does not
use a node you started yourself. CI runs it in the `integration` job.

## After changing a contract interface

```sh
bun run contracts:build
bun run --filter @equityos/contracts-abi generate
```

Commit the regenerated modules in `packages/contracts-abi/src`. `bun run test:integration` fails while they
differ from the build artifacts.
