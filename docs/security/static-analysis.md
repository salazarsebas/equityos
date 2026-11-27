# Static analysis

The contracts under `contracts/src` are checked by two static analyzers on every pull request, as part of the
`contracts` CI job. Their findings are compared with a reviewed baseline,
[`contracts/static-analysis/baseline.json`](../../contracts/static-analysis/baseline.json), by
`scripts/check-static-analysis.ts`.

## Tools

| Tool                                         | Version | How it runs                                                                                                  |
| -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| [Slither](https://github.com/crytic/slither) | 0.11.6  | `slither . --config-file slither.config.json --json <file>`, with `lib/`, `test/` and `script/` filtered out |
| [Aderyn](https://github.com/Cyfrin/aderyn)   | 0.6.8   | `aderyn . --output <file>`                                                                                   |

Aderyn is retired and its release binaries were withdrawn. CI builds it from the source of its last release,
pinned by commit `a288420403cb1ae5f38ce606c3a6d4e605b9c81d`, and caches the binary. That source does not build on
Windows, so on Windows only Slither can be run locally:

```sh
cd contracts
slither . --config-file slither.config.json
```

## Rules of the gate

- Every reported finding must have a baseline entry with a verdict and a reason. A new finding fails the job until
  it is fixed or reviewed.
- Every baseline entry must still be reported. An entry that no longer matches fails, so a finding that changed or
  was fixed cannot stay hidden behind an old review.
- A High or Medium finding can only be in the baseline as a false positive. Nothing of that severity is accepted as
  a known risk.

## Triage

No High or Medium finding is reported by either tool, so none is unresolved. The reviewed findings:

| Tool    | Detector                 | Severity      | Location                                                   | Verdict        | Reason                                                                                                                                                                                     |
| ------- | ------------------------ | ------------- | ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slither | `timestamp`              | Low           | `IndexRegistry.exists`                                     | False positive | The comparison is on `latestVersion`, a version counter that shares a storage slot with `deprecatedAt`, which is written from `block.timestamp`. No logic depends on time.                 |
| Slither | `timestamp`              | Low           | `IndexRegistry.versionExists`                              | False positive | Same as `exists`: both sides of the comparison are version counters.                                                                                                                       |
| Slither | `naming-convention`      | Informational | `IIndexRegistry.BPS`, `MAX_SPEC_BYTES`, `MAX_CONSTITUENTS` | Accepted       | Getters of public constants, in upper case as the Solidity style guide asks. Renaming them changes the ABI and the deterministic deployment address.                                       |
| Slither | `naming-convention`      | Informational | `RebalanceLog.REGISTRY`, `IRebalanceLog.REGISTRY`          | Accepted       | Public immutable named like a constant. Same reason.                                                                                                                                       |
| Aderyn  | `costly-loop`            | Low           | `IndexRegistry.sol`                                        | Accepted       | The loop pushes each constituent to storage, which is the purpose of the call. It is bounded by `MAX_CONSTITUENTS` (64), checked first, and the gas tests measure the 64-token case.       |
| Aderyn  | `large-numeric-literal`  | Low           | `IndexRegistry.sol`                                        | Accepted       | `BPS = 10_000` already uses a digit separator. Any source change alters the metadata hash, the bytecode and the deterministic deployment address.                                          |
| Aderyn  | `require-revert-in-loop` | Low           | `IndexRegistry.sol`                                        | Accepted       | Validation reverts on the first bad token or weight and names its position. Publication is all or nothing by design: skipping a bad entry would store a mirror that differs from the spec. |

## Limits

Static analysis finds known patterns. It does not prove the contracts correct and is not an audit: see
[Index registry security](index-registry.md) for the tests and invariants, and for the fact that the contracts
have not been audited.
