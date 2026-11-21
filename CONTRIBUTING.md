# Contributing

Thank you for your interest in EquityOS.

1. Read [AGENTS.md](AGENTS.md). It holds the working rules: layout, commands and conventions.
2. Set up the project with [docs/development/getting-started.md](docs/development/getting-started.md).
3. Create a branch named `<type>/<kebab-case>` from `main`.
4. Make the change with tests. Add an entry to [CHANGELOG.md](CHANGELOG.md) under `Unreleased` when the change
   is visible to users or integrators.
5. Run the checks from the repository root:

   ```sh
   bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build
   bun run contracts:fmt:check && bun run contracts:build && bun run contracts:test
   ```

6. Open a pull request against `main` with a Conventional Commits title. Describe what changed, why, and how it
   was verified. The `web` and `contracts` CI jobs must pass.

## Reporting a security issue

Do not open a public issue for a vulnerability. Report it privately to the maintainers through the repository
security advisories page on GitHub.
