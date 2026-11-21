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
```

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

## TypeScript configuration

Every workspace extends `tsconfig.base.json`. The packages have two configurations: `tsconfig.json` type-checks
sources and tests without emitting, and `tsconfig.build.json` emits `dist/` from `src/` only.

## Solidity toolchain

`contracts/foundry.toml` pins the compiler to solc 0.8.39 with the optimizer enabled and targets the `prague`
EVM version, which Base supports. `contracts/test/Setup.t.sol` asserts the EVM version so that a change to it is
deliberate. CI runs the tests with `FOUNDRY_PROFILE=ci`, which raises the number of fuzz runs.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`:

- `web`: install with a frozen lockfile, format check, lint, typecheck, test, build.
- `contracts`: format check, build, test.

When a dependency changes, commit the updated `bun.lock`. CI fails if the lockfile does not match
`package.json`.
