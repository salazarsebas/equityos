# EquityOS

Open, verifiable index infrastructure for tokenized stocks on Base.

EquityOS lets anyone define an index of tokenized stocks as a transparent, deterministic methodology and publish
it. The hash of each published version is stored onchain, anyone can recompute its weights with the open
calculator, and whoever follows an index holds the tokens in their own wallet. It is not a fund.

## Core idea

- **An index is a methodology, not a fund.** An index is a published, versioned, deterministic rule set over
  tokenized stocks. Given the same inputs, anyone can recompute the same constituents and weights.
- **Replication happens per wallet.** A user who follows an index holds the constituents in their own wallet.
- **No pooled funds.** EquityOS does not custody assets and does not pool user funds behind an index.

## Status

Early development. The contracts are not deployed on any network, so no index can be published or replicated yet.

What exists today:

- `@equityos/core`: the methodology spec `equityos.index/1` with its validator, canonicalization, hash, weight
  calculation and verification checks, plus market calendar, price staleness and position value math. All integer
  arithmetic on `bigint`. See [docs/architecture/methodology-spec.md](docs/architecture/methodology-spec.md).
- `contracts`: `IndexRegistry` and `RebalanceLog`, immutable and ownerless, with a deterministic deployment script.
  Not audited. See [docs/architecture/index-registry.md](docs/architecture/index-registry.md) and
  [docs/security/index-registry.md](docs/security/index-registry.md).
- `apps/web`: a landing page that shows the asset universe and registry state with their sources, a design
  system, the asset universe page with reference prices read from Base mainnet, an index
  explorer and index profile pages that verify each published version against the registry, and the public API
  v1 for assets and indexes. On a network without the registry the index pages and the API say so. See
  [docs/api/README.md](docs/api/README.md) and [docs/product/index-profile.md](docs/product/index-profile.md).
- `@equityos/sdk`: a package skeleton that exports its version and nothing else.

The Index Studio drafts, validates and exports an index, and publishes it where the registry is deployed, which
today is a local chain only. See [docs/product/index-studio.md](docs/product/index-studio.md).

The portfolio page compares any address with a published index and previews a rebalance plan at reference
prices. It does not trade. See [docs/product/portfolio.md](docs/product/portfolio.md).

Not built yet: new versions of a published index from the app, rebalance execution.

Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Repository layout

```text
apps/web            Next.js app (App Router, React, Tailwind CSS)
packages/core       @equityos/core: methodology and calculation engine (pure TypeScript)
packages/sdk        @equityos/sdk: TypeScript SDK
contracts           Foundry project for the Solidity contracts
docs                Technical documentation
.github/workflows   Continuous integration
```

## Prerequisites

| Tool                             | Version                    | Used for                              |
| -------------------------------- | -------------------------- | ------------------------------------- |
| [Bun](https://bun.sh)            | 1.3.14                     | Package manager, script runner, tests |
| [Node.js](https://nodejs.org)    | 22 or newer (see `.nvmrc`) | Runtime for the Next.js CLI           |
| [Foundry](https://getfoundry.sh) | 1.5.1                      | Solidity build, test and format       |
| [Git](https://git-scm.com)       | any recent version         | Source control and submodules         |

## Install

```sh
git clone --recurse-submodules https://github.com/salazarsebas/equityos.git
cd equityos
bun install
```

If the repository was cloned without `--recurse-submodules`, fetch the Solidity dependencies with
`git submodule update --init --recursive`.

## Run

```sh
bun run dev
```

The web app is served at <http://localhost:3000>.

## Check and test

All commands run from the repository root.

| Command                       | What it does                                         |
| ----------------------------- | ---------------------------------------------------- |
| `bun run format`              | Format TypeScript, JavaScript, JSON and CSS in place |
| `bun run format:check`        | Verify formatting without writing                    |
| `bun run lint`                | Lint with Biome                                      |
| `bun run typecheck`           | Type-check every workspace                           |
| `bun run test`                | Run the unit tests of every workspace                |
| `bun run build`               | Build the packages and the web app                   |
| `bun run test:e2e`            | Run the Playwright smoke test against the build      |
| `bun run contracts:build`     | Compile the Solidity project                         |
| `bun run contracts:test`      | Run the Foundry tests                                |
| `bun run contracts:fmt:check` | Verify Solidity formatting                           |

CI runs the same checks on every pull request and on every push to `main`.

## Documentation

- [docs/README.md](docs/README.md): documentation index.
- [AGENTS.md](AGENTS.md): working rules for contributors and coding agents.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to propose a change.

## License

[MIT](LICENSE)
