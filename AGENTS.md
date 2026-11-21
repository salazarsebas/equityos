# Working rules

These rules apply to every contributor and every coding agent working in this repository.

## What this project is

EquityOS is programmable index infrastructure for tokenized stocks on Base. An index is a published, versioned,
deterministic methodology. It is not a pooled fund: users replicate an index in their own wallets.

## Layout

| Path                | Contents                                                              |
| ------------------- | --------------------------------------------------------------------- |
| `apps/web`          | Next.js app (App Router, React, Tailwind CSS), sources under `src/`   |
| `packages/core`     | `@equityos/core`: methodology and calculation engine, pure TypeScript |
| `packages/sdk`      | `@equityos/sdk`: TypeScript SDK                                       |
| `contracts`         | Foundry project, dependencies as git submodules in `contracts/lib`    |
| `docs`              | Technical documentation, indexed in `docs/README.md`                  |
| `.github/workflows` | CI                                                                    |

## Commands

Run everything from the repository root. Bun is the only package manager and script runner: do not use npm, pnpm
or yarn, and do not commit any lockfile other than `bun.lock`.

| Command                       | Purpose                               |
| ----------------------------- | ------------------------------------- |
| `bun install`                 | Install dependencies                  |
| `bun run dev`                 | Start the web app in development mode |
| `bun run format`              | Format in place with Biome            |
| `bun run format:check`        | Verify formatting                     |
| `bun run lint`                | Lint with Biome                       |
| `bun run typecheck`           | Type-check every workspace            |
| `bun run test`                | Run unit tests with `bun test`        |
| `bun run build`               | Build the packages and the web app    |
| `bun run test:e2e`            | Playwright smoke test, after a build  |
| `bun run contracts:build`     | `forge build`                         |
| `bun run contracts:test`      | `forge test`                          |
| `bun run contracts:fmt:check` | `forge fmt --check`                   |

Every one of these must pass before a change is pushed. CI runs them in the `web` and `contracts` jobs.

## TypeScript

- Strict mode everywhere. Every workspace extends `tsconfig.base.json`, which enables `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. Do not weaken these flags
  in a workspace.
- No `any`, no non-null assertions and no `@ts-ignore` to silence an error. Fix the type instead.
- Use `import type` for type-only imports. Relative imports inside `packages/*` include the `.ts` extension.
- `packages/core` stays pure: no network, no filesystem, no clock, no randomness. Inputs in, outputs out.
- Dependencies are pinned to exact versions. Add one only when it is needed, at its latest stable version.

## Financial math

- Use `bigint` with fixed-point scaling for every amount, price, weight and ratio. Never use `number` for a
  financial quantity.
- Make units explicit in names and documentation: basis points, token base units with their decimals, price scale.
- Choose the rounding direction deliberately on every division and state it. Use `mulDivDown` and `mulDivUp`
  from `@equityos/core`.
- A reference price is not an executable price. Never present, store or use a reference price as the price a
  trade will execute at.
- Handle stale and missing data explicitly. A missing or outdated input is a distinct, typed outcome that the
  caller must handle. Never substitute zero, a default or the last known value silently.

## Honesty of the product

- No fake data and no fake functionality: no placeholder numbers, no mocked responses presented as real, no
  links or controls that lead nowhere.
- Documentation describes what is implemented. Planned work is never described as existing.
- Do not add placeholder files, example code or empty pages.

## Solidity

- The compiler version, EVM version and optimizer settings are pinned in `contracts/foundry.toml`. Change them
  only on purpose, together with `contracts/test/Setup.t.sol`.
- Format with `forge fmt`. Every contract has tests.

## Tests

Tests are required for every change in behavior. TypeScript tests use `bun test` and live in the `test/`
directory of their workspace. Browser smoke tests for the web app use Playwright and live in `apps/web/e2e`.
Solidity tests use Foundry and live in `contracts/test`.

## Git

- Branch names: `<type>/<kebab-case>`, for example `feat/index-registry` or `fix/weight-rounding`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): a single lowercase line,
  no trailing period, for example `feat(core): add weight normalization`.
- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- Keep commits focused. Do not commit generated output, local notes or scratch files.
- Record user-visible changes in `CHANGELOG.md` under `Unreleased`.
