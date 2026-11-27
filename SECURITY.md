# Security policy

## Status

**EquityOS has not been audited.** No external party has reviewed the contracts or the execution path. The
security pages under [`docs/security`](docs/security) describe what is checked, what is tested and what remains
trusted; they are not an audit, and nothing in this repository should be read as one.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.
Do not open a public issue, pull request or discussion for a vulnerability, and do not share it elsewhere before it
is fixed.

Please include:

- what is affected: a contract and its address, an API route, a page, or a file and commit;
- the steps to reproduce, or a proof of concept against a local chain or a fork;
- the impact you expect, and what an attacker needs;
- whether anyone else knows of it.

Test only against a local chain, a fork, or accounts and funds you control. Do not access other people's data or
funds, degrade the service for others, or use social engineering.

## What to expect

- We aim to acknowledge a report within 3 days, and to share an assessment, with a plan or the reason for not
  changing anything, within 10 days.
- A fix lands in a public pull request, credited to you if you wish. A vulnerability is described publicly only
  after its fix is merged, or after 90 days if no fix is possible, in agreement with you.

There is no bug bounty.

## Scope

| In scope                                                                                    | Out of scope                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `contracts/src`: `IndexRegistry`, `RebalanceLog`, and their addresses in the deployment map | Third-party contracts: the swap router and its executor, tokens and price feeds   |
| The REST API and the web app as deployed                                                    | Rate limits and availability of third-party APIs                                  |
| `packages/core`, `packages/sdk`, `packages/contracts-abi`                                   | Example and simulation contracts under `contracts/test`, which are never deployed |
| The execution path: plan building, calldata verification, the browser's checks and sending  | A compromised wallet, browser or RPC endpoint                                     |

The [bounded executor](docs/architecture/bounded-executor.md) is a design and a test simulation only. It is not
deployed and is out of scope until it is.

## Supported versions

Only the current `main` branch and the contracts at the addresses in the deployment map
(`packages/contracts-abi/src/deployments.ts`) are supported. The registry has no upgrade path: a vulnerability in a
deployed version is addressed by documenting it, and by deploying a new registry if it has to be replaced.
