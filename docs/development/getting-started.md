# Getting started

How to set up the repository, run it and verify a change.

## Prerequisites

- [Bun](https://bun.sh) 1.3.14. The version is pinned in the `packageManager` field of the root `package.json`
  and CI uses the same one.
- [Node.js](https://nodejs.org) 22 or newer. The Next.js CLI runs on Node.js. `.nvmrc` holds the version CI uses.
- [Foundry](https://getfoundry.sh) 1.5.1, installed with `foundryup --install v1.5.1`.
- Git.

## Clone and install

```sh
git clone --recurse-submodules https://github.com/salazarsebas/equityos.git
cd equityos
bun install
```

Solidity dependencies are git submodules under `contracts/lib`. In an existing clone, fetch them with:

```sh
git submodule update --init --recursive
```

## Workspaces

| Workspace        | Path            | Notes                                            |
| ---------------- | --------------- | ------------------------------------------------ |
| `@equityos/web`  | `apps/web`      | Next.js app, sources in `src/`                   |
| `@equityos/core` | `packages/core` | Compiled with `tsc` to `dist/`, tests in `test/` |
| `@equityos/sdk`  | `packages/sdk`  | Compiled with `tsc` to `dist/`, tests in `test/` |

`contracts` is a Foundry project and is not a Bun workspace.

## Run the web app

```sh
bun run dev
```

The app is served at <http://localhost:3000>. To run the production build instead:

```sh
bun run build
bun run --filter @equityos/web start
```

## Checks

Run from the repository root. These are the checks CI runs, in the same order.

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e
```

`test:e2e` is a Playwright smoke test that runs against the production build. Install its browser once with
`bunx playwright install chromium` from `apps/web`.

```sh
bun run contracts:fmt:check
bun run contracts:build
bun run contracts:test
```

`bun run format` rewrites files to match the formatter. `forge fmt --root contracts` does the same for Solidity.

To run a script in a single workspace, filter by package name:

```sh
bun run --filter @equityos/core test
```

## Environment

| Variable               | Used by    | Purpose                                                                                |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL` | `apps/web` | Public origin for canonical URLs, `robots.txt` and the sitemap. Defaults to localhost. |
| `BASE_RPC_URL`         | `apps/web` | Base mainnet JSON-RPC endpoint for server-side market data. Required in production.    |

`apps/web/.env.example` lists the variables. Outside production, an unset `BASE_RPC_URL` falls back to the public
Base endpoint, which is rate limited. The market data layer is described in
[Market data layer](../architecture/market-data.md).

## TypeScript configuration

Every workspace extends `tsconfig.base.json`. The packages have two configurations: `tsconfig.json` type-checks
sources and tests without emitting, and `tsconfig.build.json` emits `dist/` from `src/` only. The web app
type-checks its unit tests with `tsconfig.test.json`, which adds the Bun types that application code must not see.

The web app imports `@equityos/core` from source through a `paths` entry in `apps/web/tsconfig.json`, so
type-checking and unit tests do not depend on a prior build of the package.

`apps/web/test/market/live.test.ts` reads the live issuer API and Base mainnet. It is skipped unless
`LIVE_TESTS=1` is set and is not part of CI.

## Solidity toolchain

`contracts/foundry.toml` pins the compiler to solc 0.8.39 with the optimizer enabled and targets the `prague`
EVM version, which Base supports. `contracts/test/Setup.t.sol` asserts the EVM version so that a change to it is
deliberate. CI runs the tests with `FOUNDRY_PROFILE=ci`, which raises the number of fuzz runs.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`:

- `web`: install with a frozen lockfile, format check, lint, typecheck, test, build, Playwright smoke test.
- `contracts`: format check, build, test.

When a dependency changes, commit the updated `bun.lock`. CI fails if the lockfile does not match
`package.json`.
